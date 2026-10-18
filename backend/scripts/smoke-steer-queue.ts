/**
 * steer 待发送队列冒烟（进程内 host，不起 WS daemon）—— 守住这些性质：
 *
 * 1. 轮进行中 sendMessage → 入队（steer.queued 带 id + steer.queue 快照），
 *    session.list 行带 steerQueue/steerPaused
 * 2. 轮落定 → 队首自动出队（steer.boundary 带同一条 id）→ 新一轮 turn.started
 * 3. removeQueuedSend：队列里删掉、快照更新；删不存在的 id → unknown_steer_item
 * 4. cancelSession 且队列非空 → 队列暂停（快照 paused=true，不自动连发）
 * 5. resumeQueue → 恢复出队，队首发出
 * 6. sendQueuedNow：提到队首 + 取消当前轮 → 轮落定后优先进去
 * 7. session.ended 且队列非空 → steer.undelivered + 清空
 *
 * 用法：cd backend && pnpm smoke:steer-queue
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeHost } from "../src/runtime/host.ts";
import { Store } from "../src/store/db.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import type { ExecutorAdapter, AdapterSession, AdapterSink, StartRequest } from "../src/runtime/adapters/types.ts";
import type { ProbeResult, RuntimeCapabilities, RuntimeEvent, SessionId } from "../src/contract.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300));
  }
}

/**
 * 脚本化假执行器：send() 挂住直到测试调 release()，模拟长轮；
 * release() 以 session.status:idle 落定（zcode/claude 家的口径，steer 可续）。
 * kill() 则以 session.ended 收口（测未投递）。
 */
function makeSteerMock() {
  let sinkRef: AdapterSink | null = null;
  let sessionId: SessionId | null = null;
  let releaseTurn: (() => void) | null = null;
  const sentTexts: string[] = [];
  const adapter: ExecutorAdapter = {
    id: "steermock",
    displayName: "SteerMock",
    glyph: "S",
    models: [{ id: asModelId("mock-1"), displayName: "Mock-1" }],
    capabilities: {
      resumeSession: false, fileDiff: false, terminal: false, permissions: false,
      subagents: false, worktrees: false, sandbox: false, mcp: false, usage: true,
      multimodal: false, streaming: "realtime", steering: "turn-end",
    } as RuntimeCapabilities,
    async probe(): Promise<ProbeResult> {
      return { state: { status: "ready", version: "1" }, capabilities: adapter.capabilities, elapsedMs: 0 };
    },
    async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
      sinkRef = sink;
      sessionId = asSessionId(`sess-steer-${Date.now()}`) as SessionId;
      sentTexts.push(req.prompt);
      return makeSession();
    },
    reattach(): AdapterSession {
      return makeSession();
    },
    async disconnect(): Promise<void> {},
  };
  function makeSession(): AdapterSession {
    return {
      id: sessionId ?? asSessionId("sess-steer"),
      send: (text: string) => {
        sentTexts.push(text);
        sinkRef?.({ type: "tool.started", sessionId: sessionId!, callId: `c${sentTexts.length}`, toolName: "t", title: "t", input: {} });
        return new Promise<void>((resolve) => {
          releaseTurn = () => {
            sinkRef?.({ type: "message.completed", sessionId: sessionId!, messageId: `m${sentTexts.length}`, text: `ok: ${text}` });
            sinkRef?.({ type: "usage", sessionId: sessionId!, inputTokens: 10, outputTokens: 5, costUsd: 0, model: "mock-1" });
            sinkRef?.({ type: "session.status", sessionId: sessionId!, status: "idle" });
            resolve();
          };
        });
      },
      cancel: async () => {
        // 模拟真 CLI：cancel 后轮也落定（idle 口径）
        releaseTurn?.();
      },
      resolvePermission: async () => {},
      externalRef: () => `steermock:${sessionId}`,
    };
  }
  return {
    adapter,
    release: () => releaseTurn?.(),
    kill: () => {
      sinkRef?.({ type: "session.ended", sessionId: sessionId!, reason: "executor_exited" });
    },
    sentTexts,
  };
}

const home = mkdtempSync(path.join(os.tmpdir(), "awb-steer-"));
const store = new Store(home);
const mock = makeSteerMock();
const events: RuntimeEvent[] = [];
const host = new RuntimeHost(
  (event) => events.push(event),
  new TraceSink(home),
  home,
  store,
  new PermissionGate(store),
);
host.register(mock.adapter);

