import { create } from "zustand";
import {
  canOpenTab,
  closeOtherTabs as closeOther,
  closeOwnerTabs as closeOwner,
  closeTab as closeOne,
  getVisibleTabs,
  makeTabDraft,
  openTab as openOne,
  openTabs as openMany,
  reorderTab as reorder,
  resolveActiveForOwner,
  setActiveTab as setActive,
  tabIdFor,
  type SidePaneState,
  type SidePaneTab,
  type SidePaneTabType,
} from "../core/sidepane.ts";

/** 最近关闭存**完整 tab**，不是只存 id —— 否则恢复出来的页会丢掉标题与归属 */
interface RecentClosed {
  readonly tab: SidePaneTab;
  readonly closedAt: number;
}

interface SidePaneStore {
  state: SidePaneState | null;
  open: boolean;
  /** 记住上次展开尺寸，对齐 ZCode 的 useAnimatedResizablePanel */
  expandedSize: string;
  recentlyClosed: readonly RecentClosed[];

  openTab: (draft: Omit<SidePaneTab, "openedAt"> & { openedAt?: number }) => void;
  /** 从「+」目录按类型开门 —— id / 作用域 / 归属全由 core 推导，调用方不拼字符串 */
  openTabType: (type: SidePaneTabType, ownerId: string | null, subject?: string | null) => void;
  openTabs: (drafts: readonly (Omit<SidePaneTab, "openedAt"> & { openedAt?: number })[]) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  reopenClosedTab: () => void;
  reorderTab: (activeId: string, overId: string) => void;
  setOpen: (open: boolean) => void;
  setExpandedSize: (size: string) => void;
  /** 切换会话时按新归属修正激活页，并把会话级页签绑到该会话 */
  syncOwner: (ownerId: string | null) => void;
  /** 会话级页签的 id 形态：`files@<sessionId>`，保证不同会话各有各的一页 */
  sessionTabId: (type: SidePaneTabType, ownerId: string) => string;
}

const EMPTY: SidePaneState = { tabs: [], activeTabId: "" };

/**
 * 初始预置 —— 只给工作区级。
 *
 * 为什么不全预置：ZCode 的右栏是「按需开门」，22 种页签一次全开会把标签栏挤爆，
 * 总览弹层也会长到没法看。**功能可见性靠「+」目录保证，不靠预置**——
 * 目录里每一种都在，缺运行时的还标着缺什么。
 */
const DEFAULT_TABS: readonly SidePaneTabType[] = [
  "workspace-files",
  "capabilities",
  "deliverables",
  "tools",
  "git",
];

/**
 * 会话激活时按需补齐的页签。
 *
 * 会话级与会话树根级都不在这里预置成无主的 —— 它们的 ownerId 必须绑定到
 * 具体会话，对齐 ZCode：这些页签由会话事件按需开出来，不存在「无主」形态。
 */
const SESSION_TABS: readonly SidePaneTabType[] = ["files", "plan", "subagent", "bash-output"];

const SIZE_KEY = "agent-workbench:side-pane-size";

function readSize(): string {
  if (typeof window === "undefined") return "45%";
  try {
    return window.localStorage.getItem(SIZE_KEY) ?? "45%";
  } catch {
    return "45%";
  }
}

function persistSize(v: string): void {
  try {
    window.localStorage.setItem(SIZE_KEY, v);
  } catch {
    /* ignore */
  }
}

export const useSidePane = create<SidePaneStore>((set, get) => {
  const pushRecent = (tab: SidePaneTab) =>
    set((s) => ({ recentlyClosed: [{ tab, closedAt: Date.now() }, ...s.recentlyClosed].slice(0, 20) }));

  return {
    state: {
      tabs: DEFAULT_TABS.map((type) => ({ ...makeTabDraft(type, null), openedAt: Date.now() })),
      activeTabId: tabIdFor(DEFAULT_TABS[0]!, null),
    },
    open: true,
    expandedSize: readSize(),
    recentlyClosed: [],

    openTab: (draft) => set((s) => ({ state: openOne(s.state, draft), open: true })),

    // 会话级 / 会话树根级没有会话就开不了 —— 静默返回，不改状态
    openTabType: (type, ownerId, subject) => {
      if (!canOpenTab(type, ownerId)) return;
      set((s) => ({ state: openOne(s.state, makeTabDraft(type, ownerId, subject)), open: true }));
    },

    openTabs: (drafts) => set((s) => ({ state: openMany(s.state, drafts), open: true })),

    setActiveTab: (id) => set((s) => ({ state: s.state ? setActive(s.state, id) : s.state })),

    closeTab: (id) =>
      set((s) => {
        if (!s.state) return {};
        const tab = s.state.tabs.find((t) => t.id === id);
        const next = closeOne(s.state, id);
        if (tab) pushRecent(tab);
        // 全关完 → 面板自动收起，对齐 ZCode 返回 null 的语义
        return { state: next, open: next !== null };
      }),

    closeOtherTabs: (id) => set((s) => ({ state: s.state ? closeOther(s.state, id, null) : s.state })),

    closeAllTabs: () =>
      set((s) => {
        if (!s.state) return {};
        for (const t of s.state.tabs) pushRecent(t);
        return { state: null, open: false };
      }),

    reopenClosedTab: () =>
      set((s) => {
        const head = s.recentlyClosed[0];
        if (!head) return {};
        return {
          state: openOne(s.state, head.tab),
          open: true,
          recentlyClosed: s.recentlyClosed.slice(1),
        };
      }),

    // 重排不改变 activeTabId —— 拖动只是换位置
    reorderTab: (activeId, overId) =>
      set((s) => ({ state: s.state ? reorder(s.state, activeId, overId) : s.state })),

    setOpen: (open) => set({ open }),

    setExpandedSize: (expandedSize) => {
      persistSize(expandedSize);
      set({ expandedSize });
    },

    syncOwner: (ownerId) =>
      set((s) => {
        if (!ownerId || !s.state) return {};

        // 预置页签每条会话一份：关掉一条会话的，不影响其他会话的
        //
        // ⚠ openOne 每开一页都会把焦点抢到那一页。补齐是「静默」的，
        // 不能抢 —— 否则会话一切换，焦点就落到刚补出来的最后一页上。
        // ZCode 的「批量打开最后一个激活」只适用于用户主动打开的场合。
        const before = s.state.activeTabId;
        let next = s.state;
        for (const type of SESSION_TABS) {
          const id = tabIdFor(type, ownerId);
          if (!next.tabs.some((x) => x.id === id)) {
            next = { ...openOne(next, { ...makeTabDraft(type, ownerId), id }), activeTabId: next.activeTabId };
          }
        }
        // 补齐后再按原焦点修正：原焦点仍可见就留着，否则按 ZCode 口径回落
        return { state: resolveActiveForOwner({ ...next, activeTabId: before }, ownerId) };
      }),

    sessionTabId: (type, ownerId) => tabIdFor(type, ownerId),
  };
});

/** 当前 owner 下可见的 tab */
export function selectVisibleTabs(ownerId: string | null) {
  return (s: SidePaneStore) => getVisibleTabs(s.state, ownerId);
}

export { EMPTY as EMPTY_SIDE_PANE };
