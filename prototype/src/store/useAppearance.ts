import { create } from "zustand";
import {
  APPEARANCE_PRESETS,
  defaultAppearanceState,
  deriveCssVariables,
  resolveFocusX,
  resolveFocusY,
  sanitizeAppearanceState,
  toDreamSkinTheme,
  type AppearanceMode,
  type AppearancePreset,
  type AppearanceProfile,
  type AppearanceState,
  type ArtSettings,
  type PaletteKey,
  type ResolvedAppearance,
  type WallpaperSettings,
} from "../core/appearance.ts";

const STORAGE_KEY = "agent-workbench:appearance";
const LEGACY_THEME_KEY = "agent-workbench:theme-mode";

function getSystemAppearance(): ResolvedAppearance {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function readStoredState(): AppearanceState {
  if (typeof localStorage === "undefined") return defaultAppearanceState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeAppearanceState(JSON.parse(raw));

    // 一次性迁移旧版的 light/dark/system 三档，避免升级后主题被重置。
    // 旧版的 "system" 在 DS 词汇里叫 "auto"，这里顺手对齐，
    // 免得同一个概念在本项目里出现两个名字。
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === "light" || legacy === "dark") {
      return { ...defaultAppearanceState(), mode: legacy };
    }
    if (legacy === "system") {
      return { ...defaultAppearanceState(), mode: "auto" };
    }
  } catch {
    // localStorage 不可用（隐私模式）或 JSON 损坏 —— 退回默认值，不阻断渲染
  }
  return defaultAppearanceState();
}

function persist(state: AppearanceState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 配额超限时静默失败：壁纸 data URL 可能撑爆 5MB，此时设置仍在内存里生效
  }
}

/**
 * 把推导出的变量写到 <html> 的内联 style 上。
 *
 * 用内联而不是改 styles.css，是因为 @theme / :root 那两层的优先级都低于内联，
 * 天然覆盖掉硬编码的两套配色，且不需要重编译 CSS。
 */
let lastTerminalSync: ((appearance: ResolvedAppearance) => void) | null = null;

/** 由 main.tsx 注入，避免 core 与 store 互相 import 终端管理器 */
export function setTerminalAppearanceSync(fn: (appearance: ResolvedAppearance) => void): void {
  lastTerminalSync = fn;
}

function applyToDom(state: AppearanceState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveAppearance(state);
  const vars = deriveCssVariables(state.profiles[resolved], state.art, state.wallpaper);

  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }

  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-theme", resolved);

  // 壁纸：没有图或未启用时移除 data 属性，让 CSS 的默认分支接管
  const hasWallpaper = state.wallpaper.enabled && Boolean(state.wallpaper.source);
  root.toggleAttribute("data-aw-wallpaper", hasWallpaper);

  // art 三项对齐 DS 的 data-* 命名，便于日后对照排查
  const safeArea = state.art.safeArea === "auto" ? "center" : state.art.safeArea;
  root.setAttribute("data-aw-art-safe", safeArea);
  root.setAttribute("data-aw-task-mode", state.art.taskMode === "auto" ? "ambient" : state.art.taskMode);
  root.setAttribute("data-aw-art-focus", `${resolveFocusX(state.art).toFixed(4)} ${resolveFocusY(state.art).toFixed(4)}`);

  lastTerminalSync?.(resolved);
}

export function resolveAppearance(state: AppearanceState): ResolvedAppearance {
  return state.mode === "auto" ? getSystemAppearance() : state.mode;
}

const initialState = readStoredState();

// 模块加载时立即应用，消除首屏闪白。与旧版 useTheme 的行为保持一致。
applyToDom(initialState);

export interface AppearanceStore extends AppearanceState {
  resolvedAppearance: ResolvedAppearance;
  activeProfile: AppearanceProfile;

  setMode: (mode: AppearanceMode) => void;
  applyPreset: (preset: AppearancePreset) => void;
  setPaletteColor: (key: PaletteKey, value: string) => void;
  resetPaletteColor: (key: PaletteKey) => void;
  resetPalette: () => void;
  setTransparency: (value: number | null) => void;
  setSurface: <K extends keyof AppearanceProfile["surface"]>(
    key: K,
    value: AppearanceProfile["surface"][K],
  ) => void;
  resetSurface: () => void;
  setArt: <K extends keyof ArtSettings>(key: K, value: ArtSettings[K]) => void;
  setWallpaper: <K extends keyof WallpaperSettings>(key: K, value: WallpaperSettings[K]) => void;
  resetArt: () => void;
  resetWallpaper: () => void;
  resetAll: () => void;
  /** 把当前外观导出成 DS theme.json 形状 */
  exportDreamSkinTheme: () => Record<string, unknown>;
}

