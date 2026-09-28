import { create } from "zustand";
import { callImageApi, type ImageCallResult, type ImageGenParams, type ImageOutputFormat, type ImageProfile } from "../core/imageApi.ts";

/**
 * 出图工作台 store —— 供应商配置 + 任务历史。
 *
 * 配置与 gpt_image_playground 的 ApiProfile 对齐（baseUrl/apiKey/model/timeout），
 * 默认值取该仓库的 DEFAULT_OPENAI_BASE_URL 与 DEFAULT_IMAGES_MODEL：
 * `https://api.openai.com/v1` + `gpt-image-2.5-sunburst`。
 * 任务历史是本页面的「会话」概念：一次生图 = 一条任务（prompt + 参数 + 结果图）。
 *
 * 持久化语义：配置永久保存；历史图片是 dataURL（单张 1–2MB），受 localStorage
 * 配额约束 —— 写满时从最旧的任务开始丢图（保留元信息），最后整体放弃写历史。
 */

const STORE_KEY = "agent-workbench:image-studio";
const MAX_TASKS = 30;

export interface ImageTask {
  readonly id: number;
  readonly ts: number;
  readonly prompt: string;
  readonly params: ImageGenParams;
  /** 参考图（改图任务的输入） */
  readonly refImages?: readonly string[];
  /** 完成结果（dataURL）；失败任务为空 */
  readonly images: readonly string[];
  readonly revisedPrompt?: string;
  readonly error?: string;
  /** 请求进行中 */
  readonly pending?: boolean;
}

interface PersistedStudio {
  profile?: Partial<ImageProfile>;
  history?: readonly ImageTask[];
}

const DEFAULT_PROFILE: ImageProfile = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-image-2.5-sunburst",
  timeout: 600,
};

const DEFAULT_PARAMS: ImageGenParams = {
  size: "1024x1024",
  quality: "auto",
  n: 1,
  output_format: "png",
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

/** 写历史：配额满则按「最旧优先」丢掉任务的图片重试，图片全丢仍写不下就只保留元信息 */
function persist(profile: ImageProfile, history: readonly ImageTask[]): void {
  if (typeof window === "undefined") return;
  const tryWrite = (tasks: readonly ImageTask[]): boolean => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ profile, history: tasks }));
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
    tasks = tasks.map((t, i) => (i === oldestWithImage ? { ...t, images: [] } : t));
  }
  if (tryWrite(tasks)) return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ profile, history: tasks.map(({ images: _images, ...rest }) => rest) }));
  } catch {
    /* 配置也写不下 —— 放弃本轮持久化 */
  }
}

interface ImageStudioState {
  profile: ImageProfile;
  params: ImageGenParams;
  /** 输入框草稿 */
  prompt: string;
  /** 参考图 dataURL（走 edits 改图） */
  refImages: readonly string[];
  history: readonly ImageTask[];
  readonly busy: boolean;

  setProfile: (patch: Partial<ImageProfile>) => void;
  setParams: (patch: Partial<ImageGenParams>) => void;
  setPrompt: (v: string) => void;
  addRefImages: (dataUrls: readonly string[]) => void;
  removeRefImage: (index: number) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  removeTask: (id: number) => void;
  clearHistory: () => void;
}

export const useImageStudio = create<ImageStudioState>((set, get) => {
  const persisted = readPersisted();
  let seq = 1 + (persisted.history?.length ?? 0);

  const save = () => {
    const { profile, history } = get();
    persist(profile, history);
  };

  return {
    profile: { ...DEFAULT_PROFILE, ...persisted.profile },
    params: DEFAULT_PARAMS,
    prompt: "",
    refImages: [],
    history: persisted.history ?? [],
    busy: false,

    setProfile: (patch) => {
      const profile = { ...get().profile, ...patch };
      set({ profile });
      save();
    },
    setParams: (patch) => set((st) => ({ params: { ...st.params, ...patch } })),
    setPrompt: (prompt) => set({ prompt }),
    addRefImages: (dataUrls) =>
      set((st) => ({ refImages: [...st.refImages, ...dataUrls].slice(0, 4) })),
    removeRefImage: (index) => set((st) => ({ refImages: st.refImages.filter((_, i) => i !== index) })),

    generate: async () => {
      const { prompt, params, refImages, profile, busy } = get();
      if (busy || !prompt.trim() || !profile.apiKey.trim()) return;
      const id = seq++;
      const task: ImageTask = {
        id,
        ts: Date.now(),
        prompt: prompt.trim(),
        params: { ...params },
        refImages: refImages.length ? [...refImages] : undefined,
        images: [],
        pending: true,
      };
      set((st) => ({ history: [task, ...st.history].slice(0, MAX_TASKS), busy: true }));

      const controller = new AbortController();
      cancelCurrent = () => controller.abort();

      try {
        const result: ImageCallResult = await callImageApi(profile, {
          prompt: task.prompt,
          params: task.params,
          inputImageDataUrls: task.refImages,
          signal: controller.signal,
        });
        set((st) => ({
          history: st.history.map((t) =>
            t.id === id
              ? {
                  ...t,
                  pending: false,
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
        save();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((st) => ({
          history: st.history.map((t) => (t.id === id ? { ...t, pending: false, error: message } : t)),
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
export const FORMAT_OPTIONS: readonly ImageOutputFormat[] = ["png", "jpeg", "webp"];

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
