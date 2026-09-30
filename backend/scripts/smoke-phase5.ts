/**
 * Phase 5 验收 —— 自动化调度（docs/06：daemon 内 cron，到点起会话，运行记录落盘）。
 *
 *   runNow 立即起一次（mockperm，快而免费）→ 会话结束回灌运行记录
 *   → 建 "* * * * *" 的真 cron → 等 tick 到点自动发火（≤70s）
 *   → 运行记录 ≥2 → disable/ delete → 优雅退出
 *
 * 用法：cd backend && pnpm smoke:phase5
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
    });
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
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

async function waitForEvent(type: string, fromIndex: number, timeoutMs = 30000): Promise<number> {
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
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke5-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 1. 坏 cron 创建即拒
    let rejected = false;
    await call("automation.create", { unitId: "u", runtimeId: "mockperm", rootPath: home, prompt: "x", cron: "61 * * * *" }).catch(() => {
      rejected = true;
    });
    check("bad cron rejected at create", rejected);

    // 2. 预放行规则（mockperm 每轮必发权限请求；闸自动放行 = Phase 4 集成验证）
    const ruleRes = await fetch(`http://127.0.0.1:${port}/api/permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "mock_tool", decision: "allow" }),
    });
    check("pre-allow rule created", ruleRes.ok);

    // 3. runNow：立即起一次会话，运行记录落盘
    const created = await call<{ id: number }>("automation.create", {
      unitId: "smoke-auto",
      unitName: "Phase 5 冒烟",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "自动化任务",
      model: "mock-1",
      cron: "0 0 1 1 *", // 永不到点，只测 runNow
    });
    const now = await call<{ runId: number; sessionId: string }>("automation.runNow", { id: created.id });
    check("runNow launches session", now.sessionId.startsWith("sess_"), now);
    let runs = await call<Array<{ id: number; status?: string; sessionId?: string | null }>>("automation.runs", { id: created.id });
    check("run record finished with session", runs.some((r) => r.id === now.runId && r.sessionId === now.sessionId), runs);
    check("run record reached terminal status", runs.every((r) => r.id !== now.runId || r.status === "done" || r.status === "failed"), runs);
    const endedAt = await (async () => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const hit = eventLog.findLast((e) => e["type"] === "session.ended" && e["sessionId"] === now.sessionId);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) throw new Error("automated session never ended");
        await sleep(200);
      }
    })();
    check("automated session ended (gate auto-passed)", endedAt !== undefined);

    // 3. 真 cron：每分钟到点自动发火（等 tick，最长 70s）
    const cronAuto = await call<{ id: number }>("automation.create", {
      unitId: "smoke-auto-cron",
      unitName: "cron 冒烟",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "每分钟一次",
      model: "mock-1",
      cron: "* * * * *",
    });
    const sessionsBefore = eventLog.filter((e) => e["type"] === "session.started").length;
    console.log("         waiting up to 70s for cron tick...");
    const deadline = Date.now() + 70_000;
    let fired = false;
    while (Date.now() < deadline) {
      runs = await call<Array<{ id: number; status?: string; sessionId?: string | null }>>("automation.runs", { id: cronAuto.id });
      if (runs.length > 0) { fired = true; break; }
      await sleep(2000);
    }
    check("cron fired automatically within 70s", fired, runs);
    const sessionsNow = eventLog.filter((e) => e["type"] === "session.started").length;
    check("cron session appeared on event stream", sessionsNow > sessionsBefore, { sessionsNow });

    // 4. disable 后停止发火（等一个 tick 确认不再增）
    await call("automation.setEnabled", { id: cronAuto.id, enabled: false });
    await sleep(25_000);
    runs = await call<Array<{ id: number }>>("automation.runs", { id: cronAuto.id });
    check("disabled automation stops firing", runs.length === 1, runs.length);

    // 5. 清理 + 优雅退出
    const del = await call<{ deleted: boolean }>("automation.delete", { id: cronAuto.id });
    check("automation delete works", del.deleted === true);

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const exitDeadline = Date.now() + 10000;
    while (Date.now() < exitDeadline) {
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
    console.error(`smoke-phase5: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase5: all checks passed — cron 到点起会话 + 运行记录落盘成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase5: crashed", err);
  void stopDaemon();
  process.exit(1);
});
