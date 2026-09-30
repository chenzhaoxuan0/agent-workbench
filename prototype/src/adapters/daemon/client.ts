/**
 * daemon WS 客户端 —— 前端到 Runtime Host 的唯一长连接（docs/07 线上协议 v1）。
 *
 * 每 endpoint 一个单例：daemon 对所有客户端广播全部执行器的事件，
 * 各适配器实例在适配器层按「本实例创建的会话」过滤。管理面 REST 不走这里。
 *
 * 帧形态：
 *   client → daemon : { v:1, id, method, params? }
 *   daemon → client : { v:1, id, ok, result|error } | { v:1, type:"hello",… }
 *                   | { v:1, type:"event", seq, event: RuntimeEvent }
 *                   | { v:1, type:"terminal", … }（终端页签接入时再消费）
 *
 * 断线重放（docs/08 WP-2）：每个会话的 seq 在此记账；重连成功后触发 resync 监听器，
 * 由适配器层按会话调 session.events.since 补拉缺口（去重在适配器侧按 seq 判）。
 */

import type { RuntimeCapabilities } from "../../core/adapter.ts";
import type { RuntimeEvent } from "../../core/events.ts";

export interface DaemonExecutorInfo {
  readonly id: string;
  readonly displayName: string;
  readonly glyph: string;
  readonly models: readonly { id: string; displayName: string }[];
  readonly capabilities: RuntimeCapabilities;
}

export const DEFAULT_DAEMON_ENDPOINT = "http://127.0.0.1:5181";

export function wsUrlOf(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;
}

export interface DaemonTerminalFrame {
  readonly terminalId: string;
  readonly kind: "data" | "exit";
  readonly data?: string;
  readonly exitCode?: number;
}

export class DaemonClient {
  readonly #endpoint: string;
  #ws: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #eventListeners = new Set<(e: RuntimeEvent, seq?: number) => void>();
  readonly #resyncListeners = new Set<() => void>();
  readonly #terminalListeners = new Set<(f: DaemonTerminalFrame) => void>();
  /** 每会话已见最大 seq（WP-2）：重连补拉的游标来源 */
  readonly #lastSeq = new Map<string, number>();
  #seq = 0;
  #everConnected = false;

  private constructor(endpoint: string) {
    this.#endpoint = endpoint;
  }

  static readonly #instances = new Map<string, DaemonClient>();

