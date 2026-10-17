import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { toHex, withAlpha } from "../core/appearance.ts";
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
  unitId?: string;
  onExit?: (code: number) => void;
  /**
   * 重挂模式：PTY 已在 daemon 里活着（F5 刷新后 terminal.list 找回来的），
   * 传最近输出回放。设置后不再 terminal.create —— 再 create 同 id 会起第二个进程。
   */
  attachScrollback?: string;
}

/**
 * 兜底配色。正常路径不走这里 —— 终端颜色从 <html> 上算出来的 CSS 变量读，
 * 这样用户在外观设置里改的颜色会真的进到终端，而不是各走各的。
 * 只有在 CSS 变量读不到（首帧 / 非浏览器环境）时才退回这两套。
 */
export const XTERM_LIGHT_THEME = {
  background: "#f2f1ed",
  foreground: "#26251e",
  cursor: "#f54e00",
  selectionBackground: "rgba(139, 196, 248, 0.4)",
  black: "#26251e",
  red: "#cf2d56",
  green: "#1f8a65",
  yellow: "#c08532",
  blue: "#2563eb",
  magenta: "#a855f7",
  cyan: "#0d9488",
  white: "#e6e5e0",
  brightBlack: "#84847e",
  brightRed: "#e11d48",
  brightGreen: "#16a34a",
  brightYellow: "#d97706",
  brightBlue: "#3b82f6",
  brightMagenta: "#c084fc",
  brightCyan: "#14b8a6",
  brightWhite: "#ffffff",
};

export const XTERM_DARK_THEME = {
  background: "#000000",
  foreground: "#faf9f6",
  cursor: "#cbb0f7",
  selectionBackground: "rgba(203, 176, 247, 0.25)",
  black: "#121212",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#cbb0f7",
  cyan: "#cbb0f7",
  white: "#faf9f6",
  brightBlack: "#777777",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#dfc8ff",
  brightCyan: "#dfc8ff",
  brightWhite: "#ffffff",
};

/** 读 <html> 上算出来的 CSS 变量，读不到就退回 fallback。 */
function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * xterm 配色。
 *
 * 刻意不用 xterm 的 ITheme —— 那个类型每一项都是可选的，于是
 * theme.background 变成 string | undefined，后面塞进 DOM style 和 OSC
 * 序列时就得到处判空。自己收窄成必填字符串，一次转换，全链路干净。
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * 由当前外观档案推导 xterm 配色。
 *
 * ANSI 16 色直接映射外观的十组色：面板当黑、正文当白、强调色当黄光标，
 * 次要色当蓝、高亮色当品红，语义色原样给红绿。这样「换一套配色」时
 * 终端里的 diff 绿/错误红也一起跟着变，不会出现界面变了、终端还是旧配色。
 */
