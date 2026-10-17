/**
 * 对话页小终端（Chat Terminal Dock）—— Composer 下方多标签终端的状态与偏好。
 *
 * 交互对齐 ZCode 的 Terminal.tsx + terminalPanelState.ts：
 * - 标签题 = 创建时工作区目录名，第 2 个起追加最小编号（"xxx 2"）；
 * - 「+」新建终端并激活；关非末签 = 杀 PTY 并激活相邻标签；
 *   关末签 = 只收面板、标签与会话保活；PTY 自退 = 移除标签（末签自退连面板一起收）；
 * - 收面板不 dispose 任何会话 —— workspace 切换/面板收起不打断长命令。
 *
 * 与 TUI 终端页刻意隔离：daemon 侧 unitId=CHAT_DOCK_UNIT_ID（见 TerminalSessionManager），
 * created 帧认领与 F5 重挂都按标记跳过，互不开重复标签。
 *
 * F5 重挂：tabs（id/编号/目录名）记在 sessionStorage，面板挂载时对照 terminal.list
 * 认领还活着的 PTY（带回放）；已死的条目就地转新建。
 */
import { create } from "zustand";
import { SUPPORTED_TERMINAL_PROFILES } from "./useTerminalStore.ts";
import { terminalSessionRegistry } from "./TerminalSessionManager.ts";

const CHAT_TERMINAL_PREFS_KEY = "agent-workbench:chat-terminal-prefs";
const CHAT_TERMINAL_TABS_KEY = "agent-workbench:chat-terminal-tabs";

export const CHAT_DOCK_MIN_HEIGHT = 160;
export const CHAT_DOCK_DEFAULT_HEIGHT = 300;
const CHAT_DOCK_MAX_HEIGHT_RATIO = 0.7;

/** 一个终端标签 = 一条 PTY。id 即 daemon terminalId */
export interface ChatTerminalTab {
  readonly id: string;
  /** 最小编号（ZCode getNextTerminalSessionIndex 同款）：标题后缀，1 不显示 */
  readonly index: number;
  /** 创建时工作区目录名（标题主体） */
  readonly cwdLeaf: string;
}

interface ChatTerminalPrefs {
  profileId: string;
  height: number;
}

function readPrefs(): ChatTerminalPrefs {
  const fallback: ChatTerminalPrefs = { profileId: "pwsh", height: CHAT_DOCK_DEFAULT_HEIGHT };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(CHAT_TERMINAL_PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChatTerminalPrefs>;
    const profileId = SUPPORTED_TERMINAL_PROFILES.some((p) => p.id === parsed.profileId)
      ? (parsed.profileId as string)
      : fallback.profileId;
    const height =
      typeof parsed.height === "number" && Number.isFinite(parsed.height)
        ? Math.max(CHAT_DOCK_MIN_HEIGHT, parsed.height)
        : fallback.height;
    return { profileId, height };
  } catch {
    return fallback;
  }
}

