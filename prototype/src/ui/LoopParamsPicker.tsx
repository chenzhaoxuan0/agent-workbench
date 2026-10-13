import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
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
    <div role="listbox" aria-label="推理力度" className="py-1">
      <div className="px-3 py-1.5 border-b border-line-soft mb-1">
        <p className="text-caption font-medium text-ink">推理力度 (Reasoning Effort)</p>
        <p className="text-[11px] text-ash">
          {activeModel ? `${activeModel.displayName} · 随下一轮生效` : "按执行器记忆 · 随下一轮生效"}
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
              "flex w-full items-start gap-2.5 px-3 py-2 text-left transition",
              active ? "bg-teal-tint" : "hover:bg-line-soft",
            )}
          >
            <span className="flex flex-1 min-w-0 flex-col gap-0.5">
              <span className={cn("text-body-sm", active ? "font-medium text-ink" : "text-graphite")}>
                {r.label}
              </span>
              <span className="text-[11px] leading-tight text-ash">{r.desc}</span>
            </span>
            {active && <Check size={14} className="mt-0.5 shrink-0 text-teal" />}
          </button>
        );
      })}
    </div>
  );
}

export function ReasoningEffortPicker() {
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
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
  }, [open]);

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
          "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm transition",
          open
            ? "bg-line-soft text-ink"
            : isCustom
              ? "bg-teal-tint text-teal font-medium"
              : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <Sparkles size={13} className={cn("shrink-0", isCustom ? "text-teal" : "text-ash")} />
        <span className="max-w-[100px] truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-64 overflow-hidden rounded-input border border-line bg-canvas shadow-[0_8px_24px_rgb(0_0_0/0.14)]">
          <ReasoningEffortPanel onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// 保持向下兼容别名
export const LoopParamsPicker = ReasoningEffortPicker;
export const LoopParamsPanel = ReasoningEffortPanel;

