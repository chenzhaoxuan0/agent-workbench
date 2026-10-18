import { create } from "zustand";
import * as sidePane from "../core/sidePaneTabs.ts";
import type { UnitId } from "../core/units.ts";
import { useShell } from "./useShell.ts";

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
   * 头部开合钮（面板收起后的唯一重开入口，ZCode「收起即归零 + 头部状态感知
   * 开关」同款约定）：正占位 → 收起让位；其余一律展开 —— 有可见 tab 就回到
   * tab 内容，一个 tab 都没有就落功能主页（SidePaneHome 里点选要开的功能，
   * 不再硬开历史 tab）。「占位」口径统一走 sidePane.sidePaneOccupies。
   */
  toggleFromHeader: () => void;

  /**
   * 切 bot 联动：WorkspaceShell 订阅 useWorkbench.activeUnitId 后调用。
   * 切走前把当前聚焦归档到上个 bot 的记忆里，再解析新 scope 的聚焦态 ——
   * 开合偏好不动：展开着就保持展开（无 tab 落功能主页），收起着就保持收起。
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
    set((s) => {
      // 面板只在 chat 主视图展开（全局页不属于任何 bot，见 SidePanePanel 的门控）。
      // 所有 openTab 调用点都是「我现在要看」的语境 —— 这里统一切回 chat，
      // 保持弹窗时代「点了就能看到」的语义（ZCode handleSelectTaskInChat 先
      // showChatMainView 再开面板，同一条规则）
      useShell.getState().setMainView("chat");
      return { ...sidePane.openHistoryTab(s, request), collapsed: false };
    }),

  closeTab: (tabId) => set((s) => sidePane.closeTab(s, tabId)),

  activateTab: (tabId) => set((s) => sidePane.activateTab(s, tabId)),

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),

  toggleFromHeader: () => {
    const s = get();
    // 正占位 → 收起让位；其余一律走「展开」。判据用 sidePaneOccupies 与头部按钮
    // 态、列渲染同源 —— 否则停在全局页时按钮亮着「已展开」，点一下只翻 collapsed，
    // 画面不动，得再点一次才展开。
    const occupying = sidePane.sidePaneOccupies(
      s.scopeUnitId,
      s.collapsed,
      useShell.getState().mainView === "chat",
    );
    if (occupying) {
      set({ collapsed: true });
      return;
    }
    // 展开：有可见 tab 回 tab 内容；没有则落功能主页（面板里点选要开的功能）
    useShell.getState().setMainView("chat");
    set({ collapsed: false });
  },

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
      // 开合偏好不动：展开着无 tab 的 bot → 面板落功能主页（列渲染见 SidePaneColumn）。
      // 对称原则 —— 手动收起的偏好不该被切换动作翻掉，手动展开的同样不该。
      collapsed: s.collapsed,
    });
  },

  releaseUnits: (validUnitIds) =>
    set((s) => {
      const next = sidePane.releaseUnits({ tabs: s.tabs, activeTabId: s.activeTabId }, validUnitIds);
      if (next.tabs === s.tabs && next.activeTabId === s.activeTabId) {
        // 无回收发生：返回同一引用，zustand 对 Object.is 相等不通知订阅者
        return s;
      }
      let activeTabId = next.activeTabId;
      // 聚焦被回收（或自愈出空串）时按当前 scope 重解析；开合不动 ——
      // 空聚焦的面板落功能主页，不为它收起
      if (activeTabId === "" && s.scopeUnitId !== null) {
        const res = sidePane.resolveScopeOnUnitChange(next, s.scopeUnitId, s.lastActiveTabByUnit);
        activeTabId = res.activeTabId;
      }
      return { tabs: next.tabs, activeTabId, collapsed: s.collapsed };
    }),
}));

export { SIDE_PANE_MIN };
