import { create } from "zustand";

/**
 * 记忆编排 —— 后端注册表 + 三层路由（对齐 T3 的 provider instance 逻辑，
 * 数据模型对齐 waku 的记忆三柱）。
 *
 * 分三层解耦：
 * 1. **后端注册表**：每个后端是一条实例（类型 / 名称 / 启停 / 连接配置），
 *    同类型可注册多个（两个 WeKnora KB = 两个后端）；
 * 2. **全局路由**：语义 / 情节 / 程序性各路由到一组启用的后端
 *    （检索 = 并集，写入 = 广播）；
 * 3. **每 bot 路由覆盖**（WorkUnit.memory.routes）：分开用 = 指向不同
 *    后端子集，合起来用 = 全部指向同一组；未声明 = 跟随全局。
 *
 * 凭据边界同 dsh：真运行时后 key 应移入凭据库，配置只留引用名。
 */

export type BackendType =
  | "sqlite"
  | "weknora"
  | "supabase"
  | "mem0"
  | "zep"
  | "langmem"
  | "notion"
  | "local-folder";

export interface MemoryBackend {
  id: string;
  type: BackendType;
  name: string;
  enabled: boolean;
  /** weknora */
  baseUrl?: string;
  apiKey?: string;
  kbId?: string;
  /** local-folder（句柄本体在 IndexedDB，见 core/localMemorySource.ts） */
  sourceId?: string;
  /** sqlite：数据库文件路径（默认 .waku/state.db，可指向任意自定义文件） */
  dbPath?: string;
}

export interface MemoryRoutes {
  semantic: readonly string[];
  episodic: readonly string[];
  procedural: readonly string[];
}

export interface MemoryPrefs {
  backends: readonly MemoryBackend[];
  routes: MemoryRoutes;
  /** 检索门控：小模型先判断本次是否需要检索；fail-open */
  gateEnabled: boolean;
  gateModel: string;
  /** 记忆整理：每 N 次交换由小模型提取 facts + episode（waku 默认 6） */
  consolidateEvery: number;
  /** 人读镜像：每轮后重新生成 MEMORY.md */
  mirrorMd: boolean;
  /** 语义检索条数（waku: WAKU_RETRIEVAL_TOP_K，默认 4） */
  semanticTopK: number;
}

const DEFAULTS: MemoryPrefs = {
  backends: [{ id: "be-sqlite", type: "sqlite", name: "本地 SQLite", enabled: true }],
  routes: {
    semantic: ["be-sqlite"],
    episodic: ["be-sqlite"],
    procedural: ["be-sqlite"],
  },
  gateEnabled: true,
  gateModel: "claude-haiku-4-5",
  consolidateEvery: 6,
  mirrorMd: true,
  semanticTopK: 4,
};

const STORAGE_KEY = "agent-workbench:memory-orchestration";

/* ------------------------------------------------------------- 持久化 */

function load(): MemoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MemoryPrefs>;
      return {
        backends: parsed.backends ?? DEFAULTS.backends,
        routes: { ...DEFAULTS.routes, ...(parsed.routes ?? {}) },
        gateEnabled: parsed.gateEnabled ?? DEFAULTS.gateEnabled,
        gateModel: parsed.gateModel ?? DEFAULTS.gateModel,
        consolidateEvery: parsed.consolidateEvery ?? DEFAULTS.consolidateEvery,
        mirrorMd: parsed.mirrorMd ?? DEFAULTS.mirrorMd,
        semanticTopK: parsed.semanticTopK ?? DEFAULTS.semanticTopK,
      };
    }
    return migrateLegacy();
  } catch {
    return migrateLegacy();
  }
}

/**
 * 旧版单选 / weknora 散字段的迁移：
 * semanticStore(s) / episodicStore(s) / weknora 三件套 / localSources
 * → 后端注册表 + 路由。幂等：新结构存在即跳过。
 */
