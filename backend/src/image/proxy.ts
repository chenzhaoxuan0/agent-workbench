/**
 * 出图代理 —— 浏览器 → daemon → 供应商的单向隧道（密钥不出 daemon）。
 *
 * 浏览器不再直连供应商：请求体（JSON 或表单字段+图片）原样交给 daemon，
 * daemon 按 profileId 注入 Authorization 后转发，并把供应商响应**原样透传**
 * （状态码 / content-type / 流式 SSE 都不解释）——前端的解析逻辑（含 SSE
 * partial image）完全不用改，只是换了个 fetch 目标。顺带治愈 CORS：
 * 浏览器只跟同机 daemon 说话。
 *
 * 下载隧道（method=GET，profileId 可空）：供应商返回 http url 的图片在浏览器
 * 里 fetch 会被 CORS 拦（拿不到 blob），同样从这条隧道走。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { log } from "../log.ts";
import { resolveSecret } from "../secrets.ts";
import type { ImageProfileStore } from "./profiles.ts";

/** 信封里的表单文件（dataURL 拆出来的两段） */
interface EnvelopeFile {
  field: string;
  filename: string;
  mime: string;
  b64: string;
}

interface CallEnvelope {
  profileId?: string;
  url: string;
  method?: "GET" | "POST";
  /** JSON 请求体原文（images / responses 模式） */
  bodyJson?: string;
  /** edits 模式的 multipart 内容（daemon 侧重组 FormData） */
  form?: { fields: Record<string, string>; files: EnvelopeFile[] };
  timeoutMs?: number;
}

/** 编辑图 + 参考图都走 base64 信封，64MB 足够容纳 4 张 2MB 参考图 + 余量 */
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
/** 上游硬超时：比任何 profile.timeout（上限 3600s）再宽一点，真兜底用 */
const HARD_TIMEOUT_MS = 75 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown, allowOrigin?: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...(allowOrigin !== undefined ? { "access-control-allow-origin": allowOrigin } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-awb-token",
  });
  res.end(payload);
}

async function readEnvelope(req: IncomingMessage): Promise<CallEnvelope> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_ENVELOPE_BYTES) throw Object.assign(new Error("image call envelope too large"), { code: "bad_request" });
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CallEnvelope;
  if (typeof parsed.url !== "string" || !/^https?:\/\//i.test(parsed.url)) {
    throw Object.assign(new Error("envelope.url must be an absolute http(s) url"), { code: "bad_params" });
  }
  return parsed;
}

function isLocalOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * 注册进 httpd 的裸路由（流式响应，不走 JSON 框架）。
 * 鉴权由外层 route() 统一完成（本路由不在豁免面）。
 */
export function handleImageCall(profiles: ImageProfileStore): (req: IncomingMessage, res: ServerResponse, ctx: { url: URL }) => Promise<void> {
  return async (req, res) => {
    const allowOrigin = isLocalOrigin(req.headers.origin) ? req.headers.origin : undefined;
    let envelope: CallEnvelope;
    try {
      envelope = await readEnvelope(req);
    } catch (err: unknown) {
      sendJson(res, err instanceof Error && (err as { code?: string }).code === "bad_params" ? 400 : 500, {
        ok: false,
        error: { code: "bad_request", message: err instanceof Error ? err.message : String(err) },
      }, allowOrigin);
      return;
    }

    const method = envelope.method === "GET" ? "GET" : "POST";
    const profileId = envelope.profileId ?? "";
    let authorization: string | null = null;
    if (profileId !== "") {
      const profile = profiles.get(profileId);
      if (profile === undefined) {
        sendJson(res, 404, { ok: false, error: { code: "unknown_profile", message: `no such image profile: ${profileId}` } }, allowOrigin);
        return;
      }
      // 密钥支持 env: 引用（不想写盘的场景）—— 用时解析，缺失按未配置处理
      const key = resolveSecret(profile.apiKey);
      if (key !== "") authorization = `Bearer ${key}`;
      // 带 key 的写操作只许打向本 profile 的 baseUrl —— 否则这条路由就成了
      // 「拿别人的密钥打任意主机」的万能签名代理
      if (method === "POST" && authorization !== null) {
        const base = profile.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
        if (base !== "" && !envelope.url.toLowerCase().startsWith(`${base}/`)) {
          sendJson(res, 400, { ok: false, error: { code: "bad_request", message: `url 不在 profile ${profileId} 的 baseUrl 下，拒绝代理` } }, allowOrigin);
          return;
        }
      }
    }

    const controller = new AbortController();
    // 客户端断开（浏览器 AbortController / 页面关闭）→ 上游请求跟着取消
    const onClose = () => controller.abort();
    req.on("close", onClose);
    const hardTimer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { accept: envelope.bodyJson !== undefined || envelope.form !== undefined ? "application/json, text/event-stream" : "*/*" };
      if (authorization !== null) headers["authorization"] = authorization;

      let body: FormData | string | undefined;
      if (method === "POST") {
        if (envelope.form !== undefined) {
          const fd = new FormData();
          for (const [k, v] of Object.entries(envelope.form.fields)) fd.append(k, v);
          for (const f of envelope.form.files) {
            fd.append(f.field, new Blob([Buffer.from(f.b64, "base64")], { type: f.mime }), f.filename);
          }
          body = fd;
        } else if (envelope.bodyJson !== undefined) {
          body = envelope.bodyJson;
          headers["content-type"] = "application/json";
        }
      }

      const upstream = await fetch(envelope.url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      if (!res.writable) return; // 客户端已走，静默丢弃
      const passHeaders: Record<string, string | number> = {
        "cache-control": "no-store",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-awb-token",
        ...(allowOrigin !== undefined ? { "access-control-allow-origin": allowOrigin } : {}),
      };
      // content-type 原样透传（SSE / JSON / 图片二进制都靠它分流）；长度不抄，
      // 透传链路上它经常对不上（解压/分块）。
      const ct = upstream.headers.get("content-type");
      if (ct !== null) passHeaders["content-type"] = ct;
      res.writeHead(upstream.status, passHeaders);
      if (upstream.body === null) {
        res.end();
        return;
      }
      // 流式管道：供应商的 SSE partial image 逐块透传，不在 daemon 缓冲
      await new Promise<void>((resolve, reject) => {
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        nodeStream.on("error", reject);
        res.on("close", resolve);
        res.on("finish", resolve);
        nodeStream.pipe(res);
      });
    } catch (err: unknown) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && !res.headersSent) {
        sendJson(res, 499, { ok: false, error: { code: "client_closed", message: "请求已取消" } }, allowOrigin);
        return;
      }
      if (!res.headersSent) {
        log.warn("image proxy upstream failed", { url: envelope.url, error: err instanceof Error ? err.message : String(err) });
        sendJson(res, 502, { ok: false, error: { code: "upstream_failed", message: `供应商请求失败：${err instanceof Error ? err.message : String(err)}` } }, allowOrigin);
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(hardTimer);
      req.off("close", onClose);
    }
  };
}
