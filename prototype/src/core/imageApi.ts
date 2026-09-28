/**
 * OpenAI 兼容图片 API 客户端 —— 逻辑移植自 gpt_image_playground
 * （C:/Users/chenziyu/project/Agent/gpt_image_playground，MIT）。
 *
 * 移植范围是该仓库的核心链路 openaiCompatibleImageApi.ts + imageApiShared.ts：
 * - 文本生图：POST {baseUrl}/images/generations（JSON body）
 * - 参考图改图：POST {baseUrl}/images/edits（FormData，image[] 多图）
 * - 响应双解析：b64_json 直接规范化为 dataURL；url 先拉取再转 dataURL
 * - 防御式报错：优先取响应体里的 error.message，取不到再用状态码文本
 * - 超时：AbortController（默认 600s，与仓库 DEFAULT_API_TIMEOUT 一致）
 *
 * 未移植：流式 partial_images、/responses 工具模式、fal.ai、自定义 HTTP
 * 服务商映射、遮罩编辑（MaskEditor）—— 原型只需要同步生图/改图主链路。
 */

/* ----------------------------------------------------------------- 类型 */

export type ImageOutputFormat = "png" | "jpeg" | "webp";

/** 生成参数（gpt_image_playground TaskParams 的原型子集） */
export interface ImageGenParams {
  size: string;
  quality: string;
  n: number;
  output_format: ImageOutputFormat;
}

export interface ImageProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 秒 */
  timeout: number;
}

export interface ImageCallResult {
  /** dataURL 列表 */
  images: string[];
  revisedPrompts: (string | undefined)[];
  /** 服务商返回的原始 http url（b64 缺失且 url 拉取失败时兜底展示） */
  rawImageUrls: string[];
}

/* ------------------------------------------------------------- 基础工具 */

export const MIME_MAP: Record<ImageOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 规范化 baseUrl：去尾斜杠（gpt_image_playground normalizeBaseUrl 的语义） */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** b64 → dataURL（normalizeBase64Image 语义：已带前缀则原样返回） */
function normalizeBase64Image(b64: string, mime: string): string {
  const trimmed = b64.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  return `data:${mime};base64,${trimmed}`;
}

const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);
const isDataUrl = (v: unknown): v is string => typeof v === "string" && /^data:image\//i.test(v);

async function fetchImageUrlAsDataUrl(url: string, mime: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  return blobToDataUrl(blob, mime);
}

function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob.type ? blob : new Blob([blob], { type: fallbackMime }));
  });
}

/** dataURL → Blob（edits FormData 用；fetch(dataUrl) 在浏览器里同步可得） */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** 防御式错误提取（getApiErrorMessage 语义） */
async function getApiErrorMessage(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const err = parsed.error;
      if (typeof err === "string" && err.trim()) return err;
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === "string" && msg.trim()) return msg;
      }
      const msg = parsed.message;
      if (typeof msg === "string" && msg.trim()) return msg;
    } catch {
      if (text.trim().length <= 300) return text.trim();
    }
  }
  return `请求失败（HTTP ${res.status}）`;
}

/* -------------------------------------------------------------- 请求体构造 */

/**
 * 按模型族构造生成参数（paramCompatibility 的本质规则）：
 * - gpt-image*：size / quality(auto|low|medium|high) / output_format / moderation 全量支持，
 *   响应恒为 b64，不能传 response_format；
 * - dall-e-3：quality 是 standard|hd，固定三种尺寸，需要 response_format=b64_json；
 * - dall-e-2：固定方形尺寸族，需要 response_format=b64_json。
 */
function buildGenerationBody(model: string, prompt: string, params: ImageGenParams): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt };
  if (model.toLowerCase().includes("gpt-image")) {
    body.size = params.size;
    body.quality = params.quality;
    body.output_format = params.output_format;
    body.moderation = "auto";
    if (params.n > 1) body.n = params.n;
  } else if (model.toLowerCase().includes("dall-e-3")) {
    body.size = params.size;
    body.quality = params.quality === "hd" ? "hd" : "standard";
    body.response_format = "b64_json";
    if (params.n > 1) body.n = 1; // dall-e-3 只支持 n=1
  } else {
    body.size = params.size;
    body.response_format = "b64_json";
    if (params.n > 1) body.n = params.n;
  }
  return body;
}

