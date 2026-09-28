import { create } from "zustand";

/**
 * 记忆偏好 —— 全局默认，对齐 waku-agent 的记忆三柱与门控/整理参数
 * （waku: WAKU_SEMANTIC_STORE / WAKU_EPISODIC_STORE / WAKU_RETRIEVAL_TOP_K /
 *  WAKU_CONSOLIDATE_EVERY / small_model 门控）。
 *
 * 每 bot 的接入开关在「添加 bot」时单独声明（WorkUnit.memory），
 * 这里的全局值作为未显式声明时的默认。
 */

export type SemanticStore = "sqlite" | "weknora" | "supabase" | "mem0" | "zep" | "langmem";

/** WeKnora 连接配置（本地 Docker 部署，默认 8080） */
export interface WeknoraConfig {
  baseUrl: string;
  apiKey: string;
  /** 语义事实所在的知识库 id（可通过「测试连接」拉取列表选择） */
  kbId: string;
}
export type EpisodicStore = "sqlite" | "notion" | "weknora";

export interface MemoryPrefs {
  /**
   * 语义记忆 · 事实（人/项目/偏好的持久事实，FTS5 检索）。
   * **多后端**：检索 = 全部启用后端的并集；写入 = 广播到全部启用后端
   * （镜像语义——一个后端挂了记忆不丢）。
   */
  semanticEnabled: boolean;
  semanticStores: readonly SemanticStore[];
  /** 检索条数（waku: WAKU_RETRIEVAL_TOP_K，默认 4） */
  semanticTopK: number;
  /** semanticStore === "weknora" 时的连接配置 */
  weknoraBaseUrl: string;
  weknoraApiKey: string;
  /** 各记忆层绑定的 WeKnora 知识库（多选：检索跨库并集；语义写入进第一个勾选库） */
  weknoraSemanticKbIds: readonly string[];
  weknoraEpisodicKbIds: readonly string[];
  /** 本地文件来源（不经 WeKnora 直连的文件夹；句柄存 IndexedDB） */
  localSources: readonly { id: string; name: string }[];
  /** 情节记忆 · 事件（带日期的“发生过什么”一句话摘要）——多后端同上 */
  episodicEnabled: boolean;
  episodicStores: readonly EpisodicStore[];
  /** 程序性记忆 · 技能（SKILL.md 关键词命中注入，每轮最多 2 个） */
  proceduralEnabled: boolean;
  /** 检索门控：小模型先判断本次是否需要检索；fail-open（门控出错就检索） */
  gateEnabled: boolean;
  gateModel: string;
  /** 记忆整理：每 N 次交换由小模型提取 facts + episode（waku 默认 6） */
  consolidateEvery: number;
  /** 人读镜像：每轮后重新生成 MEMORY.md */
  mirrorMd: boolean;
}

const DEFAULTS: MemoryPrefs = {
  semanticEnabled: true,
  semanticStores: ["sqlite"],
  semanticTopK: 4,
  weknoraBaseUrl: "http://localhost:18080",
  weknoraApiKey: "",
  weknoraSemanticKbIds: [],
  weknoraEpisodicKbIds: [],
  localSources: [],
  episodicEnabled: true,
  episodicStores: ["sqlite"],
  proceduralEnabled: true,
  gateEnabled: true,
  gateModel: "claude-haiku-4-5",
  consolidateEvery: 6,
  mirrorMd: true,
};

const STORAGE_KEY = "agent-workbench:memory-prefs";

function load(): MemoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const prefs = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<MemoryPrefs>) };
    // 默认值迁移：旧版默认 8080（WeKnora 实际 docker 映射 18080）
    if (prefs.weknoraBaseUrl === "http://localhost:8080") {
      prefs.weknoraBaseUrl = DEFAULTS.weknoraBaseUrl;
    }
    // 旧版单库绑定 → 语义层多选（weknoraKbId 已废）
    const legacyKb = (prefs as { weknoraKbId?: string }).weknoraKbId;
    if (legacyKb && prefs.weknoraSemanticKbIds.length === 0) {
      prefs.weknoraSemanticKbIds = [legacyKb];
    }
    // 旧版单后端 → 多后端
    const legacySem = (prefs as { semanticStore?: SemanticStore }).semanticStore;
    if (legacySem && prefs.semanticStores.length === 0) {
      prefs.semanticStores = [legacySem];
    }
    const legacyEpi = (prefs as { episodicStore?: EpisodicStore }).episodicStore;
    if (legacyEpi && prefs.episodicStores.length === 0) {
      prefs.episodicStores = [legacyEpi];
    }
    return prefs;
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

interface MemoryPrefsState {
  prefs: MemoryPrefs;
  update: (patch: Partial<MemoryPrefs>) => void;
  addLocalSource: (source: { id: string; name: string }) => void;
  removeLocalSource: (id: string) => void;
  reset: () => void;
}

export const useMemoryPrefs = create<MemoryPrefsState>()((set, get) => ({
  prefs: load(),
  update: (patch) => {
    const next = { ...get().prefs, ...patch };
    save(next);
    set({ prefs: next });
  },
  addLocalSource: (source) => {
    const next = { ...get().prefs, localSources: [...get().prefs.localSources, source] };
    save(next);
    set({ prefs: next });
  },
  removeLocalSource: (id) => {
    const next = { ...get().prefs, localSources: get().prefs.localSources.filter((x) => x.id !== id) };
    save(next);
    set({ prefs: next });
  },
  reset: () => {
    save(DEFAULTS);
    set({ prefs: DEFAULTS });
  },
}));
