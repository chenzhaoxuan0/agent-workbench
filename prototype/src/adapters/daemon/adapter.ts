/**
 * daemon 传输适配器 —— RuntimeAdapter SPI 的 daemon 实现。
 *
 * 替换 mock 的方式兑现了 mock 头注释的承诺：换的是 adapters/ 目录，
 * core/ 与 ui/ 一行不改。每个 daemon 执行器（zcode / codex / mockperm…）
 * 注册一个 `daemon:<id>` 运行时，全部共享一条到 daemon 的 WS。
 *
 * 事件分发语义对齐 mock 的「缓冲 + 单槽」：daemon 会广播所有会话的事件，
 * 这里按「本实例创建/续接的会话」过滤后进同一队列 —— store 的每个 run()
 * 挂一个消费者，多消费者从同一队列取（每个事件恰好被时间线收一次）。
 */

import type {
  AdapterFactory,
  ConnectionState,
  PermissionDecision,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SendMessageRequest,
  StartSessionRequest,
} from "../../core/adapter.ts";
import type { RuntimeEvent } from "../../core/events.ts";
import { asModelId, type ModelId } from "../../core/models.ts";
import {
  asRuntimeId,
  asSessionId,
  type RuntimeId,
  type Session,
  type SessionId,
  type WorkUnit,
} from "../../core/units.ts";
import { DaemonClient, type DaemonExecutorInfo } from "./client.ts";

const ACCENTS = ["#7C6CF5", "#10A37F", "#4D6BFE", "#D97757", "#0EA5E9", "#F59E0B"];

function accentFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length] ?? "#7C6CF5";
}

export function createDaemonFactory(info: DaemonExecutorInfo, endpoint: string): AdapterFactory {
  const runtimeId = asRuntimeId(`daemon:${info.id}`);
  const client = DaemonClient.get(endpoint);
  return {
    id: runtimeId,
    presentation: {
      displayName: `${info.displayName} · daemon`,
      vendor: "daemon",
      accent: accentFor(`daemon:${info.id}`),
      glyph: info.glyph,
      tagline: "本地 Runtime Host 守护进程 · 真实执行",
    },
    transport: {
      kind: "http" as const,
      endpoint: `${endpoint} (ws)`,
      requiresCwd: true,
    },
    capabilities: info.capabilities,
    models: info.models.map((m) => asModelId(m.id)),
    rawModels: info.models.map((m) => ({
      id: asModelId(m.id),
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      reasoningLevels: m.reasoningLevels,
      defaultReasoningLevel: m.defaultReasoningLevel,
      multimodal: m.multimodal,
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
    })),
    testOnly: info.testOnly,
    create: async () => new DaemonRuntimeAdapter(runtimeId, info, client),
  };
}

class DaemonRuntimeAdapter implements RuntimeAdapter {
  readonly id: RuntimeId;
  readonly presentation;
  readonly transport;
  readonly capabilities;

  readonly #client: DaemonClient;
  readonly #executorId: string;
  /** 本实例创建/续接过的会话 —— 事件过滤的边界（别人的会话不进我的队列） */
  readonly #sessions = new Set<string>();
  /** 每会话已见最大 seq（WP-2 去重游标）：重放与补拉重叠的判据 */
  readonly #lastSeq = new Map<string, number>();
  // mock 同款「缓冲 + 单槽」：运行时不因 UI 未调 next() 丢事件
  readonly #pending: RuntimeEvent[] = [];
  #waiting: ((e: RuntimeEvent) => void) | null = null;
  #pumpInstalled = false;
  /**
   * startSession 在途缓冲：session.started 在 create RPC 返回**之前**广播，
   * 此刻会话 id 还没进 #sessions —— 不过缓冲就会把首个事件丢掉（探针实证）。
   * 只缓冲「未进 #sessions」的事件（评审 P2）：已知会话照常投递，并发 startSession 不互踩。
   */
  #inflight: RuntimeEvent[] | null = null;

  constructor(id: RuntimeId, info: DaemonExecutorInfo, client: DaemonClient) {
    this.id = id;
    this.presentation = {
      displayName: `${info.displayName} · daemon`,
      vendor: "daemon",
      accent: accentFor(id),
      glyph: info.glyph,
      tagline: "本地 Runtime Host 守护进程 · 真实执行",
    };
    this.transport = {
      kind: "http" as const,
      endpoint: `${client.endpoint} (ws)`,
      requiresCwd: true,
    };
    this.capabilities = info.capabilities;
    this.#executorId = info.id;
    this.#client = client;
    this.#installPump();
  }

