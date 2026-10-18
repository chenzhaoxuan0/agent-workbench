/**
 * ADR 0013 对话分叉冒烟 —— fork 三列落库 / HANDOFF seq 上界 / 锚点校验 / 回放隔离 / 跨重启。
 *
 *   mockperm 跑完源段第一轮（含权限放行）
 *   → branch 分叉（anchor=user-1，through 语义）：sessions 行三列正确；
 *     dispatch 快照的 HANDOFF 只含截至 fork_at_seq 的前缀（含锚点轮的回复）
 *   → revision 分叉（before 语义）：fork_at_seq < branch 的；锚点轮不在前缀里
 *   → 坏锚点 / 坏 kind → 报错（bad_params / unknown_anchor）
 *   → fork 段回放只含本段事件
 *   → daemon 重启后三列仍在（迁移 + 持久化）
 *
 * 用法：cd backend && pnpm smoke:fork
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
      srv.close(() => resolve(addr !== null && typeof addr === "object" ? addr.port : 0));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

interface Frame {
  v?: number;
  type?: string;
  seq?: number;
  event?: { type?: string; requestId?: string };
  id?: string | null;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

function makeClient(port: number): {
  events: Array<{ seq?: number; type?: string; requestId?: string }>;
  call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  open: () => Promise<void>;
  close: () => void;
} {
  const events: Array<{ seq?: number; type?: string; requestId?: string }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let seqCounter = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (ev) => {
    let f: Frame;
    try {
      f = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (f.type === "event" && f.event?.type) {
      events.push({ seq: f.seq, type: f.event.type, requestId: f.event.requestId });
      return;
    }
    if (typeof f.id === "string") {
      const p = pending.get(f.id);
      if (!p) return;
      pending.delete(f.id);
      if (f.ok === true) p.resolve(f.result);
      else p.reject(new Error(f.error?.message ?? "rpc failed"));
    }
  });
  return {
    events,
    open: () =>
      new Promise<void>((res, rej) => {
        socket.addEventListener("open", () => res(), { once: true });
        socket.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      }),
    call: <T,>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = `c-${++seqCounter}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v as T); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        socket.send(JSON.stringify({ v: 1, id, method, params }));
      }),
    close: () => socket.close(),
  };
}

async function startDaemon(port: number, home: string): Promise<ChildProcess> {
  const daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
      return daemon;
    } catch {
      await sleep(400);
    }
  }
  throw new Error("daemon did not come up");
}

async function stopDaemon(port: number): Promise<void> {
  try {
    const stopper = makeClient(port);
    await stopper.open();
    await stopper.call("daemon.stop", null, 5000).catch(() => {});
    stopper.close();
  } catch {
    // 程序化退出失败则由调用方 kill
  }
  await sleep(800);
}

interface TraceRec {
  seq: number;
  event: { type?: string; requestId?: string; text?: string; messageId?: string; role?: string };
}

async function readTrace(c: ReturnType<typeof makeClient>, sessionId: string): Promise<TraceRec[]> {
  const nd = await c.call<string>("session.trace", { sessionId });
  return nd
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as TraceRec);
}

/** 放行 mockperm 的挂起权限并等轮落定（session.ended 入账本）。账本落盘是
 *  fire-and-forget，权限请求与轮终态都要轮询等出现（不赌时序）。 */
async function settleTurn(c: ReturnType<typeof makeClient>, sessionId: string): Promise<void> {
  let req: string | undefined;
  for (let i = 0; i < 25 && req === undefined; i++) {
    const recs = await readTrace(c, sessionId);
    req = recs.filter((r) => r.event.type === "permission.requested").at(-1)?.event.requestId;
    if (req === undefined) await sleep(300);
  }
  if (typeof req !== "string") throw new Error("no pending permission found");
  await c.call("permission.resolve", { sessionId, requestId: req, decision: "allow" });
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const recs = await readTrace(c, sessionId);
    if (recs.some((r) => r.event.type === "turn.completed") && recs.some((r) => r.event.type === "session.ended")) return;
  }
  throw new Error("turn did not settle in time");
}

interface SessionRowRpc {
  id: string;
  forkOf?: string | null;
  forkAtSeq?: number | null;
  forkKind?: string | null;
}

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), "awb-fork-"));
const daemon = await startDaemon(port, home);

