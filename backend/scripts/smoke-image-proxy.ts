/**
 * 出图代理冒烟 —— profile 存储与 /api/image/call 隧道的全链路验收。
 *
 *   profile CRUD（image.profiles.* RPC：脱敏下发 / 密钥保留语义 / 删除）
 *   → mock OpenAI 兼容供应商（JSON / SSE / multipart / 二进制下载四张脸）
 *   → 经 daemon 代理往返：Authorization 注入、multipart 重组、SSE 透传、
 *     下载隧道、baseUrl 前缀校验、未知 profile 404
 *
 * 用法：cd backend && npx tsx scripts/smoke-image-proxy.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        // 必须 close 再放行端口：不关的话本进程的探针服务器占着它，
        // 紧接着的同端口 listen 必 EADDRINUSE（终端冒烟踩过同款坑）
        srv.close(() => resolve(addr.port));
      } else {
        srv.close();
        reject(new Error("no free port"));
      }
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

let daemon: ChildProcess | undefined;

function startDaemon(port: number, home: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOME: home,
      AGENT_WORKBENCH_INSECURE: "1",
      // env: 引用约定的验收变量（见下文 envRef 用例）
      AWB_SMOKE_IMAGE_KEY: "sk-from-env",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  return new Promise((resolve) => {
    const d = daemon!;
    const timer = setTimeout(() => {
      d.kill("SIGKILL");
      resolve(null);
    }, 8000);
    d.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitHealthy(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 等待 */ }
    await sleep(200);
  }
  return false;
}

let ws: WebSocket | null = null;
let wsId = 0;

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
}

