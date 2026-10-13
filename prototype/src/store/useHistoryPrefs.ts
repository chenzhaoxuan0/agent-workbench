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
}

const DEFAULTS: HistoryPrefs = {
  hideFailedInSidebar: true,
  hideFailedInDialog: true,
};

const STORAGE_KEY = "agent-workbench:history-prefs";

function load(): HistoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<HistoryPrefs>;
    return {
      hideFailedInSidebar: typeof p.hideFailedInSidebar === "boolean" ? p.hideFailedInSidebar : DEFAULTS.hideFailedInSidebar,
      hideFailedInDialog: typeof p.hideFailedInDialog === "boolean" ? p.hideFailedInDialog : DEFAULTS.hideFailedInDialog,
    };
  } catch {
    return DEFAULTS;
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
}

export const useHistoryPrefs = create<HistoryPrefsStore>((set) => ({
  prefs: load(),
  setPrefs: (patch) =>
    set((state) => {
      const next = { ...state.prefs, ...patch };
      persist(next);
      return { prefs: next };
    }),
  resetDefaults: () => {
    persist(DEFAULTS);
    set({ prefs: DEFAULTS });
  },
}));
