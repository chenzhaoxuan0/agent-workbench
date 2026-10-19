/**
 * 右侧标签面板的领域契约 —— 纯函数，不碰 React / DOM / store。
 *
 * 形态照搬 ZCode 的 `packages/ui/src/lib/workspaceSidePane.ts`，按本产品的体量裁剪。
 * 上一版右栏（IDE 式 19-tab）死于「只切状态、没人渲染」，本版只服务真实入口。
 * 现有四类 tab：历史会话（弹窗迁移）、会话实时监控（后台会话事件流跟随）、
 * 计划 / 任务进度（活跃会话的 plan 事件）、变更审查（工作目录改动面）。
 *
 * 抄下来的三条关键设计，都不是样式问题而是行为问题：
 *
 * 1. **tab 有结构化身份**。id 由业务键拼出（`history:{unitId}`），同一身份重复
 *    打开只聚焦复用，不并排开两个；「多开」的语义因此是精确的 —— 不同身份才并排。
 * 2. **关掉激活 tab 时落到右邻**，不是左邻也不是第一个（ZCode 语义）。
 * 3. **tab 归属 bot（ownerUnitId）**。切 bot 时面板按当前 bot 过滤可见 tab，
 *    隐藏不销毁 —— A 的展开态/滚动位置在切回时原样恢复。
 */

import type { UnitId } from "./units.ts";

// ---------------------------------------------------------------------------
// Tab 类型
// ---------------------------------------------------------------------------

/** 一个 bot 的历史会话页（迁移自 HistoryDialog 弹窗） */
export interface HistorySidePaneTab {
  /** `history:{unitId}` —— 一个 bot 至多一个历史 tab，重复点击幂等聚焦 */
  id: string;
  type: "history";
  ownerUnitId: UnitId;
  /** 打开时冻结的展示名，仅作 tab 标题；重名/改名以 unitId 为准 */
  unitName: string;
  /** 侧栏子列表点进来时预展开的条目键。缺席 = 不落点（复用 tab 时会清掉旧落点） */
  focusKey?: string;
  openedAt: number;
}

/**
 * 会话实时监控页（ZCode bash-output / subagent-session 的对位）：跟随一个
 * 后台会话的事件流（自动化定时任务、待办长任务、IM 渠道发起的会话在跑的
 * 过程中就能看，不必等结束后翻历史）。数据面：DaemonClient 原始广播 +
 * session.events.since 补拉 —— 不走 RuntimeAdapter（适配器只投递本端发起
 * 的会话，后台会话进不了它的 #sessions 集）。
 */
export interface LiveSessionSidePaneTab {
  /** `live:{sessionId}` —— 一个会话至多一个监控 tab */
  id: string;
  type: "live";
  ownerUnitId: UnitId;
  /** 监控的目标会话（daemon 台账口径的 id 字符串） */
  sessionId: string;
  /** 裸执行器名（台账口径），仅展示用 */
  runtimeId: string;
  /** 打开时冻结的会话标题快照，仅作 tab 标题 */
  title: string;
  openedAt: number;
}

/**
 * 计划 / 任务进度页（ZCode plan-detail 的对位）：跟随当前 bot 活跃会话的
 * plan.proposed / plan.step.updated / plan.resolved 事件，把计划抽成常驻
 * 可视面 —— 一边让它干活一边在旁边看进度，不用滚动时间线。跟随目标由渲染
 * 层解析（活跃会话优先，无则落最近一条有 id 的历史会话），tab 本身只锚 unit。
 */