try {
  const c = makeClient(port);
  await c.open();

  // ---- 1. 源段：mockperm 一轮（权限放行 → turn.completed → ended） ----
  const seg1 = await c.call<{ id: string }>("session.start", {
    runtimeId: "mockperm",
    unitId: "u-fork",
    unitName: "fork-smoke",
    rootPath: backendRoot,
    prompt: "第一轮：打个招呼",
    model: "mock-1",
    mode: "build",
  });
  await settleTurn(c, seg1.id);
  const seg1Trace = await readTrace(c, seg1.id);
  check("源段账本含 user-1 与 turn.completed", seg1Trace.some((r) => r.event.type === "message.delta" && r.event.messageId === "user-1") && seg1Trace.some((r) => r.event.type === "turn.completed"));

  // ---- 2. branch 分叉（through：锚点=助手消息 id msg_1，UI 主入口「从回复处分叉」） ----
  const branch = await c.call<{ id: string }>("session.start", {
    runtimeId: "mockperm",
    unitId: "u-fork",
    unitName: "fork-smoke",
    rootPath: backendRoot,
    prompt: "分叉后的新方向",
    model: "mock-1",
    mode: "build",
    conversationId: seg1.id,
    fork: { ofSessionId: seg1.id, anchorMessageId: "msg_1", kind: "branch" },
  });
  const listed = await c.call<SessionRowRpc[]>("session.list", null);
  const branchRow = listed.find((s) => s.id === branch.id);
  check("branch 行三列落库", branchRow !== undefined && branchRow.forkOf === seg1.id && branchRow.forkKind === "branch" && typeof branchRow.forkAtSeq === "number" && (branchRow.forkAtSeq ?? 0) > 0, branchRow);
  const branchBound = branchRow?.forkAtSeq ?? 0;
  const turnCompletedSeq = seg1Trace.find((r) => r.event.type === "turn.completed")?.seq ?? -1;
  check("branch 上界 = 锚点轮 turn.completed 的 seq（through 语义）", branchBound === turnCompletedSeq, { branchBound, turnCompletedSeq });

  // ---- 2b. 用户消息锚点（user-N）同样支持（兼容路径，bound 应一致） ----
  const branchUserAnchor = await c.call<{ id: string }>("session.start", {
    runtimeId: "mockperm",
    unitId: "u-fork",
    unitName: "fork-smoke",
    rootPath: backendRoot,
    prompt: "用户锚点分叉",
    model: "mock-1",
    mode: "build",
    conversationId: seg1.id,
    fork: { ofSessionId: seg1.id, anchorMessageId: "user-1", kind: "branch" },
  });
  const listedUA = await c.call<SessionRowRpc[]>("session.list", null);
  const uaRow = listedUA.find((s) => s.id === branchUserAnchor.id);
  check("user 锚点 branch 与 assistant 锚点 bound 一致", uaRow?.forkAtSeq === branchBound, uaRow);

  // ---- 3. HANDOFF 快照只含 seq ≤ fork_at_seq 的前缀（含锚点轮回复） ----
  await settleTurn(c, branch.id);
  const db = new DatabaseSync(path.join(home, "state.db"), { open: true, readOnly: true });
  const dispatchRow = db
    .prepare(`SELECT injected_block AS b FROM dispatches WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(branch.id) as { b: string | null } | undefined;
  db.close();
  const block = dispatchRow?.b ?? "";
  check("branch dispatch 快照存在", dispatchRow !== undefined);
  check("branch HANDOFF 带定界标记", block.includes("上文交接"));
  check("branch HANDOFF 含锚点轮用户原话", block.includes("第一轮：打个招呼"));
  check("branch HANDOFF 含锚点轮助手回复（through）", block.includes("mock ok (allow)"));

  // ---- 4. revision 分叉（before：锚点轮之前 = 空前缀） ----
  const rev = await c.call<{ id: string }>("session.start", {
    runtimeId: "mockperm",
    unitId: "u-fork",
    unitName: "fork-smoke",
    rootPath: backendRoot,
    prompt: "改写第一轮重发",
    model: "mock-1",
    mode: "build",
    conversationId: seg1.id,
    fork: { ofSessionId: seg1.id, anchorMessageId: "user-1", kind: "revision" },
  });
  const listed2 = await c.call<SessionRowRpc[]>("session.list", null);
  const revRow = listed2.find((s) => s.id === rev.id);
  check("revision 行三列落库", revRow !== undefined && revRow.forkOf === seg1.id && revRow.forkKind === "revision" && typeof revRow.forkAtSeq === "number", revRow);
  check("revision 上界 < branch 上界（before 早于 through）", (revRow?.forkAtSeq ?? -1) < branchBound, { rev: revRow?.forkAtSeq, branchBound });
  await settleTurn(c, rev.id);
  const db2 = new DatabaseSync(path.join(home, "state.db"), { open: true, readOnly: true });
  const revDispatch = db2
    .prepare(`SELECT injected_block AS b FROM dispatches WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(rev.id) as { b: string | null } | undefined;
  db2.close();
  check("revision HANDOFF 不含锚点轮内容（before = 空前缀）", (revDispatch?.b ?? "") === "" || !((revDispatch?.b ?? "").includes("第一轮") || (revDispatch?.b ?? "").includes("mock ok")), revDispatch?.b?.slice(0, 120));

  // ---- 5. 校验拒绝：坏锚点 / 坏 kind ----
  let badAnchorMsg = "";
  try {
    await c.call("session.start", {
      runtimeId: "mockperm", unitId: "u-fork", unitName: "fork-smoke", rootPath: backendRoot,
      prompt: "x", model: "mock-1", mode: "build",
      fork: { ofSessionId: seg1.id, anchorMessageId: "user-99", kind: "branch" },
    });
  } catch (e) {
    badAnchorMsg = e instanceof Error ? e.message : String(e);
  }
  check("坏锚点被拒（unknown_anchor）", badAnchorMsg.includes("anchor not found"), badAnchorMsg);

  let badKindMsg = "";
  try {
    await c.call("session.start", {
      runtimeId: "mockperm", unitId: "u-fork", unitName: "fork-smoke", rootPath: backendRoot,
      prompt: "x", model: "mock-1", mode: "build",
      fork: { ofSessionId: seg1.id, anchorMessageId: "user-1", kind: "weird" },
    });
  } catch (e) {
    badKindMsg = e instanceof Error ? e.message : String(e);
  }
  check("坏 kind 被拒（bad_params）", badKindMsg.includes("fork requires"), badKindMsg);

  // ---- 6. fork 段回放只含本段事件（读取端拼接由前端负责，这里守边界） ----
  const branchReplay = await c.call<Array<{ seq: number; event: { type?: string; text?: string; messageId?: string; role?: string } }>>(
    "session.events.since",
    { sessionId: branch.id, afterSeq: 0 },
  );
  check("branch 回放不含父段消息", branchReplay.every((r) => !(r.event.type === "message.delta" && r.event.role === "user" && (r.event.text ?? "").includes("第一轮"))));
  check("branch 回放含本段首条用户消息", branchReplay.some((r) => r.event.type === "message.delta" && r.event.role === "user" && (r.event.text ?? "").includes("分叉后的新方向")));

  c.close();

  // ---- 7. daemon 重启（同 HOME）：三列与迁移跨代成立 ----
  await stopDaemon(port);
  daemon.kill();
  const port2 = await freePort();
  const daemon2 = await startDaemon(port2, home);
  try {
    const c2 = makeClient(port2);
    await c2.open();
    const after = await c2.call<SessionRowRpc[]>("session.list", null);
    const branchAfter = after.find((s) => s.id === branch.id);
    const revAfter = after.find((s) => s.id === rev.id);
    check("重启后 branch 三列仍在", branchAfter !== undefined && branchAfter.forkOf === seg1.id && branchAfter.forkKind === "branch" && branchAfter.forkAtSeq === branchBound, branchAfter);
    check("重启后 revision 三列仍在", revAfter !== undefined && revAfter.forkKind === "revision", revAfter);
    c2.close();
  } finally {
    await stopDaemon(port2);
    daemon2.kill();
  }
} finally {
  await stopDaemon(port).catch(() => {});
  daemon.kill();
}

console.log(failures === 0 ? "smoke-fork: all checks passed — fork 三列/HANDOFF 上界/锚点校验/回放隔离/跨重启成立" : `smoke-fork: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
