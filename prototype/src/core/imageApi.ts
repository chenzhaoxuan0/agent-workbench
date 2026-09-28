/**
 * OpenAI 兼容图片 API 客户端 —— 逻辑移植自 gpt_image_playground
 * （C:/Users/chenziyu/project/Agent/gpt_image_playground，MIT）。
 *
 * 移植范围对齐该仓库的 openaiCompatibleImageApi.ts + imageApiShared.ts +
 * serverSentEvents.ts 主链路：
 * - images 模式：POST {baseUrl}/images/generations（JSON）/ images/edits（FormData）
 * - responses 模式：POST {baseUrl}/responses（tools: image_generation，含参考图 input_image）
 * - 流式：stream=true + partial_images，SSE 解析 partial_image / completed 事件
 * - 响应双解析：b64_json / url → dataURL；防御式报错（error.message 优先，
 *   附流式不支持 / 透明背景不支持等 hint，与仓库文案一致）
 * - codexCli：丢弃 size/quality 参数，把尺寸写成 prompt 前缀（prependCodexCliSizePrompt）
 * - 透明背景：api 方法 = background: transparent（gpt-image 原生参数）
 * - 超时：AbortController（profile.timeout 秒）
 *
 * 未移植（原型不需要，接真时再补）：fal.ai 供应商族、自定义 HTTP 服务商映射、
 * 透明背景 local 方法（canvas 抠图后处理）、遮罩编辑。
 */

/* ----------------------------------------------------------------- 类型 */

export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ApiMode = "images" | "responses";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** 生成参数（gpt_image_playground TaskParams 的移植） */
export interface ImageGenParams {
  size: string;
  quality: string;
  n: number;
  output_format: ImageOutputFormat;
  /** 0–100；仅非 png 格式下发 */
  output_compression: number | null;
  moderation: "auto" | "low";
  /** 原生透明背景（gpt-image 的 background 参数） */
  transparent_output: boolean;
}

/** ApiProfile —— 对齐 gpt_image_playground types.ts 的同名接口（去掉未移植族） */
export interface ImageProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** responses 模式下的专职图像模型（gpt-5.x + image_generation 工具时用） */
  imageGenerationModel?: string;
  /** 秒 */
  timeout: number;
  apiMode: ApiMode;
  reasoningEffort?: ReasoningEffort;
  /** codex CLI 中转：不支持 size/quality 参数，尺寸写成 prompt 前缀 */
  codexCli: boolean;
  /** dall-e 族需要 response_format=b64_json */
  responseFormatB64Json?: boolean;
  /** 流式传输（SSE partial images） */
  streamImages?: boolean;
  /** 0–3 */
  streamPartialImages?: number;
  /** 透明背景实现方式：api=原生参数；local=本地后处理（未移植，暂同 api） */
  transparentBackgroundMethod: "api" | "local";
}

export interface ImageCallResult {
  /** dataURL 列表 */
  images: string[];
  revisedPrompts: (string | undefined)[];
  /** 服务商返回的原始 http url（b64 缺失且 url 拉取失败时兜底展示） */
  rawImageUrls: string[];
}

export interface PartialImageEvent {
  image: string;
  partialImageIndex?: number;
}

/* ------------------------------------------------------------- 基础工具 */

export const MIME_MAP: Record<ImageOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** PROMPT_REWRITE_GUARD_PREFIX（imageApiShared.ts 原文） */
const PROMPT_REWRITE_GUARD_PREFIX =
  "Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:";

/** 规范化 baseUrl：去尾斜杠 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

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

/* ---------------------------------------------------- hint 文案（imageApiShared 原文） */

const STREAMING_FORMAT_HINT = "提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。";
const TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT =
  "提示：当前使用的 API 不支持为该模型使用原生透明背景，请将「透明背景实现方式」切换为「本地后处理」。";

function maybeAppendTransparentBackgroundHint(message: string): string {
  if (!/transparent background is not supported for this model\.?/i.test(message)) return message;
  return `${message}\n${TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT}`;
}

function maybeAppendStreamingHint(message: string, status: number, streamImages?: boolean): string {
  const transparentMessage = maybeAppendTransparentBackgroundHint(message);
  if (transparentMessage !== message) return transparentMessage;
  if (!streamImages) return message;
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return message;
  }
  return `${message}\n提示：当前使用的 API 可能不支持流式传输，请尝试关闭「流式传输」功能。`;
}

