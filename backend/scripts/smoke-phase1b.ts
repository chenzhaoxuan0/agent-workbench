/**
 * Phase 1b 验收 —— 第二家执行器（契约泛化性）。
 *
 * codex 走完全不同的协议（JSONL 事件流 vs zcode 的终态 JSON），
 * 但 host / WS 方法 / 事件形态一行不改 —— 这就是契约验收标准
 * 「新增一家工具 = 一个 adapter 文件 + 注册一行」的实证。
 *
 * 用法：cd backend && pnpm smoke:phase1b
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 400));
  }
}

let daemon: ChildProcess | undefined;
const daemonLogs: string[] = [];

function startDaemon(port: number, home: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trimEnd().split(/\r?\n/)) {
        daemonLogs.push(line);
        console.log(`  daemon | ${line}`);
      }
    });
  }
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
    if (daemon !== undefined && daemon.exitCode !== null) return false;
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

function wsConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["type"] === "event") {
        const event = frame["event"] as Record<string, unknown>;
        eventLog.push(event);
        if (event["type"] === "error") console.log(`  event | error: ${JSON.stringify(event).slice(0, 220)}`);
      }
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

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke1b-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon becomes healthy", await waitHealthy(port), daemonLogs.slice(-5));
    await wsConnect(port);

    const adapters = await call<Array<{ id: string }>>("adapter.list", null);
    check("both adapters registered", adapters.some((a) => a.id === "zcode") && adapters.some((a) => a.id === "codex"), adapters.map((a) => a.id));

    const probe = await call<{ state: { status: string } }>("adapter.probe", { runtimeId: "codex" }, 60000);
    check("codex probe ready", probe.state.status === "ready", probe);

    const workspace = mkdtempSync(path.join(os.tmpdir(), "awb-codex-ws-"));
    const mark = eventLog.length;
    const t0 = Date.now();
    const session = await call<{ id: string }>("session.start", {
      runtimeId: "codex",
      unitId: "smoke-codex",
      unitName: "Phase 1b 冒烟",
      rootPath: workspace,
      prompt: "只回答一个数字，不要执行任何命令：2+2=?",
      model: "gpt-6-astra",
    });

    const startedIdx = await waitForEvent("session.started", mark);
    const deltaIdx = await waitForEvent("message.delta", mark);
    const completedIdx = await waitForEvent("message.completed", mark);
    const usageIdx = await waitForEvent("usage", mark);
    await waitForEvent("session.status", mark);
    check(
      "event order started→delta→completed→usage→status (agent loop)",
      startedIdx < deltaIdx && deltaIdx < completedIdx && completedIdx <= usageIdx,
      eventLog.slice(mark).map((e) => e["type"]),
    );
    const reply1 = String((eventLog[completedIdx] as { text?: string }).text ?? "").trim();
    const usage1 = eventLog[usageIdx] as { inputTokens?: number };
    check("codex usage has real tokens", (usage1.inputTokens ?? 0) > 0, usage1);
    console.log(`         turn 1 reply (${((Date.now() - t0) / 1000).toFixed(1)}s): "${reply1}" — billedIn=${usage1.inputTokens}`);

    // resume 多轮
    const mark2 = eventLog.length;
    await call("session.send", { sessionId: session.id, text: "把上一个结果再乘以10，只回答一个数字。" });
    const c2 = await waitForEvent("message.completed", mark2);
    await waitForEvent("usage", mark2);
    const reply2 = String((eventLog[c2] as { text?: string }).text ?? "").trim();
    check("turn 2 (resume) completed", reply2.length > 0, eventLog.slice(mark2).map((e) => e["type"]));
    check("turn 2 answer is arithmetically right (resume works)", reply2.includes("40"), reply2);
    console.log(`         turn 2 reply: "${reply2}"`);

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { exitCode = c; break; }
      await sleep(150);
    }
    check("daemon exits 0 after daemon.stop", exitCode === 0, { exitCode, lastLogs: daemonLogs.slice(-6) });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase1b: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase1b: all checks passed — 契约泛化性成立（第二家执行器零 core 改动）");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase1b: crashed", err);
  void stopDaemon();
  process.exit(1);
});
