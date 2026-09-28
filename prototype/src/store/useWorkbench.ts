import { create } from "zustand";
import { mockFactories } from "../adapters/mock/adapter.ts";
import { SAMPLE_ARCHIVED_SESSIONS, SAMPLE_AUTOMATIONS, SAMPLE_DELIVERABLES, SAMPLE_SESSIONS, SAMPLE_UNITS } from "../adapters/mock/fixtures.ts";
import type { Automation } from "../core/automation.ts";
import { asModelId, canRuntimeUse, modelById, type ModelId, type ModelSpec } from "../core/models.ts";
import { asSessionId } from "../core/units.ts";
import {
  normalizePrefs,
  parsePrefsMap,
  prefsOf,
  pruneEmptyPrefs,
  resolveVisibleModels,
  type ModelPrefsMap,
  type ProviderModelPrefs,
} from "../core/modelPrefs.ts";
import type { PermissionMode } from "../core/permission.ts";
import type { Attachment } from "../core/units.ts";
import type { RuntimeAdapter, PermissionDecision } from "../core/adapter.ts";
import type { RuntimeEvent } from "../core/events.ts";
import { runtimeRegistry } from "../core/registry.ts";
import type { RuntimeEntry } from "../core/registry.ts";
import type { Deliverable, Session, SessionId, UnitId, WorkUnit } from "../core/units.ts";

// 注册六家工具。注册表不认识厂商，只认识 RuntimeId 字符串。
runtimeRegistry.registerAll(mockFactories);

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

interface TimelineItem {
  readonly id: number;
  readonly event: RuntimeEvent;
  readonly at: number;
}

interface WorkbenchState {
  units: readonly WorkUnit[];
  archivedSessions: readonly Session[];
  activeUnitId: UnitId;
  view: ViewMode;
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
  sessions: readonly Session[];
  activeSessionId: SessionId | null;
  timeline: readonly TimelineItem[];
  deliverables: readonly Deliverable[];
  busy: boolean;
  /** 定时任务。bot模式的时间维度 */
  automations: readonly Automation[];
  /** 输入框草稿。空态建议卡片点一下就能预填 */
  draft: string;
  /** 执行器实例偏好（T3 Providers 页逻辑：启用开关 / 覆盖 / 环境变量） */
  runtimePrefs: Readonly<Record<string, RuntimePref>>;
  setRuntimePref: (id: string, patch: Partial<Omit<RuntimePref, "enabled">> & { enabled?: boolean }) => void;
  /** 全量重探测（T3 的 Checked 刷新） */
  probeAll: () => Promise<void>;
  /** 已裁决的权限请求：requestId → 决策。用于把权限卡切成「已处理」态 */
  permissionDecisions: Readonly<Record<string, string>>;
  /** 本次运行的权限模式（composer 右侧常驻） */
  permissionMode: PermissionMode;
  /** 本条消息携带的附件 */
  attachments: readonly Attachment[];

  setView: (v: ViewMode) => void;
  selectUnit: (id: UnitId) => void;
  addUnit: (u: WorkUnit) => void;
  selectSession: (id: SessionId | null) => void;
  selectRuntime: (id: string) => void;
  /** 换模型。非法组合（该执行器不接这个模型）静默拒绝，不改状态 */
  selectModel: (model: ModelId) => void;
  /** 改某个 CLI 的模型偏好。动作原子，不合法的输入原样返回由调用方处理 */
  setModelPrefs: (runtimeId: string, next: ProviderModelPrefs) => void;
  /** 批量入口：给一组动作依次应用，任一步失败则整组不动 */
  applyModelPrefs: (runtimeId: string, steps: readonly ((p: ProviderModelPrefs) => ProviderModelPrefs)[]) => void;
  setDraft: (v: string) => void;
  setPermissionMode: (m: PermissionMode) => void;
  addAttachment: (a: Attachment) => void;
  removeAttachment: (id: string) => void;
  toggleAutomation: (id: string) => void;
  run: (prompt: string) => Promise<void>;
  /** 停止当前运行。mock 适配器没有真正的取消通道，只翻 busy 位 */
  cancelRun: () => void;
  resolvePermission: (requestId: string, decision: PermissionDecision) => void;
}

let seq = 0;

/* ------------------------------------------------------------------ 模型偏好 */

