/**
 * WS 面 —— 事件流出 + 方法调用的唯一通道，帧形态见 docs/07-wire-protocol.md（v1）。
 *
 *   client → daemon : { v:1, id:string, method:string, params?:unknown }
 *   daemon → client : { v:1, id:string, ok:true, result }        （对 request 的响应）
 *                   | { v:1, id:string, ok:false, error:{code,message} }
 *                   | { v:1, type:"hello", daemon:{…} }          （连上即推）
 *                   | { v:1, type:"event", event:RuntimeEvent }  （Phase 1 起的数据流）
 *
 * id 解析不出来的帧回 id:null 的错误帧，这是唯一允许 null id 的场景。
 */

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeEvent } from "./contract.ts";
import type { DaemonConfig } from "./config.ts";
import { log } from "./log.ts";

export const WIRE_VERSION = 1 as const;

// ---- daemon → client ------------------------------------------------------

export interface HelloFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "hello";
  readonly daemon: {
    readonly version: string;
    readonly pid: number;
    readonly uptimeMs: number;
  };
}

export interface EventFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "event";
  readonly event: RuntimeEvent;
}

/** 终端数据帧 —— 高频且非契约事件，独立于 event 流（docs/07 §二） */
export interface TerminalFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "terminal";
  readonly terminalId: string;
  readonly kind: "data" | "exit";
  readonly data?: string;
  readonly exitCode?: number;
}

export type ResponseFrame =
  | { readonly v: typeof WIRE_VERSION; readonly id: string | null; readonly ok: true; readonly result: unknown }
  | {
      readonly v: typeof WIRE_VERSION;
      readonly id: string | null;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

// ---- daemon ← client ------------------------------------------------------

export interface RequestFrame {
  readonly v: typeof WIRE_VERSION;
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

// ---- 方法注册表 -----------------------------------------------------------

type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

const methods = new Map<string, RpcHandler>();

/** 注册一个 client 可调用的方法。同名注册是编程错误，直接掀桌。 */
export function registerMethod(name: string, handler: RpcHandler): void {
  if (methods.has(name)) throw new Error(`rpc method already registered: ${name}`);
  methods.set(name, handler);
}

// ---- 服务器 ---------------------------------------------------------------

export function attachWs(
  server: Server,
  opts: { config: DaemonConfig; startedAt: number },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    log.info("ws client connected", { clients: clients.size });

    const hello: HelloFrame = {
      v: WIRE_VERSION,
      type: "hello",
      daemon: {
        version: opts.config.version,
        pid: process.pid,
        uptimeMs: Date.now() - opts.startedAt,
      },
    };
    ws.send(JSON.stringify(hello));

    ws.on("message", (data) => handleRaw(ws, data));
    ws.on("close", () => {
      clients.delete(ws);
      log.info("ws client closed", { clients: clients.size });
    });
    ws.on("error", (err) => log.warn("ws client error", { error: err.message }));
  });

  return wss;
}

function send(ws: WebSocket, frame: HelloFrame | EventFrame | TerminalFrame | ResponseFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** 向所有在线客户端广播一条终端帧（data 高频，无订阅者就丢弃） */
export function broadcastTerminal(wss: WebSocketServer, frame: TerminalFrame): void {
  const payload = JSON.stringify(frame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function handleRaw(ws: WebSocket, data: unknown): void {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    send(ws, {
      v: WIRE_VERSION,
      id: null,
      ok: false,
      error: { code: "bad_frame", message: "frame is not valid JSON" },
    });
    return;
  }

  const f = frame as Partial<RequestFrame> | null;
  if (
    f === null ||
    typeof f !== "object" ||
    f.v !== WIRE_VERSION ||
    typeof f.id !== "string" ||
    typeof f.method !== "string"
  ) {
    send(ws, {
      v: WIRE_VERSION,
      id: null,
      ok: false,
      error: { code: "bad_frame", message: `expected { v:${WIRE_VERSION}, id:string, method:string, params? }` },
    });
    return;
  }

  const handler = methods.get(f.method);
  if (handler === undefined) {
    send(ws, {
      v: WIRE_VERSION,
      id: f.id,
      ok: false,
      error: { code: "unknown_method", message: `no such method: ${f.method}` },
    });
    return;
  }

  const method: string = f.method;
  const id: string = f.id;
  void Promise.resolve()
    .then(() => handler(f.params))
    .then(
      (result) => send(ws, { v: WIRE_VERSION, id, ok: true, result: result ?? null }),
      (err: unknown) =>
        send(ws, {
          v: WIRE_VERSION,
          id,
          ok: false,
          error: {
            code: err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "internal",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
    );
}

/**
 * 向所有在线客户端广播一条 RuntimeEvent —— Phase 1 事件流的唯一出口。
 * 一个客户端都没有就丢弃：daemon 不为订阅者攒历史（历史 = 落盘的轨迹，不是内存队列）。
 */
export function broadcastEvent(wss: WebSocketServer, event: RuntimeEvent): void {
  const frame = JSON.stringify({ v: WIRE_VERSION, type: "event", event } satisfies EventFrame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
}
