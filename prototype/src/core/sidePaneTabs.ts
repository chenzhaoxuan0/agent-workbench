/**
 * 右侧标签面板的领域契约 —— 纯函数，不碰 React / DOM / store。
 *
 * 形态照搬 ZCode 的 `packages/ui/src/lib/workspaceSidePane.ts`，按本产品的体量裁剪。
 * 上一版右栏（IDE 式 19-tab）死于「只切状态、没人渲染」，本版只服务真实入口
 * （历史会话等弹窗迁移），从最小内核起步。
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
 * 后续扩展位：workspace 级 tab（如移动端远控）用 ownerUnitId: null，
 * 跨 bot 恒可见。现在只有会话级一种，联合先保持单成员 —— 加第二种时
 * SidePaneTab 联合与 visibleTabsForUnit 的过滤分支同步扩。
 */
export type SidePaneTab = HistorySidePaneTab;

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

// ---------------------------------------------------------------------------
// 打开 / 关闭 / 激活
// ---------------------------------------------------------------------------

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

/**
 * 关 tab。关的是激活 tab 时落到**右邻**（被关的是最后一个则落新的最后一个）；
 * 关非激活 tab 不动 activeTabId。清空后 activeTabId 归空串，面板自然收起。
 */
export function closeTab(state: SidePaneState, tabId: string): SidePaneState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return { tabs: [], activeTabId: "" };
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const fallback = tabs[Math.min(closingIndex, tabs.length - 1)]!;
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

export interface SidePaneScopeResolution {
  visibleTabs: readonly SidePaneTab[];
  /** 解析后的聚焦 tab；空串 = 无可聚焦（面板应收起） */
  activeTabId: string;
  /** 是否应强制收起（当前 bot 无任何可见 tab） */
  shouldCollapse: boolean;
}

/**
 * 切 bot 时解析面板状态（对齐 ZCode 的 resolveSidePaneScopeState）。
 *
 * 聚焦优先级：该 bot 上次聚焦的 tab（lastActiveTabByUnit 记忆）→ 沿用当前
 * activeTabId（若在新 scope 里可见）→ 最后一个可见 tab。
 *
 * 收起语义刻意保守：只有「无可见 tab」才强制收起；有 tab 时不自动展开 ——
 * 用户手动收起的偏好不该被切换动作翻掉，展开永远由 openTab 显式驱动。
 */
export function resolveScopeOnUnitChange(
  state: SidePaneState,
  activeUnitId: UnitId,
  lastActiveTabByUnit: Readonly<Record<string, string>>,
): SidePaneScopeResolution {
  const visibleTabs = visibleTabsForUnit(state.tabs, activeUnitId);
  if (visibleTabs.length === 0) {
    return { visibleTabs, activeTabId: "", shouldCollapse: true };
  }
  const preferred = lastActiveTabByUnit[String(activeUnitId)];
  const next =
    (preferred !== undefined && visibleTabs.some((tab) => tab.id === preferred) ? preferred : undefined) ??
    (visibleTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : undefined) ??
    visibleTabs[visibleTabs.length - 1]!.id;
  return { visibleTabs, activeTabId: next, shouldCollapse: false };
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
