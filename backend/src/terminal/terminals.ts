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
  readonly kind: "data" | "exit" | "created" | "title";
  readonly title?: string;
  readonly data?: string;
  readonly exitCode?: number;
  /** 是否由客户端显式调用 terminal.kill 触发关闭（非意外崩退） */
  readonly killed?: boolean;
  /** 终端存活时长（毫秒） */
  readonly durationMs?: number;
  /** kind=created 时随帧带的档案：前端据此直接开标签认领（不必再等 terminal.list 轮询） */
  readonly executor?: string;
  readonly unitId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  /** kind=exit 时提取的 ANSI 过滤后终端纯文本快照 */
  readonly transcript?: string;
}

/** 过滤终端 ANSI 控制符、颜色码与重绘字符，提取干净的文本日志 */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
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
  /**
   * CLI 退出即收口（自动化终端用）：不带 -NoExit / /k —— TUI 一退，shell 跟着退，
   * exit 帧随即到达，派发方据此结算运行记录。手动终端保持默认（留在 shell 里看结果）。
   */
  readonly autoExit?: boolean;
}

interface TerminalSession {
  readonly terminalId: string;
  readonly pty: pty.IPty;
  /** create 时的 shell / cwd / 前台执行器 / unitId —— 重挂（F5）时前端靠它们无缝认领还原标签 */
  readonly shell: string;
  readonly cwd: string;
  readonly executor: string;
  readonly unitId?: string;
  /** 创建时间戳（用于统计会话存活时长，区分瞬时闪退与正常长程使用） */
  readonly bornAt: number;
  /** 是否由客户端显式调用 kill 触发关闭 */
  killedByClient?: boolean;
  /**
   * 输出滚动环 buffer（按字节截断的最近输出）。只为「浏览器刷新后重挂」服务：
   * 刷新即丢 xterm 的全部画布，没有它用户面对的是一块不知道进程还活着的安全黑屏。
   * 不追求无限历史 —— 超过上限从最旧的帧开始丢。
   */
  readonly scrollback: string[];
  scrollbackBytes: number;
  /** 最近一帧输出的到达时间 —— writeWhenQuiet 的静默判据 */
  lastDataAt: number;
  /** 用户在终端中敲入/粘贴的输入缓冲（用于提取首条 prompt 作为会话标题） */
  inputBuffer: string;
  firstInputCaptured?: boolean;
}

/** 每终端滚动回放上限。128KB ≈ 千行级输出，够看清「刚才跑到哪了」，内存也可承受 */
const SCROLLBACK_CAP_BYTES = 128 * 1024;

/**
 * pty 自退后的排空窗口。ConPTY 在进程退出后还需要几秒收尾句柄，实测 ~5s；
 * 在这个窗口里 process.exit 会触发 node-pty 的 libuv 断言（UV_HANDLE_CLOSING）
 * 把 daemon 以崩溃码干掉。shutdown 前先等这个窗口过去。
 */
