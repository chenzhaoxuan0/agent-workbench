import { create } from "zustand";
import type { Automation } from "../core/automation.ts";
import { canRuntimeUse, modelById, type ModelId, type ModelSpec } from "../core/models.ts";
import type { PermissionMode } from "../core/permission.ts";
import type {
  LoopParams,
  MemoryInjectionOptions,
  PermissionDecision,
  RuntimeAdapter,
} from "../core/adapter.ts";
import type { RuntimeEvent } from "../core/events.ts";
import {
  asModelId,
  asRuntimeId,
  asSessionId,
  asUnitId,
  type Deliverable,
  type Session,
  type SessionId,
  type SessionStatus,
  type UnitId,
  type WorkUnit,
} from "../core/units.ts";
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
import type {
  ChannelIdentityMap,
  LarkBotIdentity,
  ModelSyncReport,
} from "../adapters/daemon/client.ts";

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

/** agent loop 参数 —— 每执行器各记一份；未设置的位用默认值（见 run）
 *  ⚠ 不含采样参数（temperature/top_p）：zcode 协议无此位、codex 透传未证实被尊重，
 *  无效参数不进界面 —— 未来某家 CLI 真支持了再加回来。 */
export interface LoopParamsState {
  mode?: LoopParams["mode"];
  reasoningLevel?: string;
}

const LOOP_PARAMS_KEY = "agent-workbench:loop-params";

function readLoopParams(): Record<string, LoopParamsState> {
  try {
    const raw = localStorage.getItem(LOOP_PARAMS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, LoopParamsState>);
  } catch {
    return {};
  }
}

/** 时间线条目：归一化事件 + 序号 + 时间戳。UI 唯一消费的会话数据形状 */
export interface TimelineItem {
  readonly id: number;
  readonly event: RuntimeEvent;
  readonly at: number;
}

interface WorkbenchState {
  units: readonly WorkUnit[];
  activeUnitId: UnitId;
  /**
   * 侧栏普通节的拖拽排序（会话内记忆，不持久化）。放 store 是为了让单元
   * 切换器弹层读到同一份顺序——两侧同序才好选（orderUnitsLikeSidebar 消费）。
   */
  unitOrder: readonly string[] | null;
  runtimes: readonly RuntimeEntry[];
  activeRuntimeId: string;
  /**
   * 每个执行器各自记住一个模型：`runtimeId → ModelId`。
   *
   * 刻意**不存全局单一模型**。全局那个在切执行器时必然出现非法组合：
   * ZCode 选了 claude-sonnet-5，切到 Codex 后它根本不接 Anthropic 的模型。
   * 各存各的，切回来时你上次选的那个还在。
   */
  runtimeModels: Readonly<Record<string, ModelId>>;
  /**
   * 每个 CLI 各自的模型偏好（隐藏 / 排序 / 收藏 / 自定义模型）。
   * 对齐 T3code 的 `providerModelPreferences` + `customModels`。
   */
  modelPrefs: ModelPrefsMap;
  /** 偏好变更计数。偏好对象每次都是新的，effect 要个稳定的触发源 */
  modelPrefsVersion: number;
  /** 工作台发起的会话（daemon 侧的权威列表走 session.* RPC，这里是运行态视图） */
  sessions: readonly Session[];
  activeSessionId: SessionId | null;
  /** 每执行器的 agent loop 参数（mode/reasoning），localStorage 持久化 */
  loopParams: Record<string, LoopParamsState>;
  setLoopParam: (runtimeId: string, patch: Partial<LoopParamsState>) => void;
  timeline: readonly TimelineItem[];
  deliverables: readonly Deliverable[];
  busy: boolean;
  /** 输入框草稿。空态建议卡片点一下就能预填 */
  draft: string;
  /** 已裁决的权限请求：requestId → 决策。用于把权限卡切成「已处理」态 */
  permissionDecisions: Readonly<Record<string, string>>;
  /** 本次运行的权限模式（composer 右侧常驻） */
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  /** 本次/后续会话记忆注入范围（默认仅注入长期记忆 ["semantic"]） */
  memoryScopes: readonly ("semantic" | "daily")[];
  setMemoryScopes: (scopes: readonly ("semantic" | "daily")[]) => void;
  toggleMemoryScope: (scope: "semantic" | "daily") => void;
  pushNotice: (
    title: string,
    text: string,
    options?: { level?: "info" | "success" | "warn"; meta?: Readonly<Record<string, string>> },
  ) => void;
  /** 执行器实例偏好（T3 Providers 页逻辑：启用开关 / 覆盖 / 环境变量） */
  runtimePrefs: Readonly<Record<string, RuntimePref>>;
  setRuntimePref: (id: string, patch: Partial<Omit<RuntimePref, "enabled">> & { enabled?: boolean }) => void;
  /** 全量重探测（T3 的 Checked 刷新） */
  probeAll: () => Promise<void>;
  /**
   * 重新探测模型清单（设置页第二个按钮）。
   *
   * 与 probeAll 分开是刻意的：执行器探测只回答「装没装、版本多少」，模型刷新只回答
   * 「能用哪些模型、上下文窗口多少」。两者耗时差一个量级（后者要起 CLI），
   * 混在一个按钮里用户既不知道在等什么，也说不清列表为什么变了。
   */
  syncModelsAll: () => Promise<void>;
  /** 模型刷新进行中（按钮转圈 / 禁重复点） */
  syncingModels: boolean;
  /** 最近一次模型刷新的结果。report 里 source=static 的那些 = 没刷到，用的是内置兜底 */
  modelSync: { readonly at: number; readonly report: readonly ModelSyncReport[]; readonly error?: string } | null;
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

