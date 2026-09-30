/**
 * Phase 3 验收 —— 落盘层（docs/06 §六/§七）：会话与消息落 state.db，
 * usage 落 usage.jsonl，traces 落 traces/；**重启 daemon 后 listSessions 仍在、
 * resumeSession 接回执行器续聊成立**。
 *
 *   daemon A：zcode 一轮真实对话 → 优雅退出
 *   daemon B（同一个 .waku）：listSessions 有历史 → resume → 续聊数学正确 → 退出
 *
 * 用法：cd backend && pnpm smoke:phase3
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
const eventLog: Array<Record<string, unknown>> = [];

async function connect(port: number): Promise<void> {
  eventLog.length = 0;
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["type"] === "event") eventLog.push(frame["event"] as Record<string, unknown>);
      if (frame["type"] === "event" && (frame["event"] as Record<string, unknown>)["type"] === "error") console.log('  event | error:', JSON.stringify((frame["event"] as Record<string, unknown>)["message"]).slice(0, 220));
    });
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 300000): Promise<T> {
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

async function waitForEvent(type: string, fromIndex: number, timeoutMs = 240000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = eventLog.findIndex((e, i) => i >= fromIndex && e["type"] === type);
    if (idx >= 0) return idx;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type} (have: ${eventLog.slice(fromIndex).map((e) => String(e["type"])).join(",")})`);
    await sleep(150);
  }
}

async function gracefulStop(): Promise<void> {
  await call("daemon.stop", null, 15000);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined) return;
    await sleep(150);
  }
  await stopDaemon();
}

async function main(): Promise<void> {
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke3-"));
  const workspace = mkdtempSync(path.join(os.tmpdir(), "awb-smoke3-ws-"));
  const workspaceB = mkdtempSync(path.join(os.tmpdir(), "awb-smoke3-wsb-"));
  let sessionId = "";

  // ---- daemon A：跑一轮真实对话 ----
  const portA = await freePort();
  console.log(`smoke: daemon A on ${portA} (home: ${home})`);
  startDaemon(portA, home);
  try {
    check("A healthy", await waitHealthy(portA));
    await connect(portA);
    const mark = eventLog.length;
    await call("session.start", {
      runtimeId: "codex",
      unitId: "smoke-persist",
      unitName: "Phase 3 冒烟",
      rootPath: workspace,
      prompt: "只回答一个数字，不要使用任何工具：3+4=?",
      model: "gpt-6-astra",
    });
    const completed = await waitForEvent("message.completed", mark);
    const reply = String((eventLog[completed] as { text?: string }).text ?? "").trim();
    check("turn 1 answered", reply.includes("7"), reply);
    // agent loop：turn 完成 → status（会话仍开）；落盘以 status/usage 事件驱动，稍候即可
    await waitForEvent("usage", mark);
    await sleep(600);
    const sessions = await call<Array<{ id: string }>>("session.list", null);
    sessionId = sessions[0]?.id ?? "";
    check("session has an id to remember", sessionId.startsWith("sess_"), sessions.length);
  } finally {
    await gracefulStop();
    console.log("smoke: daemon A stopped");
  }

  // ---- 落盘产物检查 ----
  check("state.db exists", existsSync(path.join(home, "state.db")));
  check("usage.jsonl exists", existsSync(path.join(home, "usage.jsonl")));
  const traceDir = path.join(home, "traces");
  check("traces dir exists", existsSync(traceDir));

  // ---- daemon B：同一个 home，重启后历史在、resume 续命 ----
  const portB = await freePort();
  console.log(`smoke: daemon B on ${portB} (same home)`);
  startDaemon(portB, home);
  try {
    check("B healthy", await waitHealthy(portB));
    await connect(portB);
    const sessions = await call<Array<{ id: string; status: string; stats: { inputTokens: number } }>>("session.list", null);
    const persisted = sessions.find((s) => s.id === sessionId);
    check("session survived restart", persisted !== undefined, sessions.length);
    check("persisted stats carry usage", (persisted?.stats.inputTokens ?? 0) > 0, persisted);

    const messages = await call<Array<{ role: string; text: string }>>("session.messages", { sessionId });
    check("messages persisted (user + assistant)", messages.some((m) => m.role === "user") && messages.some((m) => m.role === "assistant"), messages.length);

    // resume → 续聊（检验 cli_ref 续命：3+4=7，再加 1 = 8）
    await call("session.resume", { sessionId });
    const mark = eventLog.length;
    await call("session.send", { sessionId, text: "把上一个结果再加1，只回答一个数字。" });
    const completed = await waitForEvent("message.completed", mark);
    const reply2 = String((eventLog[completed] as { text?: string }).text ?? "").trim();
    check("resumed turn answers correctly (7+1=8)", reply2.includes("8"), reply2);
    console.log(`         resumed reply: "${reply2}"`);
    await waitForEvent("usage", mark);
  } finally {
    await gracefulStop();
    console.log("smoke: daemon B stopped");
  }
  void workspaceB;

  if (failures > 0) {
    console.error(`smoke-phase3: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase3: all checks passed — 会话跨重启持久 + resume 续命成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase3: crashed", err);
  void stopDaemon();
  process.exit(1);
});
