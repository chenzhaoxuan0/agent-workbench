import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Sparkles, X } from "lucide-react";
import { useWorkbench, type LoopParamsState } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 推理力度选择器 —— 原 agent loop 参数精简版。
 *
 * 仅保留推理力度（reasoningLevel）一个旋钮。
 * 默认以空值（执行器/模型默认）起步，避免配置冲突与认知负担。
 */

export const REASONING_LEVELS: readonly { id: string; label: string; desc: string }[] = [
  { id: "", label: "默认", desc: "跟随当前执行器与模型原生配置" },
  { id: "low", label: "低 (low)", desc: "响应最快，适合直接指令与简单编辑" },
  { id: "medium", label: "中 (medium)", desc: "标准思考深度，平衡速度与准确性" },
  { id: "high", label: "高 (high)", desc: "较深思考，适合复杂逻辑与多步骤推理" },
  { id: "xhigh", label: "超高 (xhigh)", desc: "高阶思考深度，适合攻坚系统级难题" },
  { id: "max", label: "极深 (max)", desc: "最深推理，耗时较长，适合攻坚疑难问题" },
  { id: "ultra", label: "极限 (ultra)", desc: "顶级思考与自动任务委派，适合极限推理" },
];

export const EMPTY_LOOP: LoopParamsState = {};

/** 当前档位的一句话摘要 */
export function summaryOfLoop(loop: LoopParamsState): string {
  const hit = REASONING_LEVELS.find((r) => r.id === (loop.reasoningLevel ?? ""));
  if (hit && hit.id !== "") return `推理: ${hit.label}`;
  return loop.reasoningLevel ? `推理: ${loop.reasoningLevel}` : "推理: 默认";
}

export function ReasoningEffortPanel({ onDone }: { onDone?: () => void }) {
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const activeRuntime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const activeModelId = useWorkbench((s) => s.runtimeModels[s.activeRuntimeId] ?? activeRuntime?.defaultModel);
  const activeModel = activeRuntime?.models.find((m) => m.id === activeModelId);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  const setLoopParam = useWorkbench((s) => s.setLoopParam);

  const cur = loop.reasoningLevel ?? "";

  // 如果模型声明了特定支持的档位，动态按模型过滤/追加；否则展示通用列表
  const supported = activeModel?.reasoningLevels;
  const availableLevels = supported && supported.length > 0
    ? [
        REASONING_LEVELS[0]!, // 默认
        ...supported.map((id) => {
          const known = REASONING_LEVELS.find((r) => r.id === id);
          return known ?? { id, label: id, desc: `模型原生支持档位 (${id})` };
        }),
      ]
    : REASONING_LEVELS;

  return (
    <div role="listbox" aria-label="推理力度" className="py-1 overflow-y-auto overscroll-contain touch-pan-y">
      <div className="px-3.5 py-2 border-b border-line-soft mb-1">
        <p className="text-caption font-semibold text-ink">推理力度设置 (Reasoning Effort)</p>
        <p className="text-[11px] text-ash">
          {activeModel ? `${activeModel.displayName} · 随下一轮会话生效` : "按执行器记忆 · 随下一轮会话生效"}
        </p>
      </div>
      {availableLevels.map((r) => {
        const active = r.id === cur;
        return (
          <button
            key={r.id}
            role="option"
            aria-selected={active}
            onClick={() => {
              setLoopParam(activeRuntimeId, { reasoningLevel: r.id === "" ? undefined : r.id });
              onDone?.();
            }}
            className={cn(
              "flex w-full items-start gap-3 px-4 py-3 text-left min-h-[48px] touch-pan-y transition",
              active ? "bg-teal-tint" : "hover:bg-line-soft active:bg-line-soft/80",
            )}
          >
            <span className="flex flex-1 min-w-0 flex-col gap-0.5">
              <span className={cn("text-body-sm", active ? "font-semibold text-teal" : "text-graphite")}>
                {r.label}
              </span>
              <span className="text-caption leading-relaxed text-ash">{r.desc}</span>
            </span>
            {active && <Check size={16} className="mt-0.5 shrink-0 text-teal" />}
          </button>
        );
      })}
    </div>
  );
}

export function ReasoningEffortPicker({
  compact = false,
  align = "right",
}: {
  compact?: boolean;
  align?: "left" | "right";
} = {}) {
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (compact) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, compact]);

  const label = summaryOfLoop(loop);
  const isCustom = loop.reasoningLevel !== undefined && loop.reasoningLevel !== "";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="设置执行器推理思考力度（默认跟随执行器原生设定）"
        className={cn(
          "flex items-center justify-center rounded-lg transition",
          "h-7 @min-[480px]:h-8 px-1.5 @min-[480px]:px-2 gap-1 @min-[480px]:gap-1.5 text-xs @min-[480px]:text-body-sm",
          compact ? "border border-line-soft bg-card/60 active:scale-95" : "hover:bg-line-soft",
          open
            ? "bg-line-soft text-ink ring-1 ring-teal/30"
            : isCustom
              ? "bg-teal-tint text-teal font-medium border-teal/40"
              : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <Sparkles size={14} className={cn("shrink-0", isCustom ? "text-teal" : "text-ash")} />
        <span className="hidden @min-[560px]:inline max-w-[90px] truncate font-medium @min-[560px]:font-normal">{label}</span>
        <ChevronDown size={11} className="hidden @min-[560px]:inline shrink-0 opacity-60" />
      </button>

      {open && (
        compact && typeof window !== "undefined" && window.innerWidth < 640 ? (
          createPortal(
            <div
              className="fixed inset-0 z-50 flex flex-col justify-end bg-black/65 backdrop-blur-xs animate-in fade-in duration-200 select-none"
              onClick={(e) => {
                if (e.target === e.currentTarget) setOpen(false);
              }}
            >
              <div
                style={{ height: "65dvh", maxHeight: "75dvh" }}
                className="mx-auto w-full max-w-[500px] flex flex-col overflow-hidden rounded-t-3xl border-t border-line bg-canvas shadow-2xl animate-in slide-in-from-bottom-6 duration-250"
              >
                {/* 顶部拉手条 */}
                <div className="flex h-5 shrink-0 items-center justify-center pt-2">
                  <span className="h-1 w-10 rounded-full bg-zinc-650/40" />
                </div>

                {/* 抽屉头部 */}
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5 bg-card/70 shrink-0">
                  <span className="text-body-sm font-semibold text-ink">推理思考力度 (Reasoning Effort)</span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="关闭选择器"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* 抽屉主体：纵向自由触控滚动 */}
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y">
                  <ReasoningEffortPanel onDone={() => setOpen(false)} />
                </div>
              </div>
            </div>,
            document.body,
          )
        ) : (
          <div
            className={cn(
              // 100cqw（容器查询单位）：弹层宽度跟着对话列实际宽度收，不按整窗摆阔
              "absolute bottom-full z-40 mb-1.5 w-64 max-w-[calc(100cqw-32px)] overflow-hidden rounded-input border border-line bg-canvas shadow-[0_8px_24px_rgb(0_0_0/0.14)]",
              align === "left" ? "left-0" : "right-0",
            )}
          >
            <ReasoningEffortPanel onDone={() => setOpen(false)} />
          </div>
        )
      )}
    </div>
  );
}

// 保持向下兼容别名
export const LoopParamsPicker = ReasoningEffortPicker;
export const LoopParamsPanel = ReasoningEffortPanel;