const PTY_DRAIN_MS = 6_000;

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
  /** 最近一次 pty 自退的时间（0 = 从未）—— shutdown 排空判据 */
  private lastSelfExitAt = 0;

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

    let isYolo = false;
    let stripped = rawTarget ? rawTarget.replace(/^daemon:/, "").trim() : undefined;
    if (stripped?.endsWith(":yolo")) {
      isYolo = true;
      stripped = stripped.slice(0, -5).trim();
    }
    const mapped =
      stripped === "antigravity"
        ? "agy"
        : stripped === "cursor"
          ? "cursor-agent"
          : stripped === "grok-build"
            ? "grok"
            : stripped;
    const targetCmd = mapped && mapped !== "mockperm" ? mapped : undefined;

    let shellArgs: string[] = [];
    const isPwsh =
      shell.toLowerCase().includes("pwsh") || shell.toLowerCase().includes("powershell");
    const isCmd = shell.toLowerCase().includes("cmd.exe");
    const isWsl = shell.toLowerCase().includes("wsl");

    if (targetCmd !== undefined && targetCmd.trim() !== "") {
      const extraArgsList = [...(opts.args ?? [])];
      if (isYolo) {
        // 各家 TUI 的免审批 flag 口径不一，只加实测过的：
        // zcode --mode yolo / claude·agy --dangerously-skip-permissions /
        // kimi --yolo / codex --dangerously-bypass-approvals-and-sandbox。
        // 没把握的裸起 —— 终端模式人就在屏幕前，TUI 弹权限确认当场可点。
        if (targetCmd === "zcode" && !extraArgsList.includes("--mode")) {
          extraArgsList.push("--mode", "yolo");
        } else if (targetCmd === "codex" && !extraArgsList.includes("--dangerously-bypass-approvals-and-sandbox")) {
          extraArgsList.push("--dangerously-bypass-approvals-and-sandbox");
        } else if (targetCmd === "agy" && !extraArgsList.includes("--dangerously-skip-permissions")) {
          extraArgsList.push("--dangerously-skip-permissions");
        } else if (targetCmd === "claude" && !extraArgsList.includes("--dangerously-skip-permissions")) {
          extraArgsList.push("--dangerously-skip-permissions");
        } else if (targetCmd === "kimi" && !extraArgsList.includes("--yolo")) {
          extraArgsList.push("--yolo");
        } else if (targetCmd === "cursor-agent" && !extraArgsList.includes("--yolo")) {
          extraArgsList.push("--yolo", "--trust");
        } else if (targetCmd === "grok" && !extraArgsList.includes("--always-approve")) {
          extraArgsList.push("--always-approve");
        }
      }
      const extraArgs = extraArgsList.join(" ");
      if (isPwsh) {
        // PowerShell 7 / 5.1：-NoLogo -NoExit，启动即交互运行对应 CLI。
        // autoExit 时去掉 -NoExit —— CLI 退出即终端收口（自动化运行记录要这个信号），
        // Ctrl+C 打断同理；手动终端保持留在工作目录的 shell 里。
        const callExpr = extraArgs ? `& '${targetCmd}' ${extraArgs}` : `& '${targetCmd}'`;
        shellArgs = ["-NoLogo", ...(opts.autoExit === true ? [] : ["-NoExit"]), "-Command", callExpr];
      } else if (isCmd) {
        const full = extraArgs ? `${targetCmd} ${extraArgs}` : targetCmd;
        shellArgs = [opts.autoExit === true ? "/c" : "/k", full];
      } else {
        const full = extraArgs ? `${targetCmd} ${extraArgs}` : targetCmd;
        shellArgs = ["-c", opts.autoExit === true ? full : `${full} || exec ${shell}`];
      }
    } else {
      // 纯 Shell 交互
      if (isPwsh) {
        shellArgs = ["-NoLogo"];
      } else if (opts.args) {
        shellArgs = [...opts.args];
      }
    }

    const userBinDirs = [
      path.join(homedir(), ".grok", "bin"),
      path.join(homedir(), "AppData", "Local", "cursor-agent"),
      path.join(homedir(), "AppData", "Roaming", "npm"),
      path.join(homedir(), ".cargo", "bin"),
      path.join(homedir(), ".local", "bin"),
    ].filter((p) => existsSync(p));

    const curPath = process.env.PATH ?? process.env.Path ?? "";
    const mergedPath = [...userBinDirs, curPath].join(path.delimiter);

    const envOverrides: Record<string, string> = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "vscode",
      TERM_PROGRAM_VERSION: "1.93.0",
      PATH: mergedPath,
      Path: mergedPath,
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
      executor: targetCmd ? (isYolo ? `${targetCmd}:yolo` : targetCmd) : "shell",
      unitId: opts.unitId,
      bornAt: Date.now(),
      scrollback: [],
      scrollbackBytes: 0,
      lastDataAt: Date.now(),
      inputBuffer: "",
    };

    shellProcess.onData((data) => {
      session.lastDataAt = Date.now();
      session.scrollback.push(data);
      session.scrollbackBytes += Buffer.byteLength(data);
      while (session.scrollbackBytes > SCROLLBACK_CAP_BYTES && session.scrollback.length > 1) {
        const dropped = session.scrollback.shift();
        session.scrollbackBytes -= Buffer.byteLength(dropped ?? "");
      }
      this.emit({ terminalId, kind: "data", data });
    });
    shellProcess.onExit(({ exitCode }) => {
      const killed = session.killedByClient === true;
      const durationMs = Date.now() - session.bornAt;
      const rawOutput = session.scrollback.join("");
      const transcript = stripAnsi(rawOutput).trim();
      this.sessions.delete(terminalId);
      this.lastSelfExitAt = Date.now();
      log.info("terminal exited", { terminalId, exitCode, killed, durationMs, transcriptChars: transcript.length });
      this.emit({ terminalId, kind: "exit", exitCode, killed, durationMs, transcript: transcript !== "" ? transcript : undefined });
    });

    this.sessions.set(terminalId, session);
    const recordedExec = targetCmd ? (isYolo ? `${targetCmd}:yolo` : targetCmd) : "shell";
    log.info("terminal created", {
      terminalId,
      shell,
      executor: recordedExec,
      unitId: opts.unitId,
      cwd: path.basename(cwd),
      pid: shellProcess.pid,
    });
    // created 帧：后端侧（自动化派发）新建的终端靠它推送认领 —— 前端不轮询
    // terminal.list，收到帧即开标签；手动路径的帧无害（前端已有该终端则忽略）。
    this.emit({ terminalId, kind: "created", executor: recordedExec, unitId: opts.unitId, cwd, shell });
    return { terminalId, shell, executor: recordedExec };
  }

  /**
   * 等 TUI 启动稳定后再写入（自动化 prompt 注入用）：raw write 抢在 TUI 画完
   * 之前会把字符喂给 shell 或被吞掉。判据 = 距最近一帧输出已静默 quietMs，
   * 且至少等了 minDelay；maxWait 封顶（慢启动也必须送达，宁可早不可丢）。
   */
  writeWhenQuiet(
    terminalId: string,
    data: string,
    opts: { minDelayMs?: number; quietMs?: number; maxWaitMs?: number } = {},
  ): Promise<void> {
    const session = this.get(terminalId);
    const minDelay = opts.minDelayMs ?? 2_000;
    const quiet = opts.quietMs ?? 900;
    const maxWait = opts.maxWaitMs ?? 15_000;
    const bornAt = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const s = this.sessions.get(terminalId);
        if (s === undefined) {
          // 终端已退（TUI 秒崩）：写入无处可去，正常收场
          clearInterval(timer);
          resolve();
          return;
        }
        const now = Date.now();
        const quietEnough = now - s.lastDataAt >= quiet;
        if ((now - bornAt >= minDelay && quietEnough) || now - bornAt >= maxWait) {
          clearInterval(timer);
          try {
            s.pty.write(data);
          } catch (err: unknown) {
            log.warn("terminal writeWhenQuiet failed", { terminalId, error: err instanceof Error ? err.message : String(err) });
          }
          resolve();
        }
      }, 150);
      timer.unref();
    });
  }

  write(terminalId: string, data: string): void {
    const session = this.get(terminalId);
    session.pty.write(data);
    if (!session.firstInputCaptured) {
      this.accumulateFirstInput(session, data);
    }
  }

  private accumulateFirstInput(session: TerminalSession, data: string): void {
    const cleaned = data
      .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
    for (const ch of cleaned) {
      if (ch === "\r" || ch === "\n") {
        const line = session.inputBuffer.trim();
        if (line.length >= 2 && !["clear", "exit", "quit", ":q", ":q!"].includes(line.toLowerCase())) {
          session.firstInputCaptured = true;
          const title = line.length > 60 ? `${line.slice(0, 60)}…` : line;
          this.emit({ terminalId: session.terminalId, kind: "title", title });
          break;
        }
        session.inputBuffer = "";
      } else if (ch === "\b" || ch === "\x7f") {
        session.inputBuffer = session.inputBuffer.slice(0, -1);
      } else if (ch.charCodeAt(0) >= 32 || ch.charCodeAt(0) > 127) {
        session.inputBuffer += ch;
        if (session.inputBuffer.length > 500) {
          session.inputBuffer = session.inputBuffer.slice(0, 500);
        }
      }
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) {
      throw Object.assign(new Error(`invalid terminal size ${cols}x${rows}`), { code: "bad_params" });
    }
    this.get(terminalId).pty.resize(cols, rows);
  }

  kill(terminalId: string): void {
    const session = this.get(terminalId);
    session.killedByClient = true;
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

  /**
   * shutdown 排空：距最近一次 pty 自退不足 PTY_DRAIN_MS 就等到窗口过去。
   * ConPTY 的句柄收尾在进程退出后仍持续几秒，抢跑 process.exit 会撞上
   * node-pty 的 libuv 断言（UV_HANDLE_CLOSING）把退出码变成崩溃。
   * 从未自退 / 窗口已过 → 立即返回。只等一次、封顶 6s。
   */
  async waitPtyDrain(): Promise<void> {
    const remain = this.lastSelfExitAt === 0 ? 0 : this.lastSelfExitAt + PTY_DRAIN_MS - Date.now();
    if (remain <= 0) return;
    log.info("terminal: waiting for ConPTY drain before exit", { ms: remain });
    await new Promise((resolve) => setTimeout(resolve, remain));
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
