import { useEffect, useRef, useState } from "react";
import { Brain, Calendar, Check, CheckSquare, Square, Sparkles } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useMemoryPanel } from "../store/useMemoryPanel.ts";
import { cn } from "./cn.ts";

export function MemoryScopePicker() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const unit = useWorkbench(selectActiveUnit);
  const memoryScopes = useWorkbench((s) => s.memoryScopes);
  const setMemoryScopes = useWorkbench((s) => s.setMemoryScopes);
  const toggleMemoryScope = useWorkbench((s) => s.toggleMemoryScope);
  const memory = useMemoryPanel((s) => s.memory);

  const hasSemantic = memoryScopes.includes("semantic");
  const hasDaily = memoryScopes.includes("daily");

  const draft = useWorkbench((s) => s.draft);

  useEffect(() => {
    if (draft.startsWith("/")) {
      setOpen(false);
    }
  }, [draft]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [open]);

  const label =
    hasSemantic && hasDaily
      ? "长期 + 今日精炼"
      : hasSemantic
        ? "长期事实"
        : hasDaily
          ? "当日精炼"
          : "未注入";

  const isEnabled = hasSemantic || hasDaily;

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="选择本轮对话要注入的记忆类型（长期记忆 MEMORY.md 与当日会话精炼独立注入）"
        className={cn(
          "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition border font-medium select-none",
          isEnabled
            ? "border-teal/30 bg-teal-tint text-teal hover:border-teal/50"
            : "border-line text-graphite hover:text-ink hover:border-line-soft bg-canvas/60",
        )}
      >
        <Brain size={13} className={cn(isEnabled ? "text-teal" : "text-graphite")} />
        <span className="font-mono text-[11px] tracking-tight">{label}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-80 rounded-xl border border-line bg-canvas p-3 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between pb-2 border-b border-line-soft">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Brain size={14} className="text-teal" />
              <span>记忆注入配置</span>
            </div>
            <span className="text-[10px] text-graphite font-mono">/mem 指令</span>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-graphite">
            选择开新会话时注入到 prompt prefix 的记忆上下文。两者独立管理，不相互污染：
          </p>

          <div className="mt-2.5 space-y-2">
            {/* 1. 语义记忆 (MEMORY.md) */}
            <div
              onClick={() => toggleMemoryScope("semantic")}
              className={cn(
                "group flex cursor-pointer items-start gap-2.5 rounded-lg border p-2 transition",
                hasSemantic
                  ? "border-teal/40 bg-teal-tint/40 text-ink"
                  : "border-line-soft hover:border-line hover:bg-canvas-soft text-graphite",
              )}
            >
              <div className="mt-0.5 shrink-0 text-teal">
                {hasSemantic ? <CheckSquare size={15} /> : <Square size={15} className="text-graphite" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">长期事实 (MEMORY.md)</span>
                  {memory && memory.chars > 0 && (
                    <span className="font-mono text-[10px] text-graphite">
                      {memory.chars}/{memory.limit} 字
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-graphite leading-normal mt-0.5">
                  沉淀在项目根目录，由 Agent 遵照上限直接维护，保证项目级关键事实不遗忘。
                </p>
              </div>
            </div>

            {/* 2. 当日会话精炼 (daily/*.md) */}
            <div
              onClick={() => toggleMemoryScope("daily")}
              className={cn(
                "group flex cursor-pointer items-start gap-2.5 rounded-lg border p-2 transition",
                hasDaily
                  ? "border-teal/40 bg-teal-tint/40 text-ink"
                  : "border-line-soft hover:border-line hover:bg-canvas-soft text-graphite",
              )}
            >
              <div className="mt-0.5 shrink-0 text-teal">
                {hasDaily ? <CheckSquare size={15} /> : <Square size={15} className="text-graphite" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">当日会话精炼 (daily/*.md)</span>
                  <span className="flex items-center gap-1 font-mono text-[10px] text-teal">
                    <Calendar size={10} />
                    <span>按日分片</span>
                  </span>
                </div>
                <p className="text-[11px] text-graphite leading-normal mt-0.5">
                  每日由总管任务自动提取并总结当天的关键结论与踩坑，作为只读参考注入。
                </p>
              </div>
            </div>
          </div>

          {/* 快捷预设 */}
          <div className="mt-3 pt-2.5 border-t border-line-soft flex items-center justify-between">
            <span className="text-[10px] text-graphite">快捷预设:</span>
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setMemoryScopes(["semantic", "daily"])}
                className="rounded px-1.5 py-0.5 text-xs text-teal hover:bg-teal-tint transition"
              >
                双注入
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => setMemoryScopes(["semantic"])}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                仅长期
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => setMemoryScopes(["daily"])}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                仅今日
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => setMemoryScopes([])}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