export function buildTerminalTheme(isDark: boolean): XtermTheme {
  const fallback = isDark ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
  const canvas = cssColor("--color-canvas", fallback.background);
  const panel = cssColor("--color-rail", fallback.black);
  const card = cssColor("--color-card", fallback.white);
  const ink = cssColor("--color-ink", fallback.foreground);
  const muted = cssColor("--color-graphite", fallback.brightBlack);
  const accent = cssColor("--color-teal", fallback.cursor);
  const accentAlt = cssColor("--color-teal-hover", fallback.brightYellow);
  const secondary = cssColor("--color-secondary", fallback.blue);
  const highlight = cssColor("--color-highlight", fallback.magenta);
  const gain = cssColor("--color-gain", fallback.green);
  const loss = cssColor("--color-loss", fallback.red);
  // 终端透明度：外观设置写进 --aw-terminal-bg-alpha（0..1）。文字永不透明，只有底色透
  const alphaRaw = Number(cssColor("--aw-terminal-bg-alpha", "1"));
  const terminalAlpha = Number.isFinite(alphaRaw) ? Math.min(1, Math.max(0, alphaRaw)) : 1;

  return {
    background: withAlpha(canvas, terminalAlpha),
    foreground: toHex(ink, fallback.foreground),
    cursor: toHex(accent, fallback.cursor),
    selectionBackground: cssColor("--color-selection", fallback.selectionBackground),
    black: toHex(panel, fallback.black),
    red: toHex(loss, fallback.red),
    green: toHex(gain, fallback.green),
    yellow: toHex(accent, fallback.yellow),
    blue: toHex(secondary, fallback.blue),
    magenta: toHex(highlight, fallback.magenta),
    cyan: toHex(secondary, fallback.cyan),
    white: toHex(card, fallback.white),
    brightBlack: toHex(muted, fallback.brightBlack),
    brightRed: toHex(loss, fallback.brightRed),
    brightGreen: toHex(gain, fallback.brightGreen),
    brightYellow: toHex(accentAlt, fallback.brightYellow),
    brightBlue: toHex(secondary, fallback.brightBlue),
    brightMagenta: toHex(highlight, fallback.brightMagenta),
    brightCyan: toHex(accentAlt, fallback.brightCyan),
    brightWhite: toHex(ink, fallback.brightWhite),
  };
}

/**
 * 构造发往后台 PTY 的主题变更通知序列。
 *
 * 前台跑的 TUI 应用靠两个信号感知明暗切换：
 *   - DEC Mode 997（带 1=暗 / 2=亮参数），部分 TUI 只认这个
 *   - OSC 10/11 颜色通报，程序主动来问「前景/背景色是什么」时回它
 * 两段一起发，两类实现都能立刻重绘，不用重启会话。
 * 颜色来自当前外观档案，用户改过配色后通报的也是新色。
 */
export function buildThemeNotification(theme: XtermTheme, isDark: boolean): string {
  const fg = toHex(theme.foreground, "#000000").slice(1);
  const bg = toHex(theme.background, "#ffffff").slice(1);
  const fg16 = (fg.match(/../g) ?? []).map((part) => part.padStart(2, "0")).join("/");
  const bg16 = (bg.match(/../g) ?? []).map((part) => part.padStart(2, "0")).join("/");
  return (
    `\x1b[?997;${isDark ? 1 : 2}n` +
    `\x1b]10;rgb:${fg16}\x1b\\` +
    `\x1b]11;rgb:${bg16}\x1b\\` +
    `\x1b]10;#${fg}\x07` +
    `\x1b]11;#${bg}\x07`
  );
}

