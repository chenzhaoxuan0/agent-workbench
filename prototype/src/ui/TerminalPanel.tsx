import { useEffect, useRef, useState } from "react";
import { SquareTerminal, X } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";

/**
 * 终端面板 —— 对应 ZCode 的 AnimatedTerminalPanel。
 *
 * 两个入口共用本组件（原型期还没有真 PTY，各挂各的实例、各自独立状态）：
 * - dock（默认）：会话下方的可开关面板（默认 30% 高，X = toggleTerminal）；
 * - page：会话头「终端」页签，占据整个会话视口（X = 切回对话页签），
 *   大屏下方便全屏使用各 provider CLI 的 TUI 界面。
 */
export function TerminalPanel({ variant = "dock" }: { variant?: "dock" | "page" } = {}) {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const setConversationView = useShell((s) => s.setConversationView);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [echo, setEcho] = useState<string[]>([]);

  const isPage = variant === "page";
  const closeTerminal = isPage ? () => setConversationView("chat") : toggleTerminal;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [echo.length]);

  const lines: readonly { text: string; tone?: "dim" | "gain" | "teal" }[] = [
    { text: `cwd  ${unit?.rootPath ?? "—"}` },
    { text: `unit ${unit?.name ?? "—"}${unit?.kind === "bot" ? "  (bot模式)" : "  (项目模式)"}` },
    { text: `exec ${runtime?.presentation.displayName ?? "—"}  via ${runtime?.transportKind ?? "—"}` },
    { text: "", tone: "dim" },
    { text: "能力可用性：", tone: "dim" },
    ...(runtime
      ? Object.entries(runtime.capabilities)
          .filter(([, v]) => v)
          .map(([k]) => ({ text: `  ✓ ${k}`, tone: "gain" as const }))
      : []),
  ];

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
        <span className="text-body-sm text-graphite">终端</span>
        {isPage && <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">全屏页签</span>}
        <span className="ml-auto font-mono text-caption text-ash">{unit?.name ?? ""}</span>
        <button
          onClick={closeTerminal}
          aria-label={isPage ? "关闭终端页签" : "关闭终端"}
          className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
        >
          <X size={12} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-body-sm leading-relaxed"
        onClick={() => setEcho([])}
      >
        {lines.map((l, i) => (
          <p
            key={i}
            className={
              l.tone === "dim" ? "text-ash" : l.tone === "gain" ? "text-gain" : l.tone === "teal" ? "text-teal" : "text-graphite"
            }
          >
            {l.text || " "}
          </p>
        ))}

        {echo.map((line, i) => (
          <p key={`e${i}`} className="text-ink">
            <span className="text-ash">$ </span>
            {line}
          </p>
        ))}

        <p>
          <span className="text-teal">❯ </span>
          <span className="text-ash">输入命令…（原型期无真实 PTY，回车清屏）</span>
        </p>
      </div>
    </div>
  );
}