  static get(endpoint: string): DaemonClient {
    let c = this.#instances.get(endpoint);
    if (!c) {
      c = new DaemonClient(endpoint);
      this.#instances.set(endpoint, c);
    }
    return c;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  async ensureConnected(timeoutMs = 8000): Promise<void> {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) return;
    if (this.#connecting !== null) return this.#connecting;

    this.#connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrlOf(this.#endpoint));
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`daemon ${this.#endpoint} 连接超时`), { code: "daemon_connect_timeout" }));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        // hello 帧随后来不及等也无所谓：rpc 会自然排队
        clearTimeout(timer);
        this.#ws = ws;
        const isReconnect = this.#everConnected;
        this.#everConnected = true;
        resolve();
        // 重连（非首连）成功 → 通知适配器按 seq 补拉断线窗口内的事件
        if (isReconnect) {
          for (const fn of this.#resyncListeners) fn();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        if (this.#connecting !== null) {
          this.#connecting = null;
          reject(Object.assign(new Error(`daemon ${this.#endpoint} 连接失败（daemon 没起？）`), { code: "daemon_unreachable" }));
        }
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame["type"] === "event") {
          const event = frame["event"] as RuntimeEvent;
          const seq = typeof frame["seq"] === "number" ? frame["seq"] : undefined;
          if (seq !== undefined && event.sessionId !== undefined) {
            const prev = this.#lastSeq.get(event.sessionId) ?? 0;
            if (seq > prev) this.#lastSeq.set(event.sessionId, seq);
          }
          for (const fn of this.#eventListeners) fn(event, seq);
          return;
        }
        if (frame["type"] === "terminal") {
          const tf = frame as unknown as DaemonTerminalFrame;
          for (const fn of this.#terminalListeners) fn(tf);
          return;
        }
        // hello 与其他帧此处不消费
        if (frame["id"] !== undefined && frame["id"] !== null && (frame["ok"] !== undefined || frame["error"] !== undefined)) {
          const key = String(frame["id"]);
          const p = this.#pending.get(key);
          if (!p) return;
          this.#pending.delete(key);
          clearTimeout(p.timer);
          if (frame["ok"] === true) p.resolve(frame["result"]);
          else {
            const err = frame["error"] as { code?: string; message?: string } | undefined;
            p.reject(Object.assign(new Error(err?.message ?? "daemon rpc failed"), { code: err?.code ?? "daemon_error" }));
          }
        }
      });
      ws.addEventListener("close", () => {
        this.#ws = null;
        // 挂起的 rpc 全部失败：调用方据此感知断线
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error("daemon 连接已断开"), { code: "daemon_disconnected" }));
        }
        this.#pending.clear();
      });
    }).finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }

  rpc<T = unknown>(method: string, params: unknown, timeoutMs = 300_000): Promise<T> {
    return this.ensureConnected().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const ws = this.#ws;
          if (ws === null || ws.readyState !== WebSocket.OPEN) {
            reject(Object.assign(new Error("daemon 未连接"), { code: "daemon_unreachable" }));
            return;
          }
          const id = `c-${++this.#seq}`;
          const timer = setTimeout(() => {
            this.#pending.delete(id);
            reject(Object.assign(new Error(`${method} 超时（${timeoutMs}ms）`), { code: "daemon_rpc_timeout" }));
          }, timeoutMs);
          this.#pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
          ws.send(JSON.stringify({ v: 1, id, method, params }));
        }),
    );
  }

  onEvent(fn: (e: RuntimeEvent, seq?: number) => void): () => void {
    this.#eventListeners.add(fn);
    return () => this.#eventListeners.delete(fn);
  }

  /** 重连成功（非首连）时触发——适配器在此按会话 seq 补拉缺口 */
  onResync(fn: () => void): () => void {
    this.#resyncListeners.add(fn);
    return () => this.#resyncListeners.delete(fn);
  }

  /** 某会话已见的最大 seq（没有收到过带 seq 的帧则为 0） */
  lastSeqOf(sessionId: string): number {
    return this.#lastSeq.get(sessionId) ?? 0;
  }

  /** 终端数据帧（terminal.create 之后到达；按 terminalId 过滤） */
  onTerminalFrame(fn: (f: DaemonTerminalFrame) => void): () => void {
    this.#terminalListeners.add(fn);
    return () => this.#terminalListeners.delete(fn);
  }
}

/** 拉执行器清单 —— 前端据此为每个 daemon 执行器注册一个 RuntimeAdapter */
export async function listDaemonExecutors(endpoint: string = DEFAULT_DAEMON_ENDPOINT): Promise<DaemonExecutorInfo[]> {
  const client = DaemonClient.get(endpoint);
  const list = await client.rpc<DaemonExecutorInfo[]>("adapter.list", null, 10000);
  return list;
}

/** 写一个 bot 的定义到 <rootPath>/.agent-workbench/bot.json（WP-5 写穿） */
export async function putBotDefinition(unit: unknown, endpoint: string = DEFAULT_DAEMON_ENDPOINT): Promise<void> {
  const client = DaemonClient.get(endpoint);
  await client.rpc("bot.put", { unit }, 15000);
}

/** 拉全部落盘 bot 定义（WP-5：启动合并） */
export async function listBotDefinitions(endpoint: string = DEFAULT_DAEMON_ENDPOINT): Promise<unknown[]> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<unknown[]>("bot.list", null, 15000);
}
