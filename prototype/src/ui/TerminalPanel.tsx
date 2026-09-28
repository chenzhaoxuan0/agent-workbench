import { useEffect, useRef, useState } from "react";
import { SquareTerminal, X } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";

/**
 * 底部终端面板 —— 对应 ZCode 的 AnimatedTerminalPanel（默认 30% 高，可开关）。
 *
 * 原型期还没有真 PTY，这里给一个可信的只读终端外观：
 * 展示当前工作单元、执行器和可用能力，让面板不是个空壳。
 */
export function TerminalPanel() {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [echo, setEcho] = useState<string[]>([]);

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
    <div className="flex h-full min-h-0 flex-col border-t border-line bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SquareTerminal size={12} className="text-ash" />
        <span className="text-body-sm text-graphite">终端</span>
        <span className="ml-auto font-mono text-caption text-ash">{unit?.name ?? ""}</span>
        <button
          onClick={toggleTerminal}
          aria-label="关闭终端"
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
