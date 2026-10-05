/**
 * 右侧标签面板的领域契约。
 *
 * 形态照搬 ZCode 的 `packages/ui/src/lib/workspaceSidePane.ts`（2069 行）与
 * `app-shell/sidePaneTabSearch.ts`，去 Effect 化后保留全部行为语义。
 *
 * 抄下来的三条关键设计，都不是样式问题而是行为问题：
 *
 * 1. **tab 有作用域**。部分 tab 归属于某条会话而非整个工作区，
 *    切走会话时它们必须跟着隐藏，否则会看到别的会话的 diff。
 * 2. **关掉激活 tab 时落到右邻**，不是左邻也不是第一个。
 * 3. **重排不改变 activeTabId**。拖动只是换个位置，不该顺手切页。
 */

// ---------------------------------------------------------------------------
// Tab 类型
// ---------------------------------------------------------------------------

import { isShellTool, type PlanStepStatus, type RuntimeEvent } from "./events.ts";

/**
 * 本项目的 19 种页签，与 ZCode 的 `WorkspaceSidePaneTab` 一一对齐。
 *
 * scope 字段是 ZCode 里散落在 `isSidePaneTabVisibleForParent` 的 if 分支，
 * 在这里显式化 —— 让「这个 tab 归谁管」成为可查的声明，而不是散落的逻辑。
 */
export type SidePaneTabType =
  // 工作区级（ZCode: workspace global）
  | "capabilities" // 执行器能力
  | "workspace-files" // 本项目：浏览当前工作目录的文件
  | "deliverables" // 产出归档
  | "tools" // 开发者工具
  | "terminal" // ZCode: terminal（daemon 侧 node-pty 真 PTY，已接）
  | "git" // ZCode: git
  | "code-viewer" // ZCode: code-viewer
  | "treemapping" // ZCode: treemapping（本实现按 ZCode 口径过滤掉，见 HIDDEN_TAB_TYPES）
  | "model-trajectory" // ZCode: model-trajectory
  | "developer-tools" // ZCode: developer-tools
  // 会话级（ZCode: parentSessionId 收窄）
  | "files" // 文件变更
  | "trace" // ZCode: model-trajectory 的会话视角
  | "plan" // ZCode: plan-detail
  | "bash-output" // ZCode: bash-output（root-session 收窄）
  // 会话树根级（ZCode: rootSessionId 收窄）
  | "subagent" // ZCode: subagent-session
  | "subagent-directory" // ZCode: subagent-directory
  // 注：ZCode 的 workflow-* 一族（编排运行/目录/actor/工作区/产物）**已整体删除**。
  // 编排不是本产品要解决的问题方向（见北极星），留着它们只会让人以为这条路还开着。
  // 真要重做编排，这里是入口，历史实现见 git log。

/** 作用域：与 ZCode `isSidePaneTabVisibleForParent` 的三类归属一一对应 */
export type SidePaneScope = "workspace" | "session" | "root-session";

const SCOPE: Record<SidePaneTabType, SidePaneScope> = {
  capabilities: "workspace",
  deliverables: "workspace",
  tools: "workspace",
  terminal: "workspace",
  git: "workspace",
  "workspace-files": "workspace",
  "code-viewer": "workspace",
  treemapping: "workspace",
  "model-trajectory": "workspace",
  "developer-tools": "workspace",

  files: "session",
  trace: "session",
  plan: "session",
  "bash-output": "root-session",

  subagent: "root-session",
  "subagent-directory": "root-session",
};

export function scopeOf(type: SidePaneTabType): SidePaneScope {
  return SCOPE[type];
}

/**
 * ZCode 在 `normalizeWorkspaceSidePaneState` 里把 treemapping 过滤掉了
 * （注释：「Treemapping 当前需要从侧边栏隐藏」）。这里照做，
 * 否则入口会与上游不一致。
 */
export const HIDDEN_TAB_TYPES: ReadonlySet<SidePaneTabType> = new Set<SidePaneTabType>([
  "treemapping",
]);