function migrateLegacy(): MemoryPrefs {
  const prefs = DEFAULTS;
  try {
    const legacy = JSON.parse(
      window.localStorage.getItem("agent-workbench:memory-prefs") ?? "null",
    ) as
      | {
          semanticEnabled?: boolean;
          semanticStores?: string[];
          semanticStore?: string;
          episodicEnabled?: boolean;
          episodicStores?: string[];
          episodicStore?: string;
          weknoraBaseUrl?: string;
          weknoraApiKey?: string;
          weknoraSemanticKbIds?: string[];
          weknoraEpisodicKbIds?: string[];
          localSources?: { id: string; name: string }[];
        }
      | null;
    if (!legacy) return prefs;

    const backends: MemoryBackend[] = [...prefs.backends];
    const semantic = [...prefs.routes.semantic];
    const episodic = [...prefs.routes.episodic];

    if (legacy.weknoraBaseUrl) {
      for (const kbId of legacy.weknoraSemanticKbIds ?? []) {
        const id = `be-weknora-${kbId}`;
        backends.push({
          id,
          type: "weknora",
          name: `WeKnora · ${kbId}`,
          enabled: legacy.semanticEnabled !== false,
          baseUrl: legacy.weknoraBaseUrl,
          apiKey: legacy.weknoraApiKey,
          kbId,
        });
        semantic.push(id);
      }
      for (const kbId of legacy.weknoraEpisodicKbIds ?? []) {
        const id = `be-weknora-epi-${kbId}`;
        backends.push({
          id,
          type: "weknora",
          name: `WeKnora · ${kbId}（情节）`,
          enabled: legacy.episodicEnabled !== false,
          baseUrl: legacy.weknoraBaseUrl,
          apiKey: legacy.weknoraApiKey,
          kbId,
        });
        episodic.push(id);
      }
    }
    for (const src of legacy.localSources ?? []) {
      const id = `be-local-${src.id}`;
      backends.push({ id, type: "local-folder", name: `本地 · ${src.name}`, enabled: true, sourceId: src.id });
      semantic.push(id);
    }

    return { ...prefs, backends, routes: { semantic, episodic, procedural: prefs.routes.procedural } };
  } catch {
    return prefs;
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

interface MemoryOrchestrationState {
  prefs: MemoryPrefs;
  addBackend: (backend: Omit<MemoryBackend, "id"> & { id?: string }) => string;
  updateBackend: (id: string, patch: Partial<Omit<MemoryBackend, "id">>) => void;
  removeBackend: (id: string) => void;
  /** 启停同时从路由中摘除/加回（停用 = 该层暂时不查不写，配置保留） */
  toggleBackend: (id: string, enabled: boolean) => void;
  setRoute: (layer: keyof MemoryRoutes, ids: readonly string[]) => void;
  setGate: (
    patch: Partial<
      Pick<MemoryPrefs, "gateEnabled" | "gateModel" | "consolidateEvery" | "mirrorMd" | "semanticTopK">
    >,
  ) => void;
}

export const useMemoryOrchestration = create<MemoryOrchestrationState>()((set, get) => ({
  prefs: load(),

  addBackend: (backend) => {
    const id = backend.id ?? `be-${backend.type}-${Date.now().toString(36)}`;
    set((s) => ({ prefs: { ...s.prefs, backends: [...s.prefs.backends, { ...backend, id }] } }));
    save(get().prefs);
    return id;
  },

  updateBackend: (id, patch) => {
    set((s) => ({
      prefs: {
        ...s.prefs,
        backends: s.prefs.backends.map((b) => (b.id === id ? { ...b, ...patch, id } : b)),
      },
    }));
    save(get().prefs);
  },

  removeBackend: (id) => {
    set((s) => ({
      prefs: {
        ...s.prefs,
        backends: s.prefs.backends.filter((b) => b.id !== id),
        routes: {
          semantic: s.prefs.routes.semantic.filter((x) => x !== id),
          episodic: s.prefs.routes.episodic.filter((x) => x !== id),
          procedural: s.prefs.routes.procedural.filter((x) => x !== id),
        },
      },
    }));
    save(get().prefs);
  },

  toggleBackend: (id, enabled) => {
    set((s) => ({
      prefs: {
        ...s.prefs,
        backends: s.prefs.backends.map((b) => (b.id === id ? { ...b, enabled } : b)),
      },
    }));
    save(get().prefs);
  },

  setRoute: (layer, ids) => {
    set((s) => ({ prefs: { ...s.prefs, routes: { ...s.prefs.routes, [layer]: ids } } }));
    save(get().prefs);
  },

  setGate: (patch) => {
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
    save(get().prefs);
  },
}));
