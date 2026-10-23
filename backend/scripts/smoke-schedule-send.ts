/**
 * 「定时发送到本对话」验收 —— dispatch_target = existing_session 的整条派发路径。
 *
 * 这个路径此前**没有任何冒烟覆盖**（smoke-phase5b 只测了调度引擎本身：
 * 一次性终态 / misfire / 持久化 / 失败徽章），于是「首轮没跑完的对话会被
 * 静默改投到新会话」这个坑一直没人发现 —— 探针实证：会话数 1 → 3，
 * 消息没进目标对话，只在自动化卡片上留一行红字。
 *
 *   场景 A（回归钉子）：目标对话**首轮还没跑完**（live，但 cli_ref 尚未落盘）
 *     → 到点 → 消息投进**目标**对话，且**没有**新建会话
 *   场景 B：目标对话**已结束**但有 cli_ref → 到点 → reattach 后投进目标对话
 *   场景 C：目标对话**跑完一轮、agent 空闲**（live + 有 cli_ref）→ 到点 → 投进目标对话
 *
 * 三条都断言「运行记录的 sessionId === 目标会话 id」+「会话数没变」——
 * 降级发生时这两条会同时不成立（降级会另开一个会话，运行记录指向那个新会话）。
 *
 * 用法：cd backend && pnpm smoke:schedule-send
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
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 400));
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

async function waitHealthy(port: number, timeoutMs = 25000): Promise<boolean> {
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
/** 事件流（permission.requested / steer.queued 等），用来认领请求 id、验队列 */
const events: Array<Record<string, unknown>> = [];

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["type"] === "event") events.push(frame["event"] as Record<string, unknown>);
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

