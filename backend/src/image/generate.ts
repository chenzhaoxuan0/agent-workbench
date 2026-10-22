/**
 * image.generate —— 出图流水线的 daemon 侧操作面（docs/21 P4c / ADR 0015）。
 *
 * 编排唯一源是 prototype/src/core/imageApi.ts（GUI 与 daemon 同一份代码），差异只在
 * 传输层：浏览器持不了密钥 → /api/image/call 代理（保 SSE partial 的 GUI UX）；
 * daemon 持密钥 → 直连（本模块注入的 transport，与代理同一套 baseUrl 门禁）。
 * 这是 RuntimeAdapter SPI 的同款哲学——一份编排，多个传输适配器，不是双轨。
 *
 * 落盘：<homeDir>/images/<taskId>/img-N.<ext>；任务历史：<homeDir>/image-tasks.json
 * （daemon 事实源，GUI 经 image.tasks.list 消费；读取走 GET /api/image/file）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  callImageApi,
  MIME_MAP,
  normalizeBaseUrl,
  type ImageGenParams,
  type ImageProfile,
  type ImageTransport,
  type ImageTransportCall,
} from "../../../prototype/src/core/imageApi.ts";
import type { ImageProfileStore } from "./profiles.ts";
import { resolveSecret } from "../secrets.ts";

const MAX_TASKS = 200;

export interface ImageTaskImage {
  readonly path: string;
  readonly bytes: number;
  readonly mime: string;
}

export interface ImageTask {
  readonly id: string;
  readonly at: number;
  readonly profileId: string;
  readonly prompt: string;
  readonly status: "done" | "failed";
  readonly ms: number;
  readonly images: readonly ImageTaskImage[];
  readonly revisedPrompt?: string;
  readonly error?: string;
  readonly outDir?: string;
}

export interface GenerateParams {
  profileId: string;
  prompt: string;
  params?: Partial<ImageGenParams>;
  /** 参考图本地路径（daemon 读盘 → dataURL；GUI 用 inputImageDataUrls 传浏览器文件） */
  inputImagePaths?: string[];
  inputImageDataUrls?: string[];
  /** 输出目录；缺省 <homeDir>/images/<taskId> */
  outDir?: string;
}

function extOf(mime: string): string {
  return mime.split("/")[1] ?? "png";
}

/** 假 png 之外的兜底（1x1 透明 png）——只在 mime 异常时兜住文件名 */
function taskFilePath(dir: string, i: number, mime: string): string {
  return path.join(dir, `img-${i + 1}.${extOf(mime)}`);
}

async function dataUrlToBytes(dataUrl: string): Promise<{ bytes: Buffer; mime: string }> {
  const marker = "base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) throw Object.assign(new Error("image result is not a base64 dataURL"), { code: "upstream_failed" });
  const mime = dataUrl.slice(5, idx - 1) || "image/png";
  return { bytes: Buffer.from(dataUrl.slice(idx + marker.length), "base64"), mime };
}

/** 参考图路径 → dataURL（mime 按扩展名；不存在报结构化错误） */
async function pathToDataUrl(p: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch {
    throw Object.assign(new Error(`input image not readable: ${p}`), { code: "attachment_missing", data: { path: p } });
  }
  const ext = (path.extname(p).slice(1) ?? "").toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "webp" ? "image/webp"
    : ext === "gif" ? "image/gif"
    : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export class ImageTasks {
  #tasks: ImageTask[] = [];
  readonly #file: string;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loaded = false;

  constructor(homeDir: string) {
    this.#file = path.join(homeDir, "image-tasks.json");
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as { tasks?: unknown };
      if (Array.isArray(parsed.tasks)) {
        this.#tasks = parsed.tasks
          .filter(
            (t): t is ImageTask =>
              typeof t === "object" && t !== null && typeof (t as ImageTask).id === "string" &&
              typeof (t as ImageTask).at === "number",
          )
          .slice(0, MAX_TASKS);
      }
    } catch {
      /* 无文件 / 坏文件：从零开始 */
    }
  }

  list(): readonly ImageTask[] {
    return this.#tasks;
  }

  record(task: ImageTask): void {
    this.#tasks = [task, ...this.#tasks].slice(0, MAX_TASKS);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void writeFile(this.#file, JSON.stringify({ tasks: this.#tasks }), "utf8").catch(() => undefined);
    }, 500);
  }
}

