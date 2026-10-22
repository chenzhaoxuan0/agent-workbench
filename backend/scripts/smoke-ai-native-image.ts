/**
 * AI-native P4c 验收（docs/21 §2 P4c）：image.generate 上移。
 *
 *   本地起一个假 OpenAI images 供应商（JSON b64 响应）→ 自起 daemon →
 *   image.profiles.put 指向假供应商 → image.generate → 断言：文件落盘
 *   <homeDir>/images/<taskId>/、image.tasks.list 有该任务、GET /api/image/file
 *   返回 200 png、路径穿越被 403。结束清理 profile（不污染真实状态）。
 *
 * 编排唯一源：daemon 与 GUI 共用 prototype/core/imageApi.ts，差异只在传输层
 * （daemon 直连注入 vs 浏览器走 /api/image/call 代理）。
 *
 * 用法：cd backend && pnpm smoke:ai-native-image
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http, { type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 1x1 透明 png */
const FAKE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

let daemon: ChildProcess | undefined;
const daemonOutput: string[] = [];

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      daemonOutput.push(chunk.toString().trimEnd());
    });
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => {
    daemon?.once("exit", (code) => resolve(code));
  });
  daemon.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    daemon.kill("SIGKILL");
    return null;
  }
  return code;
}

async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return false;
}

async function rpc<T>(port: number, method: string, params: unknown): Promise<{ ok: boolean; result?: T; error?: { code?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as { ok: boolean; result?: T; error?: { code?: string } };
}

interface ImageTask {
  id: string;
  status: string;
  images: Array<{ path: string; bytes: number; mime: string }>;
  revisedPrompt?: string;
  outDir?: string;
}

async function main(): Promise<void> {
  // 假供应商：POST /v1/images/generations → JSON b64_json
  const fakePort = await freePort();
  const fake: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const auth = req.headers["authorization"] ?? "";
      if (String(auth) !== "Bearer sk-fake-smoke") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: FAKE_PNG_B64, revised_prompt: "smoke-revised" }],
      }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(fakePort, "127.0.0.1", resolve));

  const port = await freePort();
  console.log(`smoke: fake provider on ${fakePort}, daemon on ${port}`);
  startDaemon(port);

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. profile 指向假供应商（结束清理）
    const put = await rpc(port, "image.profiles.put", {
      id: "smoke-fake",
      name: "Smoke Fake",
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      apiKey: "sk-fake-smoke",
      model: "gpt-image-smoke",
      timeout: 30,
      apiMode: "images",
      codexCli: false,
      transparentBackgroundMethod: "api",
    });
    check("image.profiles.put", put.ok === true, put);

    // 2. 生成：直连假供应商 → 落盘 + 任务
    const gen = await rpc<ImageTask>(port, "image.generate", {
      profileId: "smoke-fake",
      prompt: "一只冒烟测试猫",
      params: { n: 1, size: "auto" },
    });
    check("image.generate succeeds", gen.ok === true && gen.result?.status === "done", gen);
    const img = gen.result?.images?.[0];
    check("image written to disk", img !== undefined && existsSync(img.path) && img.bytes > 0 && img.mime === "image/png", img);
    check("revisedPrompt carried", (gen.result?.revisedPrompt ?? "") === "smoke-revised", gen.result?.revisedPrompt);

    // 3. 任务历史（daemon 事实源）
    const tasks = await rpc<{ items: ImageTask[] }>(port, "image.tasks.list", null);
    check("image.tasks.list has the task", tasks.ok === true && (tasks.result?.items ?? []).some((t) => t.id === gen.result?.id), gen.result?.id);

    // 4. 文件服务面：200 png / 路径穿越 403
    const fileRes = await fetch(`http://127.0.0.1:${port}/api/image/file?path=${encodeURIComponent(img?.path ?? "")}`, {
      signal: AbortSignal.timeout(5000),
    });
    check("GET /api/image/file serves the png", fileRes.status === 200 && (fileRes.headers.get("content-type") ?? "") === "image/png");
    const evil = await fetch(`http://127.0.0.1:${port}/api/image/file?path=${encodeURIComponent("C:/Windows/win.ini")}`, {
      signal: AbortSignal.timeout(5000),
    });
    check("path traversal is 403", evil.status === 403, evil.status);

    // 5. 错密钥：401 上游 → 结构化失败任务也入历史
    await rpc(port, "image.profiles.put", {
      id: "smoke-fake",
      apiKey: "sk-wrong",
      name: "Smoke Fake",
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      model: "gpt-image-smoke",
      timeout: 30,
      apiMode: "images",
      codexCli: false,
      transparentBackgroundMethod: "api",
    });
    const bad = await rpc<ImageTask>(port, "image.generate", { profileId: "smoke-fake", prompt: "错误密钥应失败" });
    check("bad key fails as rpc error", bad.ok === false, bad.error);
    const tasks2 = await rpc<{ items: ImageTask[] }>(port, "image.tasks.list", null);
    check("failed task recorded in history", (tasks2.result?.items ?? []).some((t) => t.status === "failed"), (tasks2.result?.items ?? []).map((t) => t.status));
  } finally {
    await rpc(port, "image.profiles.delete", { id: "smoke-fake" }).catch(() => undefined);
    await stopDaemon();
    fake.close();
  }

  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("smoke: crashed", err);
  void stopDaemon();
  process.exit(1);
});