/** 某个 CLI 适配器**声明**的内置模型（不含用户自定义） */
function declaredOf(s: WorkbenchState, runtimeId: string): readonly ModelSpec[] {
  return s.runtimes.find((r) => r.id === runtimeId)?.models ?? [];
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

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  units: SAMPLE_UNITS,
  archivedSessions: SAMPLE_ARCHIVED_SESSIONS,
  activeUnitId: SAMPLE_UNITS[0]!.id,
  view: "bot",
  runtimes: [],
  activeRuntimeId: "zcode",
  // 注册表订阅到位后由下方 syncRuntimeModels 补齐各执行器的默认模型
  runtimeModels: {},
  modelPrefs: readPrefs(),
  modelPrefsVersion: 0,
  sessions: SAMPLE_SESSIONS,
  activeSessionId: null,
  timeline: [],
  deliverables: SAMPLE_DELIVERABLES,
  busy: false,
  draft: "",
  runtimePrefs: {} as Readonly<Record<string, RuntimePref>>,
  permissionDecisions: {},
  permissionMode: "ask",
  attachments: [],
  automations: SAMPLE_AUTOMATIONS,

  setDraft: (draft) => set({ draft }),

  setPermissionMode: (permissionMode) => set({ permissionMode }),

  addAttachment: (a) => set((s) => ({ attachments: [...s.attachments, a] })),
  removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),

  toggleAutomation: (id) =>
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    })),

  setView: (view) => {
    // 切视图时自动落到该身份的第一个单元
    const first = get().units.find((u) => u.kind === view);
    set({ view, activeUnitId: first?.id ?? get().activeUnitId });
  },

  selectUnit: (activeUnitId) => set({ activeUnitId, activeSessionId: null }),

  addUnit: (u) =>
    set((s) => ({
      units: [...s.units, u],
      activeUnitId: u.id,
      activeSessionId: null,
    })),

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

  cancelRun: () => set({ busy: false }),

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

  resolvePermission: (requestId, decision) => {
    const sessions = get().sessions;
    const session = sessions.at(-1);
    if (!session) return;

    // 先落本地裁决，UI 立刻放行，不等网络往返
    set((s) => ({
      permissionDecisions: { ...s.permissionDecisions, [requestId]: decision },
    }));

    void runtimeRegistry.getOrCreate(session.runtimeId as never).then((a: RuntimeAdapter) =>
      a.resolvePermission(session.id, requestId, decision),
    );
  },

  run: async (prompt) => {
    const { activeUnitId, activeRuntimeId, runtimeModels } = get();
    const unit = get().units.find((u) => u.id === activeUnitId);
    if (!unit) return;

    set({ busy: true, timeline: [] });

    const adapter = await runtimeRegistry.getOrCreate(activeRuntimeId as never);

    // 模型三级回落：用户所选 → 工作单元 modelHint → 该 CLI 当前有效清单的第一个。
    // 每一级都过「有效清单」校验：用户在设置里藏掉的模型不算数，
    // modelHint 指向一个被藏掉 / 该 CLI 不接的模型时也不能生效。
    const visible = visibleModelsFor(get(), activeRuntimeId);
    const hint = unit.bindings.find((b) => b.runtimeId === activeRuntimeId)?.modelHint;
    const picked = runtimeModels[activeRuntimeId];
    const inVisible = (id: ModelId | null | undefined) => id !== null && id !== undefined && visible.some((m) => m.id === id);
    const model: ModelId = inVisible(picked) ? picked! : inVisible(hint ? asModelId(hint) : null) ? (asModelId(hint!) as ModelId) : (visible[0]?.id ?? asModelId(""));

    const session = await adapter.startSession({
      unit,
      prompt,
      model,
      worktree: unit.kind === "project" ? { path: `${unit.rootPath}/.wt/session`, branch: "feat/session" } : undefined,
    });

    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }));

    // 用户消息是时间线的第一行（ZCode：右对齐的用户气泡）。
    // sessionId 必须是真实会话 —— 右栏轨迹按会话过滤归档，占位 id 会被滤掉
    set((s) => ({
      timeline: [
        {
          id: ++seq,
          event: {
            type: "message.delta",
            sessionId: session.id,
            messageId: `u${++seq}`,
            role: "user" as const,
            text: prompt,
          } as const,
          at: Date.now(),
        },
        ...s.timeline,
      ],
    }));

    // 归一化事件流：UI 唯一的数据入口
    void (async () => {
      for await (const event of adapter.events()) {
        set((s) => ({
          timeline: [...s.timeline, { id: ++seq, event, at: Date.now() }],
        }));
        if (event.type === "deliverable") {
          set((s) => ({
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
        if (event.type === "session.ended") set({ busy: false });
      }
    })();
  },
}));

// 镜像注册表状态到 store。
// 注意：订阅回调里只做「读状态 → 写 store」，绝不能在里面再触发注册表变更，
// 否则会自触发成死循环。探测因此放在下面的独立一次性任务里。
runtimeRegistry.subscribe((runtimes) => {
  // 给还没选过模型的执行器补上它的默认模型。
  // 缺了这一步，用户第一次打开模型下拉会看到「未选模型」，
  // 而模型在 StartSessionRequest 里是必填的 —— 就成了个死路。
  const patch: Record<string, ModelId> = {};
  for (const r of runtimes) {
    if (useWorkbench.getState().runtimeModels[r.id] === undefined) patch[r.id] = r.defaultModel;
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

/** 当前执行器 + 当前模型。composer 与右栏「能力」页都读它 */
export const selectActivePair = (
  s: WorkbenchState,
): { readonly runtime?: RuntimeEntry; readonly model?: ModelSpec; readonly modelId: ModelId | null } => {
  const runtime = s.runtimes.find((r) => r.id === s.activeRuntimeId);
  const visible = runtime ? visibleModelsFor(s, s.activeRuntimeId) : [];
  const raw = s.runtimeModels[s.activeRuntimeId] ?? runtime?.defaultModel ?? null;
  // 所选模型可能已被用户在设置里藏掉 → 回落到当前有效清单的第一个
  const modelId = visible.some((m) => m.id === raw) ? raw : (visible[0]?.id ?? null);
  return { runtime, model: modelById(modelId), modelId };
};

/** 某个 CLI 的有效模型清单。⚠ 返回引用稳定的数组（见 visibleModelsFor 的注释） */
export const selectVisibleModels =
  (runtimeId: string) =>
  (s: WorkbenchState): readonly ModelSpec[] =>
    visibleModelsFor(s, runtimeId);

/**
 * ⚠️ 这个 selector 每次调用都返回**新数组**。
 * 必须配合 zustand 的 useShallow 使用，否则 getSnapshot 每次返回不同引用，
 * React 19 的 useSyncExternalStore 会判定为无限循环（"Maximum update depth exceeded"）。
 * 右栏的产出列表就是踩了这个坑。
 */
export const selectUnitDeliverables = (s: WorkbenchState): readonly Deliverable[] =>
  s.deliverables.filter((d) => d.unitId === s.activeUnitId);

/**
 * 当前工作单元下的会话列表，按最近更新倒序。
 * 对应 ZCode 侧栏里的 task 列表：workspace 展开后露出它的 tasks。
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