/* -------------------------------------------------------------- 请求体构造 */

/** codexCli：尺寸写成 prompt 前缀（prependCodexCliSizePrompt 原文） */
function prependCodexCliSizePrompt(prompt: string, size: string): string {
  if (size === "auto") return prompt;
  const trimmed = prompt.trimStart();
  const hint = `Generate at ${size} resolution.`;
  if (trimmed.startsWith(hint)) return trimmed;
  return `${hint} ${trimmed}`;
}

/**
 * 按模型族构造生成参数（paramCompatibility 的本质规则）：
 * - gpt-image*：size / quality / output_format / moderation / background 全量支持，
 *   响应恒为 b64，不能传 response_format；
 * - dall-e-3：quality 是 standard|hd，固定三种尺寸，需要 response_format=b64_json；
 * - dall-e-2：固定方形尺寸族，需要 response_format=b64_json。
 * codexCli 例外：丢弃 size/quality，尺寸走 prompt 前缀。
 */
function buildGenerationBody(model: string, prompt: string, params: ImageGenParams, profile: ImageProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt };
  const m = model.toLowerCase();
  if (profile.codexCli) {
    if (profile.responseFormatB64Json) body.response_format = "b64_json";
    return body;
  }
  if (m.includes("gpt-image")) {
    body.size = params.size;
    body.quality = params.quality;
    body.output_format = params.output_format;
    body.moderation = params.moderation;
    if (params.transparent_output) body.background = "transparent";
    if (params.output_format !== "png" && params.output_compression != null) {
      body.output_compression = params.output_compression;
    }
    if (params.n > 1) body.n = params.n;
  } else if (m.includes("dall-e-3")) {
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

/* ---------------------------------------------------------------- SSE 解析 */

/** readJsonServerSentEvents 移植：逐块读 data: 行，JSON 解析后回调 */
async function readServerSentEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  opts: { signal?: AbortSignal; formatErrorMessage?: (raw: string) => string },
): Promise<void> {
  if (!response.body) throw new Error("接口未返回可读取的流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  const processBlock = (block: string) => {
    // 只处理含 data: 行的块（SSE 注释/空行跳过）
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data) return;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error(opts.formatErrorMessage?.(data) ?? data);
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    throwIfAborted();
    onEvent(event as Record<string, unknown>);
  };

  try {
    while (true) {
      throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) processBlock(block);
    }
    if (buffer.trim()) processBlock(buffer);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error;
  if (error && typeof error === "object") {
    const message = getStringValue(error as Record<string, unknown>, "message");
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  const type = getStringValue(event, "type");
  if (type?.endsWith(".failed")) {
    return getStringValue(event, "message") ?? "流式请求失败";
  }
  return null;
}

/* --------------------------------------------------------- responses 模式构造 */

function createResponsesImageTool(
  params: ImageGenParams,
  isEdit: boolean,
  profile: ImageProfile,
  maskDataUrl?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    action: isEdit ? "edit" : "generate",
    output_format: params.output_format,
    moderation: params.moderation,
  };
  const imageModel = profile.imageGenerationModel?.trim();
  if (imageModel) tool.model = imageModel;
  if (!profile.codexCli) tool.size = params.size;
  if (profile.streamImages) tool.partial_images = Math.min(3, Math.max(0, profile.streamPartialImages ?? 0));
  if (!profile.codexCli) tool.quality = params.quality;
  if (params.output_format !== "png" && params.output_compression != null) {
    tool.output_compression = params.output_compression;
  }
  if (params.transparent_output) tool.background = "transparent";
  if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl };
  return tool;
}

function createResponsesInput(prompt: string, inputImageDataUrls: readonly string[]): unknown {
  if (!inputImageDataUrls.length) return prompt;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...inputImageDataUrls.map((dataUrl) => ({ type: "input_image", image_url: dataUrl })),
      ],
    },
  ];
}

/** responses 输出里的 result：b64 字符串或 {b64_json}/{url} 结构 */
function getResponsesImageResultBase64(result: unknown): string | undefined {
  if (typeof result === "string" && result.trim()) return result;
  if (result && typeof result === "object") {
    const b64 = (result as Record<string, unknown>).b64_json;
    if (typeof b64 === "string" && b64.trim()) return b64;
  }
  return undefined;
}