/* ---------------------------------------------------------------- 主调用 */

interface CallOptions {
  prompt: string;
  params: ImageGenParams;
  /** 参考图 dataURL；非空走 edits 端点 */
  inputImageDataUrls?: readonly string[];
  signal?: AbortSignal;
}

/** 入口（callOpenAICompatibleImageApi 的同步子集）：有参考图走 edits，否则走 generations */
export async function callImageApi(profile: ImageProfile, opts: CallOptions): Promise<ImageCallResult> {
  const base = normalizeBaseUrl(profile.baseUrl) || "https://api.openai.com/v1";
  const mime = MIME_MAP[opts.params.output_format];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, profile.timeout) * 1000);
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  const signal = opts.signal
    ? // 外部信号与超时联动：任一触发都中止
      (anyFn ? anyFn([controller.signal, opts.signal]) : controller.signal)
    : controller.signal;

  try {
    const res = opts.inputImageDataUrls?.length
      ? await callEdit(base, profile, opts, signal)
      : await callGenerate(base, profile, opts, signal);
    if (!res.ok) throw new Error(await getApiErrorMessage(res));
    return await parseImagesApiResponse((await res.json()) as unknown, mime, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw new Error("请求已取消或超时");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function headers(profile: ImageProfile): Record<string, string> {
  return { Authorization: `Bearer ${profile.apiKey}` };
}

async function callGenerate(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(buildGenerationBody(profile.model, opts.prompt, opts.params)),
    signal,
  });
}

async function callEdit(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  signal: AbortSignal,
): Promise<Response> {
  const formData = new FormData();
  const images = opts.inputImageDataUrls ?? [];
  formData.append("model", profile.model);
  formData.append("prompt", opts.prompt);
  formData.append("size", opts.params.size);
  formData.append("n", String(Math.max(1, opts.params.n)));
  if (profile.model.toLowerCase().includes("gpt-image")) {
    formData.append("output_format", opts.params.output_format);
    formData.append("moderation", "auto");
    if (opts.params.quality !== "auto") formData.append("quality", opts.params.quality);
  }

  for (let i = 0; i < images.length; i += 1) {
    const blob = await dataUrlToBlob(images[i]!);
    const ext = blob.type.split("/")[1] || "png";
    formData.append("image[]", blob, `input-${i + 1}.${ext}`);
  }

  return fetch(`${base}/images/edits`, {
    method: "POST",
    headers: headers(profile),
    cache: "no-store",
    body: formData,
    signal,
  });
}

/* ---------------------------------------------------------------- 响应解析 */

interface ApiImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

/** parseImagesApiResponse：b64 / url 双路径，全部失败时抛出带原始 url 的错误 */
async function parseImagesApiResponse(payload: unknown, mime: string, signal?: AbortSignal): Promise<ImageCallResult> {
  const data =
    Array.isArray(payload)
      ? (payload as ApiImageData[])
      : ((payload as { data?: unknown })?.data as ApiImageData[] | undefined);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("接口没有返回图片数据 —— 请确认 baseUrl 指向 OpenAI 兼容的 /v1 端点，且模型名正确");
  }

  const images: string[] = [];
  const revisedPrompts: (string | undefined)[] = [];
  const rawImageUrls: string[] = [];

  for (const item of data) {
    if (!item) continue;
    const revised = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
    if (item.b64_json) {
      images.push(normalizeBase64Image(item.b64_json, mime));
      revisedPrompts.push(revised);
      continue;
    }
    if (isHttpUrl(item.url)) {
      rawImageUrls.push(item.url);
      images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal));
      revisedPrompts.push(revised);
      continue;
    }
    if (isDataUrl(item.url)) {
      images.push(item.url);
      revisedPrompts.push(revised);
    }
  }

  if (images.length === 0) {
    const err = new Error(
      rawImageUrls.length
        ? `图片 url 拉取失败（可能被 CORS 拦截）：${rawImageUrls.join(" , ")}`
        : "接口没有返回可识别的图片数据，请确认服务商实际返回的数据结构",
    );
    throw err;
  }

  return { images, revisedPrompts, rawImageUrls };
}