const snap = (type: string) => events.filter((e) => e.type === type).at(-1);
const queueSnapshot = () => snap("steer.queue") as Extract<RuntimeEvent, { type: "steer.queue" }> | undefined;

// ---- 1. 轮进行中发送 → 入队（快照 + 行快照）----
const session = await host.startSession({
  runtimeId: "steermock",
  unitId: asUnitId("u1"),
  unitName: "steer-smoke",
  rootPath: home,
  prompt: "第一轮",
  model: null,
});
check("首轮 turn.started", events.some((e) => e.type === "turn.started"));

host.sendMessage(session.id, "插话A");
host.sendMessage(session.id, "插话B");
const q1 = queueSnapshot();
check("两条都入队（快照 items）", q1 !== undefined && q1.items.length === 2 && q1.items[0]!.text === "插话A" && q1.items[1]!.text === "插话B", q1);
check("steer.queued 带 id", (snap("steer.queued") as { id?: string } | undefined)?.id === q1?.items[1]?.id);
const listed1 = host.listSessions().find((s) => s.id === session.id);
check("session.list 行带队列快照", listed1 !== undefined && (listed1.steerQueue?.length ?? 0) === 2 && listed1.steerPaused === false, listed1?.steerQueue);

// ---- 2. removeQueuedSend：删队尾那条 ----
const idB = q1!.items[1]!.id;
const { removed } = host.removeQueuedSend(session.id, idB);
check("remove 返回被删 id", removed === idB);
check("删后快照只剩插话A", queueSnapshot()?.items.length === 1 && queueSnapshot()?.items[0]?.text === "插话A");
let threw = false;
try {
  host.removeQueuedSend(session.id, "q999");
} catch (err: unknown) {
  threw = (err as { code?: string }).code === "unknown_steer_item";
}
check("删不存在的 id → unknown_steer_item", threw);

// ---- 3. 轮落定 → 队首自动出队 ----
mock.release();
await new Promise((r) => setTimeout(r, 50));
const boundary = snap("steer.boundary") as Extract<RuntimeEvent, { type: "steer.boundary" }> | undefined;
check("boundary 带被注入条目的 id", boundary !== undefined && boundary.id === q1?.items[0]?.id && boundary.text === "插话A", boundary);
check("出队后进入第二轮（turn.started × 2）", events.filter((e) => e.type === "turn.started").length === 2);
check("插话A 真发到了执行器", mock.sentTexts.includes("插话A"));
check("队列已空（快照）", queueSnapshot()?.items.length === 0);

// ---- 4. 再入队一条 → cancel → 队列暂停（不自动连发）----
host.sendMessage(session.id, "插话C");
await host.cancelSession(session.id);
await new Promise((r) => setTimeout(r, 50));
const q4 = queueSnapshot();
check("取消后队列暂停（paused=true 且未出队）", q4 !== undefined && q4.paused === true && q4.items.length === 1 && q4.items[0]!.text === "插话C", q4);
check("暂停时没有新的 boundary", events.filter((e) => e.type === "steer.boundary").length === 1);
check("session.list 行 steerPaused=true", host.listSessions().find((s) => s.id === session.id)?.steerPaused === true);

// ---- 5. 暂停中发新消息 → 排队尾并恢复出队（FIFO）----
host.sendMessage(session.id, "插话D");
await new Promise((r) => setTimeout(r, 50));
check("恢复后队首（插话C）先出队", mock.sentTexts.at(-1) === "插话C");
check("插话D 仍在队列等下一轮", queueSnapshot()?.items.length === 1 && queueSnapshot()?.items[0]?.text === "插话D");

// ---- 6. sendQueuedNow：提到队首 + 取消当前轮 → 优先进去 ----
const idD = queueSnapshot()!.items[0]!.id;
await host.sendQueuedNow(session.id, idD);
await new Promise((r) => setTimeout(r, 50));
check("立刻发送后插话D已出队发出", mock.sentTexts.at(-1) === "插话D");
check("队列清空", queueSnapshot()?.items.length === 0);

// ---- 7. 会话终局 + 队列非空 → steer.undelivered ----
host.sendMessage(session.id, "插话E");
mock.kill();
await new Promise((r) => setTimeout(r, 50));
const undelivered = snap("steer.undelivered") as Extract<RuntimeEvent, { type: "steer.undelivered" }> | undefined;
check("终局宣告未投递", undelivered !== undefined && undelivered.inputs.includes("插话E"), undelivered);
check("终局后队列清空", queueSnapshot()?.items.length === 0);

console.log(failures === 0 ? "\nsmoke:steer-queue 全绿" : `\nsmoke:steer-queue 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