interface ResponsesOutputItem {
  type?: string;
  result?: unknown;
  revised_prompt?: string;
}

function parseResponsesImageResults(
  payload: { output?: unknown },
  mime: string,
): Array<{ image: string; revisedPrompt?: string }> {
  const output = payload.output;
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error("接口未返回图片数据");
  }
  const results: Array<{ image: string; revisedPrompt?: string }> = [];
  for (const item of output as ResponsesOutputItem[]) {
    if (item?.type !== "image_generation_call") continue;
    const b64 = getResponsesImageResultBase64(item.result);
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, mime),
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      });
    }
  }
  if (!results.length) {
    throw new Error(
      "接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构（中转/兼容接口请确认支持 image_generation 工具）",
    );
  }
  return results;
}

/* ---------------------------------------------------------------- 主调用 */

interface CallOptions {
  prompt: string;
  params: ImageGenParams;
  /** 参考图 dataURL；非空走 edits / responses edit */
  inputImageDataUrls?: readonly string[];
  signal?: AbortSignal;
  /** 流式 partial image 回调（images / responses 模式均支持） */
  onPartialImage?: (partial: PartialImageEvent) => void;
}

/** 入口（callOpenAICompatibleImageApi 的移植）：images / responses 双模式 */
export async function callImageApi(profile: ImageProfile, opts: CallOptions): Promise<ImageCallResult> {
  const base = normalizeBaseUrl(profile.baseUrl) || "https://api.openai.com/v1";
  const mime = MIME_MAP[opts.params.output_format];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, profile.timeout) * 1000);
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  const signal = opts.signal ? (anyFn ? anyFn([controller.signal, opts.signal]) : controller.signal) : controller.signal;

  try {
    const result =
      profile.apiMode === "responses"
        ? await callResponsesImageApi(base, profile, opts, mime, signal)
        : await callImagesApi(base, profile, opts, mime, signal);
    return result;
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

/* ------------------------------------------------------------ images 模式 */

async function callImagesApi(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  mime: string,
  signal: AbortSignal,
): Promise<ImageCallResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1;
  // codexCli 或（流式 + 多张）→ 拆成并发单张（callImagesApiConcurrent 语义）
  if ((profile.codexCli || (profile.streamImages && n > 1)) && n > 1) {
    const results = await Promise.allSettled(
      Array.from({ length: n }).map(() =>
        callImagesApiSingle(base, profile, { ...opts, params: { ...opts.params, n: 1 } }, mime, signal),
      ),
    );
    return mergeConcurrentApiResults(results);
  }
  return callImagesApiSingle(base, profile, opts, mime, signal);
}

async function callImagesApiSingle(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  mime: string,
  signal: AbortSignal,
): Promise<ImageCallResult> {
  const isEdit = (opts.inputImageDataUrls?.length ?? 0) > 0;
  const sizePrompt = profile.codexCli ? prependCodexCliSizePrompt(opts.prompt, opts.params.size) : opts.prompt;
  const partialImages = Math.min(3, Math.max(0, profile.streamPartialImages ?? 0));

  let response: Response;
  if (isEdit) {
    const formData = new FormData();
    const images = opts.inputImageDataUrls ?? [];
    formData.append("model", profile.model);
    formData.append("prompt", sizePrompt);
    if (!profile.codexCli) formData.append("size", opts.params.size);
    if (!profile.codexCli) formData.append("quality", opts.params.quality);
    formData.append("output_format", opts.params.output_format);
    formData.append("moderation", opts.params.moderation);
    if (opts.params.transparent_output) formData.append("background", "transparent");
    if (opts.params.output_format !== "png" && opts.params.output_compression != null) {
      formData.append("output_compression", String(opts.params.output_compression));
    }
    if (opts.params.n > 1) formData.append("n", String(opts.params.n));
    if (profile.responseFormatB64Json) formData.append("response_format", "b64_json");
    if (profile.streamImages) {
      formData.append("stream", "true");
      formData.append("partial_images", String(partialImages));
    }
    for (let i = 0; i < images.length; i += 1) {
      const blob = await dataUrlToBlob(images[i]!);
      const ext = blob.type.split("/")[1] || "png";
      formData.append("image[]", blob, `input-${i + 1}.${ext}`);
    }
    response = await fetch(`${base}/images/edits`, { method: "POST", headers: headers(profile), cache: "no-store", body: formData, signal });
  } else {
    const body = buildGenerationBody(profile.model, sizePrompt, opts.params, profile);
    if (profile.streamImages) {
      body.stream = true;
      body.partial_images = partialImages;
    }
    response = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...headers(profile), "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
      signal,
    });
  }

  if (!response.ok) {
    const errorMessage = await getApiErrorMessage(response);
    throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages));
  }

  if (profile.streamImages && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return parseImagesApiStreamResponse(response, mime, opts.onPartialImage, signal);
  }
  return parseImagesApiResponse(await response.json(), mime, signal);
}

