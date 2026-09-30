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
import { asSessionId } from "../../../prototype/src/core/units.ts";
import type { TraceSink } from "./trace.ts";
import type { Store } from "../store/db.ts";
import type { PermissionGate } from "../permissions/gate.ts";
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
  /** 最近一次 tool.started 的工具名 —— "always" 规则的 pattern 来源 */
  lastTool: string | null;
  /** 已落盘的执行器引用（去重，避免每事件重写） */
  lastCliRef: string | null;
  /** T3 steer 语义：turn 进行中到达的消息在此排队，轮落定后自动发出 */
  readonly pendingSends: Array<{ text: string; loop?: { readonly reasoningLevel?: string } }>;
  /** 当前是否有未落定的轮 */
  turnBusy: boolean;
  /** 会话事件环（上限 500，带 seq），eval 断言与前端重放共用 */
  readonly events: Array<{ seq: number; event: RuntimeEvent }>;
}

export interface StartSessionInput {
  readonly runtimeId: string;
  readonly unitId: UnitId;
  readonly unitName: string;
  readonly rootPath: string;
  readonly prompt: string;
  readonly model: ModelId | null;
  readonly mode?: StartRequest["mode"];
  readonly reasoningLevel?: string;
}

export class RuntimeHost {
  private readonly adapters = new Map<string, ExecutorAdapter>();
  private readonly sessions = new Map<SessionId, HostSession>();

  constructor(
    private readonly broadcast: (event: RuntimeEvent, seq: number) => void,
    private readonly trace: TraceSink,
    private readonly homeDir: string,
    private readonly store: Store,
    private readonly gate: PermissionGate,
  ) {}

  /** 挂起中的权限上下文（"always" 落规则时取 kind/detail 用） */
  private readonly pendingPerms = new Map<string, { kind: string; detail: string }>();

  /** 会话结束等待者（Ops 的 eval/arena 用它等轮次跑完） */
  private readonly endWaiters = new Map<SessionId, Array<{ type: string; resolve: () => void }>>();

