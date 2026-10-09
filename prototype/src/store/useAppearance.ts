import { create } from "zustand";
import {
  APPEARANCE_PRESETS,
  defaultAppearanceState,
  deriveCssVariables,
  resolveFocusX,
  resolveFocusY,
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
import {
  loadAppearance,
  writeAppearance,
  saveWallpaperFile,
  type AppearanceLoadSource,
} from "../core/appearanceStore.ts";

function getSystemAppearance(): ResolvedAppearance {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
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

/**
 * 首屏先用内置默认立即上色，避免等 daemon 往返时闪一帧白；
 * 真正的外观随后由 hydrateFromFile() 换上。
 */
const initialState: AppearanceState = defaultAppearanceState();
applyToDom(initialState);

/**
 * 落盘用的乐观锁基准：我方最后一次见到的 appearance.json 内容哈希。
 * 自己写完会更新它；poll 读到不同 hash 就判定「被 agent 改了」。
 */
let lastKnownHash = "";
let lastPath: string | null = null;
let lastSource: AppearanceLoadSource = "defaults";

/** 写盘是异步的，但 UI 立刻要变。串成一条链，保证顺序、避免乱序回写互相覆盖 */
let writeChain: Promise<unknown> = Promise.resolve();

function persist(next: AppearanceState): void {
  // 乐观锁在文件不可用（hash 为空）时传 null，表示无条件覆盖 —— 首启落盘就得这么写
  const expected = lastKnownHash || null;
  writeChain = writeChain
    .then(() => writeAppearance(next, expected))
    .then((result) => {
      lastKnownHash = result.hash;
      lastPath = result.path;
      lastSource = "file";
    })
    .catch(() => {
      // 写失败（daemon 没起 / hash 冲突 / 磁盘满）：界面已经变了，不回滚，
      // 但也不能让这条链卡死 —— catch 吞掉，后面的写继续排队
    });
}

export interface AppearanceStore extends AppearanceState {
  resolvedAppearance: ResolvedAppearance;
  activeProfile: AppearanceProfile;
  /** 外观文件的绝对路径，设置页显示它，用户才知道该让 agent 改哪个文件 */
  filePath: string | null;
  /** 当前外观来自哪一层：文件 / 兜底 / 默认 */
  source: AppearanceLoadSource;
  /** 写盘失败时的最后一次错误，给设置页一条提示用 */
  lastError: string | null;
  /** 从 appearance.json 重新读一次（设置页的「重新读取文件」按钮 / 外部改动后） */
  reload: () => Promise<void>;
  /** 导入壁纸：落盘到 wallpapers/ 并把路径写回状态 */
  importWallpaper: (file: File) => Promise<void>;

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
function publish(next: AppearanceState): Partial<AppearanceStore> {
  persist(next);
  applyToDom(next);
  return {
    ...next,
    resolvedAppearance: resolveAppearance(next),
    activeProfile: activeProfileOf(next),
    lastError: null,
  } as Partial<AppearanceStore>;
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
  filePath: null,
  source: "defaults",
  lastError: null,

  reload: async () => {
    await hydrate();
  },

  importWallpaper: async (file: File) => {
    try {
      const relPath = await saveWallpaperFile(file);
      // 落盘成功后立刻把图读回来看效果；读不回来（比如 daemon 刚断）就只留路径，
      // 下次 poll 会补上
      const probe = await loadAppearance();
      const fresh = probe.state.wallpaper.source;
      const next = withProfile(get(), resolveAppearance(get()), (p) => ({ ...p }));
      set(
        publish({
          ...next,
          wallpaper: {
            ...get().wallpaper,
            enabled: true,
            path: relPath,
            source: fresh ?? null,
          },
        }),
      );
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

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

/* --------------------------------------------------------------------------- 文件同步 */

/**
 * 从 appearance.json 读一次并上屏。
 *
 * hash 变了才动 —— 自己刚写完的那次 hash 会被 persist 记下来，
 * 所以这里不会把自己的回写当成「外部改动」再来一遍。
 */
async function hydrate(): Promise<void> {
  let result;
  try {
    result = await loadAppearance();
  } catch {
    return;
  }

  lastKnownHash = result.hash;
  lastPath = result.path;
  lastSource = result.source;
  applyToDom(result.state);
  useAppearance.setState({
    ...result.state,
    resolvedAppearance: resolveAppearance(result.state),
    activeProfile: activeProfileOf(result.state),
    filePath: result.path,
    source: result.source,
  } as Partial<AppearanceStore>);
}

/**
 * 轮询盘上文件，把 agent 的改动接进来。
 *
 * 只在「上次读到的 hash 与本次不同」时才 set 状态，所以常驻开销只是一次小 RPC，
 * 不会引起任何重渲染。4 秒一轮：既能在 agent 保存后很快看到，又不至于把回环打满。
 */
const POLL_INTERVAL_MS = 4000;

async function pollExternalChanges(): Promise<void> {
  let result;
  try {
    result = await loadAppearance();
  } catch {
    return;
  }
  if (result.hash === lastKnownHash) return;

  // 兜底层降级时 hash 恒为空字符串，这种"变化"不是外部编辑，别覆盖用户在界面上的即时调整
  if (!result.hash) {
    lastSource = result.source;
    useAppearance.setState({ source: result.source, filePath: result.path } as Partial<AppearanceStore>);
    return;
  }

  lastKnownHash = result.hash;
  lastPath = result.path;
  lastSource = result.source;
  applyToDom(result.state);
  useAppearance.setState({
    ...result.state,
    resolvedAppearance: resolveAppearance(result.state),
    activeProfile: activeProfileOf(result.state),
    filePath: result.path,
    source: result.source,
  } as Partial<AppearanceStore>);
}

/* 首屏立即从文件取真实外观（此时界面已经用默认配色上色，不会闪） */
void hydrate();

if (typeof window !== "undefined") {
  window.setInterval(() => {
    void pollExternalChanges();
  }, POLL_INTERVAL_MS);

  // 切回这个窗口时立刻查一次：agent 改完文件、你切回来就看到了
  window.addEventListener("focus", () => {
    void pollExternalChanges();
  });
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