import { create } from "zustand";
import {
  callImageApi,
  type ImageCallResult,
  type ImageGenParams,
  type ImageProfile,
  type PartialImageEvent,
} from "../core/imageApi.ts";
import { daemonImageFetch } from "../core/imageProxy.ts";
import { saveImageToFolder, loadSaveFolder } from "../core/imageSave.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";

/**
 * 出图工作台 store —— 多供应商 profile 管理 + 生成参数 + 任务历史。
 *
 * profile 形态对齐 gpt_image_playground 的 ApiProfile（images/responses 双模式、
 * 流式、codexCli、response_format、透明背景方法），默认值取该仓库默认：
 * `https://api.openai.com/v1` + `gpt-image-2.5-sunburst`。
 * 供应商的完整编辑面在设置页「出图」分区（SettingsPage），工作台只做
 * 当前 profile 的只读摘要 + 跳转入口。
 *
 * **profile 的唯一真相在 daemon**（<homeDir>/image-profiles.json，密钥永不下发
 * 浏览器）：localStorage 只留 UI 偏好（activeProfileId / 历史 / 保存文件夹 /
 * 自动保存）。首次启动把旧 localStorage 里的密钥一次性上缴 daemon 后剥掉。
 *
 * 任务历史是本页面的「会话」概念：一次生图 = 一条任务；流式时 partial
 * image 实时写进 pending 任务卡。历史图片是 dataURL（单张 1–2MB），
 * 配额满按「最旧优先」丢图重试。
 */

const STORE_KEY = "agent-workbench:image-studio";
/** 旧密钥已上缴 daemon 的标记（没上缴成功不置位，下次启动继续尝试） */
const MIGRATED_FLAG = "agent-workbench:image-keys-migrated";
const MAX_TASKS = 30;

export interface ImageTask {
  readonly id: number;
  readonly ts: number;
  /** 用的哪个 profile（快照，防 profile 改动后历史失真） */
  readonly profileName: string;
  readonly model: string;
  readonly apiMode: string;
  readonly prompt: string;
  readonly params: ImageGenParams;
  /** 参考图（改图任务的输入） */
  readonly refImages?: readonly string[];
  /** 完成结果（dataURL）；失败任务为空 */
  readonly images: readonly string[];
  /** 流式过程中的过渡图（仅 pending 任务持有） */
  readonly partialImage?: string;
  readonly revisedPrompt?: string;
  readonly error?: string;
  /** 自动/手动落盘到保存文件夹的张数 */
  readonly savedCount?: number;
  /** 落盘失败原因 */
  readonly saveError?: string;
  /** 请求进行中 */
  readonly pending?: boolean;
}

interface PersistedStudio {
  /** 遗留字段：只在「密钥上缴 daemon」迁移完成前还存在于旧 localStorage 里 */
  profiles?: readonly ImageProfile[];
  activeProfileId?: string;
  history?: readonly ImageTask[];
  /** 保存文件夹显示名（句柄本体在 IndexedDB，见 core/imageSave.ts） */
  saveDirName?: string | null;
  autoSave?: boolean;
}

export const DEFAULT_PROFILE: ImageProfile = {
  id: "default-openai",
  name: "OpenAI 官方",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-image-2.5-sunburst",
  timeout: 600,
  apiMode: "images",
  codexCli: false,
  responseFormatB64Json: false,
  streamImages: false,
  streamPartialImages: 0,
  transparentBackgroundMethod: "api",
};

const DEFAULT_PARAMS: ImageGenParams = {
  size: "1024x1024",
  quality: "auto",
  n: 1,
  output_format: "png",
  output_compression: null,
  moderation: "auto",
  transparent_output: false,
};

function readPersisted(): PersistedStudio {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PersistedStudio) : {};
  } catch {
    return {};
  }
}

/** 旧单 profile 配置（profile 字段）迁移为 profiles[0] */
function normalizeProfiles(persisted: PersistedStudio): { profiles: ImageProfile[]; activeProfileId: string } {
  const raw = persisted.profiles;
  if (raw && raw.length > 0) {
    const profiles = raw.map((p, i) => ({ ...DEFAULT_PROFILE, ...p, id: p.id || `profile-${i}` }));
    const activeProfileId =
      profiles.find((p) => p.id === persisted.activeProfileId)?.id ?? profiles[0]!.id;
    return { profiles, activeProfileId };
  }
  const legacy = persisted as PersistedStudio & { profile?: Partial<ImageProfile> };
  const first: ImageProfile = { ...DEFAULT_PROFILE, ...(legacy.profile ?? {}) };
  return { profiles: [first], activeProfileId: first.id };
}