async function waitForEvent(type: string, fromIndex: number, timeoutMs = 20000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = events.findIndex((e, i) => i >= fromIndex && e["type"] === type);
    if (idx >= 0) return idx;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting ${type} (have: ${events.slice(fromIndex).map((e) => String(e["type"])).join(",")})`);
    }
    await sleep(100);
  }
}

/** 解掉该会话当前挂起的权限请求（mockperm 每轮必挂一次） */
async function resolvePendingPermission(sessionId: string): Promise<boolean> {
  const hit = events.filter((e) => e["type"] === "permission.requested" && e["sessionId"] === sessionId).at(-1);
  const requestId = hit?.["requestId"];
  if (typeof requestId !== "string") return false;
  await call("permission.resolve", { sessionId, requestId, decision: "allow" });
  return true;
}

interface SessionRow {
  id: string;
  status: string;
  live?: boolean;
  resumable?: boolean;
  endedAt?: number | null;
}

interface RunRow {
  id: number;
  sessionId: string | null;
  status: string;
  trigger: string;
}

const listSessions = async (): Promise<SessionRow[]> => await call<SessionRow[]>("session.list", null);

/** 等自动化到点发火（运行记录出现） */
async function waitRunFired(autoId: number, timeoutMs = 45000): Promise<RunRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = await call<RunRow[]>("automation.runs", { id: autoId });
    if (Array.isArray(runs) && runs.length > 0) return runs;
    if (Date.now() > deadline) return [];
    await sleep(500);
  }
}

/** 排一条「定时发到指定对话」的任务：runAt 落在 2.5s 后，等一个 tick 就会发火 */
async function scheduleSendTo(
  base: Record<string, unknown>,
  name: string,
  prompt: string,
  targetSessionId: string,
): Promise<{ id: number; nextRunAt: number | null }> {
  return await call<{ id: number; nextRunAt: number | null }>("automation.create", {
    ...base,
    name,
    prompt,
    runAt: Date.now() + 2500,
    dispatchTarget: "existing_session",
    targetSessionId,
    launchMode: "headless",
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-sched-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  const base = {
    unitId: "u-sched",
    unitName: "定时发送冒烟",
    runtimeId: "mockperm",
    rootPath: home,
  };

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // ---- 场景 A：目标对话首轮未跑完（live，但 cli_ref 还没落盘）----
    console.log("\n--- 场景 A：首轮未跑完的对话（回归钉子） ---");
    // ⚠ mark 必须在 session.start 之前取：mockperm 的 permission.requested
    //   在 RPC 返回前就发出来了，事后取 mark 会漏掉它。
    const markA = events.length;
    const sA = await call<{ id: string }>("session.start", { ...base, prompt: "场景A 首轮", model: "mock-1" });
    const sidA = sA.id;
    await waitForEvent("permission.requested", markA);
    const beforeA = (await listSessions()).length;
    const rowA = (await listSessions()).find((s) => s.id === sidA);
    // 前置事实：这个会话是活的，但 cli_ref 还没落盘（首轮没跑完）
    check("场景A 前置：会话 live", rowA?.live === true, rowA);
    check("场景A 前置：尚不可续接（cli_ref 未落盘）", rowA?.resumable !== true, rowA);

    const autoA = await scheduleSendTo(base, "场景A 定时发送", "场景A 的定时消息", sidA);
    check("场景A automation.create 接受 existing_session", typeof autoA.id === "number" && (autoA.nextRunAt ?? 0) > Date.now(), autoA);
    const runsA = await waitRunFired(autoA.id);
    check("场景A 到点发火", runsA.length > 0, runsA);
    check("场景A 运行记录指向目标对话（没有降级另开会话）", runsA[0]?.sessionId === sidA, { got: runsA[0]?.sessionId, want: sidA });
    const afterA = (await listSessions()).length;
    check("场景A 没有新建会话", afterA === beforeA, { beforeA, afterA });
    // 对话正忙 → 消息进 steer 队列（不报错、不丢）
    const queuedA = events.slice(markA).some((e) => e["type"] === "steer.queued" && e["sessionId"] === sidA);
    check("场景A 忙时进 steer 队列", queuedA, events.slice(markA).map((e) => String(e["type"])));

    // ---- 场景 B：目标对话已结束，但有 cli_ref（可 reattach）----
    console.log("\n--- 场景 B：已结束但可续接的对话 ---");
    const markB = events.length;
    const sB = await call<{ id: string }>("session.start", { ...base, prompt: "场景B 首轮", model: "mock-1" });
    const sidB = sB.id;
    await waitForEvent("permission.requested", markB);
    await resolvePendingPermission(sidB);
    await sleep(1500);
    const rowB = (await listSessions()).find((s) => s.id === sidB);
    check("场景B 前置：对话已结束", rowB?.endedAt != null, rowB);
    check("场景B 前置：可续接（cli_ref 已落盘）", rowB?.resumable === true, rowB);

    const beforeB = (await listSessions()).length;
    const autoB = await scheduleSendTo(base, "场景B 定时发送", "场景B 的定时消息", sidB);
    const runsB = await waitRunFired(autoB.id);
    check("场景B 到点发火", runsB.length > 0, runsB);
    check("场景B 运行记录指向目标对话", runsB[0]?.sessionId === sidB, { got: runsB[0]?.sessionId, want: sidB });
    const msgsB = await call<Array<{ role: string; text: string }>>("session.messages", { sessionId: sidB });
    check("场景B 消息落进目标对话", msgsB.some((m) => m.role === "user" && m.text.includes("场景B 的定时消息")), msgsB.map((m) => m.text));
    const afterB = (await listSessions()).length;
    check("场景B 没有新建会话", afterB === beforeB, { beforeB, afterB });

    // ---- 场景 C：目标对话跑完一轮、agent 空闲（live + 有 cli_ref）----
    console.log("\n--- 场景 C：对话空闲时定时发送 ---");
    const markC = events.length;
    const sC = await call<{ id: string }>("session.start", { ...base, prompt: "场景C 首轮", model: "mock-1" });
    const sidC = sC.id;
    await waitForEvent("permission.requested", markC);
    await resolvePendingPermission(sidC);
    await sleep(1500);
    await call("session.resume", { sessionId: sidC });   // 接回来 → live
    await sleep(500);
    const rowC = (await listSessions()).find((s) => s.id === sidC);
    check("场景C 前置：对话 live 且可续接", rowC?.live === true && rowC?.resumable === true, rowC);

    const beforeC = (await listSessions()).length;
    const autoC = await scheduleSendTo(base, "场景C 定时发送", "场景C 的定时消息", sidC);
    const runsC = await waitRunFired(autoC.id);
    check("场景C 到点发火", runsC.length > 0, runsC);
    check("场景C 运行记录指向目标对话", runsC[0]?.sessionId === sidC, { got: runsC[0]?.sessionId, want: sidC });
    const msgsC = await call<Array<{ role: string; text: string }>>("session.messages", { sessionId: sidC });
    check("场景C 消息落进目标对话", msgsC.some((m) => m.role === "user" && m.text.includes("场景C 的定时消息")), msgsC.map((m) => m.text));
    const afterC = (await listSessions()).length;
    check("场景C 没有新建会话", afterC === beforeC, { beforeC, afterC });

    console.log(`\nsmoke-schedule-send: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
  } finally {
    await stopDaemon();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("smoke-schedule-send crashed:", err);
  process.exit(2);
});
