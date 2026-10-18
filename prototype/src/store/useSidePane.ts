import { create } from "zustand";
import * as sidePane from "../core/sidePaneTabs.ts";
import type { UnitId } from "../core/units.ts";

/**
 * 右侧标签面板的 shell 状态 —— tabs/activeTabId 的领域规则全部在
 * core/sidePaneTabs.ts（纯函数），这里只做三件事：
 *
 * 1. 持有状态并转译成 action（openTab 永远顺带展开面板）；
 * 2. 切 bot 的作用域联动（handleUnitChange：归档上个 bot 的聚焦记忆 → 解析新 scope）；
 * 3. 宽度持久化（与 useShell 的侧栏宽度同一套 localStorage 模式）。
 *
 * 刻意**不做** tabs 跨刷新持久化：数据都在 daemon，tab 只是壳；刷新后右侧栏
 * 从空开始（ZCode 的 side pane 记忆同为 renderer 内存级）。
 */

const WIDTH_KEY = "agent-workbench:sidepane-width-px";
/** 弹窗时代 720px；成列后按「主对话为主、面板为辅」收窄默认值 */
const SIDE_PANE_DEFAULT = 520;
const SIDE_PANE_MIN = 360;

function readWidth(): number {
  if (typeof window === "undefined") return SIDE_PANE_DEFAULT;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return SIDE_PANE_DEFAULT;
    return Math.max(SIDE_PANE_MIN, Math.round(n));
  } catch {
    return SIDE_PANE_DEFAULT;
  }
}

function persistWidth(w: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

interface SidePaneStore extends sidePane.SidePaneState {
  /** 面板收起（用户开关；无可见 tab 时也会被强制置 true） */
  collapsed: boolean;
  /** 当前作用域 bot。null = 还没有任何 bot 被激活过（应用首帧） */
  scopeUnitId: UnitId | null;
  /** 每个 bot 最后聚焦的 tab —— 切回时恢复现场（不持久化，会话内有效） */
  lastActiveTabByUnit: Record<string, string>;
  paneWidth: number;

  /** 打开（或复用）一个 bot 的历史 tab，并展开面板 */
  openTab: (request: sidePane.OpenHistoryTabRequest) => void;
  closeTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  toggleCollapsed: () => void;
  setPaneWidth: (w: number) => void;

  /**
   * 切 bot 联动：WorkspaceShell 订阅 useWorkbench.activeUnitId 后调用。
   * 切走前把当前聚焦归档到上个 bot 的记忆里，再解析新 scope 的聚焦与收起态。
   */
  handleUnitChange: (unitId: UnitId) => void;
  /** bot 注销回收（daemon 侧 bot 定义消失）：清掉无主 tab 并自愈聚焦 */
  releaseUnits: (validUnitIds: readonly UnitId[]) => void;
}

export const useSidePane = create<SidePaneStore>((set, get) => ({
  tabs: [],
  activeTabId: "",
  collapsed: true,
  scopeUnitId: null,
  lastActiveTabByUnit: {},
  paneWidth: readWidth(),

  openTab: (request) =>
    set((s) => ({ ...sidePane.openHistoryTab(s, request), collapsed: false })),

  closeTab: (tabId) => set((s) => sidePane.closeTab(s, tabId)),

  activateTab: (tabId) => set((s) => sidePane.activateTab(s, tabId)),

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),

  setPaneWidth: (paneWidth) => {
    const clamped = Math.max(SIDE_PANE_MIN, Math.round(paneWidth));
    set({ paneWidth: clamped });
    persistWidth(clamped);
  },

  handleUnitChange: (unitId) => {
    const s = get();
    if (s.scopeUnitId !== null && String(s.scopeUnitId) === String(unitId)) return;
    // 归档上个 bot 的聚焦记忆。CommandCenter 流（先 selectUnit 后 openTab）里
    // openTab 可能已把 activeTabId 改成新 bot 的 tab —— 无妨：解析只认可见集合，
    // 一条指向别人 tab 的过期记忆永远不会中奖（见 resolveScopeOnUnitChange 的兜底链）。
    const lastActiveTabByUnit = { ...s.lastActiveTabByUnit };
    if (s.scopeUnitId !== null && s.activeTabId !== "") {
      lastActiveTabByUnit[String(s.scopeUnitId)] = s.activeTabId;
    }
    const res = sidePane.resolveScopeOnUnitChange(
      { tabs: s.tabs, activeTabId: s.activeTabId },
      unitId,
      lastActiveTabByUnit,
    );
    set({
      scopeUnitId: unitId,
      lastActiveTabByUnit,
      activeTabId: res.activeTabId,
      // 只有「无可见 tab」才强制收起；有 tab 时保持现值 —— 用户手动收起的
      // 偏好不该被切换动作翻掉，展开永远由 openTab 显式驱动。
      collapsed: res.shouldCollapse ? true : s.collapsed,
    });
  },

  releaseUnits: (validUnitIds) =>
    set((s) => {
      const next = sidePane.releaseUnits({ tabs: s.tabs, activeTabId: s.activeTabId }, validUnitIds);
      if (next.tabs === s.tabs && next.activeTabId === s.activeTabId) return {} as Partial<SidePaneStore>;
      let activeTabId = next.activeTabId;
      let collapsed = s.collapsed;
      // 聚焦被回收（或自愈出空串）时按当前 scope 重解析，不把面板晾在空聚焦上
      if (activeTabId === "" && s.scopeUnitId !== null) {
        const res = sidePane.resolveScopeOnUnitChange(next, s.scopeUnitId, s.lastActiveTabByUnit);
        activeTabId = res.activeTabId;
        collapsed = res.shouldCollapse ? true : collapsed;
      }
      return { tabs: next.tabs, activeTabId, collapsed };
    }),
}));

export { SIDE_PANE_MIN };
