/**
 * 对话页小终端（Chat Terminal Dock）—— 对话底部快捷终端的状态与偏好。
 *
 * 与 TUI 终端页刻意隔离：同一个 daemon 只多一条 PTY（terminal.* RPC 全复用），
 * 但不进 useTerminalStore 的标签树 —— created 帧推送认领与 F5 重挂都按
 * CHAT_DOCK_UNIT_ID 标记跳过它，避免对话终端在终端页里开出重复标签。
 *
 * 会话生命周期：
 * - 关闭面板（X）只收起 UI，PTY 留活 —— 再打开瞬达，不重起进程；
 * - 「重启」按钮 / 设置里换 Shell：dispose 旧会话（杀 PTY），下次挂载按新 Shell 重建；
 * - F5 刷新：PTY 在 daemon 还活着，面板挂载时按 sessionStorage 记的 id
 *   从 terminal.list 认领回放（与 TUI 重挂同一思路，省一个孤儿进程）。
 */
import { create } from "zustand";
import { SUPPORTED_TERMINAL_PROFILES } from "./useTerminalStore.ts";
import { terminalSessionRegistry } from "./TerminalSessionManager.ts";

const CHAT_TERMINAL_PREFS_KEY = "agent-workbench:chat-terminal-prefs";
/** sessionStorage 记当前 PTY id（刷新后认领用；关浏览器即丢，不跨标签串） */
const CHAT_TERMINAL_SESSION_KEY = "agent-workbench:chat-terminal-id";

export const CHAT_DOCK_MIN_HEIGHT = 160;
export const CHAT_DOCK_DEFAULT_HEIGHT = 300;
const CHAT_DOCK_MAX_HEIGHT_RATIO = 0.7;

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

export function readChatTerminalId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(CHAT_TERMINAL_SESSION_KEY);
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

export function writeChatTerminalId(id: string): void {
  try {
    window.sessionStorage.setItem(CHAT_TERMINAL_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

function clearChatTerminalId(): void {
  try {
    window.sessionStorage.removeItem(CHAT_TERMINAL_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

interface ChatTerminalState {
  /** 面板是否展开 */
  readonly open: boolean;
  /** 面板高度（px，桌面端可拖；移动端固定 40vh 不走这里） */
  readonly height: number;
  /** Shell 档案 id（SUPPORTED_TERMINAL_PROFILES 之一，默认 pwsh = PowerShell 7） */
  readonly profileId: string;
  /** 重启代际：+1 逼迫面板 effect 重建会话（换 Shell / 手动重启共用） */
  readonly restartSeq: number;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  /** 换 Shell：立即杀掉现有 PTY，面板开着就按新 Shell 重建 */
  setProfileId: (profileId: string) => void;
  /** 手动重启（杀进程重开），Shell 不变 */
  restart: () => void;
}

const initialPrefs = readPrefs();

export const useChatTerminal = create<ChatTerminalState>((set, get) => ({
  open: false,
  height: initialPrefs.height,
  profileId: initialPrefs.profileId,
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
    if (prev !== profileId) get().restart();
  },

  restart: () => {
    const id = readChatTerminalId();
    if (id) {
      terminalSessionRegistry.dispose(id);
      // 先清 id 再 bump：boot 的认领分支查 terminal.list 时，被杀的 PTY 可能
      // 还在 daemon 清单里（kill 是异步往返）—— id 不清就会把将死的 PTY
      // 当成「刷新重挂」认领，而 attachScrollback 模式绝不再 create → 死终端。
      clearChatTerminalId();
    }
    set((s) => ({ restartSeq: s.restartSeq + 1 }));
  },
}));

/** 当前 Shell 档案（菜单/设置/面板头共用） */
export function chatTerminalProfile(profileId: string) {
  return SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? SUPPORTED_TERMINAL_PROFILES[0]!;
}
