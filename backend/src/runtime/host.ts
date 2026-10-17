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

import type { AdapterSession, ExecutorAdapter, ExecutorModelInfo, StartRequest } from "./adapters/types.ts";
import { adapterError } from "./adapters/types.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeEvent,
  RuntimeId,
  Session,
  SessionId,
  SessionStatus,
  UnitId,
} from "../contract.ts";
import { log } from "../log.ts";
import { ensureWorktree } from "../git/repo.ts";
import { asSessionId, type SessionSource } from "../../../prototype/src/core/units.ts";
import type { TraceSink } from "./trace.ts";
import type { Store } from "../store/db.ts";
import type { PermissionGate } from "../permissions/gate.ts";
import { appendJournal, MAX_USAGE } from "../store/journals.ts";
import { redact as redactText } from "../memory/redact.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 界面侧的运行时命名空间前缀。
 * 界面把每个 daemon 执行器注册成 `daemon:<id>`，后端注册的是裸 `<id>`。
 * bot.json 里的 bindings 是界面写的，所以后端必须两种都认。
 */
const FRONTEND_NS_PREFIX = "daemon:";

/** listCommands 的兜底硬超时（毫秒）—— 比前端 RPC 的 30s 短，让界面按时拿到结果 */
const LIST_COMMANDS_HARD_TIMEOUT_MS = 20_000;
/** 命令清单磁盘缓存的新鲜期（毫秒）—— 与适配器内存缓存同口径；过期触发后台刷新 */
const LIST_COMMANDS_DISK_TTL_MS = 10 * 60 * 1000;

/** 对 WS 暴露的适配器摘要 */
export interface AdapterInfo {
  readonly id: string;
  readonly displayName: string;
  readonly glyph: string;
  readonly models: readonly ExecutorModelInfo[];
  /** 该执行器能否动态发现模型清单（没实现的界面要标出来，别让人对着静态清单空按刷新） */
  readonly modelsDiscoverable: boolean;
  /**
   * 本次吐出来的 models 是不是从 models-cache.json 兜底来的，以及那份缓存写于何时。
   *
   * 缺省 = 这是本次进程真探到（或适配器自带）的清单。
   * 界面上必须照实标「来自上次探测 · X 前」—— 用户分不清
   * 「没刷新」和「真的刷新到了」这两件事，模型列表就成了玄学。
   */
  readonly modelsCachedAt?: number;
  readonly capabilities: ExecutorAdapter["capabilities"];
  /**
   * 这是**测试夹具**，不是真的 CLI 工具。
   *
   * 目前只有 mockperm：它存在的意义是「真的会挂起等审批」，好端到端验收权限闸
   * ——真实执行器要么 -p yolo、要么 exec never，中途不会停下来问人。
   * 界面上必须标出来，否则用户会以为那是个没听说过的厂商工具。
   */
  readonly testOnly?: true;
}

/**
 * 一次模型同步的单家结果（`adapter.models` 的返回项）。
 *
 * `source` 是这套机制的核心：不带它的话，「实时清单」和「内置兜底清单」在界面上
 * 完全无法区分，用户看到列表没变只能猜是刷新失败还是本来就这样。
 */
export interface ModelSyncReport {
  readonly runtimeId: string;
  readonly displayName: string;
  readonly count: number;
  readonly source: "live" | "static";
  readonly reason?: string;
  readonly elapsedMs: number;
  /**
   * 本次返回的清单是从兜底缓存沿用来的，写于何时。缺省 = 本轮真探到了。
   *
   * 界面据此显示「来自上次探测 · X 前」。它同时是「本轮没探到」的**唯一信号**：
   * 界面只在 source === "live" 时才敢认定「某个模型真的失效了」，
   * 探失败那轮一律沿用旧清单、隐藏逻辑不生效。
   */
  readonly cachedAt?: number;
}

/**
 * 一家执行器的模型兜底缓存（models-cache.json 的一条）。
 *
 * ## 它是缓存，不是账本
 *
 * 真相源永远是各 CLI 的原生配置（~/.claude/settings.json、`codex debug models`
 * 的输出、ACP session/new 返回的模型选单……），每次启动现场重读。磁盘这一份
 * 只在**本轮探测没探成**时顶一下，让冷启动不至于退回各适配器内置的种子清单
 * （那 3 条 sonnet/opus/haiku 之类，用户一眼就看出是「初始化状态」）。
 *
 * 所以它可以随时整个删掉，删了只是下次冷启动重新探一遍，不会丢任何用户数据 ——
 * 这也是它与「中央注册表/镜像账本」的根本区别。
 */
interface ModelCacheEntry {
  readonly models: readonly ExecutorModelInfo[];
  /** 写入时刻（成功探测的那一刻），界面按它显示「X 前」 */
  readonly at: number;
  /**
   * 这一份还是**启动时从盘上读的**吗？
   *
   * 这条区分不能省。缓存里躺着的东西有两种：进程启动时从 models-cache.json
   * 读进来的，和本进程刚刚实时探测成功的。两者都是「好结果」，但对界面意义相反 ——
   * 后者该显示「· 实时」，前者该显示「· 来自上次探测 X 前」。
   * 只看「缓存里有没有」的话，一次实时成功之后界面仍会喊「来自上次探测 0 秒前」，
   * 等于把最新的结果说成旧的。
   */
  readonly fromDisk: boolean;
}

interface HostSession {
  readonly id: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: RuntimeId;
  /** 会话谱系（ADR 0012）：NULL = 自身为根；切换执行器开的新段指向旧段谱系 */
  readonly conversationId: string | null;
  /** 会话实际 cwd（worktree 会话 = 工作树路径）；源代码管理删树前的活跃会话判定用 */
  readonly rootPath: string;
  title: string;
  status: SessionStatus;
  readonly startedAt: number;
  endedAt: number | undefined;
  /** 来源徽标（docs/09 §六.2）。缺省 = 工作台 */
  readonly source: SessionSource;
  /** 交互式渠道会话：权限不自动放行，等渠道侧人裁决（见 StartSessionInput.interactive） */
  readonly interactive: boolean;
  /** 实际生效的模型（modelHint 失效时的回落结果） */
  readonly modelActual: string | null;
  /** 被丢掉的 modelHint。非空 = 界面必须弱提示（docs/09 §六.1） */
  readonly modelHintDropped: string | null;
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
  /** 会话内单调轮号（ADR 0012：turn.started/completed 凭它配对） */
  turnCount: number;
  /** 是否有一轮已开始未收口 —— 杂散 status 不产生幽灵 turn.completed */
  turnOpen: boolean;
  /** 用户请求取消当前轮 —— 落定时把 turn.completed 标为 cancelled（各家 CLI 的取消口径不一，host 统一） */
  cancelRequested: boolean;
  /** 会话事件环（上限 500，带 seq 与 at），eval 断言与前端重放共用 */
  readonly events: Array<{ seq: number; at: number; event: RuntimeEvent }>;
}

