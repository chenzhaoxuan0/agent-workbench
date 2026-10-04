import { create } from "zustand";

/**
 * 记忆偏好（docs/10 §五末段 / §七「前端重做」）。
 *
 * 上一版这里是一张「8 种记忆后端注册表」（sqlite / weknora / supabase / mem0 /
 * zep / langmem / notion / local-folder）+ 三层路由 + 检索门控，存 localStorage。
 * **整套在新架构下作废**：记忆是项目文件夹里的普通文件（MEMORY.md / memory/daily/
 * skills/），跨会话检索是现场扫 CLI 的源目录，既没有「注册后端」这回事，也不需要
 * 向量库和门控小模型。注册表与 coming 标记一并从设置页移除。
 *
 * 现在只剩三件事：
 *   1. 项目记忆上限数值（默认 2200，参照 hermes 的 MEMORY.md 2200 字符 / 约 800 tokens）
 *   2. 每个 bot 的跨项目检索开关 —— 但它**不属于这里**，它落在 bot.json 的
 *      crossSearch 上（memory/steward.ts 的权限入口），由设置页逐 bot 写盘
 *   3. 每日总结任务的开关 + 试跑按钮
 *
 * 关于上限数值的诚实说明：后端 `MEMORY_CHAR_LIMIT = 2200` 是编译期常量，
 * 写死在校验里（limits.ts）。这里改数字**不会**改后端的拒绝阈值 ——
 * 它的作用是工作台侧的**提醒阈值**（面板按它给出「先整合」的提示），
 * 面板上的分母永远取后端 memory.project.read 返回的 limit。
 */

export interface MemoryPrefs {
  /** MEMORY.md 字符上限。面板用它做「先整合」提醒阈值（默认 2200 = 后端同值） */
  memoryCharLimit: number;
  /** 每日总结任务开关（写 memory/daily/，按天分片不注入） */
  digestEnabled: boolean;
}

const DEFAULTS: MemoryPrefs = {
  memoryCharLimit: 2200,
  digestEnabled: true,
};

/** 提醒阈值取 80%（hermes 的最佳实践，与后端 MEMORY_WARN_RATIO 同值） */
export const WARN_RATIO = 0.8;

const STORAGE_KEY = "agent-workbench:memory-prefs";

/* ------------------------------------------------------------- 持久化 */

function load(): MemoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<MemoryPrefs>;
    const n = typeof p.memoryCharLimit === "number" ? Math.round(p.memoryCharLimit) : DEFAULTS.memoryCharLimit;
    return {
      // 上限必须为正：0 或负数会让「百分比」除出 Infinity / NaN，面板直接显示不出东西
      memoryCharLimit: n > 0 ? n : DEFAULTS.memoryCharLimit,
      digestEnabled: typeof p.digestEnabled === "boolean" ? p.digestEnabled : DEFAULTS.digestEnabled,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: MemoryPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式/存储满：静默失败，内存态仍可用 */
  }
}

/* ------------------------------------------------------------- store */

interface MemoryPrefsState {
  prefs: MemoryPrefs;
  setPrefs: (patch: Partial<MemoryPrefs>) => void;
}

export const useMemorySettings = create<MemoryPrefsState>()((set, get) => ({
  prefs: load(),

  setPrefs: (patch) => {
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
    save(get().prefs);
  },
}));
