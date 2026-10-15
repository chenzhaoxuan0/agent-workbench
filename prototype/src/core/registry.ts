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

  // ---- 注册 ----

  register(factory: AdapterFactory): void {
    // 空模型清单 = 这个执行器没法开工。放到这里拒，
    // 是为了让问题在注册那一刻就炸，而不是在用户点了发送之后。
    if (factory.models.length === 0) {
      throw new Error(`执行器 ${factory.id} 未声明可用模型`);
    }
    this.#factories.set(factory.id, factory);
    this.#states.set(factory.id, { status: "unprobed" });
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
    // ⚠ 已知问题（本次审查记录，未改）：`models[0]?.id ?? defaultModelFor(models)` 里
    // defaultModelFor 永远轮不到（models 非空时第一项就有值），于是 models.ts 里
    // 「默认取均衡档」的规则成了死代码，默认模型 = daemon 列在第一个的那个
    // （codex 实测是旗舰档 gpt-6-astra，$10/$50 per MTok）。
    // 不能简单换成 `defaultModelFor(models) ?? models[0]?.id`：动态同步进来的
    // 未收录模型会被 scaffoldModel 标成 balanced，反而抢在目录里已知的均衡档前面。
    // 要修得先决定「未收录模型能不能当默认」，属于产品决策。
    const first = models[0]?.id ?? defaultModelFor(models);
    if (!first) return null;
    return {
      id,
      presentation: f.presentation,
      capabilities: f.capabilities,
      testOnly: f.testOnly === true,
      transportKind: f.transport.kind,
      models,
      modelsDiscoverable: this.#modelDiscoverable.get(id) ?? true,
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
   * @returns 是否真的换了清单（换了才 emit，避免空刷新把整个界面重渲一遍）
   */
  updateModels(id: RuntimeId, raw: readonly RawExecutorModel[], discoverable: boolean): boolean {
    this.#modelDiscoverable.set(id, discoverable);
    const prev = this.#modelOverrides.get(id);
    // 清单没变就别 emit —— 每家执行器都刷新一次的话，全量 emit 会让下拉框反复重建
    if (prev !== undefined && prev.length === raw.length && prev.every((m, i) => m.id === raw[i]?.id)) {
      return false;
    }
    this.#modelOverrides.set(id, raw);
    this.#emit();
    return true;
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

/** 全局单例。Electron 阶段会按窗口隔离。 */
export const runtimeRegistry = new RuntimeRegistry();
