/**
 * 终端会话管理 —— node-pty（ConPTY）× 多窗格：每格一条独立 PTY（docs/06 Phase 2）。
 *
 * 帧协议见 docs/07：daemon → client 推 {type:"terminal"} 帧（data/exit），
 * client → daemon 调 terminal.input / terminal.resize / terminal.kill 方法。
 * 终端数据高频且非契约事件，不进 RuntimeEvent 流、不落轨迹。
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  readonly terminalId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly executorId?: string;
  readonly unitId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
}

interface TerminalSession {
  readonly terminalId: string;
  readonly pty: pty.IPty;
  /** create 时的 shell / cwd / 前台执行器 / unitId —— 重挂（F5）时前端靠它们无缝认领还原标签 */
  readonly shell: string;
  readonly cwd: string;
  readonly executor: string;
  readonly unitId?: string;
  /**
   * 输出滚动环 buffer（按字节截断的最近输出）。只为「浏览器刷新后重挂」服务：
   * 刷新即丢 xterm 的全部画布，没有它用户面对的是一块不知道进程还活着的安全黑屏。
   * 不追求无限历史 —— 超过上限从最旧的帧开始丢。
   */
  readonly scrollback: string[];
  scrollbackBytes: number;
}

/** 每终端滚动回放上限。128KB ≈ 千行级输出，够看清「刚才跑到哪了」，内存也可承受 */
const SCROLLBACK_CAP_BYTES = 128 * 1024;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Windows 固定安装位置。MSI 装成 7.x 时在这个文件夹，MSIX 装的则不在 PATH 里。 */
const WIN_PWSH_PATHS = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
] as const;

/** 用 `where` 在 PATH 里找。返回完整路径，找不到返回 null。 */
function whereExe(name: string): string | null {
  try {
    const r = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim() !== "");
    return first === undefined ? null : first.trim();
  } catch {
    return null;
  }
}

/** 探测一次就够，缓存住 —— 终端可能被频繁开关，每次 spawn `where` 没必要。 */
let cachedWinShell: string | null = null;

/**
 * Windows 上的默认 shell：**优先 PowerShell 7**。
 *
 * 原来是 `process.env.ComSpec`，那是 cmd.exe。用它的理由是「Windows 自带、一定在」，
 * 但代价是终端里没有 `&&`、没有三元、管道编码也老。
 *
 * 候选按这个顺序试，**逐个落到能用为止**，任何一步都可能导致终端直接起不来：
 *   1. `AGENT_WORKBENCH_TERMINAL_SHELL` —— 显式覆盖（想指定 7-preview 时用）
 *   2. 两个固定安装路径 —— **排在 where 前面**：MSIX 装的 pwsh 会在
 *      `C:\Program Files\WindowsApps\…` 留一个应用别名，而 `where` 第一个返回的
 *      往往就是它；那个路径要过 MSIX 的 ACL，在 ConPTY 下不如 MSI 装的稳。
 *   3. PATH 里的 `pwsh.exe` —— 覆盖非标准装法
 *   4. `powershell.exe` —— Windows 自带的 5.1，至少有个能用的
 *   5. `ComSpec` / `cmd.exe` —— 最后兜底
 *
 * 非 Windows 保持 `$SHELL`：那是用户自己的 shell，替他们选 shell 越界了。
 */
function defaultShell(): string {
  if (process.platform !== "win32") return process.env["SHELL"] ?? "/bin/bash";
  if (cachedWinShell !== null) return cachedWinShell;

  const override = process.env["AGENT_WORKBENCH_TERMINAL_SHELL"];
  const candidates: readonly (string | null | undefined)[] = [
    override,
    ...WIN_PWSH_PATHS.filter((p) => existsSync(p)),
    whereExe("pwsh.exe"),
    whereExe("powershell.exe"),
    "powershell.exe",
    process.env["ComSpec"],
    "cmd.exe",
  ];

  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    if (c !== "cmd.exe" && !existsSync(c)) continue;
    cachedWinShell = c;
    // 落到 5.1 或 cmd 就说明 7 没装 —— 说清楚，否则用户只会觉得「怎么不是 pwsh」
    if (!c.toLowerCase().includes("pwsh")) {
      log.warn("terminal: PowerShell 7 未找到，已回退", { shell: c, hint: "装 7.x：https://aka.ms/powershell" });
    } else {
      log.info("terminal: 使用 PowerShell 7", { shell: c });
    }
    return c;
  }
  // 走到这说明连 ComSpec 都没有（极端定制环境）。node-pty 会自己报错，
  // 但给个能 spawn 的名字总比给 undefined 好。
  cachedWinShell = "cmd.exe";
  return cachedWinShell;
}

