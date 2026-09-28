/**
 * RuntimeHost —— daemon 的执行器宿主与会话台账。
 *
 * 职责四件事：
 * 1. 注册表：执行器适配器的唯一登记处（模型清单非空硬要求在这里执行）；
 * 2. 会话台账：contract 的 Session 形态 + 累计 stats；启动时从 state.db 装载，
 *    存活会话（有 impl）覆盖死行 —— listSessions 跨重启成立；
 * 3. 事件出口：给每条 RuntimeEvent 盖 TraceRecord 章（seq/at/runtimeId），
 *    落轨迹文件并向 WS 广播 —— 适配器只管翻译，不管分发；
 * 4. 落盘（Phase 3）：会话行/消息进 state.db，usage 进 usage.jsonl，
 *    cli_ref 存执行器原生引用 —— resumeSession 靠它跨重启续命。
 */

import type { AdapterSession, ExecutorAdapter, StartRequest } from "./adapters/types.ts";
import { adapterError } from "./adapters/types.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeEvent,
  RuntimeId,
  Session,
  SessionId,
  SessionStatus,
  UnitId,
} from "../contract.ts";
import { log } from "../log.ts";
import type { TraceSink } from "./trace.ts";
import type { Store } from "../store/db.ts";
import { appendJournal } from "../store/journals.ts";

/** 对 WS 暴露的适配器摘要 */
export interface AdapterInfo {
  readonly id: string;
  readonly displayName: string;
  readonly glyph: string;
  readonly models: readonly { id: ModelId; displayName: string }[];
  readonly capabilities: ExecutorAdapter["capabilities"];
}

interface HostSession {
  readonly id: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: RuntimeId;
  title: string;
  status: SessionStatus;
  readonly startedAt: number;
  endedAt: number | undefined;
  stats: {
    messages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
  };
  seq: number;
  /** null = 从盘装载的死会话，resume 后才活 */
  impl: AdapterSession | null;
  readonly adapter: ExecutorAdapter;
}

export interface StartSessionInput {
  readonly runtimeId: string;
  readonly unitId: UnitId;
  readonly unitName: string;
  readonly rootPath: string;
  readonly prompt: string;
  readonly model: ModelId | null;
  readonly mode?: StartRequest["mode"];
}

export class RuntimeHost {
  private readonly adapters = new Map<string, ExecutorAdapter>();
  private readonly sessions = new Map<SessionId, HostSession>();

  constructor(
    private readonly broadcast: (event: RuntimeEvent) => void,
    private readonly trace: TraceSink,
    private readonly homeDir: string,
    private readonly store: Store,
  ) {}

  /** 适配器全部注册完之后调用一次：把盘里的会话装进台账（跨重启 listSessions 成立） */
  loadPersisted(): void {
    for (const row of this.store.listSessions()) {
      if (this.sessions.has(row.id as SessionId)) continue;
      const adapter = this.adapters.get(row.runtimeId);
      if (adapter === undefined) continue;
      this.sessions.set(row.id as SessionId, {
        id: row.id as SessionId,
        unitId: row.unitId as UnitId,
        runtimeId: row.runtimeId as RuntimeId,
        title: row.title,
        status: row.status as SessionStatus,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? undefined,
        stats: { ...row.stats },
        seq: 0,
        impl: null,
        adapter,
      });
    }
    if (this.sessions.size > 0) log.info("sessions loaded from store", { count: this.sessions.size });
  }