interface ApiImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

/** parseImagesApiResponse：b64 / url 双路径 */
async function parseImagesApiResponse(payload: unknown, mime: string, signal?: AbortSignal): Promise<ImageCallResult> {
  const data = Array.isArray(payload) ? (payload as ApiImageData[]) : ((payload as { data?: unknown })?.data as ApiImageData[] | undefined);

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
    throw new Error(
      rawImageUrls.length
        ? `图片 url 拉取失败（可能被 CORS 拦截）：${rawImageUrls.join(" , ")}`
        : "接口没有返回可识别的图片数据，请确认服务商实际返回的数据结构",
    );
  }
  return { images, revisedPrompts, rawImageUrls };
}

/** parseImagesApiStreamResponse：partial_image 事件回调 + 最终结果 */
async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallOptions["onPartialImage"],
  signal?: AbortSignal,
): Promise<ImageCallResult> {
  const completedItems: ApiImageData[] = [];
  let resultPayload: unknown = null;

  await readServerSentEvents(
    response,
    (event) => {
      const type = getStringValue(event, "type");
      if (type === "image_generation.partial_image" || type === "image_edit.partial_image") {
        const b64 = getStringValue(event, "b64_json");
        if (b64) {
          onPartialImage?.({
            image: normalizeBase64Image(b64, mime),
            partialImageIndex: getNumberValue(event, "partial_image_index"),
          });
        }
        return;
      }
      if (getStringValue(event, "object") === "image.generation.result" || getStringValue(event, "object") === "image.edit.result") {
        resultPayload = event;
        return;
      }
      if (type === "image_generation.completed" || type === "image_edit.completed") {
        completedItems.push({
          b64_json: getStringValue(event, "b64_json"),
          url: getStringValue(event, "url"),
          revised_prompt: getStringValue(event, "revised_prompt"),
        });
      }
    },
    { signal, formatErrorMessage: () => STREAMING_FORMAT_HINT },
  );

  if (resultPayload) return parseImagesApiResponse(resultPayload, mime, signal);
  if (!completedItems.length) throw new Error("流式接口未返回最终图片数据");

  const images: string[] = [];
  const revisedPrompts: (string | undefined)[] = [];
  const rawImageUrls: string[] = [];
  for (const item of completedItems) {
    const revised = item.revised_prompt;
    if (item.b64_json) {
      images.push(normalizeBase64Image(item.b64_json, mime));
      revisedPrompts.push(revised);
      continue;
    }
    if (isHttpUrl(item.url) || isDataUrl(item.url)) {
      if (isHttpUrl(item.url)) rawImageUrls.push(item.url);
      images.push(await fetchImageUrlAsDataUrl(item.url!, mime, signal));
      revisedPrompts.push(revised);
    }
  }
  if (!images.length) throw new Error("流式接口未返回可用图片数据");
  return { images, revisedPrompts, rawImageUrls };
}

/* --------------------------------------------------------- responses 模式 */

async function callResponsesImageApi(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  mime: string,
  signal: AbortSignal,
): Promise<ImageCallResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1;
  if (n > 1) {
    const results = await Promise.allSettled(
      Array.from({ length: n }).map(() => callResponsesImageApiSingle(base, profile, { ...opts, params: { ...opts.params, n: 1 } }, mime, signal)),
    );
    return mergeConcurrentApiResults(results);
  }
  return callResponsesImageApiSingle(base, profile, opts, mime, signal);
}

