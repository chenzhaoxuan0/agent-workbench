/**
 * mockperm 适配器 —— 权限闸与审批流的真实试金石。
 *
 * 两家真执行器目前都没有反向权限流（capabilities.permissions=false，
 * zcode 是 -p yolo、codex 是 exec never），闸的「挂起 → 决策 → 放行 →
 * always 落规则 → 下次自动放行」需要一个会真的挂起的执行器来验收。
 * 本适配器每轮必发一次 permission.requested 并挂到被决策为止 ——
 * 与前端 adapters/mock 同一语义家族（原型期 fixtures 的服务端对应物）。
 */

import { randomUUID } from "node:crypto";
import { log } from "../../log.ts";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";

interface MockSession {
  readonly sessionId: SessionId;
  sink: AdapterSink | null;
  /** 挂起中的权限：requestId → resolve */
  readonly pending: Map<string, (decision: "allow" | "deny" | "always") => void>;
  turnCount: number;
}

export class MockPermAdapter implements ExecutorAdapter {
  readonly id = "mockperm";
  readonly displayName = "MockPerm";
  readonly glyph = "M";
  readonly models: readonly ExecutorModelInfo[] = [{ id: "mock-1" as ModelId, displayName: "Mock-1" }];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: false,
    fileDiff: false,
    terminal: false,
    permissions: true, // 本适配器存在的意义
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: false,
    usage: true,
    multimodal: false,
    streaming: "realtime", // 定时器逐条推事件，是名副其实的实时
    steering: "turn-end", // host pendingSends：轮落定后随下一轮发出
  };

  private readonly sessions = new Map<string, MockSession>();

  async probe(): Promise<ProbeResult> {
    return { state: { status: "ready", version: "mock-1" }, capabilities: this.capabilities, elapsedMs: 0 };
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: MockSession = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      sink,
      pending: new Map(),
      turnCount: 0,
    };
    this.sessions.set(state.sessionId, state);
    return this.makeSession(state);
  }

  reattach(sessionId: SessionId, _ref: string, _rootPath: string, sink: AdapterSink): AdapterSession {
    const state: MockSession = { sessionId, sink, pending: new Map(), turnCount: 0 };
    this.sessions.set(sessionId, state);
    return this.makeSession(state);
  }

  async disconnect(): Promise<void> {
    this.sessions.clear();
  }

  private makeSession(state: MockSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {
        for (const resolve of state.pending.values()) resolve("deny");
        state.pending.clear();
      },
      resolvePermission: async (requestId, decision) => {
        const resolve = state.pending.get(requestId);
        if (resolve === undefined) {
          log.warn("mockperm resolvePermission for unknown requestId", { requestId, decision });
          return;
        }
        state.pending.delete(requestId);
        resolve(decision);
      },
      externalRef: () => `mock:${state.sessionId}`,
    };
  }

  /** 一轮 = 工具开始 → 权限挂起（等人/规则）→ 工具完成 → 消息 → 用量 → 结束 */
  private async runTurn(state: MockSession, text: string): Promise<void> {
    const sink = state.sink;
    if (sink === null) return;
    state.turnCount += 1;
    const sessionId = state.sessionId;
    const callId = `call_${state.turnCount}`;
    const requestId = `perm_${state.turnCount}`;

    sink({ type: "tool.started", sessionId, callId, toolName: "mock_tool", title: "mock tool", input: { text } });

    // 先注册 pending 再广播 requested —— 闸的自动放行是同步的，
    // 顺序反了会撞上「resolve 时 pending 还没注册」的竞态（冒烟实证）
    const decisionPromise = new Promise<"allow" | "deny" | "always">((resolve) => {
      state.pending.set(requestId, resolve);
    });
    sink({
      type: "permission.requested",
      sessionId,
      requestId,
      kind: "tool",
      risk: "medium",
      detail: `mock_tool for: ${text}`,
    });

    const decision = await decisionPromise;
    sink({ type: "permission.resolved", sessionId, requestId, decision });

    sink({ type: "tool.completed", sessionId, callId, ok: decision !== "deny", output: decision });
    sink({ type: "message.completed", sessionId, messageId: `msg_${state.turnCount}`, text: `mock ok (${decision}): ${text}` });
    sink({
      type: "usage",
      sessionId,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      model: "mock-1",
    });
    sink({ type: "session.ended", sessionId, reason: decision === "deny" ? "completed" : "completed" });
  }
}