export interface StartSessionInput {
  readonly runtimeId: string;
  readonly unitId: UnitId;
  readonly unitName: string;
  readonly rootPath: string;
  readonly prompt: string;
  readonly model: ModelId | null;
  /**
   * 会话谱系（ADR 0012）：切换执行器开新段时传旧段所属谱系 id。
   * 缺省 = 新谱系（自身为根）。
   */
  readonly conversationId?: string;
  /**
   * 只读转录交接（ADR 0012，opt-in）：携带上文切换 —— 把 fromSessionId 那段
   * 的最近消息投影构造成 HANDOFF 前缀拼进新段首条消息。旧段的执行器私有
   * 上下文不迁移（做不到也不该做），迁移的是 host 账本的对话事实。
   */
  readonly handoff?: { readonly fromSessionId: SessionId };
  readonly mode?: StartRequest["mode"];
  readonly reasoningLevel?: string;
  /**
   * 会话工作树（源代码管理面板「在此工作树启动会话」）：不存在则按 branch
   * 创建，存在则幂等复用。命中后会话全程的 rootPath（执行器 cwd、记忆注入、
   * 台账）都指向工作树目录，而非单元根目录。
   */
  readonly worktree?: { readonly path: string; readonly branch: string };
  /** 这个会话从哪来（docs/09 §六.2 的来源徽标）。缺省 = 工作台 */
  readonly source?: SessionSource;
  /**
   * 交互式渠道会话（IM 审批按钮 / 移动端确认门）：权限闸**不自动放行**，
   * 挂起等渠道侧的人点按钮裁决。缺省 false = 沿用 headless 全放行语义
   * （automation / webhook / mcp / 飞书 等无人可等的来源不变）。
   */
  readonly interactive?: boolean;
  /** 记忆注入配置（可选指定 semantic / daily / procedural 作用域） */
  readonly memoryOptions?: MemoryInjectorOptions;
  /**
   * 会话登记就绪、**首轮 prompt 还没发出去**的那一刻回调。
   *
   * 存在的唯一理由：飞书/telegram 的流式输出要在 `message.delta` 到达时就刷 IM。
   * 订阅放在 `startSession` **返回之后**会整段丢失第一个 delta —— 实测就是
   * 订阅到 0 个事件（mockperm 几十毫秒就答完了）。
   */
  readonly onSessionReady?: (sessionId: SessionId) => void;
}

/**
 * modelHint 回落判定（docs/09 §六.1）。
 *
 * 回落顺序按 units.ts 契约原文：用户所选 → 这个 hint → 执行器默认。
 * 这里把「最终用哪个」和「hint 有没有被丢掉」一起算出来交给会话，
 * 界面才有东西可显示——只在 adapter 里默默回落的话，UI 永远不知道发生过。
 *
 * 判定清单由调用方给：**有兜底缓存必须用缓存**（复审 P0）——listAdapters 展示面
 * 优先吐缓存，冷启动时若这里仍用适配器种子清单，界面选的模型（缓存 id）会被
 * 派发面静默换成种子第一档，展示与派发就分裂了。
 */
function resolveModelFor(
  supported: readonly ExecutorModelInfo[],
  requested: ModelId | null,
): { model: ModelId | null; droppedHint: string | null } {
  if (requested === null) return { model: null, droppedHint: null };
  if (supported.some((m) => m.id === requested)) return { model: requested, droppedHint: null };
  // 不可用 → 落执行器默认（清单首项，与注册表口径一致），并把丢掉的那个记下来
  return { model: supported[0]?.id ?? null, droppedHint: String(requested) };
}

/**
 * 记忆注入契约（docs/10 §4.2）。
 *
 * 刻意声明在 host 侧而不是从 memory 模块 import —— 依赖方向只能是
 * host ← memory 提供的实现，不能反过来。host 不该知道 MEMORY.md 是什么。
 */
export interface InjectedPartInfo {
  readonly scope: string;
  readonly sourcePath: string;
  readonly chars: number;
}

export interface InjectedPrompt {
  /** 注入后的完整 prompt（block + 分隔 + 用户原话） */
  readonly prompt: string;
  /** 注入块本体（不含用户原话）—— 分发日志存这份就够还原「它当时知道什么」 */
  readonly block: string;
  readonly parts: readonly InjectedPartInfo[];
  readonly injectedChars: number;
}

export interface MemoryInjectorOptions {
  readonly scopes?: readonly ("semantic" | "daily" | "procedural")[];
  readonly dailyDate?: string;
  readonly dailyLimit?: number;
}

export interface MemoryInjector {
  build(rootPath: string, userText: string, opts?: MemoryInjectorOptions): Promise<InjectedPrompt | null>;
}

export class RuntimeHost {
  private readonly adapters = new Map<string, ExecutorAdapter>();
  private readonly sessions = new Map<SessionId, HostSession>();

  /**
   * 模型兜底缓存：执行器 id → 上一次**成功探测**拿到的清单。
   *
   * 与 commandsDisk 同构但语义更硬：commandsDisk 是加速（过期就后台重拉），
   * 这一份是「本轮探失败时唯一能给用户看的东西」。`listAdapters` 优先读它，
   * 所以冷启动那一下界面拿到的就已经是上次的清单，而不是适配器的内置种子。
   */
  private readonly modelCache = new Map<string, ModelCacheEntry>();

  constructor(
    private readonly broadcast: (event: RuntimeEvent, seq: number) => void,
    private readonly trace: TraceSink,
    private readonly homeDir: string,
    private readonly store: Store,
    private readonly gate: PermissionGate,
    /**
     * 记忆注入器（docs/10 WP-3）。**可选**：不传 = 记忆系统关闭，
     * 派发行为与引入记忆之前逐字节一致。所有既有冒烟因此不受影响。
     */
    private readonly memory?: MemoryInjector,
  ) {
    // 同步读盘（文件很小，几 KB）。**必须**在构造函数里做完而不是懒加载：
    // daemon 启动**不再自动探测**（见 index.ts），界面的 adapter.list 很可能
    // 在任何探测之前就到了 —— 那一刻 #modelCache 还是空的，用户就只能看到适配器
    // 内置的种子清单。这正是「每次进去都是初始化态」的由来。
    this.loadModelCacheDisk();
  }

  /** 挂起中的权限上下文（"always" 落规则时取 kind/detail 用） */
  private readonly pendingPerms = new Map<string, { kind: string; detail: string }>();

  /** 会话结束等待者（Ops 的 eval/arena 用它等轮次跑完） */
  private readonly endWaiters = new Map<SessionId, Array<{ type: string; resolve: () => void }>>();

  /** 会话当前 seq（调用方在派发动作前快照，配合 waitForSessionEvent 的 afterSeq 只等"新"事件） */
  currentSeq(sessionId: SessionId): number {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    return h.seq;
  }

