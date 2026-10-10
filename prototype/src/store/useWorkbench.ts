import { create } from "zustand";
import type { Automation } from "../core/automation.ts";
import { type ModelSpec } from "../core/models.ts";
import { asUnitId, type UnitId, type WorkUnit } from "../core/units.ts";
import type { AutomationWriteInput } from "../adapters/daemon/client.ts";
import {
  normalizePrefs,
  parsePrefsMap,
  prefsOf,
  pruneEmptyPrefs,
  resolveVisibleModels,
  type ModelPrefsMap,
  type ProviderModelPrefs,
} from "../core/modelPrefs.ts";
import { runtimeRegistry, type RuntimeEntry } from "../core/registry.ts";
import type { ChannelIdentityMap, LarkBotIdentity } from "../adapters/daemon/client.ts";

// 注册执行器：见文件末尾的 bootstrap（优先本地 daemon，回退 mock）。
// [BISECT] sync mock disabled

export type ViewMode = "bot" | "project";

/**
 * 执行器实例偏好 —— 对齐 T3 ProviderInstanceCard 的可编辑面：
 * 启用开关、显示名覆盖、端点覆盖、启动参数、环境变量、最近探测时间。
 */
export interface RuntimePref {
  readonly enabled: boolean;
  readonly displayName?: string;
  readonly endpoint?: string;
  readonly launchArgs?: string;
  readonly envVars?: readonly { key: string; value: string }[];
  readonly lastCheckedAt?: number;
}

/**
 * agent loop 参数曾存这里（mode/reasoning），随工作台发话链路一起移除。
 */

interface WorkbenchState {
  units: readonly WorkUnit[];
  activeUnitId: UnitId;
  view: ViewMode;
  runtimes: readonly RuntimeEntry[];
  activeRuntimeId: string;
  /**
   * 每个 CLI 各自的模型偏好（隐藏 / 排序 / 收藏 / 自定义模型）。
   * 对齐 T3code 的 `providerModelPreferences` + `customModels`。
   */
  modelPrefs: ModelPrefsMap;
  /** 偏好变更计数。偏好对象每次都是新的，effect 要个稳定的触发源 */
  modelPrefsVersion: number;
  /** 执行器实例偏好（T3 Providers 页逻辑：启用开关 / 覆盖 / 环境变量） */
  runtimePrefs: Readonly<Record<string, RuntimePref>>;
  setRuntimePref: (id: string, patch: Partial<Omit<RuntimePref, "enabled">> & { enabled?: boolean }) => void;
  /** 全量重探测（T3 的 Checked 刷新） */
  probeAll: () => Promise<void>;
  /**
   * `lark-cli profile → 那个 profile 是哪个飞书机器人`（应用名 + 头像）。
   *
   * 没有它，侧栏只能显示一个通用图标 + 设置页只能显示一串 cli_xxx —— 用户
   * 无法判断哪个 bot 接的是哪个飞书机器人，而这正是「每 bot 一个机器人」的前提。
   */
  channelIdentity: ChannelIdentityMap;
  /**
   * 拉取机器人身份。不传 profiles = 问盘上所有已启用飞书账号（侧栏用）；
   * 传了 = 只认这几个（设置页正在配、还没保存的草稿 profile）。
   * 失败不抛：认不出来是常态，界面要显示「认不出来 + 原因」而不是空白。
   */
  refreshChannelIdentity: (profiles?: readonly string[]) => Promise<void>;

