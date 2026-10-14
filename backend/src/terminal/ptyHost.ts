/**
 * PtyHost —— 主线程侧的 PTY worker 宿主（多路复用）。
 *
 * 主线程绝不 import node-pty（连插件 .node 的加载都不发生）：所有 spawn/
 * write/resize/kill 经 postMessage 交给 worker（见 ptyWorker.ts 头注释的
 * 卡死根因）。worker 意外死亡时：所有活终端按 exit 收口（前端标签关闭），
 * 下一次 create 自动重拉新 worker —— PTY 卡死从「daemon 全冻结」降级成
 * 「终端标签闪退」。
 */

import { Worker } from "node:worker_threads";
import { log } from "../log.ts";

export interface PtySpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Record<string, string>;
}

export interface PtyHandle {
  readonly terminalId: string;
  /** worker 侧 spawn 成功后回填（create 返回时可能还没到） */
  pid: number | undefined;
}

type Listener = (data: string) => void;
type ExitListener = (exitCode: number) => void;

interface WorkerSession {
  readonly handle: PtyHandle;
  onData: Listener | null;
  onExit: ExitListener | null;
  spawnError: string | null;
}

export class PtyHost {
  private worker: Worker | null = null;
  private readonly sessions = new Map<string, WorkerSession>();
  private starting: Promise<Worker> | null = null;

  /** 订阅要在 create 之前挂（created/data 帧可能在 create 调用返回前就到） */
  create(
    terminalId: string,
    opts: PtySpawnOptions,
    listeners: { onData: Listener; onExit: ExitListener },
  ): PtyHandle {
    const handle: PtyHandle = { terminalId, pid: undefined };
    const session: WorkerSession = { handle, onData: listeners.onData, onExit: listeners.onExit, spawnError: null };
    this.sessions.set(terminalId, session);

    // worker 在后台拉起；如果起不来（或中途死掉），failAll 会把这个 session 收口
    void this.ensureWorker().then(
      (w) => {
        w.postMessage({
          t: "create",
          id: terminalId,
          file: opts.file,
          args: [...opts.args],
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
          env: opts.env,
        });
      },
      (err: unknown) => {
        this.finishWithError(terminalId, `pty worker 起不来：${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return handle;
  }

  write(terminalId: string, data: string): void {
    this.worker?.postMessage({ t: "write", id: terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.worker?.postMessage({ t: "resize", id: terminalId, cols, rows });
  }

  kill(terminalId: string): void {
    this.worker?.postMessage({ t: "kill", id: terminalId });
  }

  /** 清台账（exit 帧到达时调用；worker 死亡收口也走这里） */
  forget(terminalId: string): void {
    this.sessions.delete(terminalId);
  }

  private ensureWorker(): Promise<Worker> {
    if (this.worker !== null) return Promise.resolve(this.worker);
    if (this.starting !== null) return this.starting;

    this.starting = new Promise<Worker>((resolve, reject) => {
      const w = new Worker(new URL("./ptyWorker.ts", import.meta.url));
      let settled = false;
      w.once("online", () => {
        settled = true;
        resolve(w);
      });
      w.once("error", (err: Error) => {
        log.error("pty worker error", { error: err.message });
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      w.on("message", (m: { t?: string; id?: string; data?: string; exitCode?: number; pid?: number; message?: string }) => {
        const { t, id } = m;
        if (t === undefined || id === undefined) return;
        const session = this.sessions.get(id);
        if (session === undefined) return;
        if (t === "data" && typeof m.data === "string") session.onData?.(m.data);
        else if (t === "exit") this.finish(session, m.exitCode ?? 0);
        else if (t === "created" && typeof m.pid === "number") session.handle.pid = m.pid;
        else if (t === "error" && t !== undefined) this.finishWithError(id, m.message ?? "pty spawn failed");
      });
      w.once("exit", (code) => {
        this.worker = null;
        this.starting = null;
        log.warn("pty worker exited", { code, liveTerminals: this.sessions.size });
        this.failAll(`pty worker 退出（code=${code}）`);
      });
      this.worker = w;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private finish(session: WorkerSession, exitCode: number): void {
    this.sessions.delete(session.handle.terminalId);
    session.onExit?.(exitCode);
  }

  private finishWithError(terminalId: string, message: string): void {
    const session = this.sessions.get(terminalId);
    if (session === undefined) return;
    log.warn("pty spawn failed", { terminalId, message });
    this.finish(session, -1);
  }

  /** worker 死亡：所有活终端立刻收口（终端标签闪退，daemon 本体无恙） */
  private failAll(reason: string): void {
    for (const session of [...this.sessions.values()]) {
      log.warn("terminal lost (pty worker died)", { terminalId: session.handle.terminalId, reason });
      this.finish(session, -1);
    }
  }

  /** daemon 关停：杀光终端后排空窗口，再 terminate worker */
  async shutdown(killAll: () => void, waitDrain: () => Promise<void>): Promise<void> {
    killAll();
    await waitDrain();
    const w = this.worker;
    this.worker = null;
    if (w !== null) await w.terminate().catch(() => undefined);
  }
}
