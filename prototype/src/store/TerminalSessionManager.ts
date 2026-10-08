import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import {
  DaemonClient,
  defaultDaemonEndpoint,
  type DaemonTerminalFrame,
} from "../adapters/daemon/client.ts";

export interface TerminalSessionCreateOptions {
  terminalId: string;
  shell: string;
  cwd: string;
  executorId?: string;
  onExit?: (code: number) => void;
}

/**
 * 终端底层会话对象（对齐 VS Code terminalInstance.ts）
 *
 * 核心设计：每个实例持有常驻的 _wrapperElement 与 xterm 实例。
 * 当分屏、合并分屏、多标签切换或最大化时，通过 DOM appendChild 直接挂载到对应的窗格 Slot。
 * 绝不在布局变更时 unmount 或重新初始化 PTY，彻底避免进程重启与 TUI 画布闪烁！
 */
export class TerminalSession {
  readonly terminalId: string;
  readonly element: HTMLDivElement;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly unicode11: Unicode11Addon;
  shell: string;
  cwd: string;
  executorId?: string;

  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCols = 80;
  private lastRows = 24;
  private unsubFrame: (() => void) | null = null;
  private onExitCallback?: (code: number) => void;

  constructor(opts: TerminalSessionCreateOptions) {
    this.terminalId = opts.terminalId;
    this.shell = opts.shell;
    this.cwd = opts.cwd;
    this.executorId = opts.executorId;
    this.onExitCallback = opts.onExit;

    // 创建持久化包装容器
    this.element = document.createElement("div");
    this.element.className = "w-full h-full relative overflow-hidden bg-[#0f1115]";
    this.element.setAttribute("data-terminal-id", this.terminalId);

    // 对齐 VS Code xtermTerminal.ts 配置
    this.term = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: false,
      customGlyphs: true,
      smoothScrollDuration: 0,
      fastScrollSensitivity: 3,
      scrollSensitivity: 1,
      windowsPty: {
        backend: "conpty",
        buildNumber: 22621,
      },
      theme: {
        background: "#0f1115",
        foreground: "#e2e8f0",
        cursor: "#2dd4bf",
        selectionBackground: "rgba(45, 212, 191, 0.25)",
        black: "#1e222b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#2dd4bf",
        white: "#f1f5f9",
        brightBlack: "#4b5563",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#eab308",
        brightBlue: "#3b82f6",
        brightMagenta: "#a855f7",
        brightCyan: "#14b8a6",
        brightWhite: "#ffffff",
      },
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.unicode11 = new Unicode11Addon();
    this.term.loadAddon(this.unicode11);
    this.term.unicode.activeVersion = "11";

    try {
      const canvasAddon = new CanvasAddon();
      this.term.loadAddon(canvasAddon);
    } catch (err) {
      console.warn("[terminal] Canvas addon fallback:", err);
    }

    // 打开到包装元素
    this.term.open(this.element);

    // 订阅后台 PTY 帧
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const onFrame = (f: DaemonTerminalFrame): void => {
      if (f.terminalId !== this.terminalId) return;
      if (f.kind === "data" && f.data !== undefined) {
        this.term.write(f.data);
      }
      if (f.kind === "exit") {
        const code = f.exitCode ?? 0;
        this.term.write(`\r\n\x1b[2m[进程已退出，exit=${code}]\x1b[0m\r\n`);
        this.onExitCallback?.(code);
      }
    };
    this.unsubFrame = client.onTerminalFrame(onFrame);

    // 发送用户输入
    this.term.onData((data) => {
      void client
        .rpc("terminal.input", { terminalId: this.terminalId, data }, 8000)
        .catch(() => {});
    });

    // 滚轮事件分流（对齐 VS Code）：备用缓冲 TUI 下映射为光标导航键驱动，普通终端放行历史滚动
    this.term.attachCustomWheelEventHandler((e: WheelEvent) => {
      if (e.shiftKey) return true;
      if (this.term.buffer.active.type === "alternate") {
        const isUp = e.deltaY < 0;
        const steps = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 35)));
        const payload = (isUp ? "\x1b[A" : "\x1b[B").repeat(steps);
        void client
          .rpc("terminal.input", { terminalId: this.terminalId, data: payload }, 3000)
          .catch(() => {});
        return false;
      }
      return true;
    });

    // 容器滑动条点击分流
    this.element.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.shiftKey || e.button !== 0) return;
      if (this.term.buffer.active.type !== "alternate") return;
      const rect = this.element.getBoundingClientRect();
      const curCols = this.term.cols || 80;
      const curRows = this.term.rows || 24;
      const cellW = rect.width / curCols;
      const cellH = rect.height / curRows;
      if (cellW <= 0 || cellH <= 0) return;
      const col = Math.min(curCols, Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1));
      const row = Math.min(curRows, Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1));

      const isScrollbarArea = col >= Math.floor(curCols * 0.45) && col <= Math.ceil(curCols * 0.55);
      if (isScrollbarArea) {
        const isTopHalf = row < Math.floor(curRows / 2);
        void client
          .rpc(
            "terminal.input",
            { terminalId: this.terminalId, data: isTopHalf ? "\x1b[5~" : "\x1b[6~" },
            3000,
          )
          .catch(() => {});
      }
    });

    // 监听包装容器的尺寸变化
    this.resizeObserver = new ResizeObserver(() => {
      this.syncResize(false);
    });
    this.resizeObserver.observe(this.element);

    // 启动真 PTY 进程
    void this.boot();
  }

  private async boot(): Promise<void> {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    await client.ensureConnected();
    if (this.disposed) return;

    let cols = 80;
    let rows = 24;
    try {
      const dims = this.fitAddon.proposeDimensions();
      if (dims && dims.cols >= 10 && dims.rows >= 4) {
        cols = dims.cols;
        rows = dims.rows;
        this.term.resize(cols, rows);
      }
    } catch {
      const rect = this.element.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        cols = Math.max(20, Math.floor((rect.width - 16) / 8.2));
        rows = Math.max(8, Math.floor((rect.height - 8) / 18));
        this.term.resize(cols, rows);
      }
    }
    this.lastCols = cols;
    this.lastRows = rows;

    await client.rpc(
      "terminal.create",
      {
        terminalId: this.terminalId,
        shell: this.shell,
        cwd: this.cwd,
        cols,
        rows,
        executorId: this.executorId,
      },
      15000,
    );

    if (this.disposed) {
      void client.rpc("terminal.kill", { terminalId: this.terminalId }).catch(() => {});
    }
  }

  attachTo(container: HTMLElement): void {
    if (this.element.parentElement !== container) {
      container.appendChild(this.element);
    }
    this.fit();
  }

  detach(): void {
    if (this.element.parentElement) {
      this.element.parentElement.removeChild(this.element);
    }
  }

  fit(immediate = false): void {
    this.syncResize(immediate);
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.clear();
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client
      .rpc("terminal.input", { terminalId: this.terminalId, data: "\x0c" }, 3000)
      .catch(() => {});
  }

  async restart(): Promise<void> {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    try {
      await client.rpc("terminal.kill", { terminalId: this.terminalId }, 3000);
    } catch {}
    this.term.clear();
    await this.boot();
  }

  private syncResize(immediate = false): void {
    if (this.disposed || !this.element.isConnected) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;

    try {
      const dims = this.fitAddon.proposeDimensions();
      if (!dims || dims.cols < 10 || dims.rows < 4) return;
      if (dims.cols === this.lastCols && dims.rows === this.lastRows) return;

      const newCols = dims.cols;
      const newRows = dims.rows;
      this.lastCols = newCols;
      this.lastRows = newRows;

      this.term.resize(newCols, newRows);

      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      const client = DaemonClient.get(defaultDaemonEndpoint());
      if (immediate) {
        void client
          .rpc(
            "terminal.resize",
            { terminalId: this.terminalId, cols: newCols, rows: newRows },
            8000,
          )
          .catch(() => {});
      } else {
        this.resizeTimer = setTimeout(() => {
          if (this.disposed) return;
          void client
            .rpc(
              "terminal.resize",
              { terminalId: this.terminalId, cols: newCols, rows: newRows },
              8000,
            )
            .catch(() => {});
        }, 60);
      }
    } catch {}
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.unsubFrame?.();
    this.detach();
    try {
      this.term.dispose();
    } catch {}
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client.rpc("terminal.kill", { terminalId: this.terminalId }, 3000).catch(() => {});
  }
}

/** 全局终端会话管理单例 */
class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>();

  getOrCreate(opts: TerminalSessionCreateOptions): TerminalSession {
    let session = this.sessions.get(opts.terminalId);
    if (!session) {
      session = new TerminalSession(opts);
      this.sessions.set(opts.terminalId, session);
    }
    return session;
  }

  get(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  dispose(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.dispose();
      this.sessions.delete(terminalId);
    }
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}

export const terminalSessionRegistry = new TerminalSessionRegistry();