export function getIsDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.classList.contains("dark") ||
    document.documentElement.getAttribute("data-theme") === "dark"
  );
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
  canvasAddon: CanvasAddon | null = null;
  shell: string;
  cwd: string;
  executorId?: string;
  unitId?: string;

  /** 首帧输出到达前是否还可写入回放（避免与实时帧交叠） */
  private disposed = false;
  private readonly attachScrollback?: string;
  /** 重挂只对第一次 boot 生效：restart()/重启必须走 terminal.create 复活进程 */
  private pendingReattach = false;
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
    this.unitId = opts.unitId;
    this.onExitCallback = opts.onExit;
    this.attachScrollback = opts.attachScrollback;
    this.pendingReattach = opts.attachScrollback !== undefined;

    // 创建持久化包装容器
    this.element = document.createElement("div");
    this.element.className = "w-full h-full relative overflow-hidden bg-card";
    this.element.setAttribute("data-terminal-id", this.terminalId);

    // 对齐 VS Code xtermTerminal.ts 配置
    const isDark = getIsDarkMode();
    this.term = new Terminal({
      allowProposedApi: true,
      // 底色带 alpha 时透出后面的壁纸；必须在构造时给，事后切换无效
      allowTransparency: true,
      fontSize: 13,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: false,
      customGlyphs: true,
      minimumContrastRatio: 4.5,
      smoothScrollDuration: 0,
      fastScrollSensitivity: 3,
      scrollSensitivity: 1,
      windowsPty: {
        backend: "conpty",
        buildNumber: 22621,
      },
      theme: isDark ? XTERM_DARK_THEME : XTERM_LIGHT_THEME,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.unicode11 = new Unicode11Addon();
    this.term.loadAddon(this.unicode11);
    this.term.unicode.activeVersion = "11";

    try {
      this.canvasAddon = new CanvasAddon();
      this.term.loadAddon(this.canvasAddon);
    } catch (err) {
      console.warn("[terminal] Canvas addon fallback:", err);
    }

    // 打开到包装元素并立即应用当前主题底色
    this.term.open(this.element);
    this.applyTheme(isDark);

    // 订阅后台 PTY 帧
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const onFrame = (f: DaemonTerminalFrame): void => {
      if (f.terminalId !== this.terminalId) return;
      if (f.kind === "data" && f.data !== undefined) {
        // 自动应答 CLI 发起的 OSC 10 / OSC 11 终端前景色与背景色查询（如 Codex, bat, fzf, vim 等）
        if (f.data.includes("]10;?") || f.data.includes("]11;?")) {
          const isDarkNow = getIsDarkMode();
          const oscReply = isDarkNow
            ? "\x1b]10;rgb:fafa/f9f9/f6f6\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\\x1b]10;#faf9f6\x07\x1b]11;#000000\x07"
            : "\x1b]10;rgb:2626/2525/1e1e\x1b\\\x1b]11;rgb:f2f2/f1f1/eded\x1b\\\x1b]10;#26251e\x07\x1b]11;#f2f1ed\x07";
          void client
            .rpc("terminal.input", { terminalId: this.terminalId, data: oscReply }, 3000)
            .catch(() => {});
        }
        this.term.write(f.data);
      }
      if (f.kind === "exit") {
        const code = f.exitCode ?? 0;
        this.term.write(`\r\n\x1b[2m[进程已退出，exit=${code}]\x1b[0m\r\n`);
        this.onExitCallback?.(code);
      }
    };
    this.unsubFrame = client.onTerminalFrame(onFrame);

    // 重挂回放：订阅完帧立即写快照 —— 不等首条实时帧（空闲的 PTY 可能永远不出帧，
    // 等它 = 空白屏）。订阅之后的实时帧自然接在快照后面，顺序正确。
    if (this.attachScrollback !== undefined && this.attachScrollback !== "") {
      this.term.write(this.attachScrollback);
    }

    // 高频输入批次缓冲（对齐 VS Code 流式调度）：
    // 鼠标拖拽、连续移动、快速滚轮会产生高密度的 DEC/SGR 字符序列，
    // 在 4ms 微批次内合并发送，避免数百次并发 RPC 造成 WebSocket 阻塞与丢帧。
    let inputBatch = "";
    let inputBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const flushInputBatch = () => {
      if (!inputBatch) return;
      const dataToSend = inputBatch;
      inputBatch = "";
      inputBatchTimer = null;
      void client
        .rpc("terminal.input", { terminalId: this.terminalId, data: dataToSend }, 8000)
        .catch(() => {});
    };

    this.term.onData((data) => {
      inputBatch += data;
      if (!inputBatchTimer) {
        inputBatchTimer = setTimeout(flushInputBatch, 4);
      }
    });

    // 滚轮事件分流（对齐 VS Code 终端规范）：
    // 1. 若应用已开启终端鼠标追踪（DECSET 1000/1002/1006，例如 ZCode、htop 等），放行原生滚轮，
    //    让 xterm.js 自动生成标准的 SGR Mouse Wheel 序列 (\x1b[<64;...M / \x1b[<65;...M) 给应用程序；
    // 2. 仅当应用未开启鼠标追踪、且处于备用屏幕缓冲（alternate buffer）时，才回退映射为方向键驱动滚动；
    // 3. 普通主屏幕放行 xterm.js 历史回滚。
    this.term.attachCustomWheelEventHandler((e: WheelEvent) => {
      if (e.shiftKey) return true;
      const mouseMode = this.term.modes.mouseTrackingMode;
      if (mouseMode && mouseMode !== "none") {
        // TUI 程序主动启用了鼠标追踪，必须放行以触发 xterm 原生 SGR 鼠标报告！
        return true;
      }

      if (this.term.buffer.active.type === "alternate") {
        const isUp = e.deltaY < 0;
        const steps = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 35)));
        const payload = (isUp ? "\x1b[A" : "\x1b[B").repeat(steps);
        inputBatch += payload;
        if (!inputBatchTimer) {
          inputBatchTimer = setTimeout(flushInputBatch, 4);
        }
        return false;
      }
      return true;
    });

    // 监听包装容器的尺寸变化
    this.resizeObserver = new ResizeObserver(() => {
      this.syncResize(false);
    });
    this.resizeObserver.observe(this.element);

    // 启动真 PTY 进程。失败必须落到终端画布上 —— void 掉的 rejection
    // 只会留一块空白窗格，用户无从知道是 daemon 没起还是 cwd 非法。
    void this.boot().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.term.write(`\r\n\x1b[31m[终端启动失败：${msg}]\x1b[0m\r\n`);
    });
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

    const isDark = getIsDarkMode();
    // 重挂模式：PTY 已在 daemon 活着，绝不能再 create（同 id 会起第二个进程）。
    // 只把 PTY 尺寸对齐到当前窗格 —— F5 前后窗格大小很可能不同。
    // 一次性：restart()/重启会再次 boot，届时必须走 create 复活进程。
    if (this.pendingReattach) {
      this.pendingReattach = false;
      await client
        .rpc("terminal.resize", { terminalId: this.terminalId, cols, rows }, 8000)
        .catch(() => {});
      return;
    }

    await client.rpc(
      "terminal.create",
      {
        terminalId: this.terminalId,
        shell: this.shell,
        cwd: this.cwd,
        cols,
        rows,
        executorId: this.executorId,
        unitId: this.unitId,
        env: {
          COLORFGBG: isDark ? "15;0" : "0;15",
        },
      },
      15000,
    );

    if (this.disposed) {
      void client.rpc("terminal.kill", { terminalId: this.terminalId }).catch(() => {});
    }
  }

  attachTo(container: HTMLElement): void {
    // 确保清理容器中任何残留的非本终端 DOM 元素，杜绝多实例叠置遮挡 Bug
    while (container.firstChild && container.firstChild !== this.element) {
      container.removeChild(container.firstChild);
    }
    if (this.element.parentElement !== container) {
      container.appendChild(this.element);
    }
    const isDark = getIsDarkMode();
    this.applyTheme(isDark);
  }

  /**
   * 动态切换终端配色主题（深色/浅色），立即穿透更新 DOM 与 xterm 内部渲染图层
   */
  applyTheme(isDark: boolean): void {
    const theme = buildTerminalTheme(isDark);

    // 1. 同步更新 xterm options 配置
    // ⚠ 注意：必须使用 options.theme = { ...theme }，切勿将整个包含 cols/rows 的 options 覆盖，避免 constructor 校验抛错
    try {
      this.term.options.theme = { ...theme };
      this.term.options.minimumContrastRatio = 4.5;
    } catch (err) {
      console.warn("[terminal] failed to update term.options.theme:", err);
    }

    // 2. 深度穿透设置包装 DOM、xterm 根层与视口背景
    this.element.style.backgroundColor = theme.background;
    if (this.term.element) {
      this.term.element.style.backgroundColor = theme.background;
    }
    const viewports = this.element.querySelectorAll<HTMLElement>(".xterm-viewport");
    viewports.forEach((node) => {
      node.style.backgroundColor = theme.background;
    });
    // ⚠ 关键修复：绝对不能给 canvas 节点设置非透明背景色！
    // xterm-cursor-layer、xterm-link-layer、xterm-selection-layer 叠加在 xterm-text-layer 之上，
    // 若具有非透明背景色，将完全遮挡底层文本图层（导致仅可见光标而文字消失）。
    const canvases = this.element.querySelectorAll<HTMLCanvasElement>("canvas");
    canvases.forEach((canvas) => {
      canvas.style.backgroundColor = "transparent";
    });

    // 3. 强制标记全屏行脏数据并重绘，清除选区残影
    try {
      this.term.clearSelection();
      this.term.refresh(0, Math.max(1, this.term.rows - 1));
    } catch {}

    // 4. 重算尺寸与自适应布局
    this.fit(true);

    // 5. 双帧调度确保渲染管线在下个事件循环彻底重绘画布背景
    requestAnimationFrame(() => {
      try {
        this.term.refresh(0, Math.max(1, this.term.rows - 1));
      } catch {}
      requestAnimationFrame(() => {
        try {
          this.term.refresh(0, Math.max(1, this.term.rows - 1));
        } catch {}
      });
    });

    // 6. 向后台 PTY 注入终端主题模式通知（DEC Mode 2031 + OSC 10/11 颜色通报）
    // 让正在前台运行的 TUI 应用（如 ZCode、Codex 等）立即同步收到主题变更信号，触发内置的主题重绘！
    // 颜色取自当前外观档案推导出的终端配色，用户改过配色后通报的也是新色。
    try {
      const client = DaemonClient.get(defaultDaemonEndpoint());
      const themeSeq = buildThemeNotification(theme, isDark);
      void client
        .rpc("terminal.input", { terminalId: this.terminalId, data: themeSeq }, 3000)
        .catch(() => {});

      // 7. 发送尺寸微调 (jitter resize) 通知后台 PTY / ConPTY 触发全屏 TUI 重绘 (SIGWINCH)
      // OpenTUI 与 crossterm 内部防抖通常为 100ms，微颤维持 120ms，确保子进程防抖定时器捕获并原位全屏刷新
      const cols = this.lastCols;
      const rows = this.lastRows;
      if (cols >= 10 && rows >= 4) {
        const jitterCols = cols > 20 ? cols - 1 : cols + 1;
        this.term.resize(jitterCols, rows);
        void client
          .rpc("terminal.resize", { terminalId: this.terminalId, cols: jitterCols, rows }, 8000)
          .catch(() => {});
        setTimeout(() => {
          if (this.disposed) return;
          this.term.resize(cols, rows);
          void client
            .rpc("terminal.resize", { terminalId: this.terminalId, cols, rows }, 8000)
            .catch(() => {});
          this.term.refresh(0, Math.max(1, this.term.rows - 1));
        }, 120);
      }
    } catch {}
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

  sendData(data: string): void {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client
      .rpc("terminal.input", { terminalId: this.terminalId, data }, 3000)
      .catch(() => {});
  }

  clear(): void {
    this.term.clear();
    this.sendData("\x0c");
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
      this.canvasAddon?.dispose();
    } catch {}
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

  updateAllThemes(isDark: boolean): void {
    for (const session of this.sessions.values()) {
      session.applyTheme(isDark);
    }
  }
}

export const terminalSessionRegistry = new TerminalSessionRegistry();
export const TerminalSessionManager = terminalSessionRegistry;

/**
 * 对话页小终端（Chat Terminal Dock）在 daemon 侧的 unitId 标记。
 *
 * 放这个叶子模块而不是 useChatTerminal：TUI 的 useTerminalStore（created 帧认领 /
 * F5 重挂）要按它跳过对话终端，而 useChatTerminal 又要引这里的注册表 ——
 * 标记若挂在这两个 store 任何一边都是环，这里是它们共同的叶子依赖。
 */
export const CHAT_DOCK_UNIT_ID = "__chatdock__";
