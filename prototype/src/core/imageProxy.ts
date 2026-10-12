/**
 * 出图代理传输层 —— 浏览器 → daemon → 供应商。
 *
 * imageApi.ts 的请求构造与响应解析全部保持原样，只把「fetch 供应商」换成
 * 「fetch daemon 的 /api/image/call」：daemon 按 profileId 注入 Authorization，
 * 并把供应商响应（含 SSE 流）原样透传回来。密钥从此不出 daemon，浏览器也
 * 不再直连供应商（CORS 之苦一并消失）。
 *
 * 响应是真正的 fetch Response：status / headers / body 流都可用，
 * imageApi 的 SSE 解析（response.body.getReader）零改动。
 */

import { DaemonClient, defaultDaemonEndpoint, httpUrlOf } from "../adapters/daemon/client.ts";

/** 信封里的表单文件（dataURL 拆成 mime + base64 两段） */
export interface ProxyFormFile {
  readonly field: string;
  readonly filename: string;
  readonly mime: string;
  readonly b64: string;
}

export interface ImageProxyCall {
  /** 谁的密钥（空串 = 不带鉴权，纯下载隧道用） */
  readonly profileId: string;
  readonly url: string;
  readonly method?: "GET" | "POST";
  /** JSON 请求体原文 */
  readonly bodyJson?: string;
  /** edits 模式的 multipart 内容（daemon 侧重组 FormData） */
  readonly form?: { readonly fields: Record<string, string>; readonly files: readonly ProxyFormFile[] };
  readonly signal?: AbortSignal;
}

/** 把 dataURL 拆成 mime + base64（不经过 Blob，省一次编解码） */
export function dataUrlParts(dataUrl: string): { mime: string; b64: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (m === null) throw new Error("参考图不是 base64 dataURL，无法走 daemon 代理");
  return { mime: m[1]!, b64: m[2]! };
}

/**
 * 经 daemon 转发一次供应商调用。返回的 Response 语义与直接 fetch 供应商相同
 * （daemon 透传 status / content-type / 流式 body）。
 */
export async function daemonImageFetch(call: ImageProxyCall): Promise<Response> {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  const token = await client.authToken().catch(() => null);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["x-awb-token"] = token;
  return fetch(`${httpUrlOf(defaultDaemonEndpoint())}/api/image/call`, {
    method: "POST",
    headers,
    cache: "no-store",
    signal: call.signal,
    body: JSON.stringify({
      profileId: call.profileId,
      url: call.url,
      method: call.method ?? "POST",
      ...(call.bodyJson !== undefined ? { bodyJson: call.bodyJson } : {}),
      ...(call.form !== undefined ? { form: call.form } : {}),
    }),
  });
}