  /** 注册执行器。重复 id 与空模型清单都是编程错误，注册即拒（契约原文）。 */
  register(adapter: ExecutorAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`adapter already registered: ${adapter.id}`);
    if (adapter.models.length === 0) throw new Error(`adapter ${adapter.id} declares no models (contract hard requirement)`);
    this.adapters.set(adapter.id, adapter);
    log.info("adapter registered", { id: adapter.id, models: adapter.models.length });
  }

  listAdapters(): AdapterInfo[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      displayName: a.displayName,
      glyph: a.glyph,
      models: [...a.models],
      capabilities: a.capabilities,
    }));
  }

  getAdapter(runtimeId: string): ExecutorAdapter {
    const a = this.adapters.get(runtimeId);
    if (a === undefined) throw adapterError("unknown_runtime", `no such executor: ${runtimeId}`);
    return a;
  }

  probe(runtimeId: string): Promise<ProbeResult> {
    return this.getAdapter(runtimeId).probe();
  }

  private toSession(h: HostSession): Session {
    return {
      id: h.id,
      unitId: h.unitId,
      runtimeId: h.runtimeId,
      title: h.title,
      status: h.status,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      ephemeral: false,
      stats: { ...h.stats },
    };
  }

  listSessions(): Session[] {
    return [...this.sessions.values()]
      .map((h) => this.toSession(h))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  sessionMessages(sessionId: SessionId): Array<{ at: number; role: string; text: string }> {
    if (!this.sessions.has(sessionId)) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    return this.store.listMessages(sessionId);
  }

  async startSession(input: StartSessionInput): Promise<Session> {
    const adapter = this.getAdapter(input.runtimeId);

    const sink = (event: RuntimeEvent): void => {
      const h = this.sessions.get(event.sessionId);
      if (h === undefined) return;
      this.track(h, event);
      this.persistOnEvent(h, event, input.prompt);
      void this.trace.append({
        seq: ++h.seq,
        at: Date.now(),
        sessionId: h.id,
        unitId: h.unitId,
        runtimeId: h.runtimeId,
        event,
      }).catch((err: unknown) => log.warn("trace append failed", { error: err instanceof Error ? err.message : String(err) }));
      this.broadcast(event);
    };

    const impl = await adapter.start(
      {
        unitId: input.unitId,
        unitName: input.unitName,
        rootPath: input.rootPath,
        prompt: input.prompt,
        model: input.model,
        mode: input.mode,
      },
      sink,
    );

    const h: HostSession = {
      id: impl.id,
      unitId: input.unitId,
      runtimeId: adapter.id as RuntimeId,
      title: input.prompt.length > 60 ? input.prompt.slice(0, 60) + "…" : input.prompt,
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      stats: { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      seq: 0,
      impl,
      adapter,
    };
    this.sessions.set(h.id, h);

    this.store.upsertSession({
      id: h.id,
      unitId: h.unitId,
      runtimeId: h.runtimeId,
      title: h.title,
      status: h.status,
      startedAt: h.startedAt,
      endedAt: null,
      cliRef: null,
      stats: { ...h.stats },
    });
    this.store.insertMessage(h.id, Date.now(), "user", input.prompt);

    const started: RuntimeEvent = { type: "session.started", sessionId: h.id, unitId: h.unitId };
    void this.trace.append({ seq: ++h.seq, at: Date.now(), sessionId: h.id, unitId: h.unitId, runtimeId: h.runtimeId, event: started })
      .catch(() => {});
    this.broadcast(started);

    // 首轮 prompt
    await impl.send(input.prompt);
    log.info("session started", { sessionId: h.id, runtimeId: adapter.id, unitId: h.unitId });
    return this.toSession(h);
  }

  /** 事件驱动的持久化钩子：assistant 消息 / usage 账本 / 终态与会话引用 */
  private persistOnEvent(h: HostSession, event: RuntimeEvent, firstPrompt: string): void {
    try {
      switch (event.type) {
        case "message.completed": {
          this.store.insertMessage(h.id, Date.now(), "assistant", event.text);
          break;
        }
        case "usage": {
          void appendJournal(this.homeDir, "usage.jsonl", {
            at: Date.now(),
            sessionId: h.id,
            unitId: h.unitId,
            runtimeId: h.runtimeId,
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? null,
            cacheWriteTokens: event.cacheWriteTokens ?? null,
            costUsd: event.costUsd,
            decodeMs: event.decodeMs ?? null,
          }).catch(() => {});
          break;
        }
        case "session.ended": {
          this.store.setSessionStatus(h.id, h.status, h.endedAt ?? Date.now(), { ...h.stats });
          const ref = h.impl?.externalRef();
          if (ref !== null && ref !== undefined) this.store.setSessionCliRef(h.id, ref);
          break;
        }
        default:
          break;
      }
      void firstPrompt;
    } catch (err: unknown) {
      log.warn("persist failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 把翻译好的事件记进台账（stats 与状态机都在这一处，适配器不用管） */
  private track(h: HostSession, event: RuntimeEvent): void {
    switch (event.type) {
      case "message.completed":
        h.stats.messages += 1;
        h.status = "running";
        break;
      case "tool.completed":
        h.stats.toolCalls += 1;
        break;
      case "usage":
        h.stats.inputTokens += event.inputTokens;
        h.stats.outputTokens += event.outputTokens;
        h.stats.costUsd += event.costUsd;
        break;
      case "permission.requested":
        h.status = "awaiting_permission";
        break;
      case "permission.resolved":
        h.status = "running";
        break;
      case "session.ended":
        h.endedAt = Date.now();
        h.stats.durationMs = h.endedAt - h.startedAt;
        h.status = event.reason === "error" || event.reason.endsWith("_error") || event.reason === "executor_exited"
          ? "failed"
          : "done";
        break;
      default:
        break;
    }
  }

  async sendMessage(sessionId: SessionId, text: string): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is persisted but not live — resume it first`);
    h.status = "running";
    this.broadcast({ type: "session.status", sessionId, status: "running" });
    this.store.insertMessage(sessionId, Date.now(), "user", text);
    await h.impl.send(text);
  }

  /** Phase 3：把盘里的会话接回执行器（cli_ref 续命），之后 send/cancel 照常 */
  resumeSession(sessionId: SessionId): Session {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl !== null) return this.toSession(h); // 活着的不用 resume
    const row = this.store.getSession(sessionId);
    if (row === undefined) throw adapterError("unknown_session", `session not in store: ${sessionId}`);
    if (row.cliRef === null) throw adapterError("no_cli_ref", `session ${sessionId} has no executor reference to resume`);
    const sink = this.makeSink(h);
    h.impl = h.adapter.reattach(sessionId, row.cliRef, sink);
    h.status = "idle";
    this.store.setSessionStatus(sessionId, "idle", h.endedAt ?? null, { ...h.stats });
    log.info("session resumed", { sessionId, runtimeId: h.runtimeId, cliRef: row.cliRef });
    return this.toSession(h);
  }

  /** sink 工厂：resume 与 start 共用同一套盖章/落盘/广播路径 */
  private makeSink(h: HostSession): (event: RuntimeEvent) => void {
    return (event: RuntimeEvent): void => {
      const cur = this.sessions.get(event.sessionId);
      if (cur === undefined) return;
      this.track(cur, event);
      this.persistOnEvent(cur, event, "");
      void this.trace.append({
        seq: ++cur.seq,
        at: Date.now(),
        sessionId: cur.id,
        unitId: cur.unitId,
        runtimeId: cur.runtimeId,
        event,
      }).catch(() => {});
      this.broadcast(event);
    };
  }

  async cancelSession(sessionId: SessionId): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is not live`);
    await h.impl.cancel();
  }

  async resolvePermission(sessionId: SessionId, requestId: string, decision: "allow" | "deny" | "always"): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is not live`);
    await h.impl.resolvePermission(requestId, decision);
  }

  async shutdown(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.disconnect().catch((err: unknown) => log.warn("adapter disconnect failed", {
        adapter: adapter.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    this.store.close();
  }
}