function call<T = unknown>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
    const id = `smoke-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.off("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

/** daemon /api/image/call 的浏览器侧调用形态（与前端 imageProxy.ts 同构） */async function imageCall(port: number, envelope: Record<string, unknown>, timeoutMs = 20000): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/image/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/* ------------------------------------------------------- mock 供应商 */

interface MockSeen {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: Buffer;
}

const TINY_PNG_B64 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");

async function startMockProvider(): Promise<{ port: number; seen: MockSeen[]; close: () => Promise<void> }> {
  const port = await freePort();
  const seen: MockSeen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers["authorization"] ?? null,
        contentType: req.headers["content-type"] ?? null,
        body,
      });
      const url = req.url ?? "";
      if (url.endsWith("/images/generations")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64, revised_prompt: "mock-revised" }] }));
        return;
      }
      if (url.endsWith("/images/edits")) {
        // multipart：确认字段与文件真的重组到了（filename 是稳定探针）
        const raw = body.toString("utf8");
        const hasField = raw.includes('name="prompt"') && raw.includes("edit-with-mock");
        const hasFile = raw.includes('filename="input-1.png"');
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }], mock_multipart_ok: hasField && hasFile }));
        return;
      }
      if (url.endsWith("/responses")) {
        // SSE 透传：两帧 partial + completed
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: TINY_PNG_B64, partial_image_index: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "image_generation.completed", b64_json: TINY_PNG_B64 })}\n\n`);
        res.end();
        return;
      }
      if (url.startsWith("/cdn/")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from(TINY_PNG_B64, "base64"));
        return;
      }
      if (url.endsWith("/teapot")) {
        res.writeHead(418, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock says no" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no such mock route" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, seen, close };
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mock = await startMockProvider();
  const mockBase = `http://127.0.0.1:${mock.port}`;

  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-img-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port} (mock provider ${mockBase})`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // ---- 1. profile CRUD：密钥永不下发，undefined 保留旧值
    const put = await call<{ id: string; hasKey: boolean; apiKey?: string }>("image.profiles.put", {
      id: "mock-provider",
      name: "Mock 供应商",
      baseUrl: mockBase,
      apiKey: "sk-smoke-secret",
      model: "gpt-image-1",
      timeout: 60,
      apiMode: "images",
      codexCli: false,
      transparentBackgroundMethod: "api",
    });
    check("put returns masked row with hasKey", put.hasKey === true && put.apiKey === undefined, put);

    const list = await call<Array<{ id: string; hasKey: boolean; apiKey?: string }>>("image.profiles.list", null);
    check("list is masked (no apiKey anywhere)", list.some((p) => p.id === "mock-provider" && p.hasKey === true) && !JSON.stringify(list).includes("sk-smoke-secret"), list);

    const putNoKey = await call<{ hasKey: boolean }>("image.profiles.put", { id: "mock-provider", name: "改名不留密钥字段" });
    check("put without apiKey keeps stored key", putNoKey.hasKey === true, putNoKey);

    // ---- 2. generations：JSON 透传 + Authorization 注入
    const gen = await imageCall(port, {
      profileId: "mock-provider",
      url: `${mockBase}/v1/images/generations`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", prompt: "smoke", size: "1024x1024" }),
    });
    check("generations status 200", gen.status === 200, gen.status);
    const genJson = (await gen.json()) as { data: Array<{ b64_json: string }> };
    check("generations body passthrough", genJson.data?.[0]?.b64_json === TINY_PNG_B64);
    const genSeen = mock.seen.find((s) => s.url.endsWith("/images/generations"));
    check("Authorization injected by daemon", genSeen?.authorization === "Bearer sk-smoke-secret", genSeen?.authorization);
    check("upstream JSON body forwarded", genSeen !== undefined && genSeen.body.toString("utf8").includes('"prompt":"smoke"'), genSeen?.body.toString().slice(0, 120));

    // ---- 3. edits：multipart 重组（字段 + base64 → 文件）
    const edit = await imageCall(port, {
      profileId: "mock-provider",
      url: `${mockBase}/v1/images/edits`,
      form: {
        fields: { model: "gpt-image-1", prompt: "edit-with-mock" },
        files: [{ field: "image[]", filename: "input-1.png", mime: "image/png", b64: TINY_PNG_B64 }],
      },
    });
    check("edits status 200", edit.status === 200, edit.status);
    const editJson = (await edit.json()) as { mock_multipart_ok?: boolean };
    check("multipart fields + file rebuilt upstream", editJson.mock_multipart_ok === true, editJson);
    const editSeen = mock.seen.find((s) => s.url.endsWith("/images/edits"));
    check("edits upstream is multipart", (editSeen?.contentType ?? "").startsWith("multipart/form-data"), editSeen?.contentType);

    // ---- 4. SSE：流式透传（响应不缓冲，逐块可读）
    const sse = await imageCall(port, {
      profileId: "mock-provider",
      url: `${mockBase}/v1/responses`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", stream: true }),
    });
    check("sse content-type passthrough", (sse.headers.get("content-type") ?? "").includes("text/event-stream"), sse.headers.get("content-type"));
    const sseText = await sse.text();
    check("sse events streamed through", sseText.includes("image_generation.partial_image") && sseText.includes("image_generation.completed"));

    // ---- 5. 下载隧道：供应商图片 url → 二进制透传
    const dl = await imageCall(port, { profileId: "mock-provider", url: `${mockBase}/cdn/pic.png`, method: "GET" });
    check("download tunnel status 200", dl.status === 200, dl.status);
    check("download tunnel content-type", (dl.headers.get("content-type") ?? "").startsWith("image/png"), dl.headers.get("content-type"));
    const dlBytes = Buffer.from(await dl.arrayBuffer());
    check("download tunnel bytes intact", dlBytes.equals(Buffer.from(TINY_PNG_B64, "base64")));

    // ---- 6. 错误路径：上游 418 透传（前端 getApiErrorMessage 语义依赖它）
    const teapot = await imageCall(port, { profileId: "mock-provider", url: `${mockBase}/v1/teapot`, bodyJson: "{}" });
    check("upstream error status passthrough", teapot.status === 418, teapot.status);
    const teapotJson = (await teapot.json()) as { error?: { message?: string } };
    check("upstream error body passthrough", teapotJson.error?.message === "mock says no", teapotJson);

    // ---- 7. 守卫：带 key 的 POST 只许打向本 profile 的 baseUrl
    const hijack = await imageCall(port, {
      profileId: "mock-provider",
      url: `http://127.0.0.1:9/v1/images/generations`,
      bodyJson: "{}",
    });
    check("url outside baseUrl rejected", hijack.status === 400, hijack.status);

    const ghost = await imageCall(port, { profileId: "no-such-profile", url: `${mockBase}/v1/images/generations`, bodyJson: "{}" });
    check("unknown profile 404", ghost.status === 404, ghost.status);

    // ---- 8. env: 引用：密钥不写盘，从环境变量取（用时解析）
    await call("image.profiles.put", {
      id: "env-ref-provider",
      name: "env 引用供应商",
      baseUrl: mockBase,
      apiKey: "env:AWB_SMOKE_IMAGE_KEY",
      model: "gpt-image-1",
      apiMode: "images",
    });
    const envRef = await imageCall(port, {
      profileId: "env-ref-provider",
      url: `${mockBase}/v1/images/generations`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", prompt: "env-ref" }),
    });
    check("env-ref generation status 200", envRef.status === 200, envRef.status);
    const envRefSeen = mock.seen.filter((s) => s.url.endsWith("/images/generations")).at(-1);
    check("env-ref Authorization from environment", envRefSeen?.authorization === "Bearer sk-from-env", envRefSeen?.authorization);

    // ---- 8b. <homeDir>/.env 文件层：引用可落到文件，且系统环境变量优先于文件
    writeFileSync(path.join(home, ".env"), [
      "# 出图密钥集中放这里（README「密钥放在哪」）",
      "AWB_SMOKE_FILE_KEY=sk-from-file",
      "AWB_SMOKE_IMAGE_KEY=sk-file-should-lose", // 与 OS 环境变量同名：文件必须让位
      "",
    ].join("\n"), "utf8");
    await call("image.profiles.put", {
      id: "env-file-provider",
      name: "env 文件供应商",
      baseUrl: mockBase,
      apiKey: "env:AWB_SMOKE_FILE_KEY",
      model: "gpt-image-1",
      apiMode: "images",
    });
    const envFile = await imageCall(port, {
      profileId: "env-file-provider",
      url: `${mockBase}/v1/images/generations`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", prompt: "env-file" }),
    });
    const envFileSeen = mock.seen.filter((s) => s.url.endsWith("/images/generations")).at(-1);
    check("env: ref resolves from <homeDir>/.env", envFileSeen?.authorization === "Bearer sk-from-file", envFileSeen?.authorization);
    // 优先级：env-ref-provider 用的名字在文件里也有一条 —— 上游必须仍收到 OS 值
    const envRefSeen2 = await imageCall(port, {
      profileId: "env-ref-provider",
      url: `${mockBase}/v1/images/generations`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", prompt: "precedence" }),
    }).then(() => mock.seen.filter((s) => s.url.endsWith("/images/generations")).at(-1));
    check("OS env wins over .env file", envRefSeen2?.authorization === "Bearer sk-from-env", envRefSeen2?.authorization);

    // ---- 8c. 改 .env 立即生效（mtime 失效重读，不重启 daemon）
    writeFileSync(path.join(home, ".env"), "AWB_SMOKE_FILE_KEY=sk-from-file-v2\n", "utf8");
    await sleep(50); // 文件系统 mtime 粒度
    await imageCall(port, {
      profileId: "env-file-provider",
      url: `${mockBase}/v1/images/generations`,
      bodyJson: JSON.stringify({ model: "gpt-image-1", prompt: "hot-reload" }),
    });
    const hotSeen = mock.seen.filter((s) => s.url.endsWith("/images/generations")).at(-1);
    check(".env edit applies without restart", hotSeen?.authorization === "Bearer sk-from-file-v2", hotSeen?.authorization);

    await call("image.profiles.delete", { id: "env-ref-provider" });
    await call("image.profiles.delete", { id: "env-file-provider" });

    // ---- 9. 落盘真值：密钥只在 daemon 侧文件里
    const onDisk = JSON.parse(readFileSync(path.join(home, "image-profiles.json"), "utf8")) as { profiles: Array<{ id: string; apiKey: string }> };
    check("key persisted on daemon disk only", onDisk.profiles?.some((p) => p.id === "mock-provider" && p.apiKey === "sk-smoke-secret"), onDisk.profiles?.map((p) => p.id));

    // ---- 10. 删除
    const del = await call<{ deleted: boolean }>("image.profiles.delete", { id: "mock-provider" });
    check("delete works", del.deleted === true, del);
    const list2 = await call<Array<{ id: string }>>("image.profiles.list", null);
    check("list empty after delete", !list2.some((p) => p.id === "mock-provider"));

    await call("daemon.stop", null, 15000);
    const code = await stopDaemon();
    check("daemon exits 0", code === 0, code);
  } finally {
    await stopDaemon();
    await mock.close(); // 不关的话事件循环被 mock 服务器吊住，进程不退
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.close();
  }

  if (failures > 0) {
    console.error(`smoke-image-proxy: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-image-proxy: all checks passed — 密钥落盘/脱敏下发/代理透传（JSON·multipart·SSE·下载）/守卫成立");
}

main().catch((err: unknown) => {
  console.error("smoke-image-proxy: crashed", err);
  process.exit(1);
});