  setUnitOrder: (order: readonly string[]) => void;
  selectUnit: (id: UnitId) => void;
  addUnit: (u: WorkUnit, opts?: { createRoot?: boolean }) => Promise<void>;
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
  selectSession: (id: SessionId | null) => void;
  selectRuntime: (id: string) => void;
  /** 换模型。非法组合（该执行器不接这个模型）静默拒绝，不改状态 */
  selectModel: (model: ModelId) => void;
  /** 改某个 CLI 的模型偏好。动作原子，不合法的输入原样返回由调用方处理 */
  setModelPrefs: (runtimeId: string, next: ProviderModelPrefs) => void;
  /** 批量入口：给一组动作依次应用，任一步失败则整组不动 */
  applyModelPrefs: (runtimeId: string, steps: readonly ((p: ProviderModelPrefs) => ProviderModelPrefs)[]) => void;
  setDraft: (v: string) => void;
  /** 发一条消息：活跃会话续聊，否则 startSession 开新会话（详见实现注释） */
  run: (
    prompt: string,
    opts?: {
      memoryOptions?: MemoryInjectionOptions;
      attachments?: readonly import("../core/attachments.ts").ChatAttachment[];
      /**
       * 在指定工作树里开**新会话**（源代码管理面板「在此工作树启动会话」）。
       * 给了它就跳过续聊判定 —— 工作树会话永远是新开的，daemon 侧负责
       * ensure（不存在则按 branch 创建）。
       */
      worktree?: { path: string; branch: string };
    },
  ) => Promise<void>;
  /** 停止当前运行 */
  cancelRun: () => void;
  resolvePermission: (requestId: string, decision: PermissionDecision) => void;
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
  /** 从 daemon 重新拉取并合并全量 Agent 机器人列表 */
  refreshUnits: () => Promise<void>;
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

/** 时间线序号 —— 全局递增，pushUserBubble / pushNotice / 事件泵共用 */
let seq = 0;

function getInitialActiveUnit(): UnitId {
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("unit");
      if (q) {
        localStorage.setItem("agent-workbench:active-unit", q);
        return asUnitId(q);
      }
      const stored = localStorage.getItem("agent-workbench:active-unit");
      if (stored) return asUnitId(stored);
    } catch {}
  }
  return asUnitId("");
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  // 评审后清 mock（用户指示）：初始全空，一切数据来自真实 daemon——
  // 空态是设计的一部分（ZCode 原则：功能不因空而消失），不再用样例数据撑门面
  units: [],
  activeUnitId: getInitialActiveUnit(),
  unitOrder: null,
  runtimes: [],
  activeRuntimeId: "zcode",
  // 注册表订阅到位后由下方 subscribe 补齐各执行器的默认模型
  runtimeModels: {},
  syncingModels: false,
  modelSync: null,
  modelPrefs: readPrefs(),
  modelPrefsVersion: 0,
  sessions: [],
  activeSessionId: null,
  loopParams: readLoopParams(),
  timeline: [],
  deliverables: [],
  busy: false,
  draft: "",
  permissionDecisions: {},
  permissionMode: "bypass",
  memoryScopes: ["semantic"] as readonly ("semantic" | "daily")[],

  setDraft: (draft) => set({ draft }),

  setPermissionMode: (permissionMode) => set({ permissionMode }),

  setMemoryScopes: (memoryScopes) => set({ memoryScopes }),

  toggleMemoryScope: (scope) =>
    set((s) => {
      const has = s.memoryScopes.includes(scope);
      const next = has ? s.memoryScopes.filter((x) => x !== scope) : [...s.memoryScopes, scope];
      return { memoryScopes: next };
    }),

  pushNotice: (title, text, options) => {
    set((s) => ({
      timeline: [
        ...s.timeline,
        {
          id: ++seq,
          event: {
            type: "system.notice",
            sessionId: s.activeSessionId ?? asSessionId("sys"),
            title,
            text,
            level: options?.level ?? "info",
            meta: options?.meta,
          },
          at: Date.now(),
        },
      ],
    }));
  },

  setLoopParam: (runtimeId, patch) => {
    set((s) => {
      const loopParams = { ...s.loopParams, [runtimeId]: { ...s.loopParams[runtimeId], ...patch } };
      try { localStorage.setItem(LOOP_PARAMS_KEY, JSON.stringify(loopParams)); } catch { /* 私有模式写不进就算了 */ }
      return { loopParams };
    });
  },

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

  deleteAutomationAction: async (id: string) => {
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
    // 运行前提示（不拦）：定时任务配的模型可能已经下线了。
    // 不拦是因为模型**临时**不可用不该让人连「手动跑一次」都做不了，
    // 但必须说一声 —— 否则用户点了没反应、或者跑起来才发现用的是别的东西。
    // 注意警告文本要**并进**成功消息里：先 set 再被「已派发」覆盖等于没提示。
    const now = get().automations.find((a) => String(a.id) === String(id));
    // 判定必须走 isModelAvailable（复审 P1）：只看「配没配模型」会让每一条配了模型
    // 的任务在手动运行时都吃到假错误，还会把「已派发」的成功提示整个顶掉。
    // runtimeId 存的是裸执行器名，判定口径要补 daemon: 前缀。
    const stale =
      now !== undefined && now.model !== null && now.model !== "" &&
      !isModelAvailable(get(), `daemon:${now.runtimeId}`, now.model)
        ? `注意：${now.name} 配的模型 ${now.model} 已不在 ${now.runtimeId} 的可选清单里（多半下线了），仍按它派发。`
        : null;
    const { runAutomationNow, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await runAutomationNow(Number(id), defaultDaemonEndpoint());
      set({
        automationNotice: { kind: stale === null ? "info" : "error", text: stale ?? "已派发，正在起新会话" },
      });
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

  setUnitOrder: (unitOrder) => {
    set({ unitOrder });
  },

  selectUnit: (activeUnitId) => {
    set({ activeUnitId, activeSessionId: null });
    try {
      localStorage.setItem("agent-workbench:active-unit", activeUnitId);
    } catch {}
  },

  refreshUnits: async () => {
    try {
      const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const defs = (await listBotDefinitions(defaultDaemonEndpoint())) as WorkUnit[];
      const valid = defs.filter(
        (d) =>
          typeof d.id === "string" &&
          typeof d.rootPath === "string" &&
          typeof d.name === "string" &&
          Array.isArray(d.bindings) &&
          (d.kind === "bot" || d.kind === "project"),
      );
      if (valid.length > 0) {
        const curActive = get().activeUnitId;
        const defaultActive = valid.some((u) => u.id === curActive && u.id !== "")
          ? curActive
          : (valid.find((u) => u.id === "steward")?.id ?? valid[0]?.id ?? asUnitId(""));
        set({ units: valid, activeUnitId: defaultActive });
        void get().refreshChannelIdentity();
      }
    } catch (err: unknown) {
      console.warn("[workbench] 刷新 Agent 列表失败", err);
    }
  },

  addUnit: async (u, opts) => {
    set((s) => ({
      units: [...s.units, u],
      activeUnitId: u.id,
      activeSessionId: null,
    }));
    // WP-5 写穿：落盘 <rootPath>/.agent-workbench/bot.json 与 <rootPath>/AGENTS.md。
    // 这里**不吞异常**——目录不存在（root_not_found）时侧栏会多一个刷新即逝的幽灵 bot，
    // 调用方（新建对话框）需要把这句话摆到用户面前。daemon 没起时也照抛。
    // createRoot（自动安置，ADR 0011）：新建流的唯一必填交互是文件夹，预填的默认位置
    // 本来就不存在，由 daemon 落笔时幂等建出。只有新建显式开启——认领（ImportBotDialog）
    // 复用本方法时不开：认领的对象必须是已存在的文件夹，路径失效应当报错而非静默重建。
    const { putBotDefinition, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const r = await putBotDefinition(u, defaultDaemonEndpoint(), {}, { createRoot: opts?.createRoot === true });
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

  selectSession: (activeSessionId) => set({ activeSessionId }),

  selectRuntime: (activeRuntimeId) => {
    // 换执行器时保证模型组合合法。
    // runtimeModels 是按执行器存的，所以理论上不会串；
    // 但工作单元的 modelHint、注册表热更新都可能引入非法值，这里兜住。
    const entry = get().runtimes.find((r) => r.id === activeRuntimeId);
    if (!entry) return set({ activeRuntimeId });
    const cur = get().runtimeModels[activeRuntimeId];
    if (canRuntimeUse(entry.models, cur)) return set({ activeRuntimeId });
    set({
      activeRuntimeId,
      runtimeModels: { ...get().runtimeModels, [activeRuntimeId]: entry.defaultModel },
    });
  },

  selectModel: (model) =>
    set((s) => {
      const entry = s.runtimes.find((r) => r.id === s.activeRuntimeId);
      if (!entry) return {};
      // 按**有效清单**校验，不是按声明清单 ——
      // 用户在设置里藏掉的模型，选择器里不该还能选到（那是个不一致）
      const visible = visibleModelsFor(s, s.activeRuntimeId);
      if (!visible.some((m) => m.id === model)) return {};
      return { runtimeModels: { ...s.runtimeModels, [s.activeRuntimeId]: model } };
    }),

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

  cancelRun: () => {
    const { activeSessionId, activeRuntimeId } = get();
    set({ busy: false });
    if (activeSessionId !== null) {
      void runtimeRegistry
        .getOrCreate(activeRuntimeId as never)
        .then((a: RuntimeAdapter) => a.cancel(activeSessionId))
        .catch((err: unknown) => console.warn("[workbench] cancel failed", err instanceof Error ? err.message : err));
    }
  },

  resolvePermission: (requestId, decision) => {
    const { sessions, timeline, activeSessionId } = get();

    // 裁决必须回到**发起这条请求的那条会话**。
    // 时间线里每条 permission.requested 自带 sessionId，这是唯一正确的归属来源
    //（daemon 按会话严格匹配 requestId，发错会话那条 tool call 永远等不到放行）。
    let ownerId: SessionId | null = null;
    for (const t of timeline) {
      if (t.event.type === "permission.requested" && t.event.requestId === requestId) {
        ownerId = t.event.sessionId;
        break;
      }
    }
    const session = sessions.find((s) => s.id === (ownerId ?? activeSessionId ?? sessions.at(-1)?.id));
    if (!session) return;

    // 先落本地裁决，UI 立刻放行，不等网络往返
    set((s) => ({
      permissionDecisions: { ...s.permissionDecisions, [requestId]: decision },
    }));

    void runtimeRegistry
      .getOrCreate(session.runtimeId as never)
      .then((a: RuntimeAdapter) => a.resolvePermission(session.id, requestId, decision))
      // 拒绝必须可见：适配器取不到时 UI 已把请求标成「已裁决」——
      // 人以为放行了，实际那一轮还挂着。
      .catch((err: unknown) => {
        get().pushNotice("授权没有送达执行器", err instanceof Error ? err.message : String(err), { level: "warn" });
      });
  },

  /**
   * 发一条消息 —— T3 语义：**活跃会话仍开着就同会话续聊**（agent loop 保持
   * 上下文，工具记得前文），只有首条消息 / 上个会话已结束 / 换了执行器才
   * startSession 开新会话。时间线在开新会话时重置，续聊时追加。
   */
  run: async (prompt, opts) => {
    const { activeUnitId, activeRuntimeId, runtimeModels, activeSessionId } = get();
    const unit = get().units.find((u) => u.id === activeUnitId);
    if (!unit) return;

    // 起会话 / 发送失败时的统一收尾。**必须有**：这两处 await 都没有 catch 的话，
    // RPC 一 reject（daemon 没起、CLI 拉不起来）busy 就永远停在 true ——
    // composer 一直显示「停止」，时间线一直显示「正在思考与执行…」。
    const fail = (err: unknown): void => {
      set({ busy: false });
      get().pushNotice("这一轮没能发出去", err instanceof Error ? err.message : String(err), { level: "warn" });
    };

    let adapter: RuntimeAdapter;
    try {
      adapter = await runtimeRegistry.getOrCreate(activeRuntimeId as never);
    } catch (err: unknown) {
      fail(err);
      return;
    }
    consumeEvents(adapter);

    // agent loop 参数：每执行器各记一份；mode 未单独设置时跟随权限档位（ask→build 等）
    const loopState = get().loopParams[activeRuntimeId] ?? {};
    const pmToMode = (pm: PermissionMode): LoopParams["mode"] =>
      pm === "ask" ? "build" : pm === "acceptEdits" ? "edit" : pm === "plan" ? "plan" : "yolo";
    const loop: LoopParams = {
      mode: loopState.mode ?? pmToMode(get().permissionMode),
      ...(loopState.reasoningLevel ? { reasoningLevel: loopState.reasoningLevel } : {}),
    };

    // 模型回落：用户所选 → 工作单元 modelHint → 该 CLI 当前有效清单的第一个。
    //
    // 两类「不在有效清单里」要分开，它们对用户是完全不同的两件事：
    //
    // ① 用户在设置里**主动藏掉**的 —— 这是他明确表达过的意图，该排除，沿用旧行为；
    // ② **失效模型**（执行器不再提供的）—— 这不是用户的选择，是模型下线了。
    //    这里绝不能静默换成 visible[0]：用户以为在用 opus，实际跑的是列表第一个
    //    （codex 实测就是 $10/$50 的旗舰档 gpt-6-astra）。照他选的用，界面上
    //    由 ModelSelect / RuntimePicker 标「不可用」，换不换由他决定。
    const s = get();
    const visible = visibleModelsFor(s, activeRuntimeId);
    const hint = unit.bindings.find((b) => b.runtimeId === activeRuntimeId)?.modelHint;
    const picked = runtimeModels[activeRuntimeId];
    const retired = new Set(s.runtimes.find((r) => r.id === activeRuntimeId)?.retiredModels.map((m) => m.id));
    const usable = (id: ModelId | null | undefined): boolean => {
      if (id === null || id === undefined) return false;
      if (visible.some((m) => m.id === id)) return true;
      // 失效但用户没主动藏过 → 尊重他的选择，不偷换
      return retired.has(id) && !isHiddenByUser(s, activeRuntimeId, id);
    };
    const model: ModelId = usable(picked)
      ? (picked as ModelId)
      : usable(hint ? asModelId(hint) : null)
        ? (asModelId(hint!) as ModelId)
        : (visible[0]?.id ?? asModelId(""));

    const attachments = opts?.attachments;
    let fullPrompt = prompt;
    if (attachments && attachments.length > 0) {
      const parts: string[] = [];
      for (const att of attachments) {
        if (att.category === "image") {
          parts.push(`[图片附件: ${att.name}${att.localPath ? ` (本地路径: ${att.localPath})` : ""}]`);
        } else if (att.textContent) {
          parts.push(`\n--- 附件文件: ${att.name} ---\n${att.textContent}\n---`);
        } else {
          parts.push(`[附件文件: ${att.name}${att.localPath ? ` (本地路径: ${att.localPath})` : ""}]`);
        }
      }
      fullPrompt = prompt.trim() ? `${prompt}\n\n${parts.join("\n")}` : parts.join("\n");
    }

    const pushUserBubble = (sessionId: SessionId) => {
      set((s) => ({
        timeline: [
          ...s.timeline,
          {
            id: ++seq,
            event: {
              type: "message.delta",
              sessionId,
              messageId: `u${++seq}`,
              role: "user" as const,
              text: prompt,
              attachments,
            } as const,
            at: Date.now(),
          },
        ],
      }));
    };

    // 续聊：活跃会话开着（未 done/failed）且属于当前执行器。
    // 工作树会话例外：它永远是新开的（daemon 按 path+branch ensure 工作树）。
    const active = activeSessionId !== null ? get().sessions.find((s) => s.id === activeSessionId) : undefined;
    if (
      opts?.worktree === undefined &&
      active !== undefined &&
      active.runtimeId === activeRuntimeId &&
      active.status !== "done" &&
      active.status !== "failed"
    ) {
      set({ busy: true });
      pushUserBubble(active.id);
      try {
        await adapter.sendMessage({
          sessionId: active.id,
          text: fullPrompt,
          attachments,
          loop: {
            ...(loop.reasoningLevel ? { reasoningLevel: loop.reasoningLevel } : {}),
          },
        });
      } catch (err: unknown) {
        fail(err);
      }
      return;
    }

    // 新会话：时间线重置（新对话）
    set({ busy: true, timeline: [] });

    let session: Awaited<ReturnType<RuntimeAdapter["startSession"]>>;
    try {
      session = await adapter.startSession({
        unit,
        prompt: fullPrompt,
        model,
        // 仅源代码管理面板显式传入：在此工作树开新会话（ADR 0008）
        worktree: opts?.worktree,
        loop,
        memoryOptions: opts?.memoryOptions ?? { scopes: get().memoryScopes },
        attachments,
      });
    } catch (err: unknown) {
      fail(err);
      return;
    }

    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }));

    // 用户消息是时间线的第一行（ZCode：右对齐的用户气泡）。
    pushUserBubble(session.id);
  },

  /**
   * 重新探测执行器 —— 探测**连接状态**，顺带把模型清单也带回来。
   *
   * 为什么必须顺带：daemon 侧好几个 adapter 的 `probe()` 里会 `void this.syncModels()`
   * （codex / grok / opencode / pi），也就是用户按这一下，daemon 的模型清单**确实变了**。
   * 但以前前端这里只 `setState(probe.state)`，从不取回模型 —— 用户看到的就是
   * 「我明明点了刷新，界面纹丝不动」。
   *
   * 所以探完必须再走一次 syncModelsAll：两条路最终收敛到同一份清单，
   * 用户按哪个按钮都不再是「白按」。
   */
  probeAll: async () => {
    for (const entry of get().runtimes) {
      void runtimeRegistry
        .getOrCreate(entry.id)
        .then((adapter) => adapter.probe())
        .then((probe) => runtimeRegistry.setState(entry.id, probe.state))
        .catch(() => undefined);
    }
    await Promise.resolve();
    await get().syncModelsAll();
  },

  /**
   * 重新探测模型清单 —— 与 probeAll **完全独立**的一条路。
   *
   * 原先模型刷新寄生在执行器探测里（daemon 的 probe 顺带调 syncModels），
   * 刷新结果只留在 daemon 进程内存里回不到界面，于是「订阅里新出了模型」永远看不见。
   * 现在一次 RPC 同时拿回报告和刷新后的完整清单，就地更新注册表，界面立刻变。
   *
   * 零用量：daemon 侧只跑只读列清单命令或读本地目录文件。
   */
  syncModelsAll: async () => {
    if (get().syncingModels) return;
    set({ syncingModels: true });
    try {
      const { syncDaemonModels } = await import("../adapters/daemon/client.ts");
      const { report, adapters } = await syncDaemonModels();
      const byId = new Map(adapters.map((a) => [a.id, a]));
      const cachedById = new Map(report.map((r) => [r.runtimeId, r.cachedAt]));
      const changed: string[] = [];
      const retired: string[] = [];
      for (const entry of runtimeRegistry.list()) {
        const bare = entry.id.replace(/^daemon:/, "");
        const fresh = byId.get(bare) ?? byId.get(entry.id);
        if (fresh === undefined) continue;
        // daemon 侧模型 id 是裸 string，注册表要的是带品牌的 ModelId —— 在这里归一，
        // 别让类型品牌泄漏成「每个调用点各写一遍 asModelId」
        const raw = fresh.models.map((m) => ({ ...m, id: asModelId(m.id) }));
        // cachedAt 决定这一轮能不能动失效模型：有值 = daemon 没能真探到，
        // 沿用的是上次的清单，此时隐藏/退役一律不生效（否则一次网络抖动
        // 就会让用户可选的模型凭空消失）。
        const cachedAt = fresh.modelsCachedAt ?? cachedById.get(fresh.id) ?? cachedById.get(bare);
        const hadRetired = entry.retiredModels.length;
        if (runtimeRegistry.updateModels(entry.id, raw, fresh.modelsDiscoverable !== false, cachedAt)) {
          changed.push(fresh.displayName);
        }
        const nowRetired = runtimeRegistry.get(entry.id)?.retiredModels.length ?? 0;
        if (nowRetired > hadRetired) retired.push(fresh.displayName);
      }
      set({
        modelSync: { at: Date.now(), report: [...report] },
      });
      // 已选模型的悬空校验交给 runtimeRegistry.subscribe —— updateModels 内部会 emit，
      // 那里统一处理「选中的模型已不在新清单里」的回落，这里不再重复一份逻辑。
      console.info(
        `[workbench] 模型清单已刷新：${report.filter((r) => r.source === "live").length}/${report.length} 家来自实时探测` +
          (changed.length > 0 ? `，更新：${changed.join("、")}` : "，清单无变化") +
          (retired.length > 0 ? `，检测到失效模型：${retired.join("、")}` : ""),
      );
    } catch (err: unknown) {
      console.info("[workbench] 模型刷新失败（执行器不可达？）", err instanceof Error ? err.message : err);
      set({ modelSync: { at: Date.now(), report: [], error: err instanceof Error ? err.message : String(err) } });
    } finally {
      set({ syncingModels: false });
    }
  },

}));


