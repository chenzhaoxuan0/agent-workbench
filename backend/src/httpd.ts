/**
 * HTTP 面 —— 裸 node:http，无框架（`docs/06` §三：按最少依赖原则）。
 *
 * Phase 0 只挂 GET /healthz；后续 REST（配置与会话管理）往 ROUTES 里加，
 * 路由就是「方法 + 前缀匹配」，API 面小到不值得为它引 Fastify。
 * WS upgrade 在 wsd.ts 里借同一个 server 的 upgrade 事件。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.ts";
import { log } from "./log.ts";

export interface HealthPayload {
  readonly ok: true;
  readonly name: "agent-workbench-daemon";
  readonly version: string;
  readonly pid: number;
  readonly uptimeMs: number;
}

export function healthPayload(config: DaemonConfig, startedAt: number): HealthPayload {
  return {
    ok: true,
    name: "agent-workbench-daemon",
    version: config.version,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // 前端 dev server（5180）跨源取管理面端点；daemon 只绑回环，CORS 全开无害
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(payload);
}

export interface HttpRouteContext {
  readonly url: URL;
  /** POST/DELETE 的 JSON body；无 body 或解析失败为 null */
  readonly body: unknown;
}

export interface HttpRoute {
  readonly method: "GET" | "POST" | "DELETE";
  /** 精确路径（无通配；够用就不写路由匹配器） */
  readonly path: string;
  readonly handle: (ctx: HttpRouteContext) => unknown | Promise<unknown>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { code: "bad_request" });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function route(
  config: DaemonConfig,
  startedAt: number,
  routes: readonly HttpRoute[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  log.debug("http request", { method: req.method, path: url.pathname });

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, healthPayload(config, startedAt));
    return;
  }

  // 预检：带 JSON body 的跨源 POST/DELETE 需要
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const hit = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (hit !== undefined) {
    const body = req.method === "GET" ? null : await readBody(req);
    const result = await hit.handle({ url, body });
    sendJson(res, 200, result ?? { ok: true });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` },
  });
}

export interface HttpHandle {
  readonly server: Server;
  /** 实际绑定的端口（传 0 时由系统分配，冒烟脚本用这个） */
  readonly port: number;
}

export function startHttp(
  config: DaemonConfig,
  startedAt: number,
  routes: readonly HttpRoute[] = [],
): Promise<HttpHandle> {
  const server = createServer((req, res) => {
    void route(config, startedAt, routes, req, res).catch((err: unknown) => {
      const code = err instanceof Error && "code" in err ? String(err.code) : "internal";
      log.error("http handler failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        sendJson(res, code === "bad_request" ? 400 : 500, {
          ok: false,
          error: { code, message: err instanceof Error ? err.message : "internal error" },
        });
      } else res.destroy();
    });
  });

  // 畸形请求别掀翻 daemon
  server.on("clientError", (err, socket) => {
    log.warn("http client error", { error: err.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
