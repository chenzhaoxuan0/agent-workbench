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
  });
  res.end(payload);
}

async function route(
  config: DaemonConfig,
  startedAt: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  log.debug("http request", { method: req.method, path: url.pathname });

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, healthPayload(config, startedAt));
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

export function startHttp(config: DaemonConfig, startedAt: number): Promise<HttpHandle> {
  const server = createServer((req, res) => {
    void route(config, startedAt, req, res).catch((err: unknown) => {
      log.error("http handler crashed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
      else res.destroy();
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
