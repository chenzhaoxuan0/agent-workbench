import { useEffect, useRef, useState } from "react";
import { Check, SlidersHorizontal } from "lucide-react";
import { useWorkbench, type LoopParamsState } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * agent loop 参数选择器 —— composer 右侧与权限档位并列的「怎么跑」旋钮。
 *
 * 参数按执行器各记一份（localStorage 持久化），透传链路：
 * composer → store.run() → daemon session.start/send → 各家 CLI
 * （reasoning → zcode model options / codex -c；采样仅 codex；
 *   maxTurns 由 daemon 强制，超预算拒发新轮）。
 *
 * 空值 = 跟随执行器默认：不猜具体数值，daemon 端缺省不发该字段。
 */

const REASONING_LEVELS: readonly { id: string; label: string }[] = [
  { id: "", label: "默认（跟随执行器）" },
  { id: "max", label: "max · 最深推理" },
  { id: "high", label: "high" },
  { id: "medium", label: "medium" },
  { id: "low", label: "low" },
];

/** ⚠ zustand 选择器的兜底必须稳定引用：字面量 {} 会让 getSnapshot 每次新对象 →
 *  React 19 无限循环白屏（与 declaredOf 的 ?? [] 同一类坑）。
 *  导出给 RunConfigMenu 复用，别在第二个文件里再写一个字面量 {}。 */
export const EMPTY_LOOP: LoopParamsState = {};

/** 当前档位的一句话摘要，触发器与 ⋯ 面板的折叠行共用 */
export function summaryOfLoop(loop: LoopParamsState): string {
  return loop.reasoningLevel ? `推理 ${loop.reasoningLevel}` : "loop 参数";
}

function summary(loop: LoopParamsState): string {
  return summaryOfLoop(loop);
}

/**
 * loop 参数面板 —— 只渲染表单体，不带触发器、不带浮层定位。
 * 与 PermissionModePanel 同理：composer 下拉与 ⋯ 手风琴共用一份表单。
 */
export function LoopParamsPanel() {
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  const setLoopParam = useWorkbench((s) => s.setLoopParam);
  const set = (patch: Partial<LoopParamsState>): void => setLoopParam(activeRuntimeId, patch);

  return (
    <div>
      <p className="mb-2 text-caption text-ash">按执行器各记一份 · 空值 = 执行器默认。</p>

      <label className="mb-2 flex items-center justify-between gap-2 text-body-sm">
        <span className="text-graphite">推理力度</span>
        <select
          value={loop.reasoningLevel ?? ""}
          onChange={(e) => set({ reasoningLevel: e.target.value === "" ? undefined : e.target.value })}
          className="w-44 rounded-btn border border-line bg-canvas px-2 py-1 text-body-sm text-ink outline-none focus:border-teal"
        >
          {REASONING_LEVELS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <p className="text-caption leading-relaxed text-ash">
        推理力度随下一轮生效（zcode → model options；codex → reasoning effort）。
      </p>

      {loop.reasoningLevel !== undefined && (
        <button
          onClick={() => set({ reasoningLevel: undefined })}
          className="mt-2 w-full rounded-btn border border-line py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          恢复默认
        </button>
      )}
    </div>
  );
}

export function LoopParamsPicker() {
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

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="agent loop 参数：推理力度 / 采样 / 轮次预算（按执行器各记一份）"
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <SlidersHorizontal size={13} className="shrink-0" />
        <span className="max-w-[110px] truncate">{summary(loop)}</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-72 rounded-input border border-line bg-canvas p-3 shadow-[0_8px_24px_rgb(0_0_0/0.14)]">
          <LoopParamsPanel />
        </div>
      )}
    </div>
  );
}