  /** 等会话的下一条指定类型事件（已在事件环里则立即返回）—— turn 级完成等待用 "usage" */
  waitForSessionEvent(sessionId: SessionId, type: string, timeoutMs: number): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) return Promise.reject(adapterError("unknown_session", `no such session: ${sessionId}`));
    if (h.events.some((e) => e.event.type === type)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.eventWaiters.get(sessionId);
        const i = list?.indexOf(waiter) ?? -1;
        if (list !== undefined && i >= 0) list.splice(i, 1);
        reject(adapterError("event_wait_timeout", `session ${sessionId}: no ${type} within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = { type, resolve: () => { clearTimeout(timer); resolve(); } };
      const list = this.eventWaiters.get(sessionId) ?? [];
      list.push(waiter);
      this.eventWaiters.set(sessionId, list);
    });
  }

  private readonly eventWaiters = new Map<SessionId, Array<{ type: string; resolve: () => void }>>();

  /** 会话事件环读取（eval 断言用；上限 500 条） */
  sessionEvents(sessionId: SessionId): readonly RuntimeEvent[] {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    return h.events.map((e) => e.event);
  }

  /**
   * 断线补拉的热路径（WP-2）：返回环内 seq > afterSeq 的事件。
   * gap=true 表示请求的游标已滑出环外（环最老 seq > afterSeq+1 且客户端确有前情），
   * 调用方应回落到落盘账本（session.trace 的 afterSeq 路径）。
   */
  hotEventsSince(sessionId: SessionId, afterSeq: number): { items: Array<{ seq: number; event: RuntimeEvent }>; gap: boolean } {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    const items = h.events.filter((e) => e.seq > afterSeq);
    const oldest = h.events[0]?.seq ?? Number.POSITIVE_INFINITY;
    // afterSeq>0（客户端真有前情）且环里最老的事件仍比游标新 → 中段缺了
    const gap = afterSeq > 0 && h.events.length > 0 && oldest > afterSeq + 1;
    return { items, gap };
  }

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
        lastTool: null,
        lastCliRef: null,
        pendingSends: [],
        turnBusy: false,
        events: [],
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

    // 晚绑定 sink：adapter.start 需要一个 sink，而台账行要等 start 返回才知道 id。
    // 适配器契约保证 start() 期间不发事件（turn 由 send 驱动），这里只是双保险。
    let sinkRef: ((event: RuntimeEvent) => void) | null = null;
    const impl = await adapter.start(
      {
        unitId: input.unitId,
        unitName: input.unitName,
        rootPath: input.rootPath,
        prompt: input.prompt,
        model: input.model,
        mode: input.mode,
        reasoningLevel: input.reasoningLevel,
      },
      (event) => sinkRef?.(event),
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
      lastTool: null,
      lastCliRef: null,
      pendingSends: [],
      turnBusy: false,
      events: [],
    };
    this.sessions.set(h.id, h);
    sinkRef = this.makeSink(h);

    this.store.upsertSession({
      id: h.id,
      unitId: h.unitId,
      runtimeId: h.runtimeId,
      title: h.title,
      status: h.status,
      startedAt: h.startedAt,
      endedAt: null,
      cliRef: null,
      rootPath: input.rootPath,
      stats: { ...h.stats },
    });
    this.store.insertMessage(h.id, Date.now(), "user", input.prompt);

    const started: RuntimeEvent = { type: "session.started", sessionId: h.id, unitId: h.unitId };
    this.emitStamped(h, started);

    // 首轮 prompt：受理即返回，turn 进展全走事件流
    //（mockperm 这类会在权限处挂起整轮，await 会把 session.start 卡死——冒烟实证）
    h.turnBusy = true;
    void impl.send(input.prompt).catch((err: unknown) => {
      log.error("first turn failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      const errorEvent: RuntimeEvent = { type: "error", sessionId: h.id, message: err instanceof Error ? err.message : String(err), recoverable: false };
      this.emitStamped(h, errorEvent);
      this.emitStamped(h, { type: "session.ended", sessionId: h.id, reason: "error" });
      h.turnBusy = false;
      this.flushPendingSends(h);
    });
    log.info("session started", { sessionId: h.id, runtimeId: adapter.id, unitId: h.unitId });
    return this.toSession(h);
  }

  /** 事件驱动的持久化钩子：assistant 消息 / usage 账本 / 终态与会话引用 */
  private persistOnEvent(h: HostSession, event: RuntimeEvent): void {
    try {
      switch (event.type) {
        case "message.completed": {
          this.store.insertMessage(h.id, Date.now(), "assistant", event.text);
          this.syncCliRef(h);
          break;
        }
        case "tool.started": {
          h.lastTool = event.toolName;
          break;
        }
        case "usage": {
          this.syncCliRef(h);
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
            requestId: event.requestId ?? null,
          }).catch(() => {});
          break;
        }
        case "session.ended": {
          this.store.setSessionStatus(h.id, h.status, h.endedAt ?? Date.now(), { ...h.stats });
          this.syncCliRef(h);
          break;
        }
        case "permission.resolved": {
          this.pendingPerms.delete(`${h.id}:${event.requestId}`);
          break;
        }
        default:
          break;
      }
    } catch (err: unknown) {
      log.warn("persist failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 执行器引用落盘（agent loop 语义下 turn 不再结束会话，ref 在首个 turn 就同步） */
  private syncCliRef(h: HostSession): void {
    const ref = h.impl?.externalRef();
    if (ref === null || ref === undefined) return;
    if (h.lastCliRef === ref) return;
    h.lastCliRef = ref;
    this.store.setSessionCliRef(h.id, ref);
    // WP-10：引用变化即推事件（resume-token 事件化），客户端免轮询 externalRef
    this.emitStamped(h, { type: "session.ref", sessionId: h.id, ref });
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
      case "session.status":
        // agent loop 语义：turn 完成 → idle（会话仍开着），失败 → failed
        if (event.status === "idle" || event.status === "running") h.status = event.status;
        else if (event.status.startsWith("failed")) h.status = "failed";
        this.store.setSessionStatus(h.id, h.status, h.endedAt ?? null, { ...h.stats });
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

  /**
   * 发一条消息 —— T3 steer 语义：turn 进行中不报错，消息进会话级出站队列，
   * 当前轮落定（status idle/failed / ended）后自动发出。预算机制已按产品决定移除。
   */
  sendMessage(
    sessionId: SessionId,
    text: string,
    loop?: { readonly reasoningLevel?: string },
  ): void {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is persisted but not live — resume it first`);

    if (h.turnBusy) {
      if (h.pendingSends.length >= 10) {
        throw adapterError("send_queue_full", "该会话已有 10 条排队消息 —— 等当前轮完成再发");
      }
      h.pendingSends.push({ text, loop });
      log.info("message queued (turn in flight)", { sessionId, queueDepth: h.pendingSends.length });
      // WP-10：插话入队对客户端可见（steer.queued）
      this.emitStamped(h, { type: "steer.queued", sessionId, queueDepth: h.pendingSends.length });
      return;
    }

    this.dispatchSend(h, text, loop);
  }

  /** 实际发起一轮：置 turnBusy、写用户消息、fire-and-forget（结果走事件流） */
  private dispatchSend(
    h: HostSession,
    text: string,
    loop?: { readonly reasoningLevel?: string },
  ): void {
    h.turnBusy = true;
    h.status = "running";
    this.emitStamped(h, { type: "session.status", sessionId: h.id, status: "running" });
    this.store.insertMessage(h.id, Date.now(), "user", text);
    void h.impl!.send(text, loop === undefined ? undefined : { reasoningLevel: loop.reasoningLevel }).catch((err: unknown) => {
      log.error("turn failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      const errorEvent: RuntimeEvent = { type: "error", sessionId: h.id, message: err instanceof Error ? err.message : String(err), recoverable: false };
      this.emitStamped(h, errorEvent);
      this.emitStamped(h, { type: "session.ended", sessionId: h.id, reason: "error" });
      h.turnBusy = false;
      this.flushPendingSends(h);
    });
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
    h.impl = h.adapter.reattach(sessionId, row.cliRef, row.rootPath ?? "", sink);
    h.status = "idle";
    this.store.setSessionStatus(sessionId, "idle", h.endedAt ?? null, { ...h.stats });
    log.info("session resumed", { sessionId, runtimeId: h.runtimeId, cliRef: row.cliRef });
    return this.toSession(h);
  }

  /** sink 工厂：start 与 resume 共用同一套盖章/落盘/广播/闸路径 */
  private makeSink(h: HostSession): (event: RuntimeEvent) => void {
    return (event: RuntimeEvent): void => {
      const cur = this.sessions.get(event.sessionId);
      if (cur === undefined) return;
      this.emitStamped(cur, event);
      this.track(cur, event);
      this.persistOnEvent(cur, event);
      if (event.type === "permission.requested") this.evaluateGate(cur, event);
      // 轮落定（status idle/failed 或 ended）→ 清 turnBusy → 自动发出排队消息（T3 steer）
      if (
        (event.type === "session.status" && (event.status === "idle" || event.status.startsWith("failed"))) ||
        event.type === "session.ended"
      ) {
        cur.turnBusy = false;
        this.flushPendingSends(cur);
      }
      // 唤醒等这一类事件的等待者（usage = turn 级完成，Ops 用）
      const waiters = this.eventWaiters.get(cur.id);
      if (waiters !== undefined) {
        const hit = waiters.filter((w) => w.type === event.type);
        if (hit.length > 0) {
          this.eventWaiters.set(cur.id, waiters.filter((w) => w.type !== event.type));
          for (const w of hit) w.resolve();
        }
      }
      if (event.type === "session.ended") {
        const ends = this.endWaiters.get(cur.id);
        if (ends !== undefined) {
          this.endWaiters.delete(cur.id);
          for (const w of ends) w.resolve();
        }
      }
    };
  }

  /**
   * 统一出口（WP-2）：分配 seq → 事件环 → 落盘 → 广播。
   * WS 事件帧带 seq 的事实源在这里；host 自产的事件（started/ended/status）也走这里，
   * 顺带修掉旧实现里 error/ended 不落 trace 的不一致。
   */
  private emitStamped(h: HostSession, event: RuntimeEvent): void {
    const seq = ++h.seq;
    h.events.push({ seq, event });
    if (h.events.length > 500) h.events.splice(0, h.events.length - 500);
    void this.trace
      .append({ seq, at: Date.now(), sessionId: h.id, unitId: h.unitId, runtimeId: h.runtimeId, event })
      .catch(() => {});
    this.broadcast(event, seq);
  }

  /** 依次发出排队消息；当前轮仍忙或会话死挂则停手（下一轮落定会再触发） */
  private flushPendingSends(h: HostSession): void {
    if (h.turnBusy || h.impl === null) return;
    const next = h.pendingSends.shift();
    if (next === undefined) return;
    log.info("dispatching queued message", { sessionId: h.id, remaining: h.pendingSends.length });
    // WP-10：注入点事件化——前端据此把 pre/post-steer 的助手消息分行
    this.emitStamped(h, { type: "steer.boundary", sessionId: h.id, text: next.text });
    this.dispatchSend(h, next.text, next.loop);
  }

  /** 权限闸（Phase 4）：规则命中就自动决策，不命中保持挂起等人 */
  private evaluateGate(h: HostSession, event: Extract<RuntimeEvent, { type: "permission.requested" }>): void {
    this.pendingPerms.set(`${h.id}:${event.requestId}`, { kind: event.kind, detail: event.detail });
    const decision = this.gate.evaluate(h.runtimeId, event.kind, h.lastTool ?? "", event.detail);
    if (decision === null) return;
    log.info("permission auto-resolved by rule", { sessionId: h.id, requestId: event.requestId, decision });
    void h.impl?.resolvePermission(event.requestId, decision).catch((err: unknown) =>
      log.warn("gate auto-resolve failed", { error: err instanceof Error ? err.message : String(err) }),
    );
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
    // always：落规则表，同类请求下次不再问（pattern 用最近工具名，detail 兜底）
    if (decision === "always") {
      const meta = this.pendingPerms.get(`${sessionId}:${requestId}`);
      const pattern = h.lastTool ?? meta?.detail ?? requestId;
      const id = this.gate.addRule({
        runtimeId: h.runtimeId,
        kind: meta?.kind ?? null,
        pattern,
        decision: "allow",
      });
      log.info("permission rule added (always)", { id, runtimeId: h.runtimeId, pattern });
    }
    await h.impl.resolvePermission(requestId, decision);
  }

  async shutdown(): Promise<void> {
    // WP-10：会话终结时仍在排队的插话如实宣告未投递（上游渠道据此重试或告知用户）
    for (const h of this.sessions.values()) {
      if (h.pendingSends.length === 0) continue;
      this.emitStamped(h, {
        type: "steer.undelivered",
        sessionId: h.id,
        inputs: h.pendingSends.map((p) => p.text),
      });
      h.pendingSends.length = 0;
    }
    for (const adapter of this.adapters.values()) {
      await adapter.disconnect().catch((err: unknown) => log.warn("adapter disconnect failed", {
        adapter: adapter.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    this.store.close();
  }

  // ---- 孤儿治理面（WP-10：cherry orphanSessionReclaim 语义的 daemon 版） ----

  /**
   * 列出可回收的落盘会话：非 live、超过 maxAgeMs、带 cli_ref（真孤儿）或不带（纯死行）。
   * 轨迹文件永不删除——回收只动 state.db 的行。
   */
  gcCandidates(maxAgeMs: number): Array<{
    id: SessionId;
    runtimeId: RuntimeId;
    title: string;
    cliRef: string | null;
    startedAt: number;
  }> {
    const out: Array<{ id: SessionId; runtimeId: RuntimeId; title: string; cliRef: string | null; startedAt: number }> = [];
    for (const row of this.store.listSessions()) {
      if (this.sessions.get(asSessionId(row.id))?.impl != null) continue; // 活着的不回收
      if (Date.now() - row.startedAt < maxAgeMs) continue;
      out.push({
        id: asSessionId(row.id),
        runtimeId: row.runtimeId as RuntimeId,
        title: row.title,
        cliRef: row.cliRef,
        startedAt: row.startedAt,
      });
    }
    return out;
  }

  /** 回收一个非 live 的落盘会话（行 + 消息）；轨迹文件保留 */
  forgetSession(sessionId: SessionId): void {
    const h = this.sessions.get(sessionId);
    if (h?.impl != null) throw adapterError("session_live", "live session cannot be forgotten — cancel it first");
    this.store.deleteSession(sessionId);
    this.sessions.delete(sessionId);
    log.info("session forgotten", { sessionId });
  }
}
