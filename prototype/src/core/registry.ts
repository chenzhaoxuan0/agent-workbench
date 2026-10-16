/**
 * 运行时注册表 —— 所有工具在这里被同等对待。
 *
 * 参照 t3code 的 EnvironmentRegistry.register()，但用 Map + 事件替代
 * Effect SubscriptionRef。UI 从这里取"有哪些工具、各自什么状态"。
 *
 * 关键：注册表不认识 ZCode / Claude Code / Codex 任何一个。
 * 它只认识 RuntimeId 字符串。厂商知识全部关在 adapters/ 里。
 */

import type { AdapterFactory, ConnectionState, RuntimeAdapter } from "./adapter.ts";
import type { RawExecutorModel } from "./adapter.ts";
import { defaultModelFor, modelById, scaffoldModel, sortModels, type ModelId, type ModelSpec } from "./models.ts";
import { asRuntimeId, type RuntimeId } from "./units.ts";

export interface RuntimeEntry {
  readonly id: RuntimeId;
  readonly presentation: AdapterFactory["presentation"];
  readonly capabilities: AdapterFactory["capabilities"];
  /** 测试夹具（mockperm），不是真工具。UI 要照实标出来 */
  readonly testOnly: boolean;
  /** 传输方式，UI 调试面板用 */
  readonly transportKind: string;
  /** 该执行器能用的模型（按菜单序排好），UI 靠它建模型下拉 */
  readonly models: readonly ModelSpec[];
  /** 该执行器能否动态发现模型清单。false = 刷新按钮对它无效，UI 要照实标 */
  readonly modelsDiscoverable: boolean;
  /**
   * 上面这份 models 来自 daemon 的兜底缓存、缓存写于何时；null = 本次真探到的。
   *
   * UI 靠它显示「来自上次探测 · X 前」。**别把它当新鲜度指标**——
   * 我们刻意不给缓存设 TTL（探不到就是探不到，宁可告诉你多旧也不假装新鲜）。
   */
  readonly modelsCachedAt: number | null;
  /**
   * 失效模型：上一次成功探测里有、最近一次成功探测里已经不在的模型。
   *
   * 它们**不在** `models` 里（不占下拉框位置），但仍保留完整 spec ——
   * 因为用户可能正选着它、或在定时任务里配着它，界面必须能显示
   * 「X（不可用）」，而不是在用户不知情时把选择悄悄换成别的模型。
   *
   * 只在 `source === "live"` 的轮次里增删：探测失败那轮沿用旧清单，
   * 此时既不认定任何模型失效，也不复活任何模型。
   */
  readonly retiredModels: readonly ModelSpec[];
  /** 相对该执行器的默认模型。非 null —— 注册时就不允许空清单 */
  readonly defaultModel: ModelId;
  readonly state: ConnectionState;
}

type Listener = (entries: readonly RuntimeEntry[]) => void;

export class RuntimeRegistry {
  readonly #factories = new Map<RuntimeId, AdapterFactory>();
  readonly #adapters = new Map<RuntimeId, RuntimeAdapter>();
  readonly #states = new Map<RuntimeId, ConnectionState>();
  readonly #listeners = new Set<Listener>();
  /**
   * 模型清单覆盖层：执行器 id → 最近一次刷新拿到的 daemon 原生清单。
   *
   * ## 为什么需要这一层
   *
   * `AdapterFactory` 是**注册那一刻**的快照（`rawModels` 来自 bootstrap 那次
   * `adapter.list`）。订阅里新出了模型，daemon 侧刷新了，工厂里的数组却还是旧的，
   * 于是「刷新了但界面不变」。
   *
   * 工厂本身是 readonly 的（不想让它变成可变状态袋），所以刷新结果记在这里，
   * `#entry` 优先读覆盖层。两边都能对上时（刷新回来的清单与注册快照一致）行为不变。
   */
  readonly #modelOverrides = new Map<RuntimeId, readonly RawExecutorModel[]>();
  /** 该执行器能否动态发现模型清单（daemon 侧能力标记） */
  readonly #modelDiscoverable = new Map<RuntimeId, boolean>();
  /**
   * 失效模型留档：执行器 id → 模型 id → 最后一次见到的完整 spec。
   *
   * 为什么要留 spec 而不只留 id：模型可能不在本地目录里（daemon 动态发现的
   * 新模型），只存 id 的话界面渲染不出它的名字，用户看到的是一串空气。
   *
   * 上限 8 家/家：绝大多数执行器一辈子不会下线超过几个模型，留满是无意义的
   * 内存增长；而一个从没见过的执行器不会一上来就有 8 个失效模型，所以这个
   * 截断只会发生在「长期跟踪同一家」的场景，代价可接受。
   */
  readonly #retired = new Map<RuntimeId, Map<ModelId, ModelSpec>>();
  /** 每家当前清单的来源标记：null = 真探到；数字 = 兜底缓存的写入时刻 */
  readonly #modelCachedAt = new Map<RuntimeId, number | null>();
  /** 退役留档的条数上限（见 #retired） */
  static readonly RETIRED_LIMIT = 8;

