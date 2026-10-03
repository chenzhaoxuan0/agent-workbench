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
import { defaultModelFor, sortModels, type ModelId, type ModelSpec } from "./models.ts";
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

  // ---- 注册 ----

  register(factory: AdapterFactory): void {
    // 空模型清单 = 这个执行器没法开工。放到这里拒，
    // 是为了让问题在注册那一刻就炸，而不是在用户点了发送之后。
    if (factory.models.length === 0) {
      throw new Error(`执行器 ${factory.id} 未声明可用模型`);
    }
    this.#factories.set(factory.id, factory);
    this.#states.set(factory.id, { status: "stopped" });
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
    const models = sortModels(f.models);
    const first = defaultModelFor(models);
    if (!first) return null;
    return {
      id,
      presentation: f.presentation,
      capabilities: f.capabilities,
      testOnly: f.testOnly === true,
      transportKind: f.transport.kind,
      models,
      defaultModel: first,
      state: this.#states.get(id) ?? { status: "stopped" },
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