export interface PlanSidePaneTab {
  /** `plan:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "plan";
  ownerUnitId: UnitId;
  unitName: string;
  openedAt: number;
}

/**
 * 变更审查页（ZCode git 的对位）：当前 bot 工作目录的改动面（暂存 / 未暂存 /
 * 未跟踪 + 行内展开 diff），「对话在左、改动在右」。数据面复用 useGitChanges
 * 单槽 store（与提交对话框、源代码管理页同一份数据，三处口径必须一致）。
 */
export interface DiffSidePaneTab {
  /** `diff:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "diff";
  ownerUnitId: UnitId;
  unitName: string;
  openedAt: number;
}

export type SidePaneTab = HistorySidePaneTab | LiveSessionSidePaneTab | PlanSidePaneTab | DiffSidePaneTab;

export interface SidePaneState {
  tabs: SidePaneTab[];
  /** 当前聚焦的 tab；空串 = 无聚焦（面板应收起） */
  activeTabId: string;
}

export const EMPTY_SIDE_PANE_STATE: SidePaneState = { tabs: [], activeTabId: "" };

export interface OpenHistoryTabRequest {
  unitId: UnitId;
  unitName: string;
  focusKey?: string;
}

export const historyTabId = (unitId: UnitId): string => `history:${unitId}`;
export const liveTabId = (sessionId: string): string => `live:${sessionId}`;
export const planTabId = (unitId: UnitId): string => `plan:${unitId}`;
export const diffTabId = (unitId: UnitId): string => `diff:${unitId}`;

// ---------------------------------------------------------------------------
// 打开 / 关闭 / 激活
// ---------------------------------------------------------------------------

export interface OpenLiveTabRequest {
  unitId: UnitId;
  sessionId: string;
  runtimeId: string;
  title: string;
}

export interface OpenUnitTabRequest {
  unitId: UnitId;
  unitName: string;
}

/**
 * 打开（或复用）一个 bot 的历史 tab。
 *
 * 复用规则：命中同 id → 原位合并 meta 并聚焦。focusKey 是「落点」不是身份 ——
 * 请求带就落到它（侧栏再点另一条 → 已开的面板滚过去），不带就显式删键
 * （header 点开 = 不落点，与弹窗时代的「打开即无展开」语义一致）。
 * openedAt 每次刷新，UI 可据此做相对时间展示。
 */
export function openHistoryTab(
  state: SidePaneState,
  request: OpenHistoryTabRequest,
): SidePaneState {
  const id = historyTabId(request.unitId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && existing.type === "history") {
    const merged: HistorySidePaneTab = {
      ...existing,
      unitName: request.unitName,
      openedAt: Date.now(),
    };
    if (request.focusKey !== undefined) merged.focusKey = request.focusKey;
    else delete merged.focusKey;
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: HistorySidePaneTab = {
    id,
    type: "history",
    ownerUnitId: request.unitId,
    unitName: request.unitName,
    openedAt: Date.now(),
    ...(request.focusKey !== undefined ? { focusKey: request.focusKey } : {}),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/** 打开（或复用）一个会话的实时监控 tab：同会话幂等聚焦，meta 刷新 */
export function openLiveTab(state: SidePaneState, request: OpenLiveTabRequest): SidePaneState {
  const id = liveTabId(request.sessionId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && existing.type === "live") {
    const merged: LiveSessionSidePaneTab = { ...existing, title: request.title, runtimeId: request.runtimeId, openedAt: Date.now() };
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: LiveSessionSidePaneTab = {
    id,
    type: "live",
    ownerUnitId: request.unitId,
    sessionId: request.sessionId,
    runtimeId: request.runtimeId,
    title: request.title,
    openedAt: Date.now(),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/** 打开（或复用）计划 tab / 变更审查 tab：按 unit 幂等 */
export function openPlanTab(state: SidePaneState, request: OpenUnitTabRequest): SidePaneState {
  return openUnitTab(state, "plan", planTabId(request.unitId), request);
}

export function openDiffTab(state: SidePaneState, request: OpenUnitTabRequest): SidePaneState {
  return openUnitTab(state, "diff", diffTabId(request.unitId), request);
}

function openUnitTab(
  state: SidePaneState,
  type: "plan" | "diff",
  id: string,
  request: OpenUnitTabRequest,
): SidePaneState {
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && (existing.type === "plan" || existing.type === "diff")) {
    const merged = { ...existing, unitName: request.unitName, openedAt: Date.now() };
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: PlanSidePaneTab | DiffSidePaneTab = {
    id,
    type,
    ownerUnitId: request.unitId,
    unitName: request.unitName,
    openedAt: Date.now(),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/**
 * 关 tab。关的是激活 tab 时落到**右邻**（被关的是最后一个则落新的最后一个）；
 * 关非激活 tab 不动 activeTabId。清空后 activeTabId 归空串，面板自然收起。
 *
 * scopeUnitId（可选，useSidePane 传当前作用域）：右邻回落只在**该 scope 可见**
 * 的 tab 里挑 —— 关闭钮只画在可见 tab 上，但全量数组里的右邻可能归属别的 bot，
 * 落过去会「明明还开着可见 tab、面板却掉了主页」。缺省（undefined）保持全量
 * 右邻的旧语义（无 scope 的调用方）。
 */
export function closeTab(state: SidePaneState, tabId: string, scopeUnitId?: UnitId | null): SidePaneState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return { tabs, activeTabId: "" };
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const candidates =
    scopeUnitId === undefined || scopeUnitId === null ? tabs : visibleTabsForUnit(tabs, scopeUnitId);
  if (candidates.length === 0) return { tabs, activeTabId: "" };
  const candidateIds = new Set(candidates.map((tab) => tab.id));
  // 右邻：新数组里 closingIndex 位起第一个可见 tab；没有（后面全是别人的）则落最后一个可见 tab
  const fallback = tabs.slice(closingIndex).find((tab) => candidateIds.has(tab.id)) ?? candidates[candidates.length - 1]!;
  return { tabs, activeTabId: fallback.id };
}

export function activateTab(state: SidePaneState, tabId: string): SidePaneState {
  if (state.activeTabId === tabId || !state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

// ---------------------------------------------------------------------------
// bot 作用域
// ---------------------------------------------------------------------------

/** 当前 bot 可见的 tab：会话级 tab 按 ownerUnitId 过滤（workspace 级恒可见，预留） */
export function visibleTabsForUnit(
  tabs: readonly SidePaneTab[],
  activeUnitId: UnitId | null,
): readonly SidePaneTab[] {
  if (activeUnitId === null) return [];
  return tabs.filter((tab) => String(tab.ownerUnitId) === String(activeUnitId));
}

/**
 * 面板当前是否**真在占位**：未收起 + 在 chat 主视图（+ 已激活过 bot）。
 *
 * 这是「占位」的唯一口径，三处共用，别各自抄一遍：
 * - `SidePaneColumn` 的 open —— 决定列渲染与窗口宽度插块；
 * - `WorkspaceHeader` 的开合钮态 —— 决定这颗钮显示展开还是收起；
 * - `toggleFromHeader` 的动作 —— 收起还是展开。
 *
 * **无可见 tab 也占位**：展开 = 功能主页（SidePaneHome）兜底，面板里直接点选
 * 要开的功能，而不是空壳或整列消失 —— 否则「展开」在零 tab 时是死点击。
 * scopeUnitId 为 null（还没激活过任何 bot）时无内容可列，不占位。
 */
export function sidePaneOccupies(
  scopeUnitId: UnitId | null,
  collapsed: boolean,
  mainViewIsChat: boolean,
): boolean {
  return !collapsed && mainViewIsChat && scopeUnitId !== null;
}

export interface SidePaneScopeResolution {
  visibleTabs: readonly SidePaneTab[];
  /** 解析后的聚焦 tab；空串 = 无可聚焦（面板落功能主页） */
  activeTabId: string;
}

/**
 * 切 bot 时解析面板状态（对齐 ZCode 的 resolveSidePaneScopeState）。
 *
 * 聚焦优先级：该 bot 上次聚焦的 tab（lastActiveTabByUnit 记忆）→ 沿用当前
 * activeTabId（若在新 scope 里可见）→ 最后一个可见 tab。
 *
 * 收起/展开不在解析职责内：无可见 tab 时聚焦归空串、面板落功能主页 ——
 * 用户的开合偏好（两个方向）都不该被切换动作翻掉。
 */
export function resolveScopeOnUnitChange(
  state: SidePaneState,
  activeUnitId: UnitId,
  lastActiveTabByUnit: Readonly<Record<string, string>>,
): SidePaneScopeResolution {
  const visibleTabs = visibleTabsForUnit(state.tabs, activeUnitId);
  if (visibleTabs.length === 0) {
    return { visibleTabs, activeTabId: "" };
  }
  const preferred = lastActiveTabByUnit[String(activeUnitId)];
  const next =
    (preferred !== undefined && visibleTabs.some((tab) => tab.id === preferred) ? preferred : undefined) ??
    (visibleTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : undefined) ??
    visibleTabs[visibleTabs.length - 1]!.id;
  return { visibleTabs, activeTabId: next };
}

/**
 * bot 注销回收（daemon 侧 bot 定义消失时）：清掉不再有主的 tab。
 * 不做任何「顺手迁移」——被回收 bot 的 tab 没有新的归属，直接删。
 */
export function releaseUnits(
  state: SidePaneState,
  validUnitIds: readonly UnitId[],
): SidePaneState {
  const valid = new Set(validUnitIds.map(String));
  const tabs = state.tabs.filter((tab) => valid.has(String(tab.ownerUnitId)));
  if (tabs.length === state.tabs.length) return state;
  if (tabs.some((tab) => tab.id === state.activeTabId)) return { tabs, activeTabId: state.activeTabId };
  return { tabs, activeTabId: "" };
}