  #installPump(): void {
    if (this.#pumpInstalled) return;
    this.#pumpInstalled = true;
    this.#client.onEvent((event, seq) => {
      // WP-2 按 seq 判重：daemon 广播全量事件，重放/补拉的重叠在此挡住。
      // 补拉进行中的会话（评审 P1）帧进 stash——若照常推进游标，补拉响应会被整体判重丢洞
      if (seq !== undefined) {
        if (this.#resyncing.has(event.sessionId)) {
          this.#stash.get(event.sessionId)?.push({ seq, event });
          return;
        }
        const prev = this.#lastSeq.get(event.sessionId) ?? 0;
        if (seq <= prev) return;
        this.#lastSeq.set(event.sessionId, seq);
      }
      // 评审 P2：在途缓冲只收「还没进 #sessions」的会话（startSession 竞态窗口），
      // 已知会话照常走判重+投递——此前不分青红皂白全缓冲，并发 startSession 互相踩
      if (this.#inflight !== null && !this.#sessions.has(event.sessionId)) {
        this.#inflight.push(event);
        return;
      }
      if (!this.#sessions.has(event.sessionId)) return;
      this.#admit(event);
    });
    // 断线重连（非首连、未换代）→ 按会话游标增量补拉（WP-2）
    this.#client.onResync(() => {
      void this.#resync(false);
    });
    // daemon 换代（评审 P1）：seq 空间重置——清游标，对新代际做全量重拉
    this.#client.onGenerationChange(() => {
      this.#lastSeq.clear();
      void this.#resync(true);
    });
  }

  /** 补拉进行中的会话：实时帧暂存不投递，响应到达后按 seq 全序合并（防洞与乱序） */
  readonly #resyncing = new Set<string>();
  readonly #stash = new Map<string, Array<{ seq: number; event: RuntimeEvent }>>();

  /** 对跟踪中的会话逐个 since 补拉；reset=true 用于 daemon 换代（游标已清，全量重拉） */
  async #resync(reset: boolean): Promise<void> {
    for (const sessionId of this.#sessions) {
      const after = reset ? 0 : (this.#lastSeq.get(sessionId) ?? 0);
      if (after <= 0) continue;
      this.#resyncing.add(sessionId);
      this.#stash.set(sessionId, []);
      try {
        const items = await this.#client.rpc<Array<{ seq: number; event: RuntimeEvent }>>(
          "session.events.since",
          { sessionId, afterSeq: after },
          15000,
        );
        // 补拉响应与补拉期间到达的实时帧按 seq 全序合并去重，再统一投递
        const merged = [...(items ?? []), ...(this.#stash.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
        for (const item of merged) {
          const prev = this.#lastSeq.get(sessionId) ?? 0;
          if (item.seq <= prev) continue;
          this.#lastSeq.set(sessionId, item.seq);
          this.#admit(item.event);
        }
      } catch {
        // 补拉失败：保持游标，等下一条实时事件推进
      } finally {
        // 合并后才撤 stash：撤之前到达的尾部帧在此兜底排空（残余按游标判重）
        const late = this.#stash.get(sessionId) ?? [];
        this.#resyncing.delete(sessionId);
        this.#stash.delete(sessionId);
        for (const item of late) {
          const prev = this.#lastSeq.get(sessionId) ?? 0;
          if (item.seq <= prev) continue;
          this.#lastSeq.set(sessionId, item.seq);
          this.#admit(item.event);
        }
      }
    }
  }

  /** 缓冲 + 单槽投递：有人在等就直接交给他；没人等就进缓冲，绝不丢 */
  #admit(event: RuntimeEvent): void {
    const w = this.#waiting;
    if (w) {
      this.#waiting = null;
      w(event);
    } else {
      this.#pending.push(event);
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const r = await this.#client.rpc<ProbeResult>("adapter.probe", { runtimeId: this.#executorId }, 30000);
      return r;
    } catch (err: unknown) {
      const state: ConnectionState = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return { state, elapsedMs: 0 };
    }
  }

  async connect(): Promise<void> {
    await this.#client.ensureConnected();
  }

  async disconnect(): Promise<void> {}

  async listSessions(_unit: WorkUnit): Promise<readonly Session[]> {
    const all = await this.#client.rpc<Session[]>("session.list", null, 15000);
    return all.filter((s) => s.runtimeId === this.#executorId);
  }

  async startSession(req: StartSessionRequest): Promise<Session> {
    this.#inflight = []; // create 期间广播的 started/delta 进缓冲，拿到 id 后回收
    try {
      const session = await this.#client.rpc<Session>(
        "session.start",
        {
          runtimeId: this.#executorId,
          unitId: req.unit.id,
          unitName: req.unit.name,
          rootPath: req.unit.rootPath,
          prompt: req.prompt,
          model: req.model,
          mode: req.loop?.mode ?? "build",
          reasoningLevel: req.loop?.reasoningLevel,
          memoryOptions: req.memoryOptions,
        },
        60000,
      );
      this.#sessions.add(session.id);
      const buffered = this.#inflight ?? [];
      for (const e of buffered) {
        if (e.sessionId === session.id) this.#admit(e);
      }
      return session;
    } finally {
      this.#inflight = null;
    }
  }

  async resumeSession(sessionId: SessionId): Promise<Session> {
    const session = await this.#client.rpc<Session>("session.resume", { sessionId }, 30000);
    this.#sessions.add(session.id);
    return session;
  }

  async sendMessage(req: SendMessageRequest): Promise<void> {
    this.#sessions.add(req.sessionId);
    await this.#client.rpc("session.send", {
      sessionId: req.sessionId,
      text: req.text,
      reasoningLevel: req.loop?.reasoningLevel,
    });
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await this.#client.rpc("session.cancel", { sessionId });
  }

  async resolvePermission(sessionId: SessionId, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.#client.rpc("permission.resolve", { sessionId, requestId, decision });
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    while (true) {
      const next =
        this.#pending.length > 0
          ? this.#pending.shift()!
          : await new Promise<RuntimeEvent>((resolve) => {
              this.#waiting = resolve;
            });
      yield next;
    }
  }

  async exportTrace(sessionId: SessionId): Promise<string> {
    return this.#client.rpc<string>("session.trace", { sessionId }, 15000);
  }
}

/** 便捷：把 ModelId 字符串归一（daemon 的模型 id 即目录 id，直通） */
export function daemonModelId(v: string): ModelId {
  return asModelId(v);
}