  setView: (v: ViewMode) => void;
  selectUnit: (id: UnitId) => void;
  addUnit: (u: WorkUnit) => Promise<void>;
  /**
   * 改已有单元（bot 设置页保存）。按 id 替换，不切 activeUnitId，同样写穿 bot.json
   * 与 AGENTS.md。guards 传进入设置页时看到的 revision / AGENTS.md hash 作乐观锁基线。
   *
   * 盘上在这期间被改过（VS Code 改了文件 / 另一个窗口保存）时**抛 code="conflict"**，
   * 且不会写盘——调用方负责弹「覆盖 / 重新加载 / 取消」。
   */
  updateUnit: (u: WorkUnit, guards?: BotWriteGuards) => Promise<void>;
  /**
   * 重拉某个单元的定义（settings 面板的「重新加载」）。daemon 无缓存，每次都重扫盘，
   * 所以这能拿到用户在 VS Code 里改完的 AGENTS.md 新内容。
   */
  reloadUnit: (id: UnitId) => Promise<WorkUnit | null>;
  selectRuntime: (id: string) => void;
  /** 改某个 CLI 的模型偏好。动作原子，不合法的输入原样返回由调用方处理 */
  setModelPrefs: (runtimeId: string, next: ProviderModelPrefs) => void;
  /** 批量入口：给一组动作依次应用，任一步失败则整组不动 */
  applyModelPrefs: (runtimeId: string, steps: readonly ((p: ProviderModelPrefs) => ProviderModelPrefs)[]) => void;
  /**
   * 定时任务 —— 权威数据在 daemon（SQLite），这里只是运行态视图。
   * 每个动作都「先调 daemon、成功后刷新」，失败在 automationNotice 里说实话。
   */
  automations: readonly Automation[];
  /** 页面级通知（操作成败的一行实话）。null = 无 */
  automationNotice: { readonly kind: "error" | "info"; readonly text: string } | null;
  setAutomationNotice: (n: { readonly kind: "error" | "info"; readonly text: string } | null) => void;
  /** 从 daemon 重拉全量（启动、页面挂载、每次写操作之后） */
  refreshAutomations: () => Promise<void>;
  toggleAutomation: (id: string) => Promise<void>;
  createAutomationAction: (input: AutomationWriteInput) => Promise<boolean>;
  updateAutomationAction: (id: string, patch: AutomationWriteInput) => Promise<boolean>;
  deleteAutomationAction: (id: string) => Promise<void>;
  runAutomationNowAction: (id: string) => Promise<void>;
}

/* ------------------------------------------------------------------ 模型偏好 */

/** 某个 CLI 适配器**声明**的内置模型（不含用户自定义）。
 *  ⚠ 未注册时的兜底必须是**稳定引用**的空数组：返回字面量 [] 会让
 *  visibleModelsFor 的缓存永不命中 → getSnapshot 每次新数组 →
 *  React 19 无限循环白屏（registry 异步装填的首个渲染窗口必踩）。 */
const EMPTY_MODELS: readonly ModelSpec[] = [];

function declaredOf(s: WorkbenchState, runtimeId: string): readonly ModelSpec[] {
  return s.runtimes.find((r) => r.id === runtimeId)?.models ?? EMPTY_MODELS;
}

/**
 * 某个 CLI 在选择器里**实际可选**的模型：声明 + 自定义 − 隐藏，再按偏好排序。
 * 可见性判定的唯一入口 —— 设置页、选择器、自检共用它，避免各写一套又漂移。
 *
 * ⚠⚠ 这里**必须**做引用记忆，返回稳定的数组。理由比一般情况更硬：
 * 自定义模型每次都由 `customToSpec` 现造一个新对象，所以数组里的元素
 * 引用每次都变。`useShallow` 逐元素比引用 → 永远不相等 → 缓存永不命中
 * → React 19 判为无限循环（"getSnapshot should be cached"）。
 * 这个坑在无自定义模型时看不见，一添加自定义模型立刻炸。
 *
 * 判据用**输入的引用**（declared / prefs 都是稳定来源），一次比较即可。
 *
 * 缓存按 runtimeId 分槽（Map）。曾经是单槽：只要渲染期间有第二个
 * runtime 来查一遍清单（比如选择器 rail 标题里的计数），订阅者的缓存槽
 * 就被踩掉，getSnapshot 下一次返回新数组 → React 19 无限循环 → 白屏。
 * 多槽后每个订阅者各占各的槽位，互不踩踏。
 */
let modelsMemo = new Map<string, { declared: readonly ModelSpec[]; prefs: ProviderModelPrefs; out: readonly ModelSpec[] }>();

export function visibleModelsFor(s: WorkbenchState, runtimeId: string): readonly ModelSpec[] {
  const declared = declaredOf(s, runtimeId);
  const prefs = prefsOf(s.modelPrefs, runtimeId);
  const hit = modelsMemo.get(runtimeId);
  if (hit && hit.declared === declared && hit.prefs === prefs) return hit.out;
  const out = resolveVisibleModels(declared, prefs);
  modelsMemo.set(runtimeId, { declared, prefs, out });
  return out;
}


