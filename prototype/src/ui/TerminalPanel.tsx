import { useEffect, useRef, useState } from "react";
import { SquareTerminal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { DaemonClient, DEFAULT_DAEMON_ENDPOINT, type DaemonTerminalFrame } from "../adapters/daemon/client.ts";

/**
 * 终端面板（单窗格）—— 对应 ZCode 的 AnimatedTerminalPanel。
 *
 * 接的是 daemon 的真 PTY（Phase 2 WS 帧，ConPTY）：
 * terminal.create（cwd = 工作单元根目录）→ data 帧进 xterm →
 * xterm.onData → terminal.input → ResizeObserver → terminal.resize。
 * 每个窗格一条独立 PTY（TerminalPage 可多窗格并开）。
 * daemon 不可达时降级为能力说明卡（不白屏）。
 *
 * 入口两种：
 * - dock（默认）：会话下方的可开关面板（默认 30% 高，X = toggleTerminal）；
 * - page：会话头「终端」页签的窗格（TerminalPage 可多窗格并开）。
 */
export function TerminalPanel({
  variant = "dock",
  onClose,
  label,
}: {
  variant?: "dock" | "page";
  /** 覆盖关闭行为（TerminalPage 的多窗格：关自己的窗格 / 最后一格切回对话） */
  onClose?: () => void;
  /** 窗格标题（多窗格时显示 终端 #n） */
  label?: string;
} = {}) {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const setConversationView = useShell((s) => s.setConversationView);

  const isPage = variant === "page";
  const closeTerminal = onClose ?? (isPage ? () => setConversationView("chat") : toggleTerminal);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [daemonDown, setDaemonDown] = useState(false);
  const [exited, setExited] = useState<number | null>(null);

  // 真 PTY 生命周期：mount → create + 接帧；unmount → kill
  useEffect(() => {
    if (!unit?.rootPath) return;
    let disposed = false;
    let unsubs: Array<() => void> = [];
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      convertEol: true,
      theme: { background: "#14161b", foreground: "#d6dae2", cursor: "#5fb3a1" },
    });
    termRef.current = term;

    const client = DaemonClient.get(DEFAULT_DAEMON_ENDPOINT);
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
      // 按容器尺寸估列数/行数（12px 等宽：字符宽约 7.2px、行高约 17px）
      const rect = containerRef.current!.getBoundingClientRect();
      const cols = Math.max(20, Math.floor(rect.width / 7.2));
      const rows = Math.max(8, Math.floor(rect.height / 17));
      const created = await client.rpc<{ terminalId: string; shell: string }>(
        "terminal.create",
        { cwd: unit.rootPath, cols, rows },
        15000,
      );
      if (disposed) {
        void client.rpc("terminal.kill", { terminalId: created.terminalId }).catch(() => {});
        return;
      }
      terminalIdRef.current = created.terminalId;
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
      const cols = Math.max(20, Math.floor(rect.width / 7.2));
      const rows = Math.max(8, Math.floor(rect.height / 17));
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
  }, [unit?.rootPath]);

  return (
    <div
      className={
        isPage
          ? "flex h-full min-h-0 flex-col bg-canvas"
          : "flex h-full min-h-0 flex-col border-t border-line bg-canvas"
      }
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SquareTerminal size={12} className="text-ash" />
        <span className="text-body-sm text-graphite">{label ?? "终端"}</span>
        {isPage && <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">全屏页签</span>}
        <span className="ml-auto font-mono text-caption text-ash">
          {exited !== null ? `已退出 (exit ${exited})` : (unit?.name ?? "")}
        </span>
        <button
          onClick={closeTerminal}
          aria-label={isPage ? "关闭终端窗格" : "关闭终端"}
          title={isPage ? undefined : "关闭终端"}
          className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
        >
          <X size={12} />
        </button>
      </div>

      {daemonDown ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-body-sm leading-relaxed text-ash">
          <p>daemon 不可达，无真实 PTY。</p>
          <p className="mt-1">当前工作单元能力：</p>
          {runtime !== null && runtime !== undefined
            ? Object.entries(runtime.capabilities)
                .filter(([, v]) => v)
                .map(([k]) => (
                  <p key={k} className="text-gain">
                    {"  ✓ "}
                    {k}
                  </p>
                ))
            : null}
        </div>
      ) : (
        /* xterm 挂载点：padding 收紧给 PTY 让位 */
        <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-1 py-1" />
      )}
    </div>
  );
}
