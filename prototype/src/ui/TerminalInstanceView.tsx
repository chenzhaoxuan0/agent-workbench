import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  memo,
} from "react";
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

export interface TerminalInstanceHandle {
  clear: () => void;
  focus: () => void;
  restart: () => void;
  getTerminalId: () => string;
}

export interface TerminalInstanceViewProps {
  terminalId: string;
  shell: string;
  cwd: string;
  executorId?: string;
  isActive: boolean;
  onExited?: (code: number) => void;
}

export const TerminalInstanceView = memo(
  forwardRef<TerminalInstanceHandle, TerminalInstanceViewProps>(
    function TerminalInstanceView(
      {
        terminalId,
        shell,
        cwd,
        executorId,
        isActive,
        onExited,
      },
      ref,
    ) {
      const containerRef = useRef<HTMLDivElement>(null);
      const termRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      const [restartNonce, setRestartNonce] = useState(0);
      const [exited, setExited] = useState<number | null>(null);

      useImperativeHandle(
        ref,
        () => ({
          clear: () => {
            termRef.current?.clear();
            const client = DaemonClient.get(defaultDaemonEndpoint());
            void client
              .rpc("terminal.input", { terminalId, data: "\x0c" }, 3000)
              .catch(() => {});
          },
          focus: () => {
            termRef.current?.focus();
          },
          restart: () => {
            setRestartNonce((n) => n + 1);
          },
          getTerminalId: () => terminalId,
        }),
        [terminalId],
      );

      useEffect(() => {
        let disposed = false;
        const unsubs: Array<() => void> = [];
        setExited(null);

        // 对齐 VS Code xtermTerminal.ts 配置
        const term = new Terminal({
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
        termRef.current = term;

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.unicode.activeVersion = "11";

        try {
          const canvasAddon = new CanvasAddon();
          term.loadAddon(canvasAddon);
        } catch (err) {
          console.warn("[terminal] Canvas addon fallback:", err);
        }

        const client = DaemonClient.get(defaultDaemonEndpoint());

        // 订阅后台 PTY 帧
        const onFrame = (f: DaemonTerminalFrame): void => {
          if (f.terminalId !== terminalId) return;
          if (f.kind === "data" && f.data !== undefined) term.write(f.data);
          if (f.kind === "exit") {
            const code = f.exitCode ?? 0;
            setExited(code);
            onExited?.(code);
            term.write(`\r\n\x1b[2m[进程已退出，exit=${code}]\x1b[0m\r\n`);
          }
        };
        unsubs.push(client.onTerminalFrame(onFrame));

        let lastCols = 80;
        let lastRows = 24;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        const boot = async () => {
          await client.ensureConnected();
          if (disposed || !containerRef.current) return;

          term.open(containerRef.current);
          if (isActive) term.focus();

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
            const rect = containerRef.current.getBoundingClientRect();
            cols = Math.max(20, Math.floor((rect.width - 16) / 8.2));
            rows = Math.max(8, Math.floor((rect.height - 8) / 18));
            term.resize(cols, rows);
          }
          lastCols = cols;
          lastRows = rows;

          await client.rpc(
            "terminal.create",
            {
              terminalId,
              shell,
              cwd,
              cols,
              rows,
              executorId,
            },
            15000,
          );

          if (disposed) {
            void client.rpc("terminal.kill", { terminalId }).catch(() => {});
            return;
          }

          term.onData((data) => {
            void client
              .rpc("terminal.input", { terminalId, data }, 8000)
              .catch(() => {});
          });

          // 滚轮驱动逻辑（对齐 VS Code 终端处理）：
          // 备用屏幕缓冲（如 ZCode TUI、vim、less）下映射为光标键驱动平滑滚动；普通终端下放行默认历史滚动
          term.attachCustomWheelEventHandler((e: WheelEvent) => {
            if (e.shiftKey) return true;
            if (term.buffer.active.type === "alternate") {
              const isUp = e.deltaY < 0;
              const steps = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 35)));
              const payload = (isUp ? "\x1b[A" : "\x1b[B").repeat(steps);
              void client
                .rpc("terminal.input", { terminalId, data: payload }, 3000)
                .catch(() => {});
              return false;
            }
            return true;
          });

          // 滑动条与轨道点击分流
          const containerEl = containerRef.current;
          if (containerEl) {
            const onMouseDown = (e: MouseEvent) => {
              if (e.shiftKey || e.button !== 0) return;
              if (term.buffer.active.type !== "alternate") return;
              const rect = containerEl.getBoundingClientRect();
              const curCols = term.cols || 80;
              const curRows = term.rows || 24;
              const cellW = rect.width / curCols;
              const cellH = rect.height / curRows;
              if (cellW <= 0 || cellH <= 0) return;
              const col = Math.min(
                curCols,
                Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1),
              );
              const row = Math.min(
                curRows,
                Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1),
              );

              const isScrollbarArea =
                col >= Math.floor(curCols * 0.45) && col <= Math.ceil(curCols * 0.55);
              if (isScrollbarArea) {
                const isTopHalf = row < Math.floor(curRows / 2);
                void client
                  .rpc(
                    "terminal.input",
                    { terminalId, data: isTopHalf ? "\x1b[5~" : "\x1b[6~" },
                    3000,
                  )
                  .catch(() => {});
              }
            };

            containerEl.addEventListener("mousedown", onMouseDown);
            unsubs.push(() => {
              containerEl.removeEventListener("mousedown", onMouseDown);
            });
          }
        };

        void boot().catch((err: unknown) => {
          console.warn("[terminal] Boot error:", err);
        });

        // 尺寸自适应与防抖同步
        const syncResize = (immediate = false) => {
          const el = containerRef.current;
          if (disposed || !el) return;
          if (el.offsetParent === null) return;
          const rect = el.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 40) return;

          try {
            const dims = fitAddon.proposeDimensions();
            if (!dims || dims.cols < 10 || dims.rows < 4) return;
            if (dims.cols === lastCols && dims.rows === lastRows) return;

            const newCols = dims.cols;
            const newRows = dims.rows;
            lastCols = newCols;
            lastRows = newRows;

            term.resize(newCols, newRows);

            if (resizeTimer) clearTimeout(resizeTimer);
            if (immediate) {
              void client
                .rpc(
                  "terminal.resize",
                  { terminalId, cols: newCols, rows: newRows },
                  8000,
                )
                .catch(() => {});
            } else {
              resizeTimer = setTimeout(() => {
                if (disposed) return;
                void client
                  .rpc(
                    "terminal.resize",
                    { terminalId, cols: newCols, rows: newRows },
                    8000,
                  )
                  .catch(() => {});
              }, 60);
            }
          } catch {}
        };

        const ro = new ResizeObserver(() => syncResize(false));
        if (containerRef.current) ro.observe(containerRef.current);
        unsubs.push(() => ro.disconnect());

        if (typeof document !== "undefined" && document.fonts) {
          void document.fonts.ready.then(() => {
            if (!disposed) syncResize(true);
          });
        }

        return () => {
          disposed = true;
          if (resizeTimer) clearTimeout(resizeTimer);
          unsubs.forEach((u) => u());
          try {
            term.dispose();
          } catch {}
          void client.rpc("terminal.kill", { terminalId }).catch(() => {});
        };
      }, [terminalId, shell, cwd, executorId, restartNonce]);

      // 处于活跃状态时自动 focus 和重新 fit
      useEffect(() => {
        if (
          isActive &&
          termRef.current &&
          fitAddonRef.current &&
          containerRef.current
        ) {
          termRef.current.focus();
          try {
            const dims = fitAddonRef.current.proposeDimensions();
            if (dims && dims.cols >= 10 && dims.rows >= 4) {
              termRef.current.resize(dims.cols, dims.rows);
              const client = DaemonClient.get(defaultDaemonEndpoint());
              void client
                .rpc(
                  "terminal.resize",
                  { terminalId, cols: dims.cols, rows: dims.rows },
                  3000,
                )
                .catch(() => {});
            }
          } catch {}
        }
      }, [isActive, terminalId]);

      return (
        <div
          ref={containerRef}
          className="relative w-full h-full overflow-hidden bg-[#0f1115]"
          style={{ display: isActive ? "block" : "none" }}
        />
      );
    },
  ),
);
