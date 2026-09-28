/**
 * Phase 1 验收（docs/06 §六）：**产品第一条真实对话**。
 *
 *   自起 daemon → probe 执行器 → WS 发一条真实 prompt
 *   → 断言事件序列 session.started → message.delta* → message.completed → usage → session.ended
 *   → 第二轮 session.send 验证多轮 → 轨迹落盘检查 → daemon.stop 优雅退出
 *
 * 这里会真调一次模型（GLM，几十毫秒级费用），是所有后续改动的回归线（docs/06 §九）。
 * 用法：cd backend && pnpm smoke:phase1
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 通用小工具（与 smoke-health 同款式，验收脚本保持自包含） ----------------

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
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home },
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
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  return false;
}

// ---- WS 客户端 -------------------------------------------------------------

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
        if (event["type"] === "error") console.log(`  event | error: ${JSON.stringify(event)}`);
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

/** 等到事件流里出现下一个指定类型的事件（从 fromIndex 起找） */
async function waitForEvent(type: string, fromIndex: number, timeoutMs = 240000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = eventLog.findIndex((e, i) => i >= fromIndex && e["type"] === type);
    if (idx >= 0) return idx;
    if (Date.now() > deadline) throw new Error(`timed out waiting for event ${type} (have: ${eventLog.slice(fromIndex).map((e) => String(e["type"])).join(",")})`);
    await sleep(150);
  }
}

// ---- 主流程 ----------------------------------------------------------------

const ROOT = path.join(backendRoot, ".waku", "smoke-workspace");

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke1-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port} (home: ${home})`);
  startDaemon(port, home);

  try {
    check("daemon becomes healthy", await waitHealthy(port), daemonLogs.slice(-5));
    await wsConnect(port);

    // 1. 执行器清单与探测
    const adapters = await call<Array<{ id: string; models: unknown[] }>>("adapter.list", null);
    check("zcode adapter registered with non-empty models", adapters.some((a) => a.id === "zcode" && a.models.length > 0), adapters);

    const probe = await call<{ state: { status: string; version?: string } }>("adapter.probe", { runtimeId: "zcode" }, 60000);
    check("zcode probe ready", probe.state.status === "ready", probe);
    console.log(`         zcode version: ${probe.state.version ?? "?"}`);

    // 2. 第一轮：真实 prompt → 断言契约事件序列
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(path.join(ROOT, "README.md"), "# smoke workspace\n\nPhase 1 冒烟用工作目录。\n");

    const mark0 = eventLog.length;
    const t0 = Date.now();
    const session = await call<{ id: string; status: string; runtimeId: string }>("session.start", {
      runtimeId: "zcode",
      unitId: "smoke-unit",
      unitName: "Phase 1 冒烟",
      rootPath: ROOT,
      prompt: "只回答一个数字，不要使用任何工具，不要解释：1+1=?",
      model: "glm-5-turbo",
    });
    check("session.start returns session", typeof session.id === "string" && session.runtimeId === "zcode", session);

    const startedIdx = await waitForEvent("session.started", mark0);
    const deltaIdx = await waitForEvent("message.delta", mark0);
    const completedIdx = await waitForEvent("message.completed", mark0);
    const usageIdx = await waitForEvent("usage", mark0);
    const endedIdx = await waitForEvent("session.ended", mark0);
    check(
      "event order started→delta→completed→usage→ended",
      startedIdx < deltaIdx && deltaIdx < completedIdx && completedIdx <= usageIdx && usageIdx < endedIdx,
      eventLog.slice(mark0).map((e) => e["type"]),
    );

    const deltas = eventLog.slice(mark0, completedIdx).filter((e) => e["type"] === "message.delta");
    check("streaming deltas >= 1", deltas.length >= 1, deltas.length);
    const reply1 = String((eventLog[completedIdx] as { text?: string }).text ?? "").trim();
    const usage1 = eventLog[usageIdx] as { inputTokens?: number; outputTokens?: number };
    check("usage has real tokens", (usage1.inputTokens ?? 0) > 0 && (usage1.outputTokens ?? 0) >= 0, usage1);
    console.log(`         turn 1 reply (${((Date.now() - t0) / 1000).toFixed(1)}s): "${reply1}" — usage in=${usage1.inputTokens} out=${usage1.outputTokens}`);

    // 3. 第二轮：多轮续聊（session.send 复用同一会话）
    const mark1 = eventLog.length;
    const t1 = Date.now();
    await call("session.send", { sessionId: session.id, text: "把上一个结果再乘以3，只回答一个数字。" });
    await waitForEvent("message.delta", mark1);
    const completed2 = await waitForEvent("message.completed", mark1);
    await waitForEvent("usage", mark1);
    const ended2 = await waitForEvent("session.ended", mark1);
    const reply2 = String((eventLog[completed2] as { text?: string }).text ?? "").trim();
    check("turn 2 streamed and ended", completed2 < ended2, eventLog.slice(mark1).map((e) => e["type"]));
    check("turn 2 answer is arithmetically right", reply2.includes("6"), reply2);
    console.log(`         turn 2 reply (${((Date.now() - t1) / 1000).toFixed(1)}s): "${reply2}"`);

    // 4. 台账与轨迹
    const sessions = await call<Array<{ id: string; stats: { inputTokens: number } }>>("session.list", null);
    const listed = sessions.find((s) => s.id === session.id);
    check("session listed with accumulated usage", listed !== undefined && listed.stats.inputTokens > 0, listed);

    const today = new Date().toISOString().slice(0, 10);
    const traceFile = path.join(home, "traces", `${today}.jsonl`);
    check("trace file written", existsSync(traceFile), traceFile);
    if (existsSync(traceFile)) {
      const lines = readFileSync(traceFile, "utf8").trimEnd().split("\n");
      // 头 1 行 + session.started 1 行 + 每轮 4 条（delta/completed/usage/ended）× 2 轮 = 10
      check("trace file has header + records", lines.length >= 10 && JSON.parse(lines[0]!)["format"] === "trace", lines.length);
    }

    // 5. 优雅退出（纯轮询观察，不发信号干扰判断）
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
    console.error(`smoke-phase1: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase1: all checks passed — 产品有了第一条真实对话");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase1: crashed", err);
  void stopDaemon();
  process.exit(1);
});
