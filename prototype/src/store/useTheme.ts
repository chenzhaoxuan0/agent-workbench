import { create } from "zustand";
import {
  TerminalSessionManager,
  XTERM_LIGHT_THEME,
  XTERM_DARK_THEME,
} from "./TerminalSessionManager.ts";

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeOption {
  readonly id: ThemeMode;
  readonly label: string;
  readonly name: string;
  readonly desc: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "light",
    label: "温润羊皮纸 (Light)",
    name: "Cursor Parchment",
    desc: "暖白奶油底色、纸阶平坦分层、暖调墨黑文字与 Ember 炽橙强调",
  },
  {
    id: "dark",
    label: "深邃黑曜石 (Dark)",
    name: "Warp Obsidian",
    desc: "极致纯黑终端底、炭黑控制面板、骨白高对比文本与荧光紫光标",
  },
  {
    id: "system",
    label: "跟随系统 (Auto)",
    name: "System Preference",
    desc: "自动检测并同步操作系统的浅色或深色偏好",
  },
];

const STORAGE_KEY = "agent-workbench:theme-mode";

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function applyThemeToDOM(resolved: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  } else {
    root.classList.remove("dark");
    root.setAttribute("data-theme", "light");
  }
  try {
    TerminalSessionManager.updateAllThemes(resolved === "dark");
  } catch {}
}

const initialMode: ThemeMode = ((): ThemeMode => {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  }
  return "light";
})();

const initialResolved: "light" | "dark" =
  initialMode === "system" ? getSystemTheme() : initialMode;

// 立即在模块加载时设置，消除闪屏
applyThemeToDOM(initialResolved);

interface ThemeState {
  mode: ThemeMode;
  resolvedTheme: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => {
      if (get().mode === "system") {
        const nextResolved = e.matches ? "dark" : "light";
        applyThemeToDOM(nextResolved);
        set({ resolvedTheme: nextResolved });
      }
    });
  }

  return {
    mode: initialMode,
    resolvedTheme: initialResolved,
    setMode: (mode: ThemeMode) => {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {}
      const nextResolved = mode === "system" ? getSystemTheme() : mode;
      applyThemeToDOM(nextResolved);
      set({ mode, resolvedTheme: nextResolved });
    },
  };
});