/** 已挂事件消费循环的适配器 —— 每个 CLI 一条，进程内不重复挂（多挂会分抢单队列） */
const consumerAttached = new WeakSet<RuntimeAdapter>();

/** 归一化 turn 完成态 → 契约 SessionStatus */
function mapTurnStatus(raw: string): SessionStatus {
  if (raw.startsWith("failed")) return "failed";
  if (raw === "idle" || raw === "running" || raw === "done" || raw === "awaiting_permission" || raw === "awaiting_input") return raw;
  return "running";
}

/** 归一化事件流消费循环 —— UI 唯一的数据入口。每适配器挂一次，跨轮次常驻。 */
function consumeEvents(adapter: RuntimeAdapter): void {
  if (consumerAttached.has(adapter)) return;
  consumerAttached.add(adapter);
  void (async () => {
    for await (const event of adapter.events()) {
      useWorkbench.setState((s) => ({
        timeline: [...s.timeline, { id: ++seq, event, at: Date.now() }],
      }));
      // 会话生命周期回写：status 变化 / ended → sessions[].status + busy
      if (event.type === "session.status") {
        const status = mapTurnStatus(event.status);
        useWorkbench.setState((s) => ({
          sessions: s.sessions.map((x) => (x.id === event.sessionId ? { ...x, status } : x)),
          ...(s.activeSessionId === event.sessionId && status !== "running" ? { busy: false } : {}),
        }));
      }
      if (event.type === "session.ended") {
        useWorkbench.setState((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === event.sessionId ? { ...x, status: event.reason === "error" ? ("failed" as const) : ("done" as const), endedAt: Date.now() } : x,
          ),
          busy: false,
        }));
      }
      if (event.type === "permission.resolved") {
        useWorkbench.setState((s) => ({
          permissionDecisions: {
            ...s.permissionDecisions,
            [event.requestId]: event.decision,
          },
        }));
      }
      if (event.type === "message.completed") useWorkbench.setState({ busy: false });
      if (event.type === "deliverable") {
        useWorkbench.setState((s) => ({
          deliverables: [
            {
              id: `d${seq}`,
              unitId: event.unitId,
              sessionId: event.sessionId,
              title: event.title,
              kind: event.kind,
              path: event.path,
              url: event.url,
              createdAt: Date.now(),
            },
            ...s.deliverables,
          ],
        }));
      }
    }
  })();
}

