import { useEffect, useRef, useState } from "react";
import {
  SquareTerminal,
  X,
  RotateCw,
  Trash2,
  FolderOpen,
  MessageSquare,
  Sparkles,
  Zap,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { DaemonClient, defaultDaemonEndpoint, openFolder, type DaemonTerminalFrame } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/**
 * 终端面板（单窗格 / 主工作台画布）—— 对应路径 A 的核心 TUI 载体。
 *
 * 接的是 daemon 的真 PTY（ConPTY）：
 * terminal.create（cwd = 工作单元根目录，executorId = 当前活跃执行器）
 * → data 帧进 xterm → xterm.onData → terminal.input → ResizeObserver（FitAddon 精确测算网格 + 防抖）→ terminal.resize。
 *
 * 入口三种：
 * - canvas（主视图）：会话区域的主画布（100% 充满，原生 TUI 与斜杠命令交互）；
 * - dock：会话底部的可收起面板（默认 30% 高）；
 * - page：全屏页签窗格。
 */
export function TerminalPanel({
  variant = "dock",
  onClose,
  label,
}: {
  variant?: "dock" | "page" | "canvas";
  /** 覆盖关闭行为 */
  onClose?: () => void;
  /** 窗格标题 */
  label?: string;
} = {}) {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const setConversationView = useShell((s) => s.setConversationView);

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  const closeTerminal = onClose ?? (isPage || isCanvas ? () => setConversationView("chat") : toggleTerminal);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [daemonDown, setDaemonDown] = useState(false);
  const [exited, setExited] = useState<number | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  const handleRestart = () => {
    setRestartNonce((n) => n + 1);
  };

  const handleClear = () => {
    termRef.current?.clear();
    const tid = terminalIdRef.current;
    if (tid !== null) {
      // 向底层真 PTY 发送 0x0c (Ctrl+L)，触发 CLI 进程（ZCode CLI / Ink 等）全量重绘屏幕，彻底治愈残影
      const client = DaemonClient.get(defaultDaemonEndpoint());
      void client.rpc("terminal.input", { terminalId: tid, data: "\x0c" }, 3000).catch(() => {});
    }
  };

  // 真 PTY 生命周期：mount / 切换 Bot / 换执行器 / 点击重启 → 杀旧起新
  useEffect(() => {
    if (!unit?.rootPath) return;
    let disposed = false;
    let unsubs: Array<() => void> = [];
    setExited(null);

    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: "bar",
      // 真 PTY（Windows ConPTY）自行处理 \r\n；开启 convertEol 会导致单发 \n 被强行移回第 0 列，破坏 TUI 布局
      convertEol: false,
      customGlyphs: true,
      allowTransparency: false,
      smoothScrollDuration: 0,
      scrollSensitivity: 1,
      fastScrollSensitivity: 3,
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
    termRef.current = term;

    // 官方 FitAddon：精确测量字符物理像素并自适应容器
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Unicode 11 规范支持：让中文、制表符、Emoji 等宽字符对齐标准（对齐 Windows Terminal）
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    // Canvas GPU 硬件加速渲染器：基于物理像素点阵绘制字符，消除 DOM 模式下背景块与制表符的亚像素舍入断裂与错位
    try {
      const canvasAddon = new CanvasAddon();
      term.loadAddon(canvasAddon);
    } catch (err) {
      console.warn("[terminal] Canvas addon fallback to DOM:", err);
    }

    // 事先生成 terminalId，避免首批 PTY 帧在 RPC 往返期间漏发
    const myTerminalId = `term_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    terminalIdRef.current = myTerminalId;
    (window as unknown as { __AGENT_TERMINAL_ID?: string; __AGENT_TERM?: Terminal }).__AGENT_TERMINAL_ID = myTerminalId;
    (window as unknown as { __AGENT_TERMINAL_ID?: string; __AGENT_TERM?: Terminal }).__AGENT_TERM = term;

    const client = DaemonClient.get(defaultDaemonEndpoint());
    const onFrame = (f: DaemonTerminalFrame): void => {
      if (f.terminalId !== terminalIdRef.current) return;
      if (f.kind === "data" && f.data !== undefined) term.write(f.data);
      if (f.kind === "exit") {
        setExited(f.exitCode ?? 0);
        term.write(`\r\n\x1b[2m[进程已退出，exit=${f.exitCode ?? 0}]\x1b[0m\r\n`);
      }
    };
    unsubs.push(client.onTerminalFrame(onFrame));

    let lastCols = 80;
    let lastRows = 24;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const boot = async (): Promise<void> => {
      await client.ensureConnected();
      if (disposed) return;
      term.open(containerRef.current!);
      term.focus();

      // 在 DOM 挂载后，用 FitAddon 精确获取当前容器可用行列数，绝不因写死宽度多算导致溢出折行
      let cols = 80;
      let rows = 24;
      try {
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols >= 10 && dims.rows >= 4) {
          cols = dims.cols;
          rows = dims.rows;
          term.resize(cols, rows);
        }
      } catch {
        const rect = containerRef.current!.getBoundingClientRect();
        cols = Math.max(20, Math.floor((rect.width - 16) / 8.2));
        rows = Math.max(8, Math.floor((rect.height - 8) / 18));
        term.resize(cols, rows);
      }
      lastCols = cols;
      lastRows = rows;

      const created = await client.rpc<{ terminalId: string; shell: string; executor?: string }>(
        "terminal.create",
        {
          terminalId: myTerminalId,
          cwd: unit.rootPath,
          cols,
          rows,
          executorId: activeRuntimeId,
        },
        15000,
      );

      if (disposed) {
        void client.rpc("terminal.kill", { terminalId: created.terminalId }).catch(() => {});
        return;
      }

      term.onData((data) => {
        if (terminalIdRef.current === null) return;
        void client.rpc("terminal.input", { terminalId: terminalIdRef.current, data }, 8000).catch(() => {});
      });

      // 1. 挂载官方自定义滚轮事件分发器（对齐 VS Code 终端）：
      // 当处于 TUI 界面时，阻止 xterm.js 默认滚动空的 scrollback 历史，
      // 将滚轮精准转换为对应字符网格坐标的 SGR 鼠标滚轮转义序列（\x1b[<64... / \x1b[<65...）直通 PTY，
      // 驱动 OpenTUI 的 ScrollBoxRenderable 和滑动条上下滑动；按住 Shift 则放行供划词复制。
      const getCellCoords = (e: MouseEvent | WheelEvent): { col: number; row: number } | null => {
        const el = containerRef.current;
        if (!el) return null;
        const screenEl = (el.querySelector(".xterm-screen") as HTMLElement | null) ?? el;
        const rect = screenEl.getBoundingClientRect();
        const curCols = term.cols || 80;
        const curRows = term.rows || 24;
        const cellW = rect.width / curCols;
        const cellH = rect.height / curRows;
        if (cellW <= 0 || cellH <= 0) return null;
        const col = Math.min(curCols, Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1));
        const row = Math.min(curRows, Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1));
        return { col, row };
      };

      // 1. 挂载自定义滚轮事件分发器（对齐 VS Code 终端）：
      // 在 TUI 交互界面中，将鼠标滚轮精准转换为光标方向键（ArrowUp: \x1b[A / ArrowDown: \x1b[B），
      // 直接驱动 CLI 内部的视口与滑动条平滑上下翻滚；按住 Shift 则放行供划词复制。
      term.attachCustomWheelEventHandler((e: WheelEvent) => {
        if (e.shiftKey) return true;
        const tid = terminalIdRef.current;
        if (tid === null) return true;

        // 滚轮方向：向上为 ArrowUp (\x1b[A)，向下为 ArrowDown (\x1b[B)
        const isUp = e.deltaY < 0;
        // 计算步长：根据滚轮幅度发送 1 ~ 3 个方向键，确保手感轻盈丝滑
        const steps = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 35)));
        const keySeq = isUp ? "\x1b[A" : "\x1b[B";
        const payload = keySeq.repeat(steps);

        void client.rpc("terminal.input", { terminalId: tid, data: payload }, 3000).catch(() => {});
        return false; // 拦截默认的历史滚动
      });

      // 2. 滑动条与视口点击交互：
      // 当用户用鼠标左键直接点击滑动条所在列或轨道时，分流发送 PageUp/PageDown 实现直觉式翻页
      const containerEl = containerRef.current;
      if (containerEl !== null) {
        const onMouseDown = (e: MouseEvent) => {
          if (e.shiftKey || e.button !== 0) return;
          const tid = terminalIdRef.current;
          if (tid === null) return;
          const coords = getCellCoords(e);
          if (!coords) return;

          const curCols = term.cols || 80;
          const curRows = term.rows || 24;

          // 探测是否点击在右侧分割线/滑动条附近（通常在中间偏右或终端右边缘）
          // 若点击在中下部则向下翻页（PageDown），点击在上部则向上翻页（PageUp）
          const isScrollbarArea = coords.col >= Math.floor(curCols * 0.45) && coords.col <= Math.ceil(curCols * 0.55);
          if (isScrollbarArea) {
            const isTopHalf = coords.row < Math.floor(curRows / 2);
            const navSeq = isTopHalf ? "\x1b[5~" : "\x1b[6~"; // PageUp or PageDown
            void client.rpc("terminal.input", { terminalId: tid, data: navSeq }, 3000).catch(() => {});
          }
        };

        containerEl.addEventListener("mousedown", onMouseDown);
        unsubs.push(() => {
          containerEl.removeEventListener("mousedown", onMouseDown);
        });
      }
    };

    void boot().catch((err: unknown) => {
      if (!disposed) {
        setDaemonDown(true);
        console.warn("[terminal] PTY 创建失败（daemon 不可达？）", err instanceof Error ? err.message : err);
      }
    });

    // 尺寸响应：使用 FitAddon 精确计算 + 防抖向 PTY 发送 resize
    const syncResize = (immediate = false) => {
      const el = containerRef.current;
      const tid = terminalIdRef.current;
      if (disposed || el === null || tid === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;

      try {
        const dims = fitAddon.proposeDimensions();
        if (!dims || dims.cols < 10 || dims.rows < 4) return;

        // 若尺寸未变，坚决不发冗余事件
        if (dims.cols === lastCols && dims.rows === lastRows) return;

        const newCols = dims.cols;
        const newRows = dims.rows;
        lastCols = newCols;
        lastRows = newRows;

        // 本地 xterm 立即跟随缩放
        term.resize(newCols, newRows);

        // 防抖 60ms：避免拖拽或过渡动画期间向 Windows ConPTY 发送风暴式 resize 打烂缓冲
        if (resizeTimer) clearTimeout(resizeTimer);
        if (immediate) {
          void client.rpc("terminal.resize", { terminalId: tid, cols: newCols, rows: newRows }, 8000).catch(() => {});
        } else {
          resizeTimer = setTimeout(() => {
            if (disposed || terminalIdRef.current !== tid) return;
            void client.rpc("terminal.resize", { terminalId: tid, cols: newCols, rows: newRows }, 8000).catch(() => {});
          }, 60);
        }
      } catch {
        // 忽略动画中短时测量异常
      }
    };

    const ro = new ResizeObserver(() => {
      syncResize(false);
    });
    if (containerRef.current !== null) ro.observe(containerRef.current);

    // 字体就绪时，再次精准校准一次尺寸
    if (typeof document !== "undefined" && document.fonts) {
      void document.fonts.ready.then(() => {
        if (!disposed) syncResize(true);
      });
    }

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      for (const u of unsubs) u();
      const tid = terminalIdRef.current;
      if (tid !== null) {
        void client.rpc("terminal.kill", { terminalId: tid }, 5000).catch(() => {});
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      terminalIdRef.current = null;
    };
  }, [unit?.rootPath, activeRuntimeId, restartNonce]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col bg-[#0f1115]",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* 终端顶部操作栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line/40 bg-[#14171f] px-3">
        <SquareTerminal size={13} className="text-teal" />
        <span className="text-body-sm font-medium text-ink">
          {label ?? (isCanvas ? "交互终端 (TUI)" : "终端")}
        </span>

        {/* 活跃执行器与目录 */}
        {unit && (
          <div className="flex items-center gap-1.5 font-mono text-caption text-ash">
            <span className="text-line">|</span>
            <span className="flex items-center gap-1 rounded bg-teal/10 px-1.5 py-0.5 text-teal">
              <Zap size={10} />
              <span>{runtime?.presentation.displayName ?? activeRuntimeId}</span>
            </span>
            <span className="hidden md:inline text-ash/80 truncate max-w-[260px]" title={unit.rootPath}>
              {unit.name}
            </span>
          </div>
        )}

        {/* 提示与状态 */}
        <div className="ml-auto flex items-center gap-1.5">
          {exited !== null ? (
            <span className="rounded bg-rose-500/10 px-1.5 py-0.5 font-mono text-caption text-rose-400">
              已退出 ({exited})
            </span>
          ) : isCanvas ? (
            <span className="hidden lg:flex items-center gap-1 text-[11px] text-ash font-mono">
              <Sparkles size={11} className="text-teal/70" />
              <span>原生斜杠命令 (/compact, /help) 及交互快捷键已就绪</span>
            </span>
          ) : null}

          {/* 清屏按钮 */}
          <button
            onClick={handleClear}
            title="清空终端屏幕"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Trash2 size={11} />
            <span className="hidden sm:inline">清屏</span>
          </button>

          {/* 重启执行器按钮 */}
          <button
            onClick={handleRestart}
            title="重启当前 Agent CLI 终端会话"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-teal-tint hover:text-teal transition"
          >
            <RotateCw size={11} />
            <span className="hidden sm:inline">重启 CLI</span>
          </button>

          {/* 在资源管理器打开目录 */}
          {unit && (
            <button
              onClick={() => void openFolder({ path: unit.rootPath }).catch(() => {})}
              title="在系统资源管理器中打开工作空间"
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <FolderOpen size={12} />
            </button>
          )}

          {/* 若在主画布，提供一键切至会话历史 */}
          {isCanvas && (
            <button
              onClick={() => setConversationView("chat")}
              title="切换至会话与历史列表视图"
              className="flex items-center gap-1 rounded-btn bg-line-soft/60 px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
            >
              <MessageSquare size={11} />
              <span className="hidden sm:inline">会话历史</span>
            </button>
          )}

          {/* 关抽屉按钮（非 canvas 态） */}
          {!isCanvas && (
            <button
              onClick={closeTerminal}
              aria-label={isPage ? "关闭终端窗格" : "关闭终端"}
              title={isPage ? undefined : "关闭终端"}
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {unit === undefined ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <p className="text-body-sm text-ash">
            终端需要一个工作目录才能启动。请在左侧侧边栏选择一个 Bot 或工作空间。
          </p>
        </div>
      ) : daemonDown ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 font-mono text-body-sm leading-relaxed text-ash">
          <p className="text-amber-400 font-semibold">⚠ 后台 daemon 服务暂未启动或连接中断</p>
          <p className="mt-2 text-graphite">
            无法创建真 PTY 交互终端。请确保后台服务已运行：
          </p>
          <pre className="mt-2 rounded bg-black/40 p-2.5 text-caption text-teal font-mono">
            pnpm run dev
          </pre>
          <p className="mt-3 text-caption text-ash">
            daemon 启动后将自动监听 5281 端口，并由 ConPTY 提供原生 TUI 支持。
          </p>
        </div>
      ) : (
        /* xterm 挂载点：移除外层 padding，确保 FitAddon 精准贴合容器边界，绝不多算一列导致意外折行 */
        <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-[#0f1115]" />
      )}
    </div>
  );
}