async function callResponsesImageApiSingle(
  base: string,
  profile: ImageProfile,
  opts: CallOptions,
  mime: string,
  signal: AbortSignal,
): Promise<ImageCallResult> {
  const requestPrompt = profile.codexCli ? prependCodexCliSizePrompt(opts.prompt, opts.params.size) : opts.prompt;
  const inputImageDataUrls = opts.inputImageDataUrls ?? [];

  const body: Record<string, unknown> = {
    model: profile.model,
    input: createResponsesInput(requestPrompt, inputImageDataUrls),
    tools: [createResponsesImageTool(opts.params, inputImageDataUrls.length > 0, profile)],
    tool_choice: "required",
  };
  if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort };
  if (profile.streamImages) body.stream = true;

  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorMessage = await getApiErrorMessage(response);
    throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages));
  }

  if (profile.streamImages && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return parseResponsesApiStreamResponse(response, mime, opts.onPartialImage);
  }

  const payload = (await response.json()) as { output?: unknown };
  const imageResults = parseResponsesImageResults(payload, mime);
  return {
    images: imageResults.map((r) => r.image),
    revisedPrompts: imageResults.map((r) => r.revisedPrompt),
    rawImageUrls: [],
  };
}

/** parseResponsesApiStreamResponse：partial_image_b64 / output_item.done / response.completed */
async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallOptions["onPartialImage"],
): Promise<ImageCallResult> {
  const outputItems: ResponsesOutputItem[] = [];
  let completedPayload: { output?: unknown } | null = null;

  await readServerSentEvents(
    response,
    (event) => {
      const type = getStringValue(event, "type");
      if (type === "response.image_generation_call.partial_image") {
        const b64 = getStringValue(event, "partial_image_b64");
        if (b64) {
          onPartialImage?.({ image: normalizeBase64Image(b64, mime), partialImageIndex: getNumberValue(event, "partial_image_index") });
        }
        return;
      }
      const payload = getResponsesStreamPayload(event);
      if (!payload) return;
      if (type === "response.output_item.done" && Array.isArray(payload.output)) {
        outputItems.push(...(payload.output as ResponsesOutputItem[]));
        return;
      }
      completedPayload = payload;
    },
    { formatErrorMessage: () => STREAMING_FORMAT_HINT },
  );

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null);
  if (!payload) throw new Error("流式接口未返回最终图片数据");

  let imageResults: Array<{ image: string; revisedPrompt?: string }>;
  try {
    imageResults = parseResponsesImageResults(payload, mime);
  } catch (err) {
    const collected = outputItems.filter((item) => getResponsesImageResultBase64(item.result));
    if (collected.length === 0) throw err;
    imageResults = parseResponsesImageResults({ output: collected }, mime);
  }
  return {
    images: imageResults.map((r) => r.image),
    revisedPrompts: imageResults.map((r) => r.revisedPrompt),
    rawImageUrls: [],
  };
}

function getResponsesStreamPayload(event: Record<string, unknown>): { output?: unknown } | null {
  const response = event.response;
  if (response && typeof response === "object") return response as { output?: unknown };
  const item = event.item;
  if (item && typeof item === "object" && (item as ResponsesOutputItem).type === "image_generation_call") {
    return { output: [item] };
  }
  return null;
}

/* ------------------------------------------------------------- 并发合并 */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** mergeConcurrentApiResults：全败抛首个错误；部分失败在结果里带上失败清单 */
function mergeConcurrentApiResults(results: PromiseSettledResult<ImageCallResult>[]): ImageCallResult {
  const ok = results.filter((r): r is PromiseFulfilledResult<ImageCallResult> => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    throw firstError.reason;
  }
  const images = ok.flatMap((r) => r.images);
  const revisedPrompts = ok.flatMap((r) => (r.revisedPrompts.length ? r.revisedPrompts : r.images.map(() => undefined)));
  const rawImageUrls = ok.flatMap((r) => r.rawImageUrls);
  const failedRequests = results.flatMap((r, i) => (r.status === "rejected" ? [{ requestIndex: i, error: errorMessage(r.reason) }] : []));
  return {
    images,
    revisedPrompts,
    rawImageUrls,
    ...(failedRequests.length ? { failedRequests } : {}),
  } as ImageCallResult & { failedRequests: { requestIndex: number; error: string }[] };
}