/** 展示元数据 —— 对齐 `sidePaneTabPresentation` 的 typeLabel 与 searchHint */
export const TAB_META: Record<
  SidePaneTabType,
  { readonly title: string; readonly typeLabel: string; readonly hint: string }
> = {
  capabilities: { title: "能力", typeLabel: "执行器", hint: "runtime capability provider transport" },
  deliverables: { title: "产出", typeLabel: "产出", hint: "deliverable artifact output 产出归档" },
  tools: { title: "工具", typeLabel: "开发者工具", hint: "mcp tool developer 开发者工具" },
  terminal: { title: "终端", typeLabel: "终端", hint: "shell terminal command 终端" },
  git: { title: "变更", typeLabel: "git diff", hint: "git diff change review 变更审查" },
  "code-viewer": { title: "查看", typeLabel: "文件查看", hint: "code viewer file open 文件查看" },
  treemapping: { title: "活动映射", typeLabel: "活动映射", hint: "treemapping activity map 活动映射" },
  "model-trajectory": { title: "模型轨迹", typeLabel: "模型轨迹", hint: "model io trajectory 轨迹" },
  "developer-tools": { title: "开发者工具", typeLabel: "开发者工具", hint: "devtools console 开发者工具" },

  "workspace-files": { title: "工作区文件", typeLabel: "目录浏览", hint: "workspace files folder 目录浏览" },
  files: { title: "文件", typeLabel: "文件变更", hint: "file change diff 文件变更" },
  trace: { title: "轨迹", typeLabel: "运行轨迹", hint: "trace event run 运行轨迹" },
  plan: { title: "计划", typeLabel: "计划详情", hint: "plan ExitPlanMode 计划详情" },
  "bash-output": { title: "后台输出", typeLabel: "后台命令", hint: "background bash output 后台命令" },

  subagent: { title: "子代理", typeLabel: "子代理", hint: "subagent child session 子代理" },
  "subagent-directory": { title: "子代理目录", typeLabel: "子代理目录", hint: "subagent directory 目录" },
};

export function metaOf(type: SidePaneTabType): { readonly title: string; readonly typeLabel: string; readonly hint: string } {
  return TAB_META[type];
}

// ---------------------------------------------------------------------------
// 页签目录 —— ZCode 的「+」加号菜单
// ---------------------------------------------------------------------------

/**
 * 展示顺序 = 目录菜单顺序。
 *
 * 手工列出而不是 `Object.keys(TAB_META)`：对象键序是实现细节，
 * 而菜单顺序是产品决策（按「有多常用」排，不是按字母）。
 */
const TAB_ORDER = [
  // 工作区级
  "workspace-files",
  "git",
  "code-viewer",
  "terminal",
  "model-trajectory",
  "developer-tools",
  "tools",
  "capabilities",
  "deliverables",
  // 会话级
  "files",
  "plan",
  "trace",
  // 会话树根级
  "subagent",
  "subagent-directory",
  "bash-output",
  // 按 ZCode 口径隐藏（保留在类型里，但不出现在目录中）
  "treemapping",
] as const satisfies readonly SidePaneTabType[];

/**
 * 编译期断言：TAB_ORDER 必须覆盖 SidePaneTabType 的每一个成员。
 *
 * 少了任何一种，`Exclude<...>` 就不是 never，`_exhaustive` 的赋值会报错。
 * 这样「加了一种页签却忘了加进目录」在 tsc 阶段就挂，而不是上线后菜单里少一项。
 */
type _MissingFromOrder = Exclude<SidePaneTabType, (typeof TAB_ORDER)[number]>;
const _exhaustive: _MissingFromOrder extends never ? true : never = true;
void _exhaustive;

/** 全部页签类型（含被隐藏的），供自检遍历 */
export const ALL_TAB_TYPES: readonly SidePaneTabType[] = TAB_ORDER;