/** 写历史与 UI 偏好。**profiles 不再落 localStorage** —— 权威在 daemon，
 * 本地存密钥正是这次迁移要消灭的事（同源脚本可读、清站点数据即丢）。 */
function persist(activeProfileId: string, history: readonly ImageTask[], saveDirName: string | null, autoSave: boolean): void {
  if (typeof window === "undefined") return;
  const tryWrite = (tasks: readonly ImageTask[]): boolean => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ activeProfileId, history: tasks, saveDirName, autoSave }));
      return true;
    } catch {
      return false;
    }
  };
  let tasks = history;
  // history 新任务在前；每次写失败就把最旧的还带图的任务丢图
  while (tasks.some((t) => t.images.length > 0) && !tryWrite(tasks)) {
    let oldestWithImage = -1;
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      if (tasks[i]!.images.length > 0) {
        oldestWithImage = i;
        break;
      }
    }
    if (oldestWithImage === -1) break;
    tasks = tasks.map((t, i) => (i === oldestWithImage ? { ...t, images: [], partialImage: undefined } : t));
  }
  if (tryWrite(tasks)) return;
  try {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ activeProfileId, saveDirName, autoSave, history: tasks.map(({ images: _i, partialImage: _p, ...rest }) => rest) }),
    );
  } catch {
    /* 配置也写不下 —— 放弃本轮持久化 */
  }
}

/* ------------------------------------------------- daemon profile 同步层 */

async function rpc<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  return client.rpc<T>(method, params, timeoutMs);
}

/** 编辑防抖：设置页逐键 onChange 不能逐键打 RPC */
const pendingPatches = new Map<string, Partial<ImageProfile>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueProfileWrite(id: string, patch: Partial<ImageProfile>): void {
  const prev = pendingPatches.get(id) ?? {};
  pendingPatches.set(id, { ...prev, ...patch });
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushProfileWrites(), 600);
}

