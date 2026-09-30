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
 * 断线重放（docs/08 WP-2）：事件帧带 per-session seq；重连（hello）成功后触发
 * resync 监听器，适配器按会话调 session.events.since 补拉缺口（判重在适配器侧）。
 * hello 帧的 daemon.generation（评审 P1）：daemon 换代后 seq 空间从 1 重来，
 * 检测到换代即通知适配器清游标做全量重拉——否则旧游标会把新事件全部判重丢弃。
 *
 * token（WP-7）：localStorage 显式配置优先（手机/局域网），否则回环经 /bootstrap
 * 自动取；都拿不到就连裸的，daemon 开着鉴权会 401。
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
  readonly #generationListeners = new Set<() => void>();
  readonly #terminalListeners = new Set<(f: DaemonTerminalFrame) => void>();
  #seq = 0;
  #everConnected = false;
  #generation: string | null = null;
  #token: string | null = null;

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

  /**
   * token 解析（WP-7）：localStorage 显式配置优先，否则回环自动经 GET /bootstrap 取。
   * 都拿不到返回 null——连裸的，鉴权开着会 401，调用方据此报"需要 token"。
   */
  async #ensureToken(): Promise<string | null> {
    if (this.#token !== null) return this.#token;
    try {
      const stored = localStorage.getItem("agent-workbench:daemon-token");
      if (stored !== null && stored !== "") {
        this.#token = stored;
        return stored;
      }
    } catch { /* 私有模式 localStorage 不可用 */ }
    try {
      const r = await fetch(`${this.#endpoint}/bootstrap`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = (await r.json()) as { token?: string | null };
        if (typeof j.token === "string" && j.token !== "") {
          this.#token = j.token;
          return j.token;
        }
      }
    } catch { /* daemon 未起或非回环拒绝 */ }
    return null;
  }

  async ensureConnected(timeoutMs = 8000): Promise<void> {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) return;
    if (this.#connecting !== null) return this.#connecting;

    const attempt: Promise<void> = new Promise<void>((resolve, reject) => {
      // 评审 P2：建连体全程 try/catch + attempt 级 settled 标记——此前超时不关 socket、
      // 迟到的 error/open 会 clobber 下一次尝试、WebSocket 构造同步抛会让 Promise 永不 settle
      let settled = false;
      let ws: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = (code: string, message: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (ws !== null) {
          try {
            ws.close();
          } catch { /* 已死不究 */ }
        }
        reject(Object.assign(new Error(message), { code }));
      };
      const succeed = (socket: WebSocket): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.#ws = socket;
        resolve();
      };

      void this.#ensureToken()
        .then((token) => {
          const base = wsUrlOf(this.#endpoint);
          const wsUrl = token !== null ? `${base}?token=${encodeURIComponent(token)}` : base;
          try {
            ws = new WebSocket(wsUrl);
          } catch (err: unknown) {
            fail("daemon_unreachable", `daemon ${this.#endpoint} 连接创建失败：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          timer = setTimeout(() => fail("daemon_connect_timeout", `daemon ${this.#endpoint} 连接超时`), timeoutMs);
          ws.addEventListener("open", () => succeed(ws!));
          ws.addEventListener("error", () => fail("daemon_unreachable", `daemon ${this.#endpoint} 连接失败（daemon 没起？或 token 不对）`));
          ws.addEventListener("message", (ev: MessageEvent) => this.#onFrame(ev));
          ws.addEventListener("close", () => {
            if (this.#ws === ws) this.#ws = null;
            // 挂起的 rpc 全部失败：调用方据此感知断线
            for (const p of this.#pending.values()) {
              clearTimeout(p.timer);
              p.reject(Object.assign(new Error("daemon 连接已断开"), { code: "daemon_disconnected" }));
            }
            this.#pending.clear();
          });
        })
        .catch((err: unknown) => fail("daemon_unreachable", err instanceof Error ? err.message : String(err)));
    }).finally(() => {
      if (this.#connecting === attempt) this.#connecting = null;
    });

    this.#connecting = attempt;
    return attempt;
  }

  /** 帧分发：hello（代际检测/resync 触发）、event、terminal、rpc 响应 */
  #onFrame(ev: MessageEvent): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame["type"] === "hello") {
      // 评审 P1：daemon 换代（pid 变）= seq 空间重置——通知适配器清游标全量重拉；
      // 未换代的重连走增量 resync。resync 触发统一收敛到 hello（连接建立的权威信号）。
      const daemon = frame["daemon"] as { generation?: string; pid?: number } | undefined;
      const gen = daemon === undefined ? "unknown" : (daemon.generation ?? `pid:${daemon.pid ?? "?"}`);
      const changed = this.#generation !== null && this.#generation !== gen;
      const wasConnected = this.#everConnected;
      this.#generation = gen;
      this.#everConnected = true;
      if (changed) {
        for (const fn of this.#generationListeners) fn();
      } else if (wasConnected) {
        for (const fn of this.#resyncListeners) fn();
      }
      return;
    }
    if (frame["type"] === "event") {
      const event = frame["event"] as RuntimeEvent | undefined;
      // 评审 P3：最小形状校验——半实现 daemon / wscat 手发帧不至于在监听器里抛 TypeError
      if (event === undefined || typeof event !== "object" || typeof event.sessionId !== "string") return;
      const seq = typeof frame["seq"] === "number" ? frame["seq"] : undefined;
      for (const fn of this.#eventListeners) fn(event, seq);
      return;
    }
    if (frame["type"] === "terminal") {
      const tf = frame as unknown as DaemonTerminalFrame;
      for (const fn of this.#terminalListeners) fn(tf);
      return;
    }
    // rpc 响应
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

  /** 重连（未换代）时触发——适配器按会话游标增量补拉 */
  onResync(fn: () => void): () => void {
    this.#resyncListeners.add(fn);
    return () => this.#resyncListeners.delete(fn);
  }

  /** daemon 换代（重连后 hello 的 generation 变化）——适配器清游标全量重拉 */
  onGenerationChange(fn: () => void): () => void {
    this.#generationListeners.add(fn);
    return () => this.#generationListeners.delete(fn);
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