function resolveShell(requested?: string): string {
  if (!requested || requested === "default") return defaultShell();
  const lower = requested.toLowerCase().trim();
  if (lower === "wsl" || lower === "wsl.exe") {
    return whereExe("wsl.exe") ?? "C:\\Windows\\System32\\wsl.exe";
  }
  if (lower === "cmd" || lower === "cmd.exe") {
    return process.env["ComSpec"] ?? "cmd.exe";
  }
  if (lower === "powershell" || lower === "powershell.exe") {
    return whereExe("powershell.exe") ?? "powershell.exe";
  }
  if (lower === "bash" || lower === "bash.exe") {
    return whereExe("bash.exe") ?? "bash.exe";
  }
  if (lower === "pwsh" || lower === "pwsh.exe") {
    return defaultShell();
  }
  return whereExe(requested) ?? requested;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly emit: (frame: TerminalFrameInput) => void) {}

  create(opts: CreateOptions = {}): { terminalId: string; shell: string; executor?: string } {
    const terminalId = opts.terminalId ?? `term_${randomUUID()}`;
    const shell = resolveShell(opts.shell);
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    // 空串 cwd 会让 pty.spawn 直接失败（前端「无归属 bot」的标签就是空串）——
    // 当作没给，落到用户主目录比落到 daemon 进程 cwd 更符合直觉
    const cwd = opts.cwd && opts.cwd.trim() !== "" ? opts.cwd : homedir();

    // 解析前台执行器命令（Claude Code, Codex, ZCode, OpenCode, Pi, MCode, DSH 等）
    const rawTarget =
      opts.command ??
      (opts.executorId && opts.executorId !== "shell" && opts.executorId !== "pwsh"
        ? opts.executorId
        : undefined);

    const stripped = rawTarget ? rawTarget.replace(/^daemon:/, "").trim() : undefined;
    const targetCmd = stripped && stripped !== "mockperm" ? stripped : undefined;

    let shellArgs: string[] = [];
    const isPwsh =
      shell.toLowerCase().includes("pwsh") || shell.toLowerCase().includes("powershell");
    const isCmd = shell.toLowerCase().includes("cmd.exe");
    const isWsl = shell.toLowerCase().includes("wsl");

    if (targetCmd !== undefined && targetCmd.trim() !== "") {
      const extraArgs = (opts.args ?? []).join(" ");
      if (isPwsh) {
        // PowerShell 7 / 5.1：-NoLogo -NoExit，启动即交互运行对应 CLI。
        // 若 CLI 退出或 Ctrl+C，保留在当前工作目录的 shell，不直接销毁终端。
        const callExpr = extraArgs ? `& '${targetCmd}' ${extraArgs}` : `& '${targetCmd}'`;
        shellArgs = ["-NoLogo", "-NoExit", "-Command", callExpr];
      } else if (isCmd) {
        const full = extraArgs ? `${targetCmd} ${extraArgs}` : targetCmd;
        shellArgs = ["/k", full];
      } else {
        const full = extraArgs ? `${targetCmd} ${extraArgs}` : targetCmd;
        shellArgs = ["-c", `${full} || exec ${shell}`];
      }
    } else {
      // 纯 Shell 交互
      if (isPwsh) {
        shellArgs = ["-NoLogo"];
      } else if (opts.args) {
        shellArgs = [...opts.args];
      }
    }

    const envOverrides: Record<string, string> = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "vscode",
      TERM_PROGRAM_VERSION: "1.93.0",
      ...opts.env,
    };

    const isWindows = process.platform === "win32";
    const shellProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, ...envOverrides } as Record<string, string>,
      useConpty: isWindows,
      useConptyDll: isWindows,
      conptyInheritCursor: isWindows,
    });

    const session: TerminalSession = {
      terminalId,
      pty: shellProcess,
      shell,
      cwd,
      executor: targetCmd ?? "shell",
      unitId: opts.unitId,
      scrollback: [],
      scrollbackBytes: 0,
    };

    shellProcess.onData((data) => {
      session.scrollback.push(data);
      session.scrollbackBytes += Buffer.byteLength(data);
      while (session.scrollbackBytes > SCROLLBACK_CAP_BYTES && session.scrollback.length > 1) {
        const dropped = session.scrollback.shift();
        session.scrollbackBytes -= Buffer.byteLength(dropped ?? "");
      }
      this.emit({ terminalId, kind: "data", data });
    });
    shellProcess.onExit(({ exitCode }) => {
      this.sessions.delete(terminalId);
      log.info("terminal exited", { terminalId, exitCode });
      this.emit({ terminalId, kind: "exit", exitCode });
    });

    this.sessions.set(terminalId, session);
    log.info("terminal created", {
      terminalId,
      shell,
      executor: targetCmd ?? "shell",
      unitId: opts.unitId,
      cwd: path.basename(cwd),
      pid: shellProcess.pid,
    });
    return { terminalId, shell, executor: targetCmd ?? "shell" };
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

  list(): Array<{ terminalId: string; shell: string; pid: number; cwd: string; executor: string; unitId?: string; scrollback: string }> {
    return [...this.sessions.values()].map((s) => ({
      terminalId: s.terminalId,
      shell: s.pty.process,
      pid: s.pty.pid,
      cwd: s.cwd,
      executor: s.executor,
      unitId: s.unitId,
      // 拼好整段回放：前端刷新后没有别的途径找回这段输出
      scrollback: s.scrollback.join(""),
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
