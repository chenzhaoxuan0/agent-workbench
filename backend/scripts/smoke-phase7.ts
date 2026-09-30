/**
 * Phase 7 验收 —— 记忆编排服务端化（docs/06：sqlite 三柱 + WeKnora 代理 +
 * MEMORY.md 镜像 + 三柱路由；浏览器端 weknora.ts / localMemorySource.ts 不动）。
 *
 *   三柱写入（sqlite 路由）→ list 逐柱可读 → MEMORY.md 镜像含语义事实
 *   → search 命中 → 路由切到 [sqlite, weknora]（weknora 未配置/不可达）
 *   → 写入广播 sqlite 成功 + weknora 记错误不炸；检索并集带错误注记
 *   → 路由还原 → daemon.stop
 *
 * 用法：cd backend && pnpm smoke:phase7
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("no free port"));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return Promise.resolve(daemon?.exitCode ?? null);
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
    d.kill("SIGTERM");
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

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
    const id = `smoke-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke7-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 1. 三柱写入（默认 sqlite 路由）
    await call("memory.save", { pillar: "semantic", content: "用户偏好简洁的中文回复", source: "smoke" });
    await call("memory.save", { pillar: "episodic", content: "2026-09-29 完成了 Phase 7 冒烟", source: "smoke" });
    await call("memory.save", { pillar: "procedural", content: "跑冒烟用 pnpm smoke:phaseN", source: "smoke" });

    const semantic = await call<Array<{ content: string }>>("memory.list", { pillar: "semantic" });
    check("semantic pillar saved", semantic.some((r) => r.content.includes("简洁的中文")), semantic);
    const episodic = await call<Array<{ content: string }>>("memory.list", { pillar: "episodic" });
    check("episodic pillar saved", episodic.length === 1, episodic);
    const procedural = await call<Array<{ content: string }>>("memory.list", { pillar: "procedural" });
    check("procedural pillar saved", procedural.length === 1, procedural);

    // 2. MEMORY.md 镜像（语义柱）
    const mirror = await call<string>("memory.mirror", null);
    check("MEMORY.md mirror contains semantic fact", typeof mirror === "string" && mirror.includes("简洁的中文"), mirror?.slice(0, 120));

    // 3. 检索命中
    const search = await call<{ hits: Array<{ pillar: string; content: string }>; errors: unknown[] }>("memory.search", { query: "简洁" });
    check("search hits semantic row", search.hits.some((h) => h.pillar === "semantic" && h.content.includes("简洁")), search);
    check("search without weknora has no errors", Array.isArray(search.errors) && search.errors.length === 0, search.errors);

    // 4. 路由广播：semantic → [weknora]（未配置）——写入 weknora 报错但 sqlite 永远兜底成功
    const routing = await call<Record<string, string[]>>("memory.routing.set", { routing: { semantic: ["weknora"] } });
    check("routing updated", Array.isArray(routing["semantic"]) && routing["semantic"]?.includes("weknora"), routing);

    const saveRes = await call<{ results: Array<{ backend: string; ok: boolean; error?: string }> }>("memory.save", {
      pillar: "semantic",
      content: "用户在杭州工作",
      source: "smoke",
    });
    const weknoraResult = saveRes.results.find((r) => r.backend === "weknora");
    const sqliteResult = saveRes.results.find((r) => r.backend === "sqlite");
    check("sqlite backend always succeeds", sqliteResult?.ok === true, saveRes);
    check("unconfigured weknora records error without crashing", weknoraResult?.ok === false && typeof weknoraResult?.error === "string", saveRes);

    // 5. 检索并集带错误注记（weknora 已路由但不可用）
    const search2 = await call<{ hits: Array<{ content: string }>; errors: Array<{ backend: string }> }>("memory.search", {
      query: "杭州",
      pillars: ["semantic"],
    });
    check("sqlite hit still returned with weknora routed", search2.hits.some((h) => h.content.includes("杭州")), search2);
    check("weknora error noted", search2.errors.some((e) => e.backend === "weknora"), search2.errors);

    // 6. weknora 配置存取（key 掩码）
    const cfgSet = await call<{ baseUrl: string; apiKeyMasked: string }>("memory.weknora.config.set", {
      baseUrl: "http://127.0.0.1:18080",
      apiKey: "sk-secret-abc",
      kbIds: ["kb-1"],
    });
    check("weknora config stored with masked key", cfgSet.baseUrl === "http://127.0.0.1:18080" && cfgSet.apiKeyMasked.startsWith("sk-s") && !cfgSet.apiKeyMasked.includes("secret"), cfgSet);

    // 7. 路由还原
    await call("memory.routing.set", { routing: { semantic: ["sqlite"] } });
    const restored = await call<Record<string, string[]>>("memory.routing.get", null);
    check("routing restored", restored["semantic"]?.length === 1 && restored["semantic"]?.[0] === "sqlite", restored);

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { exitCode = c; break; }
      await sleep(150);
    }
    check("daemon exits 0", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase7: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase7: all checks passed — 记忆三柱 + 路由 + WeKnora 代理 + MEMORY.md 镜像成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase7: crashed", err);
  void stopDaemon();
  process.exit(1);
});