// 镜像注册表状态到 store。
// 注意：订阅回调里只做「读状态 → 写 store」，绝不能在里面再触发注册表变更，
// 否则会自触发成死循环。探测因此放在下面的独立一次性任务里。
runtimeRegistry.subscribe((runtimes) => {
  // 给还没选过模型的执行器补上它的默认模型。
  // 缺了这一步，用户第一次打开模型下拉会看到「未选模型」，
  // 而模型在 StartSessionRequest 里是必填的 —— 就成了个死路。
  //
  // ⚠ 已选模型的悬空**不再就地改回默认**（原先会）。
  // 以前这里 `else if (!r.models.some(...)) patch[r.id] = r.defaultModel`，
  // 于是模型被下线时，用户以为自己在用 opus，实际已经悄悄跑成列表第一个
  // （codex 实测就是旗舰档 gpt-6-astra，$10/$50 per MTok）。
  // 模型下线不是用户的错，不该在他不知情时换掉他正在用的东西：
  // 现在保持选中，交给 UI 标「不可用」，由他决定换不换。
  // 判据用 visibleModelsFor 而不是 r.models —— 用户自己添加的自定义模型
  // 不在 r.models 里，但它可选，不该被判成失效。
  const state = useWorkbench.getState();
  const cur = state.runtimeModels;
  const patch: Record<string, ModelId> = {};
  for (const r of runtimes) {
    if (cur[r.id] === undefined) patch[r.id] = r.defaultModel;
  }
  if (Object.keys(patch).length > 0) {
    useWorkbench.setState((s) => ({ runtimeModels: { ...s.runtimeModels, ...patch } }));
  }
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

export const selectActiveRuntime = (s: WorkbenchState): RuntimeEntry | undefined =>
  s.runtimes.find((r) => r.id === s.activeRuntimeId);

/**
 * 用户是否**主动**把这个模型从选择器里藏了。
 *
 * 与「模型失效」是两回事，必须分开判：藏是明确意图，该尊重；失效是模型下线，
 * 不是用户的选择，不该因此偷换他正在用的模型。见 send() 里的回落注释。
 */
export function isHiddenByUser(
  s: WorkbenchState,
  runtimeId: string,
  modelId: string,
): boolean {
  return prefsOf(s.modelPrefs, runtimeId).hiddenModels.includes(asModelId(modelId));
}

/**
 * 某个模型 id 在该执行器当前**是否还可选**。
 *
 * 四个下拉框（设置页 / 待办 / 定时任务 / 提议横幅）共用这一个判据，
 * 免得各写一套又漂移 —— 只要有一个地方没接上，「隐藏失效模型」就漏了。
 *
 * 判据走 visibleModelsFor 而非 runtime.models：用户自己添加的自定义模型
 * 不在执行器申报清单里，但它照样可选，不该被判成失效。
 */
export function isModelAvailable(
  s: WorkbenchState,
  runtimeId: string,
  modelId: string | null | undefined,
): boolean {
  if (modelId === null || modelId === undefined || modelId === "") return false;
  return visibleModelsFor(s, runtimeId).some((m) => m.id === modelId);
}

/**
 * 取模型的展示 spec —— 当前清单里没有就退到失效留档，再没有才查本地目录。
 *
 * 失效留档这一步不能省：动态发现的新模型不在本地目录里，只查目录会返回
 * undefined，UI 上就只剩一个空气 id，用户完全不知道自己在选什么。
 */
export function modelSpecFor(
  runtime: RuntimeEntry | undefined,
  modelId: ModelId | null | undefined,
): ModelSpec | undefined {
  if (runtime === undefined || modelId === null || modelId === undefined) return undefined;
  return (
    runtime.models.find((m) => m.id === modelId) ??
    runtime.retiredModels.find((m) => m.id === modelId) ??
    modelById(modelId)
  );
}

/** 当前执行器 + 当前模型。composer 与能力展示都读它 */
export const selectActivePair = (
  s: WorkbenchState,
): {
  readonly runtime?: RuntimeEntry;
  readonly model?: ModelSpec;
  readonly modelId: ModelId | null;
  /** false = 用户选的模型已经失效。UI 必须标出来，绝不能静默换掉。 */
  readonly modelAvailable: boolean;
} => {
  const runtime = s.runtimes.find((r) => r.id === s.activeRuntimeId);
  const visible = runtime ? visibleModelsFor(s, s.activeRuntimeId) : [];
  const raw = s.runtimeModels[s.activeRuntimeId] ?? runtime?.defaultModel ?? null;
  // 保持用户选的那个 —— 失效也保持（原先在这里静默回落到 visible[0]，
  // 于是模型一被下线，用户以为在用 opus，实际悄悄跑的是列表第一个）。
  // 只有「压根没选过」才退到清单第一个。
  const modelId = raw ?? (visible[0]?.id ?? null);
  return {
    runtime,
    model: modelSpecFor(runtime, modelId),
    modelId,
    modelAvailable: isModelAvailable(s, s.activeRuntimeId, modelId),
  };
};

/** 某个 CLI 的有效模型清单。⚠ 返回引用稳定的数组（见 visibleModelsFor 的注释） */
export const selectVisibleModels =
  (runtimeId: string) =>
  (s: WorkbenchState): readonly ModelSpec[] =>
    visibleModelsFor(s, runtimeId);

/**
 * 当前工作单元下的会话列表，按最近更新倒序。
 * ⚠️ 返回新数组，必须配 useShallow。
 */
export const selectUnitSessions = (s: WorkbenchState): readonly Session[] =>
  s.sessions
    .filter((x) => x.unitId === s.activeUnitId)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);

export type { SessionId };

/** 当前工作单元的自动化，bot视图下最关心的一组 */
export const selectUnitAutomations = (s: WorkbenchState): readonly Automation[] =>
  s.automations.filter((a) => a.unitId === s.activeUnitId);

// 注册执行器 bootstrap —— 必须在 store 创建之后（要校正 activeRuntimeId）：
// 优先本地 daemon（真实执行），不可达时回退 mock（纯 UI 原型，daemon 没起是正常态）。
//
// ⚠ 必须重试：`pnpm dev` 下 vite 0.5s 就绪而 daemon 还要再起一会儿，页面先开就
// 撞上竞态；单次尝试失败会让执行器列表永远空着（「没有已注册的执行器」），
// 用户只能手动刷新。重试让竞态自愈。
//
// ⚠ 间隔必须**短间隔起步、指数退避**，不能是固定 3s。去掉 daemon 启动预热之后，
// 冷启动的 db→listening 实测只有 37ms，tsx 进程本身几百毫秒也就起来了 ——
// 也就是说「页面已加载但 daemon 还没监听」这个窗口通常不到一秒。固定 3s 会让用户
// 盯着一个空的执行器列表白等整整一轮，而实际差距可能只有 200ms。
// 封顶仍留 3s：daemon 真没起（被占用/崩溃）时，长间隔避免无谓重试风暴，
// 总时长仍在两分钟内自愈。
const RETRY_DELAYS_MS = [150, 300, 600, 1200, 3000] as const;
void (async () => {
  const { listDaemonExecutors } = await import("../adapters/daemon/client.ts");
  const { createDaemonFactory } = await import("../adapters/daemon/adapter.ts");
  const { defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");

  const MAX_ATTEMPTS = 40;
  let infos: Awaited<ReturnType<typeof listDaemonExecutors>> | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const list = await listDaemonExecutors(defaultDaemonEndpoint());
      if (list.length > 0) {
        infos = list;
        break;
      }
      // daemon 已监听但清单为空：注册在 listen 前同步完成，理论不可达——按失败重试
      throw new Error("daemon 无可用执行器");
    } catch (err: unknown) {
      if (attempt === 1) {
        console.info("[workbench] daemon 未就绪，按退避节奏重试（pnpm dev 下 daemon 比 vite 慢是常态）", err instanceof Error ? err.message : err);
      }
      if (attempt === MAX_ATTEMPTS) {
        console.info("[workbench] 本地 daemon 不可达 —— 无执行器可用（启动 backend/ 的 daemon 即接入真实执行）", err instanceof Error ? err.message : err);
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!));
    }
  }
  if (infos === null) return;
  try {
    const factories = infos.map((info) => createDaemonFactory(info, defaultDaemonEndpoint()));
    runtimeRegistry.registerAll(factories);
    // 登记各家能否动态发现模型：没实现的执行器，模型按钮对它无效 —— 界面要照实标，
    // 否则用户对着一个从不变的列表反复按刷新，还以为是自己没刷新对
    for (const info of infos) {
      runtimeRegistry.markModelDiscovery(asRuntimeId(`daemon:${info.id}`), info.modelsDiscoverable !== false);
    }
    runtimeRegistry.setState(factories[0]!.id, { status: "stopped" });
    useWorkbench.setState({ activeRuntimeId: factories[0]!.id });
    console.info(`[workbench] 已连接本地 daemon：${infos.map((i) => i.id).join(", ")}`);
    // 哪些模型本地元数据目录没收 —— **说出来**。
    // 原来的坑：查不到就静默丢弃，models 空了 → defaultModel 为 null → 整个
    // 执行器从列表里消失，控制台一个错都没有。现在降级显示（价格显示为未知），
    // 必须留痕，否则「加了个执行器但界面看不到」只能靠猜。
    //
    // 判据用 vendor === "custom" 而非文案：scaffoldModel 造的占位一律 vendor=custom，
    // 用户自己添加的自定义模型也是。绑死中文字符串的话，下次改文案这里就静默失配。
    //
    // 放在这里而不是 subscribe 里：registerAll 每注册一个就 emit 一次，
    // 在回调里打会把同一条消息刷 8 遍。
    const unlisted = runtimeRegistry
      .list()
      .flatMap((r) => r.models.filter((m) => m.vendor === "custom" && m.source === "").map((m) => `${r.presentation.displayName}/${m.id}`));
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
    // 走到这里说明连接已成功但注册/后续装配失败——与「daemon 不可达」不同源
    console.error("[workbench] 执行器注册失败（daemon 连接是好的，查 registerAll 装配链）", err instanceof Error ? err.message : err);
  }
})();