/** 目录里可见的全部页签类型（已剔除 HIDDEN_TAB_TYPES） */
export function listVisibleTabTypes(): readonly SidePaneTabType[] {
  return TAB_ORDER.filter((t) => !HIDDEN_TAB_TYPES.has(t));
}

/** 按作用域分组 —— 菜单里「工作区级 / 会话级 / 会话树根级」三段 */
export function groupTabTypesByScope(
  types: readonly SidePaneTabType[] = listVisibleTabTypes(),
): readonly { readonly scope: SidePaneScope; readonly label: string; readonly types: readonly SidePaneTabType[] }[] {
  const LABEL: Record<SidePaneScope, string> = {
    workspace: "工作区级",
    session: "会话级",
    "root-session": "会话树根级",
  };
  return (["workspace", "session", "root-session"] as const)
    .map((scope) => ({ scope, label: LABEL[scope], types: types.filter((t) => SCOPE[t] === scope) }))
    .filter((g) => g.types.length > 0);
}

export const SCOPE_LABEL: Record<SidePaneScope, string> = {
  workspace: "工作区级",
  session: "会话级",
  "root-session": "会话树根级",
};

/**
 * 页签 id 的唯一形态 —— 集中在这里，别处不许自己拼。
 *
 * 工作区级没有归属，id 就是类型名；会话/会话树根级必须带 owner，
 * 否则两条会话会共用同一页（切会话时看到的是别人的 diff）。
 */
export function tabIdFor(type: SidePaneTabType, ownerId: string | null, subject?: string | null): string {
  const base = SCOPE[type] === "workspace" ? type : `${type}@${ownerId ?? "-"}`;
  return subject ? `${base}:${subject}` : base;
}

