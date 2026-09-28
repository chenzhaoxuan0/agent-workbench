/**
 * 终端会话管理 —— node-pty（ConPTY）× 多窗格：每格一条独立 PTY（docs/06 Phase 2）。
 *
 * 帧协议见 docs/07：daemon → client 推 {type:"terminal"} 帧（data/exit），
 * client → daemon 调 terminal.input / terminal.resize / terminal.kill 方法。
 * 终端数据高频且非契约事件，不进 RuntimeEvent 流、不落轨迹。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import pty from "node-pty";
import { log } from "../log.ts";

export interface TerminalFrameInput {
  readonly terminalId: string;
  readonly kind: "data" | "exit";
  readonly data?: string;
  readonly exitCode?: number;
}

export interface CreateOptions {
  readonly cwd?: string;
  readonly shell?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
}

interface TerminalSession {
  readonly terminalId: string;
  readonly pty: pty.IPty;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function defaultShell(): string {
  return process.platform === "win32"
    ? (process.env["ComSpec"] ?? "powershell.exe")
    : process.env["SHELL"] ?? "/bin/bash";
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly emit: (frame: TerminalFrameInput) => void) {}

  create(opts: CreateOptions = {}): { terminalId: string; shell: string } {
    const terminalId = `term_${randomUUID()}`;
    const shell = opts.shell ?? defaultShell();
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    const cwd = opts.cwd ?? process.cwd();

    const shellProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    shellProcess.onData((data) => {
      this.emit({ terminalId, kind: "data", data });
    });
    shellProcess.onExit(({ exitCode }) => {
      this.sessions.delete(terminalId);
      log.info("terminal exited", { terminalId, exitCode });
      this.emit({ terminalId, kind: "exit", exitCode });
    });

    this.sessions.set(terminalId, { terminalId, pty: shellProcess });
    log.info("terminal created", { terminalId, shell, cwd: path.basename(cwd), pid: shellProcess.pid });
    return { terminalId, shell };
  }

  write(terminalId: string, data: string): void {
    this.get(terminalId).pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) {
      throw Object.assign(new Error(`invalid terminal size ${cols}x${rows}`), { code: "bad_params" });
    }
    this.get(terminalId).pty.resize(cols, rows);
  }

  kill(terminalId: string): void {
    const session = this.get(terminalId);
    // kill 后 onExit 会补发 exit 帧并清台账
    session.pty.kill();
  }

  list(): Array<{ terminalId: string; shell: string; pid: number }> {
    return [...this.sessions.values()].map((s) => ({
      terminalId: s.terminalId,
      shell: s.pty.process,
      pid: s.pty.pid,
    }));
  }

  private get(terminalId: string): TerminalSession {
    const s = this.sessions.get(terminalId);
    if (s === undefined) throw Object.assign(new Error(`no such terminal: ${terminalId}`), { code: "unknown_terminal" });
    return s;
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        // 已经死了就算赢
      }
    }
    this.sessions.clear();
  }
}