const PREFS_KEY = "agent-workbench:model-prefs";

function readPrefs(): ModelPrefsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? parsePrefsMap(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function persistPrefs(map: ModelPrefsMap): void {
  try {
    // 只存非空的，空偏好不留痕 —— 否则 localStorage 里会堆一堆 `{}`
    const pruned = pruneEmptyPrefs(map);
    if (Object.keys(pruned).length === 0) window.localStorage.removeItem(PREFS_KEY);
    else window.localStorage.setItem(PREFS_KEY, JSON.stringify(pruned));
  } catch {
    /* ignore */
  }
}

/** 写盘乐观锁基线：进入设置页时看到的盘上真值 */
export interface BotWriteGuards {
  readonly ifRevision?: number;
  readonly ifAgentsMdHash?: string;
}

/** daemon 判定"盘上已被改过"时的错误码。前端据此弹三选一而不是静默覆盖。 */
export const BOT_CONFLICT = "conflict";

/**
 * 这个单元上所有**启用中**的飞书 profile。
 *
 * 停用的不算：它现在接不到消息，界面上也不该显示一个机器人头像，
 * 否则用户会以为「这个 bot 归它管」，而实际上消息根本不会来。
 */
export function feishuProfilesOf(unit: WorkUnit): readonly string[] {
  const out: string[] = [];
  for (const ch of unit.channels ?? []) {
    if (ch.kind !== "feishu" || ch.enabled !== true) continue;
    for (const acc of ch.accounts ?? []) {
      const p = (acc.profile ?? "").trim();
      if (p !== "") out.push(p);
    }
  }
  return out;
}

/** 写盘成功后把 daemon 回的 revision 写回 state——否则下次保存会拿旧基线撞自己。 */
function applyPutResult(
  set: (fn: (s: WorkbenchState) => Partial<WorkbenchState>) => void,
  _get: () => WorkbenchState,
  unitId: string,
  res: unknown,
): void {
  const revision = (res as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "number") return;
  set((s) => ({
    units: s.units.map((x) => (x.id === unitId ? { ...x, revision } : x)),
  }));
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  // 评审后清 mock（用户指示）：初始全空，一切数据来自真实 daemon——
  // 空态是设计的一部分（ZCode 原则：功能不因空而消失），不再用样例数据撑门面
  units: [],
  activeUnitId: asUnitId(""),
  view: "bot",
  runtimes: [],
  activeRuntimeId: "zcode",
  modelPrefs: readPrefs(),
  modelPrefsVersion: 0,
  runtimePrefs: {} as Readonly<Record<string, RuntimePref>>,
  automations: [],
  automationNotice: null,
  // 启动时不预置：空 map 由 bootstrap 在合并 bot 定义后拉一次。
  // ⚠ 必须是**稳定引用**，selector 会逐个组件地读它（见 Sidebar 的 UnitRow），
  // 换新对象会让所有订阅者重渲染。
  channelIdentity: {},

  setAutomationNotice: (automationNotice) => set({ automationNotice }),

  refreshAutomations: async () => {
    const { fetchAutomations, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      const list = await fetchAutomations(defaultDaemonEndpoint());
      set({ automations: list });
    } catch (err: unknown) {
      // daemon 没起是正常态：空着 + 控制台留痕，不打断用户正在看的页面
      console.info("[workbench] 自动化列表拉取失败", err instanceof Error ? err.message : err);
    }
  },

  toggleAutomation: async (id) => {
    const current = get().automations.find((a) => a.id === id);
    if (current === undefined) return;
    // 乐观翻转 + 失败回滚：开关的即时反馈重要，但「显示开了、daemon 没开」更糟
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    }));
    const { setAutomationEnabled, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await setAutomationEnabled(Number(id), !current.enabled, defaultDaemonEndpoint());
    } catch (err: unknown) {
      set((s) => ({
        automations: s.automations.map((a) => (a.id === id ? { ...a, enabled: current.enabled } : a)),
        automationNotice: {
          kind: "error",
          text: `开关没生效：${err instanceof Error ? err.message : String(err)}`,
        },
      }));
    }
  },

  createAutomationAction: async (input) => {
    const { createAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await createAutomation(input, defaultDaemonEndpoint());
      await get().refreshAutomations();
      return true;
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `创建失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
  },

  updateAutomationAction: async (id, patch) => {
    const { updateAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await updateAutomation(Number(id), patch, defaultDaemonEndpoint());
      await get().refreshAutomations();
      return true;
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `保存失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
  },

  deleteAutomationAction: async (id) => {
    const { deleteAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await deleteAutomation(Number(id), defaultDaemonEndpoint());
      await get().refreshAutomations();
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `删除失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  },

  runAutomationNowAction: async (id) => {
    const { runAutomationNow, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await runAutomationNow(Number(id), defaultDaemonEndpoint());
      set({ automationNotice: { kind: "info", text: "已派发，正在起新会话" } });
      // 稍等片刻再刷，让「最近运行」立刻出现这条
      setTimeout(() => void get().refreshAutomations(), 1500);
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `立即运行失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  },

  setView: (view) => {
    // 切视图时自动落到该身份的第一个单元
    const first = get().units.find((u) => u.kind === view);
    set({ view, activeUnitId: first?.id ?? get().activeUnitId });
  },

  selectUnit: (activeUnitId) => set({ activeUnitId }),

  addUnit: async (u) => {
    set((s) => ({
      units: [...s.units, u],
      activeUnitId: u.id,
    }));
    // WP-5 写穿：落盘 <rootPath>/.agent-workbench/bot.json 与 <rootPath>/AGENTS.md。
    // 这里**不吞异常**——目录不存在（root_not_found）时侧栏会多一个刷新即逝的幽灵 bot，
    // 调用方（新建对话框）需要把这句话摆到用户面前。daemon 没起时也照抛。
    const { putBotDefinition, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const r = await putBotDefinition(u, defaultDaemonEndpoint());
    applyPutResult(set, get, u.id, r);
    // 新建时就配了渠道的话，当场把「这是哪个飞书机器人」认出来——
    // 用户在对话框里点完「接上飞书」就该看到它长什么样，而不是关了窗口再去找
    const profiles = feishuProfilesOf(u);
    if (profiles.length > 0) void get().refreshChannelIdentity(profiles);
  },

  // 改已有单元：state 里按 id 替换 + 同样写穿 bot.json。
  // addUnit 只管新建，bot 设置页改完 AGENTS.md / 换执行器都走这里。
  // 刻意不新建条目也不切 activeUnitId —— 编辑一个后台单元不该把用户拽走。
  //
  // 与 addUnit 的区别：**await 并把冲突抛回调用方**。bot 设置页必须知道"盘上已被改过"，
  // 否则用户在 VS Code 改完 AGENTS.md、在设置页看到旧的、点保存就静默覆盖——那是数据丢失。
  updateUnit: async (u, guards) => {
    // 先记下原值：写盘失败（版本冲突 / daemon 不可达）必须**回滚**。
    // 以前是「先写 store 再写盘、失败不回滚」—— 侧栏已经显示新名字、
    // 头部已经显示新 AGENTS.md，而对话框说「这次没有写入」：
    // 界面和 bot.json 分叉到下次刷新，而且下一次基于 `units` 的保存会把
    // 这份没落盘的值一起推上去。
    const prev = get().units.find((x) => x.id === u.id);
    set((s) => ({ units: s.units.map((x) => (x.id === u.id ? u : x)) }));
    try {
      const { putBotDefinition, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const r = await putBotDefinition(u, defaultDaemonEndpoint(), guards ?? {});
      applyPutResult(set, get, u.id, r);
      // 渠道可能被改过（换了 profile / 刚启用 / 刚停用），侧栏头像要跟着变
      const profiles = feishuProfilesOf(u);
      if (profiles.length > 0) void get().refreshChannelIdentity(profiles);
    } catch (err: unknown) {
      if (prev !== undefined) {
        set((s) => ({ units: s.units.map((x) => (x.id === u.id ? prev : x)) }));
      }
      throw err;
    }
  },

  // 认「哪个 profile 是哪个飞书机器人」。后端成功缓存 10 分钟，所以这里可以放心地在
  // 保存后和启动时各调一次，不会变成 spawn 风暴。
  refreshChannelIdentity: async (profiles) => {
    const { fetchChannelIdentity, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      const next = await fetchChannelIdentity(profiles, defaultDaemonEndpoint());
      set((s) => ({ channelIdentity: { ...s.channelIdentity, ...next } }));
    } catch (err: unknown) {
      // 认不出来是常态（daemon 没起 / lark-cli 不在 PATH / profile 写错）。
      // 界面回落通用图标即可，不该弹一个红框打断用户正在做的事。
      console.info("[workbench] 机器人身份拉取失败（界面回落通用渠道图标）", err instanceof Error ? err.message : err);
    }
  },

  // 重新从盘上拉一个单元。bot.list 每次重扫盘（无缓存），所以这就是"用户在 VS Code
  // 改完 AGENTS.md 后刷新"的那一下。合并进 units 同 id 条目并回传，供设置页预填。
  reloadUnit: async (id) => {
    const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const defs = await listBotDefinitions(defaultDaemonEndpoint());
    const fresh = defs.find((d) => d.id === id);
    if (fresh === undefined) return null;
    set((s) => ({ units: s.units.map((x) => (x.id === id ? { ...x, ...fresh } : x)) }));
    return { ...(get().units.find((x) => x.id === id) ?? fresh) };
  },

  selectRuntime: (activeRuntimeId) => set({ activeRuntimeId }),

  setModelPrefs: (runtimeId, next) =>
    set((s) => {
      const map = { ...s.modelPrefs, [runtimeId]: next };
      persistPrefs(map);
      return { modelPrefs: map, modelPrefsVersion: s.modelPrefsVersion + 1 };
    }),

  applyModelPrefs: (runtimeId, steps) =>
    set((s) => {
      const cur = prefsOf(s.modelPrefs, runtimeId);
      // 每步都过一遍归一：像「全藏」这种动作可能触发「至少留一个」的兜底，
      // 不归一的话内存里就留下一个「藏光了」的非法状态。
      let next = cur;
      for (const step of steps) next = normalizePrefs(step(next), declaredOf(s, runtimeId));
      const map = { ...s.modelPrefs, [runtimeId]: next };
      persistPrefs(map);
      return { modelPrefs: map, modelPrefsVersion: s.modelPrefsVersion + 1 };
    }),

  setRuntimePref: (id, patch) =>
    set((s) => {
      const base: RuntimePref = s.runtimePrefs[id] ?? { enabled: true };
      return { runtimePrefs: { ...s.runtimePrefs, [id]: { ...base, ...patch } } };
    }),

  probeAll: async () => {
    for (const entry of get().runtimes) {
      void runtimeRegistry
        .getOrCreate(entry.id)
        .then((adapter) => adapter.probe())
        .then((probe) => runtimeRegistry.setState(entry.id, probe.state))
        .catch(() => undefined);
    }
    await Promise.resolve();
  },

}));


// 镜像注册表状态到 store。
// 注意：订阅回调里只做「读状态 → 写 store」，绝不能在里面再触发注册表变更，
// 否则会自触发成死循环。探测因此放在下面的独立一次性任务里。
runtimeRegistry.subscribe((runtimes) => {
  useWorkbench.setState({ runtimes });
});

// 一次性探测所有运行时的连接状态（各自独立 await，互不阻塞）
void (async () => {
  for (const entry of runtimeRegistry.list()) {
    void runtimeRegistry
      .getOrCreate(entry.id)
      .then((adapter) => adapter.probe())
      .then((probe) => runtimeRegistry.setState(entry.id, probe.state))
      .catch((err: unknown) =>
        runtimeRegistry.setState(entry.id, {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }
})();

export const selectActiveUnit = (s: WorkbenchState): WorkUnit | undefined =>
  s.units.find((u) => u.id === s.activeUnitId);

/** 某个 CLI 的有效模型清单。⚠ 返回引用稳定的数组（见 visibleModelsFor 的注释） */
export const selectVisibleModels =
  (runtimeId: string) =>
  (s: WorkbenchState): readonly ModelSpec[] =>
    visibleModelsFor(s, runtimeId);

/** 当前工作单元的自动化，bot视图下最关心的一组 */
export const selectUnitAutomations = (s: WorkbenchState): readonly Automation[] =>
  s.automations.filter((a) => a.unitId === s.activeUnitId);

// 注册执行器 bootstrap —— 必须在 store 创建之后（要校正 activeRuntimeId）：
// 优先本地 daemon（真实执行），不可达时回退 mock（纯 UI 原型，daemon 没起是正常态）。
void (async () => {
  try {
    const { listDaemonExecutors } = await import("../adapters/daemon/client.ts");
    const { createDaemonFactory } = await import("../adapters/daemon/adapter.ts");
    const { defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const infos = await listDaemonExecutors(defaultDaemonEndpoint());
    if (infos.length === 0) throw new Error("daemon 无可用执行器");
    const factories = infos.map((info) => createDaemonFactory(info, defaultDaemonEndpoint()));
    runtimeRegistry.registerAll(factories);
    runtimeRegistry.setState(factories[0]!.id, { status: "stopped" });
    useWorkbench.setState({ activeRuntimeId: factories[0]!.id });
    console.info(`[workbench] 已连接本地 daemon：${infos.map((i) => i.id).join(", ")}`);
    // 哪些模型本地目录没收 —— **说出来**。
    // 原来的坑：查不到就静默丢弃，models 空了 → defaultModel 为 null → 整个
    // 执行器从列表里消失，控制台一个错都没有。现在降级显示（价格显示为未知），
    // 必须留痕，否则「加了个执行器但界面看不到」只能靠猜。
    //
    // 放在这里而不是 subscribe 里：registerAll 每注册一个就 emit 一次，
    // 在回调里打会把同一条消息刷 8 遍。
    const unlisted = runtimeRegistry
      .list()
      .flatMap((r) => r.models.filter((m) => m.vendorLabel === "未收录").map((m) => `${r.presentation.displayName}/${m.id}`));
    if (unlisted.length > 0) {
      console.info(
        `[workbench] ${unlisted.length} 个模型本地目录没收录，已降级显示（价格/窗口为未知）：${unlisted.join("、")}` +
          ` —— 补进 core/models.ts 的 MODELS 就能拿到价格与档位`,
      );
    }
    // WP-5：daemon 可达时合并落盘 bot 定义（bot.json 是家，store 只是运行态视图）
    try {
      const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const defs = (await listBotDefinitions(defaultDaemonEndpoint())) as WorkUnit[];
      // 评审 P2：bot.json 手可编辑——缺 bindings/kind 的半成品合并进来会把
      // 绑定/渠道渲染搞出 TypeError，最小必填面守卫不合格即跳过
      const valid = defs.filter(
        (d) =>
          typeof d.id === "string" &&
          typeof d.rootPath === "string" &&
          typeof d.name === "string" &&
          Array.isArray(d.bindings) &&
          (d.kind === "bot" || d.kind === "project"),
      );
      const skipped = defs.length - valid.length;
      if (valid.length > 0) {
        const current = useWorkbench.getState().units;
        const merged = [...current.filter((u) => !valid.some((d) => d.id === u.id)), ...valid];
        const curActive = useWorkbench.getState().activeUnitId;
        const defaultActive = merged.some((u) => u.id === curActive && u.id !== "")
          ? curActive
          : (merged.find((u) => u.id === "steward")?.id ?? merged[0]?.id ?? asUnitId(""));
        useWorkbench.setState({ units: merged, activeUnitId: defaultActive });
        console.info(`[workbench] 已合并 ${valid.length} 个落盘 bot 定义${skipped > 0 ? `（跳过 ${skipped} 个不合格定义）` : ""}`);
        // 认出「哪个 bot 接的是哪个飞书机器人」。不传 profiles = 问 daemon 盘上所有
        // 已启用的飞书账号，它按 profile 去重，三个 bot 绑同一个机器人也只 spawn 一次。
        void useWorkbench.getState().refreshChannelIdentity();
      }
    } catch (err: unknown) {
      console.info("[workbench] 落盘 bot 定义缺失（不致命）", err instanceof Error ? err.message : err);
    }
    // 自动化（Phase 5 v2）：daemon 可达时拉全量列表，页面打开即有数据
    void useWorkbench.getState().refreshAutomations();
  } catch (err: unknown) {
    console.info(
      "[workbench] 本地 daemon 不可达 —— 无执行器可用（启动 backend/ 的 daemon 即接入真实执行）",
      err instanceof Error ? err.message : err,
    );
    // 评审后清 mock（用户指示）：daemon 不可达就空着，不再注册六家 mock 执行器充数
  }
})();