  /**
   * 等会话的下一条指定类型事件——turn 级完成等待用 "usage"。
   * afterSeq（评审 P1）：只认 seq 大于它的事件。续聊场景事件环里必有上一轮的
   * usage，不传游标会立即返回并拿到旧回复——askBot 等渠道入口必须传派发前快照。
   */
  waitForSessionEvent(sessionId: SessionId, type: string, timeoutMs: number, afterSeq = 0): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) return Promise.reject(adapterError("unknown_session", `no such session: ${sessionId}`));
    if (h.events.some((e) => e.seq > afterSeq && e.event.type === type)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.eventWaiters.get(sessionId);
        const i = list?.indexOf(waiter) ?? -1;
        if (list !== undefined && i >= 0) list.splice(i, 1);
        reject(adapterError("event_wait_timeout", `session ${sessionId}: no ${type} within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = { type, afterSeq, resolve: () => { clearTimeout(timer); resolve(); } };
      const list = this.eventWaiters.get(sessionId) ?? [];
      list.push(waiter);
      this.eventWaiters.set(sessionId, list);
    });
  }

  private readonly eventWaiters = new Map<SessionId, Array<{ type: string; afterSeq: number; resolve: () => void }>>();

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
  hotEventsSince(sessionId: SessionId, afterSeq: number): { items: Array<{ seq: number; at: number; event: RuntimeEvent }>; gap: boolean } {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    const items = h.events.filter((e) => e.seq > afterSeq);
    const oldest = h.events[0]?.seq ?? Number.POSITIVE_INFINITY;
    // afterSeq>0（客户端真有前情）且环为空或最老事件仍比游标新 → 中段缺了。
    // 空环分支（评审 P1）：daemon 重启后事件环从零开始，客户端旧游标必然落空——
    // 不判 gap 会静默返回 []，永不回落落盘账本。
    const gap = afterSeq > 0 && (h.events.length === 0 || oldest > afterSeq + 1);
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
        conversationId: row.conversationId,
        // 老行可能没写 rootPath（列后加的）：空串 = 未知，删树防拆判定自然不命中
        rootPath: row.rootPath ?? "",
        title: row.title,
        status: row.status as SessionStatus,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? undefined,
        // 从盘装载的死会话：来源与模型没落 state.db（老会话更是连字段都没有），
        // 只能按「工作台起的」处理。徽标显示成「工作台」而不是空——空会让人以为
        // 这个字段没实现。同理 interactive 按缺省 false：resume 后不自动放行，
        // 与工作台当面确认的行为一致。
        source: "workbench",
        interactive: false,
        modelActual: null,
        modelHintDropped: null,
        stats: { ...row.stats },
        // ADR 0012 不变量 3：seq 从落库值续号，换代不重置（afterSeq 补拉跨代成立）
        seq: row.lastSeq,
        impl: null,
        adapter,
        lastTool: null,
        // 行上的 cli_ref 即恢复凭据（ADR 0012 readiness：lastCliRef 非空 = resumable）
        lastCliRef: row.cliRef,
        pendingSends: [],
        turnBusy: false,
        turnCount: 0,
        turnOpen: false,
        cancelRequested: false,
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

  /**
   * 并发刷新所有支持动态模型发现的适配器。
   * 单家失败或超时不会抛错阻断其余适配器。
   */
  async syncAllModels(): Promise<void> {
    await this.syncModels();
  }

  /**
   * 刷新模型清单 —— 模型按钮的落点。
   *
   * @param runtimeId 只刷这一家；省略则刷全部（各家并发，互不阻塞）
   *
   * 返回每家的同步结果，**必须带来源标记**：界面要能区分「刚从 CLI 问到的实时清单」
   * 和「实时源不可用、退回内置兜底」。两者长得一模一样，不标出来用户就没法判断
   * 「我到底刷到没有」——而这正是模型列表最常见的困惑来源。
   *
   * ## 失败那轮为什么还能给出有用的清单
   *
   * 每个适配器的 syncModels 失败时都返回 `{ models: this._models, source: "static" }`，
   * 也就是**它自己上次成功的清单**。这个兜底在进程内有效，一重启就退化成内置种子
   * （sonnet/opus/haiku 那 3 条）。所以这里在宿主层再兜一层：本轮没探成时改用
   * #modelCache（启动时从 models-cache.json 载进来的那份），并如实标上 cachedAt，
   * 让界面显示「来自上次探测 · X 前」而不是假装这是新探到的。
   *
   * 只有 source === "live" 才允许覆写缓存 —— 失败结果绝不能污染盘上那份好的。
   */
  async syncModels(runtimeId?: string): Promise<readonly ModelSyncReport[]> {
    const targets =
      runtimeId === undefined
        ? [...this.adapters.values()]
        : [this.getAdapter(runtimeId)];

    return await Promise.all(
      targets.map(async (a): Promise<ModelSyncReport> => {
        if (typeof a.syncModels !== "function") {
          return {
            runtimeId: a.id,
            displayName: a.displayName,
            count: a.models.length,
            source: "static",
            reason: "该执行器未实现动态模型探测",
            elapsedMs: 0,
          };
        }
        try {
          const r = await a.syncModels();
          if (r.source === "live") {
            this.putModelCache(a.id, r.models);
            return {
              runtimeId: a.id,
              displayName: a.displayName,
              count: r.models.length,
              source: "live",
              reason: r.reason,
              elapsedMs: r.elapsedMs,
            };
          }
          // 本轮没探成。先看有没有一份好的兜底。
          const cached = this.modelCache.get(a.id);
          if (cached !== undefined) {
            log.info("模型探测未成功，沿用兜底缓存", {
              id: a.id,
              cachedAt: new Date(cached.at).toISOString(),
              reason: r.reason,
            });
            return {
              runtimeId: a.id,
              displayName: a.displayName,
              count: cached.models.length,
              source: "static",
              reason: `${r.reason ?? "实时源不可用"}；沿用上次探测结果（${relativeTime(cached.at)}）`,
              elapsedMs: r.elapsedMs,
              cachedAt: cached.at,
            };
          }
          // 连兜底都没有（首装、或磁盘上从没写过）—— 如实退回适配器自带的清单
          return {
            runtimeId: a.id,
            displayName: a.displayName,
            count: r.models.length,
            source: "static",
            reason: r.reason,
            elapsedMs: r.elapsedMs,
          };
        } catch (err: unknown) {
          // 适配器里已经各自兜底过了，走到这里说明它连兜底都没兜住 —— 如实报，不假装成功
          const reason = err instanceof Error ? err.message : String(err);
          log.warn("syncModels 抛出未捕获异常", { id: a.id, error: reason });
          const cached = this.modelCache.get(a.id);
          return {
            runtimeId: a.id,
            displayName: a.displayName,
            count: cached?.models.length ?? a.models.length,
            source: "static",
            reason: cached === undefined ? reason : `${reason}；沿用上次探测结果（${relativeTime(cached.at)}）`,
            elapsedMs: 0,
            ...(cached === undefined ? {} : { cachedAt: cached.at }),
          };
        }
      }),
    );
  }

  // ---- 模型兜底缓存（models-cache.json）----

  /** 读盘。构造函数里同步调一次；坏文件只丢数据不阻断启动（顶多是退回种子清单） */
  private loadModelCacheDisk(): void {
    try {
      const raw = readFileSync(join(this.homeDir, "models-cache.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, { models?: unknown; at?: unknown }>;
      for (const [id, entry] of Object.entries(parsed)) {
        if (Array.isArray(entry?.models) && typeof entry?.at === "number") {
          this.modelCache.set(id, {
            models: entry.models as readonly ExecutorModelInfo[],
            at: entry.at,
            fromDisk: true,
          });
        }
      }
      if (this.modelCache.size > 0) {
        log.info("models-cache 已载入", { executors: this.modelCache.size });
      }
    } catch {
      // 没有这个文件 = 首次运行，或用户手动删了。都属正常，不记警告。
    }
  }

  /** 成功探测才写。写盘失败只影响下次冷启动，不影响本次会话。 */
  private putModelCache(id: string, models: readonly ExecutorModelInfo[]): void {
    const prev = this.modelCache.get(id);
    const unchanged = prev !== undefined && sameExecutorModels(prev.models, models);
    // ⚠ 早退条件里**必须**看 fromDisk，不能只看内容是否相同。
    //
    // 冷启动时从盘上读进来的是 `{内容相同, at=一小时前, fromDisk:true}`。
    // 本轮实时探测回来的内容一模一样 —— 若此时早退，fromDisk 就一直是 true：
    // ① listAdapters 会报一个陈旧的 modelsCachedAt，界面在**刚刚实时探到**之后
    //    仍挂「· 来自上次探测 1 小时前」，等于把最新结果说成旧的；
    // ② 前端 syncModelsAll 拿这个标记当「本轮不是实时」的判据，会跳过失效模型
    //    对齐 —— 于是清单稳定的执行器（大多数执行器大多数时候都稳定）永远
    //    检测不到模型下线，这是决策 5 整个机制的静默失效。
    //
    // fromDisk 为 true 时即便内容没变也要写：这一轮**确实验证过**，
    // at 该记成现在，而不是留着一小时前的时间戳。
    if (unchanged && prev?.fromDisk === false) {
      // 内容没变也要把 at 续到「刚刚实测」：留着旧时间戳，界面会在刚刚探测成功
      // 之后仍挂「来自上次探测 · N 小时前」。盘上那份不必重写 —— 内容没变时
      // 旧 at 只让下次冷启动的展示保守一点，无害
      this.modelCache.set(id, { models: prev.models, at: Date.now(), fromDisk: false });
      return;
    }
    this.modelCache.set(id, { models, at: Date.now(), fromDisk: false });
    try {
      const out: Record<string, { models: readonly ExecutorModelInfo[]; at: number }> = {};
      for (const [k, v] of this.modelCache) out[k] = v;
      const path = join(this.homeDir, "models-cache.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), "utf8");
      renameSync(tmp, path);
    } catch (err: unknown) {
      log.debug("models-cache 写盘失败（本次会话不受影响，下次冷启动要重探）", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 模型清单发现能力：有实现 syncModels 的才算「刷新得动」 */
  private supportsModelDiscovery(a: ExecutorAdapter): boolean {
    return typeof a.syncModels === "function";
  }

  async listAdapters(sync = false): Promise<AdapterInfo[]> {
    if (sync) {
      await this.syncAllModels();
    }
    return [...this.adapters.values()].map((a) => {
      // 兜底缓存优先于适配器内置种子清单。启动预热还没跑完的那一刻，
      // 适配器手里只有 3 条内置兜底，缓存里却是上次真探到的完整清单 ——
      // 界面拿到哪个，决定了用户看到的是「上次结果」还是「初始化态」。
      const cached = this.modelCache.get(a.id);
      return {
        id: a.id,
        displayName: a.displayName,
        glyph: a.glyph,
        models: [...(cached?.models ?? a.models)],
        modelsDiscoverable: this.supportsModelDiscovery(a),
        // 只在这一份**确实是从盘上沿用**时才标兜底。本进程刚实时探到的
        // 同样躺在 modelCache 里，但那是新鲜结果，该让界面显示「· 实时」。
        ...(cached?.fromDisk === true ? { modelsCachedAt: cached.at } : {}),
        capabilities: a.capabilities,
        // 只在真标了的时候才带这个键，省得每个执行器都多一个 testOnly: undefined
        ...(a.testOnly === true ? { testOnly: true as const } : {}),
      };
    });
  }

  /**
   * 取适配器，**同时接受前端命名空间**。
   *
   * bot.json 的 `bindings[].runtimeId` 是界面写进去的，而界面把适配器注册成
   * `daemon:<id>`（prototype/src/adapters/daemon/adapter.ts:44）—— 后端注册的却是
   * 裸 `<id>`。于是**界面路径自洽、IM 路径跨命名空间**：
   * 飞书/telegram/webhook 走 `runBotTurn` → `getAdapter("daemon:mcode")` →
   * `no such executor`。
   *
   * 之所以要在这里容错而不是让界面改写裸 id：bot.json 是**手可编辑**的，
   * 里面早就躺着 `daemon:zcode` 这类值（老 bot 都是），改不动也不该改。
   * 后端收下两种写法，是唯一不破坏既有数据的做法。
   */
  getAdapter(runtimeId: string): ExecutorAdapter {
    const direct = this.adapters.get(runtimeId);
    if (direct !== undefined) return direct;
    // 前端命名空间 `daemon:<id>` → 后端 `<id>`
    const bare = runtimeId.startsWith(FRONTEND_NS_PREFIX) ? runtimeId.slice(FRONTEND_NS_PREFIX.length) : "";
    const viaNs = bare === "" ? undefined : this.adapters.get(bare);
    if (viaNs !== undefined) return viaNs;
    // 兼容 antigravity / agy 别名
    if (runtimeId === "antigravity" || bare === "antigravity") {
      const agy = this.adapters.get("agy");
      if (agy !== undefined) return agy;
    }
    // 兼容 cursor-agent / cursor 别名
    if (runtimeId === "cursor-agent" || bare === "cursor-agent") {
      const cur = this.adapters.get("cursor");
      if (cur !== undefined) return cur;
    }
    // 兼容 grok-build / grok 别名
    if (runtimeId === "grok-build" || bare === "grok-build") {
      const grk = this.adapters.get("grok");
      if (grk !== undefined) return grk;
    }
    // 报可用清单：只说「no such executor: daemon:mcode」等于把人逼去翻代码
    const available = [...this.adapters.keys()].sort().join(", ");
    throw adapterError(
      "unknown_runtime",
      `no such executor: ${runtimeId}（本机已注册：${available}）` +
        (runtimeId.startsWith(FRONTEND_NS_PREFIX) ? `　注意：界面写的 "${runtimeId}" 里的 "${FRONTEND_NS_PREFIX}" 前缀只在界面侧有效` : ""),
    );
  }

  async probe(runtimeId: string): Promise<ProbeResult> {
    const adapter = this.getAdapter(runtimeId);
    // ⚠ 这里**故意不再**顺带刷新模型。探测只回答「装没装、能不能连、什么版本」；
    // 顺带刷模型的历史包袱是：结果只留在 daemon 进程内存里回不到界面，
    // 而探测按钮的耗时被模型拉长，用户点一下等半天还不知道在等什么。
    // 两个职责各自独立，模型刷新走 adapter.models。
    return adapter.probe();
  }

  /**
   * 列出执行器的原生斜杠命令（UI 菜单数据源）。没有原生命令面的执行器返回 []。
   * 单家失败不抛 —— 菜单退化成工作台本地命令，不阻断其他执行器。
   *
   * ## 为什么要落盘缓存 + stale-while-revalidate
   *
   * 菜单的体验对标 TUI：TUI 里命令清单和渲染菜单在同一个进程，零开销秒开；
   * 我们这边浏览器→daemon→执行器跨两层，冷路径上 zcode 要问 app-server
   * （~1s）、opencode 要起 server（~6s）。落盘缓存让「曾经拉到过」的清单
   * 在 daemon 重启后依然 0ms 命中（菜单先开、后台刷新）—— 首次成功之后，
   * 菜单永远秒开。
   *
   * ## 防悬死
   *
   * 适配器自己的兜底超时可能失约（promise 悬死），RPC 不能跟着悬 —— 到点回
   * 空清单，让前端按时进「拉取失败/空清单」态。落盘写入只在新清单非空或
   * 本来就没有缓存时发生：一次瞬时失败不该抹掉一份好数据。
   */
  async listCommands(runtimeId: string, rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const adapter = this.getAdapter(runtimeId);
    if (typeof adapter.listCommands !== "function") return [];
    this.loadCommandsDiskOnce();
    const key = `${adapter.id}|${rootPath}`;

    // 命中磁盘缓存（不论新旧）：立即返回（菜单秒开），过期则后台刷新
    const disk = this.commandsDisk.get(key);
    if (disk !== undefined) {
      if (Date.now() - disk.at > LIST_COMMANDS_DISK_TTL_MS) void this.refreshCommands(adapter, rootPath, key);
      return disk.commands;
    }

    // 首次（从未成功过）：现场拉，护栏竞速
    try {
      const commands = await Promise.race([
        adapter.listCommands(rootPath),
        new Promise<readonly NativeCommandInfo[]>((resolve) =>
          setTimeout(() => resolve([]), LIST_COMMANDS_HARD_TIMEOUT_MS).unref?.(),
        ),
      ]);
      this.putCommandsDisk(key, commands);
      return commands;
    } catch (err: unknown) {
      log.warn("listCommands failed", { id: adapter.id, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  // ---- 命令清单落盘缓存 --------------------------------------------------------

  /**
   * 启动预热：后台拉一遍「有命令面的执行器 × 已知 rootPath」。
   * 冷启动成本（zcode 问 app-server ~1s、opencode 起 server ~6s）被藏进启动期，
   * 用户第一次打开斜杠菜单时命中磁盘/适配器缓存。小并发（2）：预热不能抢
   * 正在起会话的执行器的资源。失败静默 —— 预热是优化，不是功能路径。
   */
  async prewarmCommands(rootPaths: readonly string[]): Promise<void> {
    this.loadCommandsDiskOnce();
    const ids = [...this.adapters.values()].filter((a) => typeof a.listCommands === "function").map((a) => a.id);
    const jobs: Array<() => Promise<void>> = [];
    for (const id of ids) {
      for (const root of rootPaths) jobs.push(() => this.listCommands(id, root).then(() => undefined));
    }
    let i = 0;
    const workers = Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (i < jobs.length) {
        const job = jobs[i++]!;
        await job().catch(() => undefined);
      }
    });
    await Promise.all(workers);
  }

  /** key = `${adapter.id}|${rootPath}` → 清单 + 拉取时间 */
  private readonly commandsDisk = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();
  private commandsDiskLoaded = false;
  /** 命令缓存世代：invalidateCommandsFor 递增；在途后台刷新完成时校验，防止旧清单回写 */
  private commandsEpoch = 0;
  /** 在途后台刷新（同 key 只跑一个） */
  private readonly commandsRefreshes = new Set<string>();

  private loadCommandsDiskOnce(): void {
    if (this.commandsDiskLoaded) return;
    this.commandsDiskLoaded = true;
    try {
      const raw = readFileSync(join(this.homeDir, "commands-cache.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, { commands?: unknown; at?: number }>;
      for (const [key, entry] of Object.entries(parsed)) {
        if (Array.isArray(entry?.commands) && typeof entry.at === "number") {
          this.commandsDisk.set(key, { commands: entry.commands as readonly NativeCommandInfo[], at: entry.at });
        }
      }
    } catch {
      /* 没有缓存文件/坏格式 = 全部按首次拉取走，不是错误 */
    }
  }

  private putCommandsDisk(key: string, commands: readonly NativeCommandInfo[]): void {
    // 瞬时失败常表现为空清单：非空旧缓存不该被一次空结果抹掉
    if (commands.length === 0 && this.commandsDisk.has(key)) return;
    this.commandsDisk.set(key, { commands, at: Date.now() });
    this.persistCommandsDisk();
  }

  /**
   * 失效给定执行器的全部命令缓存（所有 rootPath）—— 技能停用/恢复后调用：
   * 磁盘清单马上作废（否则最长 10 分钟内斜杠菜单还显示已停用的技能），
   * 下一次 listCommands 自然重扫。
   *
   * 三件事缺一不可：
   * 1. 先载盘 —— daemon 刚重启、还没人打开过菜单时，盘上旧数据尚未进内存，
   *    不先 loadCommandsDiskOnce 的话失效是 no-op，旧数据随后照样命中；
   * 2. 清适配器内存缓存 —— 适配器各自有 10 分钟 TTL，不清会把旧清单原样
   *    返回并**重新落盘**，失效等于没做；
   * 3. epoch++ —— 在途的后台刷新（stale-while-revalidate）完成时要校验
   *    epoch 没变才允许落盘，否则停用前一瞬间启动的刷新会把旧世界写回来。
   */
  invalidateCommandsFor(runtimeIds: readonly string[]): void {
    this.loadCommandsDiskOnce();
    this.commandsEpoch++;
    const ids = new Set(runtimeIds);
    let changed = false;
    for (const key of [...this.commandsDisk.keys()]) {
      const id = key.split("|")[0] ?? "";
      if (ids.has(id)) {
        this.commandsDisk.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistCommandsDisk();
    for (const adapter of this.adapters.values()) {
      if (ids.has(adapter.id)) adapter.invalidateCommands?.();
    }
  }

  private persistCommandsDisk(): void {
    try {
      const out: Record<string, { commands?: unknown; at?: number }> = {};
      for (const [k, v] of this.commandsDisk) out[k] = v;
      const path = join(this.homeDir, "commands-cache.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), "utf8");
      renameSync(tmp, path);
    } catch (err: unknown) {
      log.debug("commands-cache 写盘失败（菜单不受影响，只是下次重启要重拉）", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 后台刷新（stale-while-revalidate 的后台半边）：成功才覆写磁盘；跨世代结果丢弃 */
  private async refreshCommands(adapter: ExecutorAdapter, rootPath: string, key: string): Promise<void> {
    if (adapter.listCommands === undefined) return;
    if (this.commandsRefreshes.has(key)) return;
    this.commandsRefreshes.add(key);
    const epochAtStart = this.commandsEpoch;
    try {
      const commands = await Promise.race([
        adapter.listCommands(rootPath),
        new Promise<readonly NativeCommandInfo[]>((resolve) =>
          setTimeout(() => resolve([]), LIST_COMMANDS_HARD_TIMEOUT_MS).unref?.(),
        ),
      ]);
      // 刷新期间发生过缓存失效（技能停用/恢复）→ 这份结果属于旧世界，丢弃
      if (epochAtStart !== this.commandsEpoch) return;
      this.putCommandsDisk(key, [...commands]);
    } catch (err: unknown) {
      log.debug("commands-cache 后台刷新失败（保留旧清单）", { key, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.commandsRefreshes.delete(key);
    }
  }

  private toSession(h: HostSession): Session {
    return {
      id: h.id,
      unitId: h.unitId,
      runtimeId: h.runtimeId,
      conversationId: h.conversationId ?? undefined,
      rootPath: h.rootPath,
      title: h.title,
      status: h.status,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      source: h.source,
      modelActual: h.modelActual ?? undefined,
      modelHintDropped: h.modelHintDropped ?? undefined,
      ephemeral: false,
      // ADR 0012 readiness 事实（host 台账判定，不依赖适配器自觉发 ended）：
      // live = 进程内 impl 存活；resumable = 有执行器原生引用可接回
      live: h.impl !== null,
      resumable: h.lastCliRef !== null,
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

    // 会话工作树：ensure（不存在则建）之后，rootPath 全程指向工作树。
    // 放在最前面 —— 记忆注入、执行器 cwd、台账都要用换算后的路径。
    let rootPath = input.rootPath;
    if (input.worktree !== undefined) {
      rootPath = await ensureWorktree(input.rootPath, input.worktree);
    }

    // 记忆注入（docs/10 WP-3）：**只在开新会话时注入一次**。
    // - 冻结快照：续聊不重复注入，保住 LLM 前缀缓存（hermes 的做法）
    // - 切换执行器会开新会话 → 冷启动时自然重新注入，这正是我们要的
    // - daemon 重启后 resumeSession 走 CLI 自己的历史，不重复注入
    // 注入失败绝不阻断派发 —— 记忆是增强，不是前置条件。
    //
    // 斜杠命令首消息跳过注入：执行器的 slash 分发要求消息以 "/" 开头（Claude SDK
    // 的 slash-command dispatch 见 verbatimPrompts 文档），前面拼记忆块会把
    // "/init" 这类原生命令变成一句普通文本 —— 命令就废了。命令是控制输入，不是内容。
    const isNativeCommand = input.prompt.startsWith("/");
    let injected: InjectedPrompt | null = null;
    if (this.memory !== undefined && !isNativeCommand) {
      try {
        injected = await this.memory.build(rootPath, input.prompt, input.memoryOptions);
      } catch (err: unknown) {
        log.warn("memory injection skipped", {
          root: rootPath,
          error: err instanceof Error ? err.message : String(err),
        });
        injected = null;
      }
    }
    // ADR 0012 只读转录交接（opt-in）：与记忆注入同一挂载点、同一跳过规则
    //（斜杠命令是控制输入，前面拼块会废掉命令分发）。
    const handoffBlock =
      input.handoff !== undefined && !isNativeCommand
        ? this.buildHandoffBlock(input.handoff.fromSessionId)
        : null;
    const effectivePrompt = [handoffBlock, injected === null ? null : injected.prompt, input.prompt]
      .filter((p): p is string => p !== null)
      .join("\n\n");

    // modelHint 的回落在这里一次解决，并把「实际生效」与「被丢掉的 hint」都算出来。
    // 契约原文说 hint 失效会被静默忽略——那正是 docs/09 §六.1 要补掉的静默：
    // 用户以为自己在用便宜模型，实际在烧贵的。适配器自己也会回落，但只有 host
    // 知道它回落到了哪儿，所以判定收在这一处，不散进每个 adapter。
    // 判定清单与 listAdapters 同源：兜底缓存优先，没有缓存才用适配器种子清单（复审 P0）。
    const { model: effective, droppedHint } = resolveModelFor(
      this.modelCache.get(adapter.id)?.models ?? adapter.models,
      input.model,
    );

    // 晚绑定 sink：adapter.start 需要一个 sink，而台账行要等 start 返回才知道 id。
    // 适配器契约保证 start() 期间不发事件（turn 由 send 驱动），这里只是双保险。
    let sinkRef: ((event: RuntimeEvent) => void) | null = null;
    const impl = await adapter.start(
      {
        unitId: input.unitId,
        unitName: input.unitName,
        rootPath,
        prompt: effectivePrompt,
        model: effective,
        mode: input.mode,
        reasoningLevel: input.reasoningLevel,
      },
      (event) => sinkRef?.(event),
    );

    const h: HostSession = {
      id: impl.id,
      unitId: input.unitId,
      runtimeId: adapter.id as RuntimeId,
      conversationId: input.conversationId ?? null,
      rootPath,
      title: input.prompt.length > 60 ? input.prompt.slice(0, 60) + "…" : input.prompt,
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      source: input.source ?? "workbench",
      interactive: input.interactive ?? false,
      modelActual: effective === null ? null : String(effective),
      modelHintDropped: droppedHint,
      stats: { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      seq: 0,
      impl,
      adapter,
      lastTool: null,
      lastCliRef: null,
      pendingSends: [],
      turnBusy: true,
      turnCount: 1,
      turnOpen: true,
      cancelRequested: false,
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
      rootPath,
      conversationId: h.conversationId,
      lastSeq: 0,
      stats: { ...h.stats },
    });
    this.store.insertMessage(h.id, Date.now(), "user", input.prompt);
    // 分发日志：用户原话与注入内容**分列**存（docs/10 §2.1 残件）。
    // 有了它才能回答「这一轮它到底知道什么」—— messages 表做不到，
    // 因为那里的 prompt 只是一整块文本，注入部分和用户原话糊在一起。
    // ADR 0012：HANDOFF 交接块同样进这份快照（它也是「它当时知道什么」的一部分）。
    if (injected !== null || handoffBlock !== null) {
      // 分发日志与遥测都是**附属记录**，写不出来绝不能杀掉这一轮对话
      // （review 抓到的阻断项：insertDispatch 原本裸调，一次 SQLITE_BUSY /
      // 磁盘满就会让已启动的 CLI 子进程永远收不到 prompt，UI 上表现为
      // 「会话已开但没反应」）。红线 2 的 fail-open 在这里同样成立。
      try {
        this.store.insertDispatch({
          sessionId: h.id,
          runtimeId: h.runtimeId,
          rootPath,
          userText: redactText(input.prompt),
          injectedBlock: [
            ...(handoffBlock !== null ? [redactText(handoffBlock)] : []),
            ...(injected !== null ? [injected.block] : []), // 已在 injection 侧遮蔽过
          ].join("\n\n"),
          injectedChars: (handoffBlock?.length ?? 0) + (injected?.injectedChars ?? 0),
          parts: injected?.parts ?? [],
          createdAt: h.startedAt,
        });
      } catch (err: unknown) {
        log.warn("dispatch log write failed (session continues)", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      }
      // curator 的判断全靠「上次什么时候被注入过」（docs/10 §4.7）。
      // 这行打点漏了，curator 就永远只能把每条都当成 active。
      if (injected !== null) {
        for (const part of injected.parts) {
          try {
            this.store.markMemoryUsed(part.sourcePath, h.startedAt, part.chars);
          } catch (err: unknown) {
            log.warn("memory telemetry mark failed", { path: part.sourcePath, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    const started: RuntimeEvent = {
      type: "session.started",
      sessionId: h.id,
      unitId: h.unitId,
      // 透明化三细节的落点：来源徽标 + 实际生效模型 + 被丢掉的 hint，
      // 都随第一帧事件发出去，前端在时间轴第一行就能说清（docs/09 §六）
      source: h.source,
      modelActual: h.modelActual ?? undefined,
      modelHintDropped: h.modelHintDropped ?? undefined,
    };
    this.emitStamped(h, started);

    // 首轮 prompt：受理即返回，turn 进展全走事件流
    //（mockperm 这类会在权限处挂起整轮，await 会把 session.start 卡死——冒烟实证）
    //
    // ⚠️ 顺序要紧：**先给 onSessionReady，再 send**。订阅方（飞书流式）必须赶在
    // 第一个 message.delta 之前就位 —— 实测差几十毫秒就会整段丢失。
    if (input.onSessionReady !== undefined) {
      try {
        input.onSessionReady(h.id);
      } catch (err: unknown) {
        log.warn("onSessionReady hook threw (turn continues)", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // 首轮 turn 边界 + 用户轮入账本（ADR 0012）：时间线重建（session.events.since）
    // 从此完整 —— 用户消息是账本事实，不再只存在于前端本地合成。
    // delta 记用户原话 input.prompt，不是记忆注入后的 effectivePrompt（与 messages 表口径一致）。
    this.emitStamped(h, { type: "turn.started", sessionId: h.id, turn: h.turnCount });
    this.emitStamped(h, { type: "message.delta", sessionId: h.id, messageId: `user-${h.turnCount}`, role: "user", text: input.prompt });
    void impl.send(effectivePrompt).catch((err: unknown) => {
      log.error("first turn failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      const errorEvent: RuntimeEvent = { type: "error", sessionId: h.id, message: err instanceof Error ? err.message : String(err), recoverable: false };
      this.emitStamped(h, errorEvent);
      this.endSession(h, "error");
    });
    log.info("session started", { sessionId: h.id, runtimeId: adapter.id, unitId: h.unitId });
    return this.toSession(h);
  }

  /** 事件驱动的持久化钩子：assistant 消息 / usage 账本 / 终态与会话引用 / seq quiesce 落盘 */
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
          // MAX_USAGE 滚动：账本只增不减会一直长（docs/06 §七 定的 4000 行，
          // 之前常量没落地、也没传给 appendJournal）。
          // 失败要留痕：以前是空 catch，写不进去谁也不知道。
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
          }, MAX_USAGE).catch((err: unknown) => {
            log.warn("usage journal append failed", { error: err instanceof Error ? err.message : String(err) });
          });
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
      // seq quiesce 落盘（ADR 0012 不变量 3）：低频事实点持久化，daemon 换代续号。
      // 不逐事件写 —— 流式 delta 每秒几百条，逐条 UPDATE 的代价配不上收益；
      // 崩溃时最多回退到上个 quiesce 点，前端换代走全量重拉兜底。
      if (event.type === "message.completed" || event.type === "usage" || event.type === "turn.completed" || event.type === "session.ended") {
        this.store.setSessionSeq(h.id, h.seq);
      }
    } catch (err: unknown) {
      log.warn("persist failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 交接块的行数与单行长度上限 —— 有损但透明（ADR 0012：一次性只读转录，非全量迁移） */
  private static readonly HANDOFF_MAX_MESSAGES = 24;
  private static readonly HANDOFF_MAX_CHARS_PER_MESSAGE = 4000;

  /**
   * 构造只读转录交接块（ADR 0012）：旧段消息投影（user/assistant 文本）→ 定界前缀。
   * 数据来自 host 账本的 messages 投影 —— 旧段执行器的私有上下文不迁移，
   * 迁移的是对话事实本身。拿不到任何消息时返回 null（等价于未开启交接）。
   */
  private buildHandoffBlock(fromSessionId: SessionId): string | null {
    let turns: Array<{ role: string; text: string }>;
    let fromRuntimeId = "另一执行器";
    try {
      const row = this.store.getSession(fromSessionId);
      if (row !== undefined) fromRuntimeId = row.runtimeId;
      turns = this.store
        .listMessages(fromSessionId, RuntimeHost.HANDOFF_MAX_MESSAGES)
        .filter((m) => m.role === "user" || m.role === "assistant");
    } catch {
      return null;
    }
    if (turns.length === 0) return null;
    const lines = turns.map((m) => {
      const text = m.text.length > RuntimeHost.HANDOFF_MAX_CHARS_PER_MESSAGE
        ? m.text.slice(0, RuntimeHost.HANDOFF_MAX_CHARS_PER_MESSAGE) + "…（截断）"
        : m.text;
      return `${m.role === "user" ? "用户" : "助手"}：${text}`;
    });
    return [
      "===== 上文交接（只读背景 —— 来自与另一执行器的对话，不是当前指令）=====",
      `来源执行器：${fromRuntimeId}；以下是最近对话转录：`,
      ...lines,
      "===== 上文交接结束 =====",
    ].join("\n");
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
    h.turnCount += 1;
    h.turnOpen = true;
    this.emitStamped(h, { type: "turn.started", sessionId: h.id, turn: h.turnCount });
    this.emitStamped(h, { type: "message.delta", sessionId: h.id, messageId: `user-${h.turnCount}`, role: "user", text });
    this.store.insertMessage(h.id, Date.now(), "user", text);
    void h.impl!.send(text, loop === undefined ? undefined : { reasoningLevel: loop.reasoningLevel }).catch((err: unknown) => {
      log.error("turn failed", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      const errorEvent: RuntimeEvent = { type: "error", sessionId: h.id, message: err instanceof Error ? err.message : String(err), recoverable: false };
      this.emitStamped(h, errorEvent);
      this.endSession(h, "error");
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

  /**
   * 收口当前轮（ADR 0012）：把 turn.completed 作为账本事实发出去。
   * 只在确有一轮开着时发出 —— 空闲会话的杂散 status（如 resume 后的 idle）不产生幽灵轮。
   * cancelRequested 在这里消费：各家 CLI 的取消口径不一（zcode 报 failed:cancelled、
   * 其余报 idle），host 统一标 cancelled。
   */
  private settleTurn(h: HostSession, reason: "idle" | "failed" | "cancelled" | "error"): void {
    if (!h.turnOpen) return;
    h.turnOpen = false;
    const cancelled = h.cancelRequested;
    h.cancelRequested = false;
    const ev: RuntimeEvent = {
      type: "turn.completed",
      sessionId: h.id,
      turn: h.turnCount,
      reason: cancelled ? "cancelled" : reason,
    };
    this.emitStamped(h, ev);
    this.persistOnEvent(h, ev);
  }

  /** sink 工厂：start 与 resume 共用同一套盖章/落盘/广播/闸路径 */
  private makeSink(h: HostSession): (event: RuntimeEvent) => void {
    return (event: RuntimeEvent): void => {
      // 仓库级事件（git.changed，无 sessionId）不经会话 sink —— 类型面收窄
      if (!("sessionId" in event)) return;
      const cur = this.sessions.get(event.sessionId);
      if (cur === undefined) return;
      this.emitStamped(cur, event);
      this.track(cur, event);
      this.persistOnEvent(cur, event);
      if (event.type === "permission.requested") this.evaluateGate(cur, event);
      // 轮落定（status idle/failed 或 ended）→ 收口 turn → 清 turnBusy → 自动发出排队消息（T3 steer）
      if (
        (event.type === "session.status" && (event.status === "idle" || event.status.startsWith("failed"))) ||
        event.type === "session.ended"
      ) {
        this.settleTurn(
          cur,
          event.type === "session.ended" ? "error" : event.status.startsWith("failed") ? "failed" : "idle",
        );
        cur.turnBusy = false;
        this.flushPendingSends(cur);
      }
      // 唤醒等这一类事件的等待者（usage = turn 级完成，Ops 用）
      const waiters = this.eventWaiters.get(cur.id);
      if (waiters !== undefined) {
        // 只唤醒 afterSeq 落在本条事件之前的等待者——旧游标的等待者继续等它自己的轮
        const hit = waiters.filter((w) => w.type === event.type && w.afterSeq < cur.seq);
        if (hit.length > 0) {
          this.eventWaiters.set(cur.id, waiters.filter((w) => !(w.type === event.type && w.afterSeq < cur.seq)));
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
    const at = Date.now();
    h.events.push({ seq, at, event });
    if (h.events.length > 500) h.events.splice(0, h.events.length - 500);
    // 推送订阅者（飞书流式用它把增量文本刷到 IM）。**回调一律包 try**：
    // 订阅方是自己的代码，它炸了不能反过来掀翻这一轮派发。
    for (const w of [...(this.eventSubs.get(h.id) ?? [])]) {
      if (w.type !== "" && w.type !== event.type) continue;
      try {
        w.cb(event, seq);
      } catch (err: unknown) {
        log.warn("session event subscriber threw", { sessionId: h.id, type: event.type, error: err instanceof Error ? err.message : String(err) });
      }
    }
    void this.trace
      .append({ seq, at: Date.now(), sessionId: h.id, unitId: h.unitId, runtimeId: h.runtimeId, event })
      .catch((err: unknown) => {
        // canonical 账本写失败必须可观测（ADR 0012）：以前吞错，坏盘/权限问题时
        // 账本静默缺行，投影重放会无声丢历史。日志 + kv 计数器双留痕。
        log.warn("trace append failed (ledger gap risk)", {
          sessionId: h.id,
          seq,
          error: err instanceof Error ? err.message : String(err),
        });
        this.countTraceFailure();
      });
    this.broadcast(event, seq);
  }

  /** 账本写失败计数（kv: trace_append_failures）—— daemon 健康面可查 */
  private countTraceFailure(): void {
    try {
      const cur = Number(this.store.kvGet("trace_append_failures") ?? "0");
      this.store.kvSet("trace_append_failures", String(cur + 1));
    } catch {
      // 计数也写不进去就只剩日志了，不再升级
    }
  }

  /**
   * 订阅某会话的事件流。返回退订函数。
   *
   * 用途：飞书/telegram 的**流式输出** —— 它们要在 `message.delta` 到达时
   * 就把文本刷到 IM，而不是等整轮跑完只发一条。
   *
   * 为什么不复用 `waitForSessionEvent`：那是**一次性**的（等到就 resolve），
   * 拿不到「第二个 delta」。也不复用 `sessionEvents`：那是读环形缓冲，**轮询**，
   * 而 350ms 一次的 IM 往返经不起轮询延迟。
   *
   * 纯新增，不改任何既有行为。
   */
  onSessionEvent(sessionId: SessionId, type: string, cb: (event: RuntimeEvent, seq: number) => void): () => void {
    const list = this.eventSubs.get(sessionId) ?? [];
    const w = { type, cb };
    list.push(w);
    this.eventSubs.set(sessionId, list);
    return () => {
      const cur = this.eventSubs.get(sessionId);
      if (cur === undefined) return;
      const i = cur.indexOf(w);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  private readonly eventSubs = new Map<SessionId, Array<{ type: string; cb: (event: RuntimeEvent, seq: number) => void }>>();

  /** 依次发出排队消息；当前轮仍忙或会话死挂则停手（下一轮落定会再触发） */
  private flushPendingSends(h: HostSession): void {
    // 评审 P2：ended 会话不再复活派发——session.ended 也走 flush 路径，无此守卫会把
    // 排队插话逐条打进死会话变成 error 风暴（与 steer.undelivered 语义矛盾）
    if (h.turnBusy || h.impl === null || h.endedAt !== undefined) return;
    const next = h.pendingSends.shift();
    if (next === undefined) return;
    log.info("dispatching queued message", { sessionId: h.id, remaining: h.pendingSends.length });
    // WP-10：注入点事件化——前端据此把 pre/post-steer 的助手消息分行
    this.emitStamped(h, { type: "steer.boundary", sessionId: h.id, text: next.text });
    this.dispatchSend(h, next.text, next.loop);
  }

  /**
   * host 自产的终态（轮次失败等）—— 必须与 makeSink 的 `session.ended` 分支走同一条路。
   *
   * 只 emitStamped 是不够的：`track()` 才写 h.endedAt/status，`persistOnEvent()` 才落盘，
   * endWaiters 才被唤醒。漏掉 track 的直接后果是 flushPendingSends 的「会话已死」守卫
   * （`h.endedAt !== undefined`，见上）永远不成立 —— 于是排队插话会被继续打进这条
   * 刚失败的会话，正是那条守卫的注释要防的 error 风暴；等 session 结束的调用方
   * （bot.ask / webhook 的 waitMs）也只能干等到超时。
   */
  private endSession(h: HostSession, reason: string): void {
    // 派发失败收口：先把开着的那一轮按 error 落进账本，再记会话终态
    this.settleTurn(h, "error");
    const ended: RuntimeEvent = { type: "session.ended", sessionId: h.id, reason };
    this.emitStamped(h, ended);
    this.track(h, ended);
    this.persistOnEvent(h, ended);
    h.turnBusy = false;
    this.flushPendingSends(h);
    const ends = this.endWaiters.get(h.id);
    if (ends !== undefined) {
      this.endWaiters.delete(h.id);
      for (const w of ends) w.resolve();
    }
  }

  /** 权限闸（Phase 4）：规则命中就自动决策；交互会话不命中保持挂起等人 */
  private evaluateGate(h: HostSession, event: Extract<RuntimeEvent, { type: "permission.requested" }>): void {
    const key = `${h.id}:${event.requestId}`;
    this.pendingPerms.set(key, { kind: event.kind, detail: event.detail });
    const decision = this.gate.evaluate(h.runtimeId, event.kind, h.lastTool ?? "", event.detail);
    if (decision !== null) {
      // 同步占位：自动裁决成立的同一 tick 就摘牌，晚到的人工点击在
      // resolvePermission 的首响判定处直接出局，落不进 always 规则
      this.pendingPerms.delete(key);
      log.info("permission auto-resolved by rule", { sessionId: h.id, requestId: event.requestId, decision });
      void h.impl?.resolvePermission(event.requestId, decision).catch((err: unknown) =>
        log.warn("gate auto-resolve failed", { error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    // headless 会话（automation / webhook / mcp / 飞书等无人可等的渠道）挂着就是
    // 永远挂着：运行记录卡 running、渠道这轮永远不回。按 docs/08 的既定语义
    // 【完全放行】——敏感命令的收口靠 deny 规则（上面 evaluate 已按规则优先拦过一轮）。
    // 例外是 interactive 渠道会话（IM 审批按钮 / 移动端确认门）：闸门是他们存在的
    // 全部意义，自动放行等于把确认门变成装饰品——必须挂起等渠道侧的人裁决。
    if (h.source !== "workbench" && !h.interactive) {
      this.pendingPerms.delete(key);
      log.info("permission auto-allowed for headless session", { sessionId: h.id, requestId: event.requestId, source: h.source });
      void h.impl?.resolvePermission(event.requestId, "allow").catch((err: unknown) =>
        log.warn("headless auto-allow failed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  async cancelSession(sessionId: SessionId): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is not live`);
    // 取消意图先记号：后续落定事件（各家口径不一）统一翻成 turn.completed: cancelled
    const wasBusy = h.turnBusy;
    if (wasBusy) h.cancelRequested = true;
    try {
      await h.impl.cancel();
    } catch (err: unknown) {
      if (wasBusy) h.cancelRequested = false;
      throw err;
    }
  }

  async resolvePermission(sessionId: SessionId, requestId: string, decision: "allow" | "deny" | "always"): Promise<void> {
    const h = this.sessions.get(sessionId);
    if (h === undefined) throw adapterError("unknown_session", `no such session: ${sessionId}`);
    if (h.impl === null) throw adapterError("session_not_live", `session ${sessionId} is not live`);
    // 首响仲裁（复审 P1）：pendingPerms 的查与删在同一个同步块里完成——
    // 另一端并发点击 / IM 迟到的回调在这里直接出局：不落 always 规则、不补发
    // 「实际没生效的裁决」事件（那会把时间线徽标覆盖成假的）。
    const key = `${sessionId}:${requestId}`;
    const meta = this.pendingPerms.get(key);
    if (meta === undefined) {
      log.warn("permission resolution dropped (not pending: already resolved or unknown)", { sessionId, requestId, decision });
      return;
    }
    this.pendingPerms.delete(key);
    await h.impl.resolvePermission(requestId, decision);
    // always：落规则表，同类请求下次不再问（pattern 用最近工具名，detail 兜底）。
    // 放在 impl 首响成立**之后**：迟到的 always 不再有机会改写放行面。
    if (decision === "always") {
      const pattern = h.lastTool ?? meta.detail ?? requestId;
      const id = this.gate.addRule({
        runtimeId: h.runtimeId,
        kind: meta.kind,
        pattern,
        decision: "allow",
      });
      log.info("permission rule added (always)", { id, runtimeId: h.runtimeId, pattern });
    }
    // 注：permission.resolved 事件**不在这里补发**——适配器在 resolvePermission
    // 内部经 sink 发过一份（claude/mockperm/kimi/… 均如此），host 再发会造成
    // trace 双写与广播双帧；无人值守来源也不会丢事件：规则自动裁决同样走适配器。
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
    // 收尾把全部会话的 seq 落库（ADR 0012）：正常停机不丢 quiesce 点之后的进度
    for (const h of this.sessions.values()) {
      try {
        this.store.setSessionSeq(h.id, h.seq);
      } catch (err: unknown) {
        log.warn("session seq flush failed on shutdown", { sessionId: h.id, error: err instanceof Error ? err.message : String(err) });
      }
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
    if (h !== undefined && h.impl !== null && h.status !== "done" && h.status !== "failed") {
      throw adapterError("session_live", "live session cannot be forgotten — cancel it first");
    }
    this.store.deleteSession(sessionId);
    this.sessions.delete(sessionId);
    this.eventWaiters.delete(sessionId); // 评审 P3：等待者/挂起权限一并清，防悬挂到自身超时
    for (const key of [...this.pendingPerms.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.pendingPerms.delete(key);
    }
    log.info("session forgotten", { sessionId });
  }
}

/**
 * 「X 前」的人话时间戳，给兜底缓存的标记用。
 *
 * 刻意**不引第三方格式化库**：这里要的是「大概多久」而不是精确到秒，
 * 一旦写成 `2026-10-16T01:23:45Z` 用户根本不会去算那是多久以前。
 */
function relativeTime(at: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  return day < 30 ? `${day} 天前` : `${Math.round(day / 30)} 个月前`;
}

/**
 * 两份执行器模型清单是否实质相同 —— 逐字段比。
 *
 * 只比 id 是不够的：执行器给同一个模型改了上下文窗口或显示名而 id 没动时，
 * 会把一次真实变化判成「没变」，于是既不更新缓存也不重写盘，
 * 用户按了刷新却什么都没发生。
 */
function sameExecutorModels(
  a: readonly ExecutorModelInfo[],
  b: readonly ExecutorModelInfo[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    if (o === undefined) return false;
    // 推理档位也要比（复审 P1）：CLI 给同一模型改档位而 id/窗口没动时，
    // 不比就会把真实变化判成「没变」——与前端 registry.sameModelList 口径对齐
    const sameLevels = (x: readonly string[] | undefined, y: readonly string[] | undefined): boolean => {
      if (x === y) return true;
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      return x.every((v, j) => v === y[j]);
    };
    return (
      m.id === o.id &&
      m.displayName === o.displayName &&
      m.contextWindow === o.contextWindow &&
      m.maxOutput === o.maxOutput &&
      m.multimodal === o.multimodal &&
      m.defaultReasoningLevel === o.defaultReasoningLevel &&
      m.inputPerMTok === o.inputPerMTok &&
      m.outputPerMTok === o.outputPerMTok &&
      sameLevels(m.reasoningLevels, o.reasoningLevels)
    );
  });
}