/** 直连传输（与 proxy.ts 同一套门禁）：带 key 的 POST 只许打向本 profile 的 baseUrl */
function directTransport(profile: ImageProfile, apiKey: string): ImageTransport {
  const base = normalizeBaseUrl(profile.baseUrl).toLowerCase();
  return async (call: ImageTransportCall) => {
    const headers: Record<string, string> = {
      accept: call.bodyJson !== undefined || call.form !== undefined ? "application/json, text/event-stream" : "*/*",
    };
    if (apiKey !== "") headers["authorization"] = `Bearer ${apiKey}`;
    if (call.method === "POST" && apiKey !== "" && base !== "" && !call.url.toLowerCase().startsWith(`${base}/`)) {
      throw Object.assign(new Error(`url 不在 profile ${profile.id} 的 baseUrl 下，拒绝直连`), { code: "bad_request" });
    }
    let body: FormData | string | undefined;
    if (call.method === "POST") {
      if (call.form !== undefined) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(call.form.fields)) fd.append(k, v);
        for (const f of call.form.files) {
          fd.append(f.field, new Blob([Buffer.from(f.b64, "base64")], { type: f.mime }), f.filename);
        }
        body = fd;
      } else if (call.bodyJson !== undefined) {
        body = call.bodyJson;
        headers["content-type"] = "application/json";
      }
    }
    return fetch(call.url, {
      method: call.method ?? "POST",
      headers,
      body,
      signal: call.signal,
      redirect: "manual",
    });
  };
}

const DEFAULT_PARAMS: ImageGenParams = {
  size: "auto",
  quality: "auto",
  n: 1,
  output_format: "png",
  output_compression: null,
  moderation: "auto",
  transparent_output: false,
};

export async function generateImage(
  deps: { profiles: ImageProfileStore; tasks: ImageTasks; homeDir: string },
  p: GenerateParams,
): Promise<ImageTask> {
  const row = deps.profiles.get(p.profileId);
  if (row === undefined) {
    throw Object.assign(new Error(`no such image profile: ${p.profileId}`), { code: "unknown_profile" });
  }
  const apiKey = resolveSecret(row.apiKey);
  if (apiKey === "") {
    throw Object.assign(new Error(`profile ${p.profileId} 未配置密钥`), { code: "no_api_key" });
  }
  const profile: ImageProfile = { ...row, apiKey };
  const inputs = [
    ...(p.inputImageDataUrls ?? []),
    ...(await Promise.all((p.inputImagePaths ?? []).map((x) => pathToDataUrl(x)))),
  ];
  const taskId = `img_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const outDir = p.outDir !== undefined && p.outDir !== "" ? p.outDir : path.join(deps.homeDir, "images", taskId);
  const started = Date.now();

  try {
    const result = await callImageApi(profile, {
      prompt: p.prompt,
      params: { ...DEFAULT_PARAMS, ...(p.params ?? {}) },
      inputImageDataUrls: inputs,
      transport: directTransport(profile, apiKey),
    });
    const images: ImageTaskImage[] = [];
    await mkdir(outDir, { recursive: true });
    for (let i = 0; i < result.images.length; i++) {
      const dataUrl = result.images[i] ?? "";
      const { bytes, mime } = await dataUrlToBytes(dataUrl);
      const filePath = taskFilePath(outDir, i, mime);
      await writeFile(filePath, bytes);
      images.push({ path: filePath, bytes: bytes.byteLength, mime });
    }
    const task: ImageTask = {
      id: taskId,
      at: started,
      profileId: p.profileId,
      prompt: p.prompt,
      status: "done",
      ms: Date.now() - started,
      images,
      revisedPrompt: result.revisedPrompts.find((x) => x !== undefined),
      outDir,
    };
    deps.tasks.record(task);
    return task;
  } catch (err: unknown) {
    const task: ImageTask = {
      id: taskId,
      at: started,
      profileId: p.profileId,
      prompt: p.prompt,
      status: "failed",
      ms: Date.now() - started,
      images: [],
      error: err instanceof Error ? err.message : String(err),
    };
    deps.tasks.record(task);
    throw err;
  }
}