function activeProfileOf(state: AppearanceState): AppearanceProfile {
  return state.profiles[resolveAppearance(state)];
}

/**
 * 统一出口：落盘 → 刷 DOM → 回填派生字段，返回可直接喂给 zustand set 的补丁。
 * 任何 setter 都不该绕过它，否则会出现「界面变了但没落盘」这种幽灵状态。
 */
function publish(next: AppearanceState): AppearanceStore {
  persist(next);
  applyToDom(next);
  return {
    ...next,
    resolvedAppearance: resolveAppearance(next),
    activeProfile: activeProfileOf(next),
  } as AppearanceStore;
}

function withProfile(
  state: AppearanceState,
  resolved: ResolvedAppearance,
  patch: (profile: AppearanceProfile) => AppearanceProfile,
): AppearanceState {
  return {
    ...state,
    profiles: { ...state.profiles, [resolved]: patch(state.profiles[resolved]) },
    // 用户手动改过就不再声称「等于某个预设」；用哨兵值而不是 null，
    // 因为 null 还要留给「从未选过预设」的合法状态
    presetId: "__custom__",
  };
}

export const useAppearance = create<AppearanceStore>((set, get) => ({
  ...initialState,
  resolvedAppearance: resolveAppearance(initialState),
  activeProfile: activeProfileOf(initialState),

  setMode: (mode) => {
    set(publish({ ...get(), mode }));
  },

  applyPreset: (preset) => {
    const next: AppearanceState = {
      ...get(),
      mode: preset.mode,
      profiles: {
        light: cloneProfile(preset.light),
        dark: cloneProfile(preset.dark),
      },
      presetId: preset.id,
    };
    set(publish(next));
  },

  setPaletteColor: (key, value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      palette: { ...profile.palette, [key]: value },
    }));
    set(publish(next));
  },

  resetPaletteColor: (key) => {
    const resolved = resolveAppearance(get());
    const preset = APPEARANCE_PRESETS.find((item) => item.id === get().presetId);
    const base = preset
      ? preset[resolved].palette[key]
      : defaultAppearanceState().profiles[resolved].palette[key];
    get().setPaletteColor(key, base);
  },

  resetPalette: () => {
    const resolved = resolveAppearance(get());
    const preset = APPEARANCE_PRESETS.find((item) => item.id === get().presetId);
    const base = preset ? preset[resolved] : defaultAppearanceState().profiles[resolved];
    const next = withProfile(get(), resolved, () => cloneProfile(base));
    set(publish(next));
  },

  setTransparency: (value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({ ...profile, transparency: value }));
    set(publish(next));
  },

  setSurface: (key, value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      surface: { ...profile.surface, [key]: value },
    }));
    set(publish(next));
  },

  resetSurface: () => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      surface: { ...defaultAppearanceState().profiles[resolved].surface },
    }));
    set(publish(next));
  },

  setArt: (key, value) => {
    const next: AppearanceState = { ...get(), art: { ...get().art, [key]: value } };
    set(publish(next));
  },

  resetArt: () => {
    const next: AppearanceState = {
      ...get(),
      art: { ...defaultAppearanceState().art },
    };
    set(publish(next));
  },

  setWallpaper: (key, value) => {
    const next: AppearanceState = { ...get(), wallpaper: { ...get().wallpaper, [key]: value } };
    set(publish(next));
  },

  resetWallpaper: () => {
    const next: AppearanceState = {
      ...get(),
      wallpaper: { ...defaultAppearanceState().wallpaper },
    };
    set(publish(next));
  },

  resetAll: () => {
    set(publish(defaultAppearanceState()));
  },

  exportDreamSkinTheme: () => {
    const state = get();
    return toDreamSkinTheme(state, resolveAppearance(state));
  },
}));

function cloneProfile(profile: AppearanceProfile): AppearanceProfile {
  return {
    palette: { ...profile.palette },
    surface: { ...profile.surface },
    transparency: profile.transparency,
  };
}

/* 系统明暗变化时，auto 模式要跟着重算 —— 与旧版 useTheme 的行为一致 */
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const state = useAppearance.getState();
    if (state.mode !== "auto") return;
    persist(state);
    applyToDom(state);
    useAppearance.setState({
      resolvedAppearance: resolveAppearance(state),
      activeProfile: activeProfileOf(state),
    });
  });
}