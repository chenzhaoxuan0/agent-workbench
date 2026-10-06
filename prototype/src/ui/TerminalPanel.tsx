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
 * → data 帧进 xterm → xterm.onData → terminal.input → ResizeObserver → terminal.resize。
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
  const terminalIdRef = useRef<string | null>(null);
  const [daemonDown, setDaemonDown] = useState(false);
  const [exited, setExited] = useState<number | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  const handleRestart = () => {
    setRestartNonce((n) => n + 1);
  };

  const handleClear = () => {
    termRef.current?.clear();
  };

  // 真 PTY 生命周期：mount / 切换 Bot / 换执行器 / 点击重启 → 杀旧起新
  useEffect(() => {
    if (!unit?.rootPath) return;
    let disposed = false;
    let unsubs: Array<() => void> = [];
    setExited(null);

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: true,
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

    // 事先生成 terminalId，避免首批 PTY 帧在 RPC 往返期间漏发
    const myTerminalId = `term_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    terminalIdRef.current = myTerminalId;

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

    const boot = async (): Promise<void> => {
      await client.ensureConnected();
      if (disposed) return;
      term.open(containerRef.current!);
      term.focus();

      // 按容器尺寸估列数/行数（13px 等宽：字符宽约 7.8px、行高约 18px）
      const rect = containerRef.current!.getBoundingClientRect();
      const cols = Math.max(20, Math.floor(rect.width / 7.8));
      const rows = Math.max(8, Math.floor(rect.height / 18));

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
    };

    void boot().catch((err: unknown) => {
      if (!disposed) {
        setDaemonDown(true);
        console.warn("[terminal] PTY 创建失败（daemon 不可达？）", err instanceof Error ? err.message : err);
      }
    });

    // 尺寸变化 → resize 帧
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      const tid = terminalIdRef.current;
      if (el === null || tid === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 60) return;
      const cols = Math.max(20, Math.floor(rect.width / 7.8));
      const rows = Math.max(8, Math.floor(rect.height / 18));
      term.resize(cols, rows);
      void client.rpc("terminal.resize", { terminalId: tid, cols, rows }, 8000).catch(() => {});
    });
    if (containerRef.current !== null) ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const u of unsubs) u();
      const tid = terminalIdRef.current;
      if (tid !== null) {
        void client.rpc("terminal.kill", { terminalId: tid }, 5000).catch(() => {});
      }
      termRef.current?.dispose();
      termRef.current = null;
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
        /* xterm 挂载点 */
        <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1.5" />
      )}
    </div>
  );
}
