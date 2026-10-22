/**
 * AI-native P1 验收（docs/21 §2 P1）：HTTP-RPC 桥。
 *
 *   自起 daemon（随机端口 + 显式 token，鉴权真实生效）→
 *   POST /rpc：无 token 401 / health 回环 / id 回填 / unknown_method 200+ok:false /
 *   坏信封 400 / GET /rpc 404 → WS 同方法同结果（同一条分发路径）→
 *   daemon.stop 走 /rpc → 断言退出码 0
 *
 * 纪律（docs/21 D2）：传输层错误用状态码（401/404/400），RPC 层错误一律 200 + ok:false。
 * 用法：cd backend && pnpm smoke:ai-native-rpc
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "smoke-rpc-token-0123456789";
/** 冒烟家（隔离 AGENT_WORKBENCH_HOME）：daemon 全部状态住临时目录，绝不碰真实 ~/.agent-workbench */
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "aw-rpc-home-"));

// ---- 小工具（对齐 smoke-health.ts）-----------------------------------------

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
    // 显式 token（不走 INSECURE）：鉴权面真实生效，401 才可断言
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_TOKEN: TOKEN, AGENT_WORKBENCH_HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      daemonOutput.push(text);
      console.log(`  daemon | ${text}`);
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

function rpc(port: number, body: unknown, withToken = true): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(withToken ? { "x-awb-token": TOKEN } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => ({ status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }));
}

interface WsMessage {
  [k: string]: unknown;
}

function nextMessage(ws: WebSocket, pred: (f: WsMessage) => boolean, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for ws frame"));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as WsMessage;
      if (!pred(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
  });
}

// ---- 主流程 ---------------------------------------------------------------

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port} (token auth ON)`);
  startDaemon(port);

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. 传输层：无 token 401（状态码，不是 200+ok:false）
    const noAuth = await rpc(port, { v: 1, method: "health" }, false);
    check("no token gets 401", noAuth.status === 401 && (noAuth.json?.["error"] as Record<string, unknown> | undefined)?.["code"] === "unauthorized", noAuth);

    // 2. health 回环：与 WS 同信封 {v:1, ok:true, result}
    const health = await rpc(port, { v: 1, id: "c-1", method: "health", params: null });
    const healthResult = health.json?.["result"] as Record<string, unknown> | undefined;
    check(
      "health round-trips over /rpc",
      health.status === 200 && health.json?.["v"] === 1 && health.json?.["ok"] === true &&
        healthResult?.["ok"] === true && healthResult?.["name"] === "agent-workbench-daemon",
      health,
    );
    check("id echoes back", health.json?.["id"] === "c-1", health);

    // 3. RPC 层：unknown method → 200 + ok:false + unknown_method（与 WS 帧同码）
    const unknown = await rpc(port, { v: 1, method: "definitely_not_a_method" });
    check(
      "unknown method is 200 + ok:false + unknown_method",
      unknown.status === 200 && unknown.json?.["ok"] === false &&
        (unknown.json?.["error"] as Record<string, unknown> | undefined)?.["code"] === "unknown_method",
      unknown,
    );

    // 4. 传输层：坏信封 400 / GET /rpc 404
    const badEnvelope = await rpc(port, { v: 2, method: "health" });
    check("bad envelope gets 400", badEnvelope.status === 400, badEnvelope);
    const getMiss = await fetch(`http://127.0.0.1:${port}/rpc`, {
      headers: { "x-awb-token": TOKEN },
      signal: AbortSignal.timeout(3000),
    });
    check("GET /rpc is 404 (POST-only route)", getMiss.status === 404);

    // 5. 同一条分发路径：WS 与 /rpc 对同一方法返回同一 result（比对稳定字段；uptimeMs 天然漂移）
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    });
    await nextMessage(ws, (f) => f["type"] === "hello");
    ws.send(JSON.stringify({ v: 1, id: "ws-1", method: "health", params: null }));
    const wsResp = await nextMessage(ws, (f) => f["id"] === "ws-1");
    const wsResult = wsResp["result"] as Record<string, unknown> | undefined;
    check(
      "WS and /rpc share one dispatch path (same result)",
      wsResult?.["ok"] === healthResult?.["ok"] && wsResult?.["name"] === healthResult?.["name"] &&
        wsResult?.["version"] === healthResult?.["version"] && wsResult?.["pid"] === healthResult?.["pid"],
      { ws: wsResult, http: healthResult },
    );

    // 6. 方法自描述（P2）：全量注册表 + 元数据（说明 / params 提示 / danger）
    const meta = await rpc(port, { v: 1, method: "rpc.methods" });
    const metaResult = meta.json?.["result"] as { count?: number; methods?: Array<Record<string, unknown>> } | undefined;
    const metaList = metaResult?.methods ?? [];
    const byName = (n: string): Record<string, unknown> | undefined => metaList.find((m) => m["method"] === n);
    check(
      "rpc.methods self-describes the registry",
      meta.status === 200 && (metaResult?.count ?? 0) >= 150 && byName("health") !== undefined && byName("rpc.methods") !== undefined,
      { count: metaResult?.count },
    );
    check(
      "method metadata: descriptions and danger flags land",
      typeof byName("session.start")?.["description"] === "string" &&
        typeof byName("git.status")?.["paramsHint"] === "string" &&
        byName("daemon.stop")?.["danger"] === "high" && byName("git.push")?.["danger"] === "high",
      { sessionStart: byName("session.start"), daemonStop: byName("daemon.stop") },
    );

    // 7. 收尾也走 /rpc：daemon.stop → 退出码 0
    const stop = await rpc(port, { v: 1, method: "daemon.stop" });
    check("daemon.stop works over /rpc", stop.status === 200 && stop.json?.["ok"] === true, stop);

    const exitPromise = new Promise<number | null>((resolve) => {
      daemon?.once("exit", (code) => resolve(code));
    });
    const exitCode = await Promise.race([exitPromise, sleep(8000).then(() => "timeout" as const)]);
    check("daemon exits 0 after /rpc daemon.stop", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) {
      console.error("smoke: daemon did not exit, killed");
    }
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