  // ---- 注册 ----

  register(factory: AdapterFactory): void {
    // 空模型清单 = 这个执行器没法开工。放到这里拒，
    // 是为了让问题在注册那一刻就炸，而不是在用户点了发送之后。
    if (factory.models.length === 0) {
      throw new Error(`执行器 ${factory.id} 未声明可用模型`);
    }
    this.#factories.set(factory.id, factory);
    this.#states.set(factory.id, { status: "unprobed" });
    // 注册快照自带兜底标记的话，登记下来 —— 否则 bootstrap 拿到的是缓存清单，
    // 界面却会说「已刷新」，正是要治的那个毛病。
    this.#modelCachedAt.set(factory.id, factory.modelsCachedAt ?? null);
    this.#emit();
  }

  registerAll(factories: readonly AdapterFactory[]): void {
    for (const f of factories) this.register(f);
  }

  has(id: RuntimeId): boolean {
    return this.#factories.has(id);
  }

  #entry(id: RuntimeId): RuntimeEntry | null {
    const f = this.#factories.get(id);
    if (!f) return null;
    const rawOverride = this.#modelOverrides.get(id);
    const raw = rawOverride && rawOverride.length > 0 ? rawOverride : f.rawModels;
    let models: ModelSpec[];
    if (raw && raw.length > 0) {
      models = raw.map((m) => {
        const known = modelById(m.id);
        if (known) {
          return {
            ...known,
            displayName: m.displayName || known.displayName,
            contextWindow: m.contextWindow ?? known.contextWindow,
            maxOutput: m.maxOutput ?? known.maxOutput,
            reasoningLevels: m.reasoningLevels ?? known.reasoningLevels,
            defaultReasoningLevel: m.defaultReasoningLevel ?? known.defaultReasoningLevel,
            multimodal: m.multimodal ?? known.multimodal,
            inputPerMTok: m.inputPerMTok ?? known.inputPerMTok,
            outputPerMTok: m.outputPerMTok ?? known.outputPerMTok,
          };
        }
        return scaffoldModel(m.id, m.displayName, m);
      });
    } else {
      models = [...sortModels(f.models)];
    }
    // 默认模型 = **已收录模型**里挑均衡档；实在一个都没有才退回第一个。
    //
    // 为什么不能直接 `defaultModelFor(models)`：scaffoldModel 把所有未收录模型
    // 一律标成 balanced，于是「均衡档优先」这条规则会让一个刚探回来的、我们根本
    // 不了解强弱的新模型抢在目录里已知的均衡档前面当默认。用户什么都不选，
    // 默认拿到的就是个来路不明的模型。
    // 为什么不能只用 `models[0]`：那是 daemon 的排列顺序，不是用户意图。
    // codex 实测列在第一个的是旗舰档 gpt-6-astra（$10/$50 per MTok）——
    // 等于什么都不选就按最贵的跑。
    const catalogued = models.filter((m) => modelById(m.id) !== undefined);
    const first = defaultModelFor(catalogued.length > 0 ? catalogued : models) ?? models[0]?.id;
    if (!first) return null;
    return {
      id,
      presentation: f.presentation,
      capabilities: f.capabilities,
      testOnly: f.testOnly === true,
      transportKind: f.transport.kind,
      models,
      modelsDiscoverable: this.#modelDiscoverable.get(id) ?? true,
      modelsCachedAt: this.#modelCachedAt.get(id) ?? null,
      retiredModels: [...(this.#retired.get(id)?.values() ?? [])],
      defaultModel: first,
      state: this.#states.get(id) ?? { status: "unprobed" },
    };
  }

  list(): readonly RuntimeEntry[] {
    return [...this.#factories.keys()]
      .map((id) => this.#entry(id))
      .filter((e): e is RuntimeEntry => e !== null);
  }

  get(id: RuntimeId): RuntimeEntry | undefined {
    return this.#entry(id) ?? undefined;
  }

  /** 按展示名查找，UI 顶栏用 */
  byDisplayName(name: string): RuntimeEntry | undefined {
    return this.list().find((e) => e.presentation.displayName === name);
  }

  resolveId(nameOrId: string): RuntimeId | undefined {
    const direct = asRuntimeId(nameOrId);
    if (this.#factories.has(direct)) return direct;
    return this.list().find((e) => e.presentation.displayName === nameOrId)?.id;
  }

  // ---- 状态 ----

  setState(id: RuntimeId, state: ConnectionState): void {
    this.#states.set(id, state);
    this.#emit();
  }

  // ---- 模型清单刷新 ----

  /**
   * 用刷新回来的 daemon 原生清单替换该执行器的模型清单，并标记它能否动态发现。
   *
   * @param cachedAt 这份清单来自 daemon 的兜底缓存、缓存写于何时；
   *                 **省略 = 本轮真探到了**。这个区分是整套失效模型机制的地基：
   *                 探测失败那轮沿用旧清单，此时既不认定任何模型失效，也不复活任何模型。
   *
   * @returns 是否真的换了清单（换了才 emit，避免空刷新把整个界面重渲一遍）
   */
  updateModels(
    id: RuntimeId,
    raw: readonly RawExecutorModel[],
    discoverable: boolean,
    cachedAt?: number,
  ): boolean {
    const prevRaw = this.#modelOverrides.get(id);
    const prevCachedAt = this.#modelCachedAt.get(id) ?? null;
    const nextCachedAt = cachedAt ?? null;

    // 退役增删必须排在「无变化就提前返回」**之前**：清单没变不代表
    // 「这份清单是不是探来的」没变，而且顺序反了会在首次拿到实时清单时
    // 把刚出现的模型误判成「上一个执行器的遗留」。
    if (cachedAt === undefined) this.#reconcileRetired(id, raw);

    if (
      prevRaw !== undefined &&
      sameModelList(prevRaw, raw) &&
      this.#modelDiscoverable.get(id) === discoverable &&
      prevCachedAt === nextCachedAt
    ) {
      return false; // 真的什么都没变，不必 emit
    }
    this.#modelDiscoverable.set(id, discoverable);
    this.#modelOverrides.set(id, raw);
    this.#modelCachedAt.set(id, nextCachedAt);
    this.#emit();
    return true;
  }

  /**
   * 对齐失效模型留档：清单里没有的旧模型退役，回归的模型复活。
   *
   * 只在真探到的那轮调用（见 updateModels 的 cachedAt 语义）。
   * 退役时存的是**上一轮的完整 spec**，不是重新去目录里查 —— 动态发现的新模型
   * 本来就不在目录里，只存 id 会让界面渲染不出它的名字。
   */
  #reconcileRetired(id: RuntimeId, raw: readonly RawExecutorModel[]): void {
    const next = new Map<ModelId, ModelSpec>(this.#retired.get(id) ?? []);
    for (const m of raw) next.delete(m.id);
    const seen = new Set(raw.map((m) => m.id));
    for (const spec of this.#entry(id)?.models ?? []) {
      if (seen.has(spec.id)) continue;
      next.set(spec.id, spec);
    }
    while (next.size > RuntimeRegistry.RETIRED_LIMIT) {
      const oldest = next.keys().next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
    if (next.size === 0) this.#retired.delete(id);
    else this.#retired.set(id, next);
  }

  /** bootstrap 阶段登记该执行器的发现能力（还没拿到模型清单，只标能力） */
  markModelDiscovery(id: RuntimeId, discoverable: boolean): void {
    this.#modelDiscoverable.set(id, discoverable);
  }

  // ---- 实例化 ----

  async getOrCreate(id: RuntimeId): Promise<RuntimeAdapter> {
    const cached = this.#adapters.get(id);
    if (cached) return cached;
    const factory = this.#factories.get(id);
    if (!factory) throw new Error(`未注册的运行时: ${id}`);
    const adapter = await factory.create();
    this.#adapters.set(id, adapter);
    return adapter;
  }

  // ---- 订阅 ----

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    fn(this.list());
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    const snapshot = this.list();
    for (const fn of this.#listeners) fn(snapshot);
  }
}

/**
 * 两份清单是否**实质**相同。
 *
 * ⚠ 早先只比 id，结果漏掉了最该刷的那类变化：执行器给同一个模型改了上下文窗口、
 * 显示名或推理档位，但 id 一个没动。表现就是「我按了刷新，界面说无变化」，
 * 而那个过期的 200000 窗口还挂着 —— 正是这套机制本来要消灭的毛病。
 * 所以逐字段比，宁可多 emit 一次也不能把真实变化判成没变。
 */
function sameModelList(a: readonly RawExecutorModel[], b: readonly RawExecutorModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    if (o === undefined) return false;
    return (
      m.id === o.id &&
      m.displayName === o.displayName &&
      m.contextWindow === o.contextWindow &&
      m.maxOutput === o.maxOutput &&
      m.multimodal === o.multimodal &&
      m.defaultReasoningLevel === o.defaultReasoningLevel &&
      sameStrings(m.reasoningLevels, o.reasoningLevels) &&
      m.inputPerMTok === o.inputPerMTok &&
      m.outputPerMTok === o.outputPerMTok
    );
  });
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** 全局单例。Electron 阶段会按窗口隔离。 */
export const runtimeRegistry = new RuntimeRegistry();