async function flushProfileWrites(): Promise<void> {
  flushTimer = null;
  const entries = [...pendingPatches.entries()];
  pendingPatches.clear();
  for (const [id, patch] of entries) {
    try {
      const saved = await rpc<ImageProfile>("image.profiles.put", { id, ...patch });
      // 回填脱敏真值（hasKey 变了要让工作台守卫立刻看见）；apiKey 落盘即清，
      // 输入框是「失焦提交」草稿态，清空不打断正在看的值
      useImageStudio.setState((st) => ({
        profiles: st.profiles.map((p) => (p.id === id ? { ...p, ...saved, apiKey: "" } : p)),
        profileSyncError: null,
      }));
    } catch (err) {
      useImageStudio.setState({ profileSyncError: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** 一次性密钥上缴：旧 localStorage 里的 profiles（含明文 key）推上 daemon，
 *  成功后剥掉本地副本。daemon 没起就整个跳过，下次启动再试。 */
async function migrateLegacyKeys(): Promise<void> {
  if (typeof window === "undefined") return;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch {
    return;
  }
  if (raw === null || window.localStorage.getItem(MIGRATED_FLAG) !== null) return;
  let parsed: PersistedStudio;
  try {
    parsed = JSON.parse(raw) as PersistedStudio;
  } catch {
    window.localStorage.setItem(MIGRATED_FLAG, "1"); // 坏数据：标记完成，别反复试
    return;
  }
  const legacy = normalizeProfiles(parsed).profiles.filter((p) => p.apiKey.trim() !== "");
  for (const p of legacy) {
    await rpc("image.profiles.put", { ...p }, 15000); // daemon 写盘（含密钥）
  }
  window.localStorage.setItem(MIGRATED_FLAG, "1");
  const { profiles: _profiles, ...rest } = parsed;
  window.localStorage.setItem(STORE_KEY, JSON.stringify(rest));
}

/** 初始化（幂等，单例）：迁移旧密钥 → 拉脱敏清单。工作台与设置页挂载时都调它。 */
let initPromise: Promise<void> | null = null;
export function initImageStudio(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async () => {
      try {
        await migrateLegacyKeys();
      } catch {
        /* daemon 没起：迁移留到下次，继续尝试同步清单 */
      }
      await syncProfiles();
    })();
  }
  return initPromise;
}

async function syncProfiles(): Promise<void> {
  try {
    const list = await rpc<ImageProfile[]>("image.profiles.list", null);
    useImageStudio.setState((st) => {
      if (list.length === 0) return { profileSyncError: null };
      // 保留本地正在编辑的草稿（apiKey 输入不脱敏丢字），其余以 daemon 为准
      const merged = list.map((remote) => {
        const local = st.profiles.find((p) => p.id === remote.id);
        return local !== undefined && local.apiKey !== "" ? { ...remote, apiKey: local.apiKey } : remote;
      });
      const activeStillThere = merged.some((p) => p.id === st.activeProfileId);
      return {
        profiles: merged,
        activeProfileId: activeStillThere ? st.activeProfileId : merged[0]!.id,
        profileSyncError: null,
      };
    });
  } catch (err) {
    useImageStudio.setState({ profileSyncError: err instanceof Error ? err.message : String(err) });
  }
}

interface ImageStudioState {
  profiles: readonly ImageProfile[];
  activeProfileId: string;
  params: ImageGenParams;
  /** 输入框草稿 */
  prompt: string;
  /** 参考图 dataURL（走 edits / responses edit 改图） */
  refImages: readonly string[];
  history: readonly ImageTask[];
  readonly busy: boolean;
  /** 保存文件夹显示名（句柄在 IndexedDB；null = 未绑定） */
  saveDirName: string | null;
  /** 保存文件夹权限态：granted 可直接写；prompt = 刷新后需重新授权 */
  savePermission: "granted" | "prompt" | "denied" | "none";
  /** 生成成功后自动落盘到保存文件夹 */
  autoSave: boolean;
  /** daemon profile 同步的最近一次错误（没起 / RPC 失败；null = 正常） */
  profileSyncError: string | null;

  /** 当前生效的 profile（便捷选择器） */
  activeProfile: () => ImageProfile;
  setActiveProfile: (id: string) => void;
  addProfile: () => void;
  removeProfile: (id: string) => void;
  updateProfile: (id: string, patch: Partial<ImageProfile>) => void;

  setParams: (patch: Partial<ImageGenParams>) => void;
  setPrompt: (v: string) => void;
  addRefImages: (dataUrls: readonly string[]) => void;
  removeRefImage: (index: number) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  removeTask: (id: number) => void;
  clearHistory: () => void;

  /** 启动时恢复保存文件夹句柄的权限态 */
  restoreSaveDir: () => Promise<void>;
  bindSaveDir: (name: string) => void;
  unbindSaveDir: () => void;
  setSavePermission: (p: "granted" | "prompt" | "denied") => void;
  setAutoSave: (v: boolean) => void;
  /** 手动把某条任务的第 index 张写入保存文件夹（TaskCard 下载按钮） */
  saveOne: (taskId: number, index: number) => Promise<boolean>;
  /** 把整条任务写入保存文件夹（自动保存复用） */
  saveTask: (taskId: number) => Promise<void>;
}

export const useImageStudio = create<ImageStudioState>((set, get) => {
  const persisted = readPersisted();
  // 初始形态：迁移还没跑时的旧 profiles（不含密钥也能撑展示），否则默认占位。
  // initImageStudio() 挂载后会用 daemon 的脱敏清单覆盖。
  const initProfiles = persisted.profiles && persisted.profiles.length > 0
    ? persisted.profiles.map((p) => ({ ...DEFAULT_PROFILE, ...p, apiKey: "" }))
    : [{ ...DEFAULT_PROFILE }];
  const initActive = initProfiles.some((p) => p.id === persisted.activeProfileId)
    ? (persisted.activeProfileId as string)
    : initProfiles[0]!.id;
  let seq = 1 + (persisted.history?.length ?? 0);

  const save = () => {
    const { activeProfileId, history, saveDirName, autoSave } = get();
    persist(activeProfileId, history, saveDirName, autoSave);
  };

  return {
    profiles: initProfiles,
    activeProfileId: initActive,
    params: DEFAULT_PARAMS,
    prompt: "",
    refImages: [],
    history: persisted.history ?? [],
    busy: false,
    saveDirName: persisted.saveDirName ?? null,
    savePermission: "none",
    autoSave: persisted.autoSave ?? false,
    profileSyncError: null,

    activeProfile: () => {
      const { profiles, activeProfileId } = get();
      return profiles.find((p) => p.id === activeProfileId) ?? profiles[0]!;
    },
    setActiveProfile: (id) => {
      set({ activeProfileId: id });
      save();
    },
    addProfile: () => {
      const id = `profile-${Date.now().toString(36)}`;
      set((st) => ({
        profiles: [...st.profiles, { ...DEFAULT_PROFILE, id, name: `供应商 ${st.profiles.length + 1}` }],
        activeProfileId: id,
      }));
      queueProfileWrite(id, get().profiles.find((p) => p.id === id)!);
    },
    removeProfile: (id) => {
      set((st) => {
        if (st.profiles.length <= 1) return st;
        const profiles = st.profiles.filter((p) => p.id !== id);
        return {
          profiles,
          activeProfileId: st.activeProfileId === id ? profiles[0]!.id : st.activeProfileId,
        };
      });
      pendingPatches.delete(id);
      void rpc("image.profiles.delete", { id }).catch((err: unknown) => {
        set({ profileSyncError: err instanceof Error ? err.message : String(err) });
      });
    },
    updateProfile: (id, patch) => {
      set((st) => ({ profiles: st.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
      queueProfileWrite(id, patch);
    },

    setParams: (patch) => set((st) => ({ params: { ...st.params, ...patch } })),
    setPrompt: (prompt) => set({ prompt }),
    addRefImages: (dataUrls) => set((st) => ({ refImages: [...st.refImages, ...dataUrls].slice(0, 4) })),
    removeRefImage: (index) => set((st) => ({ refImages: st.refImages.filter((_, i) => i !== index) })),

    generate: async () => {
      const { prompt, params, refImages, busy } = get();
      const profile = get().activeProfile();
      // 密钥在 daemon 侧（浏览器只见 hasKey）——没配就拦住
      if (busy || !prompt.trim() || profile.hasKey !== true) return;
      const id = seq++;
      const task: ImageTask = {
        id,
        ts: Date.now(),
        profileName: profile.name,
        model: profile.model,
        apiMode: profile.apiMode,
        prompt: prompt.trim(),
        params: { ...params },
        refImages: refImages.length ? [...refImages] : undefined,
        images: [],
        pending: true,
      };
      set((st) => ({ history: [task, ...st.history].slice(0, MAX_TASKS), busy: true }));

      const controller = new AbortController();
      cancelCurrent = () => controller.abort();

      // 流式 partial image：实时写进 pending 任务卡
      const onPartialImage = (partial: PartialImageEvent) => {
        set((st) => ({
          history: st.history.map((t) => (t.id === id && t.pending ? { ...t, partialImage: partial.image } : t)),
        }));
      };

      try {
        const result: ImageCallResult = await callImageApi(profile, {
          prompt: task.prompt,
          params: task.params,
          inputImageDataUrls: task.refImages,
          signal: controller.signal,
          onPartialImage,
          // 浏览器传输（docs/21 P4c）：密钥在 daemon，走 /api/image/call 代理保流式 partial
          transport: daemonImageFetch,
        });
        set((st) => ({
          history: st.history.map((t) =>
            t.id === id
              ? {
                  ...t,
                  pending: false,
                  partialImage: undefined,
                  images: result.images,
                  revisedPrompt: result.revisedPrompts.find(Boolean),
                }
              : t,
          ),
          busy: false,
          // 成功后清空输入（参考图一并清掉，与 playground 的批次语义一致）
          prompt: "",
          refImages: [],
        }));
        // 自动保存：autoSave 开启且文件夹已授权 → 逐张落盘（失败写进任务卡，不影响结果）
        const { autoSave, saveDirName, savePermission } = get();
        if (autoSave && saveDirName && savePermission === "granted") {
          await get().saveTask(id);
        }
        save();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((st) => ({
          history: st.history.map((t) => (t.id === id ? { ...t, pending: false, partialImage: undefined, error: message } : t)),
          busy: false,
        }));
        save();
      } finally {
        cancelCurrent = null;
      }
    },

    cancel: () => cancelCurrent?.(),

    removeTask: (id) => {
      set((st) => ({ history: st.history.filter((t) => t.id !== id) }));
      save();
    },
    clearHistory: () => {
      set({ history: [] });
      save();
    },

    restoreSaveDir: async () => {
      const { name, permission } = await loadSaveFolder();
      set({ saveDirName: name, savePermission: name ? permission : "none" });
      const { saveDirName } = get();
      if (!saveDirName) save();
    },
    bindSaveDir: (name) => {
      set({ saveDirName: name, savePermission: "granted" });
      save();
    },
    unbindSaveDir: () => {
      set({ saveDirName: null, savePermission: "none" });
      save();
    },
    setSavePermission: (p) => set({ savePermission: p }),
    setAutoSave: (v) => {
      set({ autoSave: v });
      save();
    },

    saveOne: async (taskId, index) => {
      const task = get().history.find((t) => t.id === taskId);
      const dataUrl = task?.images[index];
      if (!task || !dataUrl || !get().saveDirName) return false;
      try {
        await saveImageToFolder(dataUrl, task.prompt, index, task.params.output_format);
        set((st) => ({
          history: st.history.map((t) =>
            t.id === taskId
              ? { ...t, savedCount: Math.max(t.savedCount ?? 0, index + 1), saveError: undefined }
              : t,
          ),
        }));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((st) => ({ history: st.history.map((t) => (t.id === taskId ? { ...t, saveError: message } : t)) }));
        return false;
      }
    },

    saveTask: async (taskId) => {
      const task = get().history.find((t) => t.id === taskId);
      if (!task || !get().saveDirName) return;
      let saved = 0;
      let saveError: string | undefined;
      for (let i = 0; i < task.images.length; i += 1) {
        try {
          await saveImageToFolder(task.images[i]!, task.prompt, i, task.params.output_format);
          saved = i + 1;
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      if (saved > 0 || saveError) {
        set((st) => ({
          history: st.history.map((t) => (t.id === taskId ? { ...t, savedCount: saved, saveError } : t)),
        }));
      }
    },
  };
});

let cancelCurrent: (() => void) | null = null;

/* --------------------------------------------------------------- 小工具导出 */

export const IMAGE_STUDIO_STORAGE_KEY = STORE_KEY;

/** gpt-image 支持的尺寸族（dall-e 另有尺寸族，选择器按模型族切换） */
export const SIZE_OPTIONS_GPT_IMAGE: readonly string[] = ["auto", "1024x1024", "1536x1024", "1024x1536"];
export const SIZE_OPTIONS_DALLE3: readonly string[] = ["1024x1024", "1792x1024", "1024x1792"];
export const SIZE_OPTIONS_DALLE2: readonly string[] = ["256x256", "512x512", "1024x1024"];
export const QUALITY_OPTIONS_GPT_IMAGE: readonly string[] = ["auto", "low", "medium", "high"];
export const QUALITY_OPTIONS_DALLE3: readonly string[] = ["standard", "hd"];
export const FORMAT_OPTIONS: readonly ImageOutputFormat2[] = ["png", "jpeg", "webp"];
type ImageOutputFormat2 = ImageGenParams["output_format"];

export function sizeOptionsFor(model: string): readonly string[] {
  const m = model.toLowerCase();
  if (m.includes("gpt-image")) return SIZE_OPTIONS_GPT_IMAGE;
  if (m.includes("dall-e-3")) return SIZE_OPTIONS_DALLE3;
  if (m.includes("dall-e-2")) return SIZE_OPTIONS_DALLE2;
  return SIZE_OPTIONS_GPT_IMAGE;
}

export function qualityOptionsFor(model: string): readonly string[] {
  return model.toLowerCase().includes("dall-e-3") ? QUALITY_OPTIONS_DALLE3 : QUALITY_OPTIONS_GPT_IMAGE;
}

export const PRESET_MODELS: readonly string[] = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-1",
  "dall-e-3",
];