/** 构造一个可直接喂给 `openTab` 的 draft */
export function makeTabDraft(
  type: SidePaneTabType,
  ownerId: string | null,
  subject?: string | null,
): Omit<SidePaneTab, "openedAt"> & { readonly openedAt?: number } {
  const scope = SCOPE[type];
  const needsOwner = scope !== "workspace" && !ownerId;
  const title = subject ? `${TAB_META[type].title} · ${basename(subject)}` : TAB_META[type].title;
  return {
    id: tabIdFor(type, ownerId, subject),
    type,
    title,
    scope,
    subject: subject ?? null,
    // 无会话时会话级页签一律给 null 归属，由 UI 负责不给它开门 ——
    // 与 ZCode「没有 parentSessionId 就没有这类页签」一致
    ownerId: scope === "workspace" ? null : needsOwner ? null : ownerId,
    keepMounted: KEEP_MOUNTED_TYPES.has(type),
  };
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * 需要常驻挂载的页签 —— 运行时资源依赖 DOM 持续存在，卸载即丢状态
 * （终端滚到底、后台命令的实时输出）。
 */
export const KEEP_MOUNTED_TYPES: ReadonlySet<SidePaneTabType> = new Set<SidePaneTabType>([
  "bash-output",
  "terminal",
]);

/** 该页签当前能不能开 —— 会话级页签没有会话就开不了 */
export function canOpenTab(type: SidePaneTabType, ownerId: string | null): boolean {
  return SCOPE[type] === "workspace" || ownerId !== null;
}

/** 开不了的原因，喂给 UI 直接显示 */
export function blockedReason(type: SidePaneTabType, ownerId: string | null): string | null {
  if (canOpenTab(type, ownerId)) return null;
  return SCOPE[type] === "root-session" ? "需先打开一条会话" : "需先打开一条会话";
}

// 注：原先这里有 NEEDS_RUNTIME（browser / browser-use / whiteboard / selection-chat /
// terminal / workflow-* 各自「缺什么」），配套 PendingRuntimePane 给占位页签显示待接入说明。
// 那批页签已整体删除 —— 留着入口只会让人以为这条路还开着。
// 真要重新接（例如 Electron 桌面壳的 webview），从这里重建，git log 有原实现。
export const NEEDS_RUNTIME: Partial<Record<SidePaneTabType, string>> = {};


export interface SidePaneTab {
  readonly id: string;
  readonly type: SidePaneTabType;
  /** 展示标题 */
  readonly title: string;
  readonly scope: SidePaneScope;
  /**
   * scope 为 session 时，这是它归属的会话 id。
   * scope 为 root-session 时，这是它归属的会话树根 id。
   */
  readonly ownerId?: string | null;
  /**
   * 页签的「对象」—— 同一类型可以开多页时区分它们。
   *
   * 对齐 ZCode 的 `openCodeViewerSidePanes`（复数）：文件查看器是**每个文件一页**，
   * 不是一页里切文件。工作区级的 code-viewer 因此也是一文件一 tab。
   */
  readonly subject?: string | null;
  readonly openedAt?: number;
  /**
   * 面板不可见时仍需保持内容挂载。
   * 对应 ZCode 的 browser / browser-use / bash-output ——
   * 它们的运行时资源依赖 DOM 持续存在，卸载会丢状态。
   */
  readonly keepMounted?: boolean;
}

export interface SidePaneState {
  readonly tabs: readonly SidePaneTab[];
  readonly activeTabId: string;
}

/**
 * 状态边界归一 —— 对齐 ZCode 的 `normalizeWorkspaceSidePaneState`。
 *
 * ZCode 在这里做两件事：
 * 1. 过滤掉 HIDDEN_TYPES（treemapping）—— 旧版本可能已把隐藏类型写进记忆
 * 2. 过滤到空则整个 state 变 null
 *
 * 我们的持久化范围更窄（只有展开尺寸），但过滤逻辑仍要保留：
 * 过滤必须发生在状态边界，而不是散落在渲染时。
 */
export function normalizeSidePaneState(current: SidePaneState | null): SidePaneState | null {
  if (!current) return null;

  const filtered = current.tabs.filter((t) => !HIDDEN_TAB_TYPES.has(t.type));
  if (filtered.length === 0) return null;

  const activeTabId = filtered.some((t) => t.id === current.activeTabId) ? current.activeTabId : "";
  return { tabs: filtered, activeTabId };
}

// ---------------------------------------------------------------------------
// 可见性
// ---------------------------------------------------------------------------

/**
 * 这个 tab 在当前会话下是否可见。
 * 对齐 ZCode 的 `isSidePaneTabVisibleForParent`。
 */
export function isTabVisibleForOwner(tab: SidePaneTab, ownerId: string | null): boolean {
  if (tab.scope === "workspace") return true;
  return tab.ownerId === ownerId;
}

export function getVisibleTabs(
  state: SidePaneState | null,
  ownerId: string | null,
): readonly SidePaneTab[] {
  if (!state) return [];
  return state.tabs.filter((t) => isTabVisibleForOwner(t, ownerId));
}

/** 关闭当前 owner 下的所有 tab 之后是否应当整体收起面板 */
export function shouldCollapseAfterClose(remaining: readonly SidePaneTab[]): boolean {
  return remaining.length === 0;
}

// ---------------------------------------------------------------------------
// 激活回落
// ---------------------------------------------------------------------------

/**
 * 关闭后该激活哪一个。
 * 对齐 ZCode 的 `closeSidePaneTab`：关掉激活页时落到**右邻**，即
 * `min(closingIndex, len - 1)`；不是左邻，也不是第一个。
 */
export function resolveActiveAfterClose(
  state: SidePaneState,
  closingId: string,
): SidePaneState | null {
  const closingIndex = state.tabs.findIndex((t) => t.id === closingId);
  if (closingIndex < 0) return state;

  const next = state.tabs.filter((t) => t.id !== closingId);
  if (next.length === 0) return null;

  // 关的不是当前激活页 —— 激活页保持不变
  if (state.activeTabId !== closingId) return { tabs: next, activeTabId: state.activeTabId };

  const fallbackIndex = Math.min(closingIndex, next.length - 1);
  return { tabs: next, activeTabId: next[fallbackIndex]!.id };
}

/**
 * owner 收窄后的激活修正。
 * 对齐 ZCode 的 `selectSidePaneTabsForParent`：
 * 若当前激活页在新的可见集里消失，优先落到可见集中「会话型」tab 的最后一个，
 * 再退到可见集最后一个 —— 会话型 tab 比 workspace 全局 tab 更可能是用户刚看的。
 */
export function resolveActiveForOwner(
  state: SidePaneState,
  ownerId: string | null,
  preferredId?: string | null,
): SidePaneState {
  const visible = getVisibleTabs(state, ownerId);
  if (visible.length === 0) {
    return state.activeTabId === "" ? state : { ...state, activeTabId: "" };
  }

  const current = visible.find((t) => t.id === state.activeTabId);
  const preferred = preferredId ? visible.find((t) => t.id === preferredId) : undefined;

  const next =
    current ??
    preferred ??
    visible.findLast((t) => t.scope !== "workspace") ??
    visible.at(-1);

  return next && next.id !== state.activeTabId ? { ...state, activeTabId: next.id } : state;
}

// ---------------------------------------------------------------------------
// 关闭
// ---------------------------------------------------------------------------

export function closeTab(state: SidePaneState, tabId: string): SidePaneState | null {
  return resolveActiveAfterClose(state, tabId);
}

/** 只关当前 owner 下的其他页 —— 对齐 `closeVisibleOtherSidePaneTabs` */
export function closeOtherTabs(
  state: SidePaneState,
  keepTabId: string,
  ownerId: string | null,
): SidePaneState {
  const visible = getVisibleTabs(state, ownerId);
  const target = visible.find((t) => t.id === keepTabId);
  if (!target) return state;

  const closingIds = new Set(visible.filter((t) => t.id !== keepTabId).map((t) => t.id));
  return {
    tabs: state.tabs.filter((t) => !closingIds.has(t.id)),
    activeTabId: target.id,
  };
}

/** 关掉当前 owner 下的全部 —— 对齐 `closeVisibleSidePaneTabs` */
export function closeOwnerTabs(state: SidePaneState, ownerId: string | null): SidePaneState | null {
  const closingIds = new Set(getVisibleTabs(state, ownerId).map((t) => t.id));
  const tabs = state.tabs.filter((t) => !closingIds.has(t.id));
  return tabs.length === 0 ? null : { tabs, activeTabId: "" };
}

export function setActiveTab(state: SidePaneState, tabId: string): SidePaneState {
  if (!state.tabs.some((t) => t.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

// ---------------------------------------------------------------------------
// 重排
// ---------------------------------------------------------------------------

/**
 * 拖拽重排。对齐 `reorderSidePaneTab`：**不改变 activeTabId**，
 * 拖动只是换位置，不该顺手切页。
 */
export function reorderTab(
  state: SidePaneState,
  activeId: string,
  overId: string,
): SidePaneState {
  if (activeId === overId) return state;
  const from = state.tabs.findIndex((t) => t.id === activeId);
  const to = state.tabs.findIndex((t) => t.id === overId);
  if (from < 0 || to < 0) return state;

  const next = [...state.tabs];
  const [moved] = next.splice(from, 1);
  if (!moved) return state;
  next.splice(to, 0, moved);

  return { tabs: next, activeTabId: state.activeTabId };
}

// ---------------------------------------------------------------------------
// 打开
// ---------------------------------------------------------------------------

/**
 * 打开或激活。对齐 ZCode 的 `openXxxSidePane` 共用模式：
 * 同类型 + 同归属 + 同目标已存在时**复用**，而不是叠一个新页。
 */
export function openTab(
  state: SidePaneState | null,
  draft: Omit<SidePaneTab, "openedAt"> & { readonly openedAt?: number },
): SidePaneState {
  const existing =
    state?.tabs.find(
      (t) => t.type === draft.type && t.ownerId === draft.ownerId && t.id === draft.id,
    ) ?? undefined;

  if (existing && state) {
    return { tabs: state.tabs, activeTabId: existing.id };
  }

  const tab: SidePaneTab = { ...draft, openedAt: draft.openedAt ?? Date.now() };
  return { tabs: [...(state?.tabs ?? []), tab], activeTabId: tab.id };
}

/** 批量打开（如一次打开多个文件），最后一个成为激活页 —— 对齐 `openCodeViewerSidePanes` */
export function openTabs(
  state: SidePaneState | null,
  drafts: readonly (Omit<SidePaneTab, "openedAt"> & { readonly openedAt?: number })[],
): SidePaneState {
  let next = state;
  for (const d of drafts) next = openTab(next, d);
  return next ?? { tabs: [], activeTabId: "" };
}

/** 面板是否需要保持内容挂载 —— 对齐 `shouldMountSidePaneContent` */
export function shouldKeepMounted(
  isVisible: boolean,
  tabs: readonly SidePaneTab[],
): boolean {
  return isVisible || tabs.some((t) => t.keepMounted === true);
}

// ---------------------------------------------------------------------------
// 页签徽标 —— 渲染时派生，不存进 tab 里
// ---------------------------------------------------------------------------

/**
 * 每种页签的计数徽标。
 *
 * **为什么派生而不存**：存进 tab 就得有人负责更新，而更新点分散在各处
 * （事件到达、开关页签、切会话），漏一处就是一个永远过期的数字。
 * 从事件流现算，天然不会有陈旧值。
 *
 * **为什么必须有**：面板窄的时候标签条会横向裁剪，被裁掉的那一页你根本看不见。
 * 徽标是「看不见但有事」的最后一个信号 —— 没有它，裁剪等于静默丢功能。
 *
 * 只给**有实际含义**的类型计数；`capabilities` / `deliverables` 这类
 * 「内容就是全部」的页不给数字，给了只是噪声。
 */
export function deriveTabBadges(
  events: readonly RuntimeEvent[],
  ownerId: string | null,
): ReadonlyMap<SidePaneTabType, number> {
  const own = ownerId ? events.filter((e) => e.sessionId === ownerId) : events;
  const out = new Map<SidePaneTabType, number>();

  const bump = (type: SidePaneTabType, n: number) => {
    if (n > 0) out.set(type, (out.get(type) ?? 0) + n);
  };

  // 文件变更：git 看全工作区，files 只看本会话
  const allPaths = new Set<string>();
  const ownPaths = new Set<string>();
  for (const e of events) {
    if (e.type === "file.diff" || e.type === "file.changed") {
      allPaths.add(e.path);
      if (!ownerId || e.sessionId === ownerId) ownPaths.add(e.path);
    }
  }
  bump("git", allPaths.size);
  bump("files", ownPaths.size);

  // 待裁决的权限：requested 没被 resolved 掉就一直挂着
  const resolved = new Set<string>();
  const requested = new Set<string>();
  for (const e of events) {
    if (e.type === "permission.resolved") resolved.add(e.requestId);
    else if (e.type === "permission.requested") requested.add(e.requestId);
  }
  bump("trace", [...requested].filter((id) => !resolved.has(id)).length);

  // 工具失败
  const nameByCall = new Map<string, string>();
  let failed = 0;
  for (const e of events) {
    if (e.type === "tool.started") nameByCall.set(e.callId, e.toolName);
    else if (e.type === "tool.completed" && !e.ok) {
      const n = nameByCall.get(e.callId);
      if (n) failed += 1;
    }
  }
  bump("developer-tools", failed);
  bump("tools", failed);

  // shell 调用数 → 后台命令
  let shells = 0;
  for (const e of events) if (e.type === "tool.started" && isShellTool(e.toolName)) shells += 1;
  bump("bash-output", shells);

  // 计划里没做完的步骤
  const stepStatus = new Map<string, PlanStepStatus>();
  for (const e of own) {
    if (e.type === "plan.proposed") for (const s of e.steps) stepStatus.set(s.id, s.status);
    else if (e.type === "plan.step.updated") stepStatus.set(e.stepId, e.status);
  }
  bump("plan", [...stepStatus.values()].filter((s) => s !== "done" && s !== "skipped").length);

  // 还没结束的子代理
  const spawned = new Set<string>();
  const finished = new Set<string>();
  for (const e of own) {
    if (e.type === "subagent.spawned") spawned.add(e.childId);
    else if (e.type === "subagent.finished") finished.add(e.childId);
  }
  bump("subagent", [...spawned].filter((id) => !finished.has(id)).length);

  return out;
}

// ---------------------------------------------------------------------------
// 搜索评分 —— 对齐 sidePaneTabSearch.ts
// ---------------------------------------------------------------------------

export interface SearchFields {
  readonly title: string;
  readonly hint: string;
  readonly typeLabel: string;
  readonly all: string;
}

export function buildSearchFields(title: string, hint: string, typeLabel: string): SearchFields {
  const n = (v: string) => v.trim().toLocaleLowerCase();
  const t = n(title);
  const h = n(hint);
  const l = n(typeLabel);
  return { title: t, hint: h, typeLabel: l, all: n(`${title} ${hint} ${typeLabel}`) };
}

export function normalizeSearchQuery(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 过滤 + 排序。评分权重与 ZCode 完全一致：
 * 标题前缀 120 > 词首 90 > 标题包含 70 > 提示包含 40 > 类型包含 20 > 其余 1
 * 多个关键词之间是 AND：每个词都必须命中 all 字段。
 */
export function filterAndRankSearchItems<T extends { readonly searchFields: SearchFields }>(
  items: readonly T[],
  queryParts: readonly string[],
): T[] {
  if (queryParts.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: getSearchScore(item.searchFields, queryParts) }))
    .filter((e) => e.score > 0)
    .sort((l, r) => r.score - l.score || l.index - r.index)
    .map((e) => e.item);
}

function getSearchScore(fields: SearchFields, parts: readonly string[]): number {
  if (!parts.every((p) => fields.all.includes(p))) return 0;
  return parts.reduce((score, part) => {
    if (fields.title.startsWith(part)) return score + 120;
    if (hasWordPrefix(fields.title, part)) return score + 90;
    if (fields.title.includes(part)) return score + 70;
    if (fields.hint.includes(part)) return score + 40;
    if (fields.typeLabel.includes(part)) return score + 20;
    return score + 1;
  }, 0);
}

function hasWordPrefix(value: string, part: string): boolean {
  return value.split(/[\s/_.:-]+/).some((w) => w.startsWith(part));
}

// ---------------------------------------------------------------------------
// 溢出 —— 对齐 sidePaneLayout.ts
// ---------------------------------------------------------------------------

export const SIDE_PANE_TAB_MIN_WIDTH_PX = 60;
export const SIDE_PANE_TAB_GAP_PX = 4;
export const SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX = 1;

export function resolveTabsOverflow(opts: {
  readonly addButtonInside: boolean;
  readonly addButtonWidth: number;
  readonly tabCount: number;
  readonly viewportWidth: number;
}): boolean {
  const { addButtonInside, addButtonWidth, tabCount, viewportWidth } = opts;
  const tabsWidth = tabCount * SIDE_PANE_TAB_MIN_WIDTH_PX + Math.max(0, tabCount - 1) * SIDE_PANE_TAB_GAP_PX;
  const addGap = tabCount > 0 ? SIDE_PANE_TAB_GAP_PX : 0;
  const viewportWithAdd = viewportWidth + (addButtonInside ? 0 : addButtonWidth);
  const contentWithAdd = tabsWidth + addGap + addButtonWidth;
  return contentWithAdd > viewportWithAdd + SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX;
}