function persistPrefs(prefs: ChatTerminalPrefs): void {
  try {
    window.localStorage.setItem(CHAT_TERMINAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function readChatTerminalTabs(): { tabs: ChatTerminalTab[]; activeTabId: string | null } {
  if (typeof window === "undefined") return { tabs: [], activeTabId: null };
  try {
    const raw = window.sessionStorage.getItem(CHAT_TERMINAL_TABS_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as { tabs?: ChatTerminalTab[]; activeTabId?: string | null };
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : []).filter(
      (t) => t && typeof t.id === "string" && typeof t.index === "number" && typeof t.cwdLeaf === "string",
    );
    const activeTabId =
      parsed.activeTabId && tabs.some((t) => t.id === parsed.activeTabId)
        ? parsed.activeTabId
        : (tabs[0]?.id ?? null);
    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function persistTabs(tabs: readonly ChatTerminalTab[], activeTabId: string | null): void {
  try {
    window.sessionStorage.setItem(CHAT_TERMINAL_TABS_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    /* ignore */
  }
}

function clearTabs(): void {
  try {
    window.sessionStorage.removeItem(CHAT_TERMINAL_TABS_KEY);
  } catch {
    /* ignore */
  }
}

function nextTerminalId(): string {
  return `chtdk_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/** ZCode formatTerminalTabTitle 同款：编号 1 不显示，从 2 起追加 */
export function formatChatTerminalTabTitle(tab: ChatTerminalTab): string {
  return tab.index === 1 ? tab.cwdLeaf : `${tab.cwdLeaf} ${tab.index}`;
}

interface ChatTerminalState {
  /** 面板是否展开 */
  readonly open: boolean;
  /** 面板高度（px，桌面端可拖；移动端固定 40vh 不走这里） */
  readonly height: number;
  /** Shell 档案 id（SUPPORTED_TERMINAL_PROFILES 之一，默认 pwsh = PowerShell 7） */
  readonly profileId: string;
  /** 终端标签（含历史已死待清理的 id，由面板挂载时校正） */
  readonly tabs: readonly ChatTerminalTab[];
  readonly activeTabId: string | null;
  /** 重建代际（换 Shell）：+1 逼迫面板 dispose 全部会话后重建 */
  readonly restartSeq: number;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  /** 换 Shell：杀掉全部会话并清空标签，面板开着就按新 Shell 重建 */
  setProfileId: (profileId: string) => void;
  /** 「+」新建终端（编号取现存标签的最小空位），并激活 */
  addTab: (cwdLeaf: string) => void;
  /** 标签上的 ×：非末签杀 PTY 并激活相邻；末签只收面板（ZCode 同款保活语义） */
  closeTab: (id: string) => void;
  /** PTY 自退：移除标签；末签自退连面板一起收（ZCode exitTerminalSession 同款） */
  removeExitedTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** 面板挂载时把「daemon 里已死」的标签就地替换成新建（F5 校正），返回新表 */
  replaceDeadTabs: (deadIds: readonly string[]) => ChatTerminalTab[];
}

const initialPrefs = readPrefs();
const initialTabs = readChatTerminalTabs();

export const useChatTerminal = create<ChatTerminalState>((set, get) => ({
  open: false,
  height: initialPrefs.height,
  profileId: initialPrefs.profileId,
  tabs: initialTabs.tabs,
  activeTabId: initialTabs.activeTabId,
  restartSeq: 0,

  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),

  setHeight: (height) => {
    const max = Math.max(
      CHAT_DOCK_MIN_HEIGHT,
      Math.floor((typeof window !== "undefined" ? window.innerHeight : 900) * CHAT_DOCK_MAX_HEIGHT_RATIO),
    );
    const clamped = Math.max(CHAT_DOCK_MIN_HEIGHT, Math.min(max, Math.round(height)));
    set({ height: clamped });
    persistPrefs({ profileId: get().profileId, height: clamped });
  },

  setProfileId: (profileId) => {
    if (!SUPPORTED_TERMINAL_PROFILES.some((p) => p.id === profileId)) return;
    const prev = get().profileId;
    set({ profileId });
    persistPrefs({ profileId, height: get().height });
    if (prev === profileId) return;
    // 全部杀掉 + 清标签：面板 effect 按 restartSeq 重建第 1 个标签
    for (const t of get().tabs) terminalSessionRegistry.dispose(t.id);
    clearTabs();
    set({ tabs: [], activeTabId: null, restartSeq: get().restartSeq + 1 });
  },

  addTab: (cwdLeaf) => {
    const { tabs } = get();
    // ZCode getNextTerminalSessionIndex：从现存编号推导最小空位（只增不减会漂移）
    const used = new Set(tabs.map((t) => t.index));
    let index = 1;
    while (used.has(index)) index += 1;
    const tab: ChatTerminalTab = { id: nextTerminalId(), index, cwdLeaf };
    const next = [...tabs, tab];
    set({ tabs: next, activeTabId: tab.id });
    persistTabs(next, tab.id);
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    if (!tabs.some((t) => t.id === id)) return;
    if (tabs.length === 1) {
      // 末签的关闭语义 = 收起整个面板并保活会话（与收面板按钮一致）
      get().setOpen(false);
      return;
    }
    terminalSessionRegistry.dispose(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const fallback = next[Math.max(0, idx - 1)] ?? next[0]!;
    const nextActive = activeTabId === id ? fallback.id : activeTabId;
    set({ tabs: next, activeTabId: nextActive });
    persistTabs(next, nextActive);
  },

  removeExitedTab: (id) => {
    const { tabs, activeTabId } = get();
    if (!tabs.some((t) => t.id === id)) return;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (next.length === 0) {
      // PTY 自身退出时最后一个标签不能只收起保活：清记录，重开面板时懒建新终端
      clearTabs();
      set({ tabs: [], activeTabId: null, open: false });
      return;
    }
    const fallback = next[Math.max(0, idx - 1)] ?? next[0]!;
    const nextActive = activeTabId === id ? fallback.id : activeTabId;
    set({ tabs: next, activeTabId: nextActive });
    persistTabs(next, nextActive);
  },

  setActiveTab: (id) => {
    if (!get().tabs.some((t) => t.id === id)) return;
    set({ activeTabId: id });
    persistTabs(get().tabs, id);
  },

  replaceDeadTabs: (deadIds) => {
    const dead = new Set(deadIds);
    const { tabs, activeTabId } = get();
    const survivors = tabs.filter((t) => !dead.has(t.id));
    // 对每个死条目：保持标题与编号语义，就地换一条新 PTY（新 id）
    const rebuilt = survivors.map((t) => ({ ...t }));
    const additions: ChatTerminalTab[] = [];
    for (const id of deadIds) {
      const old = tabs.find((t) => t.id === id);
      if (!old) continue;
      additions.push({ id: nextTerminalId(), index: old.index, cwdLeaf: old.cwdLeaf });
    }
    const next = [...rebuilt, ...additions];
    const nextActive =
      activeTabId && dead.has(activeTabId) ? (additions[0]?.id ?? next[0]?.id ?? null) : activeTabId;
    set({ tabs: next, activeTabId: nextActive ?? next[0]?.id ?? null });
    persistTabs(next, get().activeTabId);
    return next;
  },
}));

/** 当前 Shell 档案（菜单/设置/面板头共用） */
export function chatTerminalProfile(profileId: string) {
  return SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? SUPPORTED_TERMINAL_PROFILES[0]!;
}
