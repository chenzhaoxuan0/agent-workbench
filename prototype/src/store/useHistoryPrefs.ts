import { create } from "zustand";

/**
 * 历史会话展示偏好。
 *
 * 失败会话（status === "failed"，红点）由于无法交互且无法重现，
 * 默认在侧边栏和详情弹窗中隐藏，保留随时重新开启的能力。
 */

export interface HistoryPrefs {
  /** 在左侧栏中隐藏失败会话（默认 true） */
  hideFailedInSidebar: boolean;
  /** 在点开后的历史会话弹窗中隐藏失败会话（默认 true） */
  hideFailedInDialog: boolean;
  /**
   * 已查看的会话标记（entry key 与 `session-<id>` 混存，cap 500 淘汰最旧）。
   * 「完成任务但未查看 → 绿灯」的已读依据：被打开过（聊天页 / TUI）即视为已读。
   */
  viewedKeys: string[];
  /**
   * 绿灯的起算时刻（首次使用本功能的时间）：之前的存量历史一律视为已读，
   * 否则上线瞬间每条历史都挂绿灯，灯就失去「有新完成」的信号意义了。
   */
  lightsSinceTs: number;
  /**
   * 单条会话的默认打开方式覆盖（entry key → 覆盖值）。
   * 缺省按来源：对话页创建（headless）→ 聊天页打开，TUI 创建 → TUI 重现。
   */
  entryOpenMode: Record<string, "chat" | "tui">;
  /** 用户置顶的历史会话（entry key 列表，cap 50）—— 侧栏子列表里排在最前 */
  pinnedKeys: string[];
}

const DEFAULTS: HistoryPrefs = {
  hideFailedInSidebar: true,
  hideFailedInDialog: true,
  viewedKeys: [],
  lightsSinceTs: 0,
  entryOpenMode: {},
  pinnedKeys: [],
};

/** 已读标记容量上限：超出后丢最旧的（FIFO），防止 localStorage 无限膨胀 */
const VIEWED_CAP = 500;
/** 置顶容量上限：置顶是稀缺的手动标记，多了「置顶区」就失去意义 */
const PINNED_CAP = 50;

const STORAGE_KEY = "agent-workbench:history-prefs";

function load(): HistoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      // 首次使用：绿灯从现在起算（存量历史视为已读，见 lightsSinceTs 注释）
      return { ...DEFAULTS, lightsSinceTs: Date.now() };
    }
    const p = JSON.parse(raw) as Partial<HistoryPrefs>;
    return {
      hideFailedInSidebar: typeof p.hideFailedInSidebar === "boolean" ? p.hideFailedInSidebar : DEFAULTS.hideFailedInSidebar,
      hideFailedInDialog: typeof p.hideFailedInDialog === "boolean" ? p.hideFailedInDialog : DEFAULTS.hideFailedInDialog,
      viewedKeys: Array.isArray(p.viewedKeys) ? p.viewedKeys.filter((k): k is string => typeof k === "string") : [],
      lightsSinceTs: typeof p.lightsSinceTs === "number" && p.lightsSinceTs > 0 ? p.lightsSinceTs : Date.now(),
      entryOpenMode:
        p.entryOpenMode !== null && typeof p.entryOpenMode === "object"
          ? Object.fromEntries(
              Object.entries(p.entryOpenMode as Record<string, unknown>).filter(
                (entry): entry is [string, "chat" | "tui"] => entry[1] === "chat" || entry[1] === "tui",
              ),
            )
          : {},
      pinnedKeys: Array.isArray(p.pinnedKeys) ? p.pinnedKeys.filter((k): k is string => typeof k === "string") : [],
    };
  } catch {
    return { ...DEFAULTS, lightsSinceTs: Date.now() };
  }
}

function persist(prefs: HistoryPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略 localStorage 写入异常
  }
}

export interface HistoryPrefsStore {
  prefs: HistoryPrefs;
  setPrefs: (patch: Partial<HistoryPrefs>) => void;
  resetDefaults: () => void;
  /** 标记已查看（entry key 或 `session-<id>`；重复幂等，超容量淘汰最旧） */
  markViewed: (keys: string | readonly string[]) => void;
  /** 会话是否未读：绿灯 = 完成于起算时刻之后 && 从未打开过 */
  isUnread: (keys: string | readonly string[], finishedAt: number | null) => boolean;
  /** 覆盖某条会话的默认打开方式；传 null 清除覆盖（回落按来源判定） */
  setEntryOpenMode: (key: string, mode: "chat" | "tui" | null) => void;
  /** 置顶 / 取消置顶一条历史会话（entry key；幂等切换） */
  togglePinned: (key: string) => void;
}

export const useHistoryPrefs = create<HistoryPrefsStore>((set, get) => ({
  prefs: load(),
  setPrefs: (patch) =>
    set((state) => {
      const next = { ...state.prefs, ...patch };
      persist(next);
      return { prefs: next };
    }),
  resetDefaults: () => {
    persist({ ...DEFAULTS, lightsSinceTs: get().prefs.lightsSinceTs || Date.now() });
    set((state) => ({ prefs: { ...DEFAULTS, lightsSinceTs: state.prefs.lightsSinceTs || Date.now() } }));
  },
  markViewed: (keys) => {
    const incoming = Array.isArray(keys) ? [...keys] : [keys];
    set((state) => {
      const known = new Set(state.prefs.viewedKeys);
      const fresh = incoming.filter((k) => k !== "" && !known.has(k));
      if (fresh.length === 0) return {};
      const nextViewed = [...state.prefs.viewedKeys, ...fresh].slice(-VIEWED_CAP);
      const next = { ...state.prefs, viewedKeys: nextViewed };
      persist(next);
      return { prefs: next };
    });
  },
  isUnread: (keys, finishedAt) => {
    const p = get().prefs;
    if (finishedAt === null || finishedAt < p.lightsSinceTs) return false;
    const list = Array.isArray(keys) ? keys : [keys];
    return list.every((k) => !p.viewedKeys.includes(k));
  },
  setEntryOpenMode: (key, mode) =>
    set((state) => {
      const nextModes = { ...state.prefs.entryOpenMode };
      if (mode === null) delete nextModes[key];
      else nextModes[key] = mode;
      const next = { ...state.prefs, entryOpenMode: nextModes };
      persist(next);
      return { prefs: next };
    }),
  togglePinned: (key) =>
    set((state) => {
      if (key === "") return {};
      const has = state.prefs.pinnedKeys.includes(key);
      const nextPinned = has
        ? state.prefs.pinnedKeys.filter((k) => k !== key)
        : [...state.prefs.pinnedKeys, key].slice(-PINNED_CAP);
      const next = { ...state.prefs, pinnedKeys: nextPinned };
      persist(next);
      return { prefs: next };
    }),
}));
