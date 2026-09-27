import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { formatContext, formatPrice, modelById, type ModelSpec } from "../core/models.ts";
import { selectVisibleModels, useWorkbench, visibleModelsFor } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 执行器 + 模型选择器 —— 位置对齐各 harness 工具的「换模型」入口：
 * 放在输入框控制行的**发送键左侧**，而不是顶部常驻条。
 *
 * 理由：执行器和「用哪个模型」是同一类决策 —— 都是本次任务的一个参数。
 * 把它放进 composer，切换范围自然收敛到「这条消息会用谁、跑什么」，
 * 而顶部常驻条暗示的是「整个应用都用它」，语义更重也更吵。
 *
 * **两层而不是两个下拉**：模型清单由执行器决定（Claude Code 只接 Anthropic，
 * Codex 只接 OpenAI，OpenCode / pi / ZCode 厂商中立）。做成两个并列下拉，
 * 换一个执行器时另一个里就可能留着一个非法值，用户得自己发现。
 * 做成一层，当前执行器的模型就地展开在它下面 —— 依赖关系看得见。
 *
 * 全部六家仍然平级展示，能力计数直接露在选项里。
 */
export function RuntimePicker() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const select = useWorkbench((s) => s.selectRuntime);
  const runtimeModels = useWorkbench((s) => s.runtimeModels);
  // 偏好变更的版本号。用来当 effect 依赖 —— 偏好对象本身每次都是新的，
  // 直接当依赖等于每次渲染都重算。
  const modelPrefsVersion = useWorkbench((s) => s.modelPrefsVersion);
  const selectModel = useWorkbench((s) => s.selectModel);
  // 有效清单 = 声明 − 用户隐藏 + 用户自定义，并按用户偏好排序。
  // 必须读它而不是 runtime.models —— 否则在设置里藏掉的模型这里还会出现，
  // 那是最典型的一种「设置改了但没生效」。
  //
  // ⚠ 不要再套 useShallow：selectVisibleModels 返回的是**引用稳定**的数组
  // （见 store 里的引用记忆）。加 useShallow 只会掩盖引用不稳定这个真问题 ——
  // 之前自定义模型就是靠它「看起来正常」，一加自定义模型立刻无限循环。
  const activeModels = useWorkbench(selectVisibleModels(activeId));
  // 计数只在弹层里显示，且是渲染期一次性计算，不进 store、不进 selector
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 弹层打开时按需算一次计数。不做成 selector 是因为它每次都返回新对象。
  useEffect(() => {
    if (!open) return;
    const s = useWorkbench.getState();
    const out: Record<string, number> = {};
    for (const r of s.runtimes) out[r.id] = visibleModelsFor(s, r.id).length;
    setModelCounts(out);
  }, [open, runtimes, activeId, modelPrefsVersion]);

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

  const active = runtimes.find((r) => r.id === activeId);
  const activeModel = active ? modelById(runtimeModels[activeId] ?? active.defaultModel) : undefined;
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={
          active
            ? `${active.presentation.displayName} · ${activeModel?.displayName ?? "未选模型"}\n${active.presentation.tagline}`
            : "选择执行器"
        }
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        {active && (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-medium text-white"
            style={{ background: active.presentation.accent }}
            aria-hidden
          >
            {active.presentation.glyph}
          </span>
        )}
        {/* 两段都要看得到：只显示执行器名，用户会以为模型没得选 */}
        <span className="max-w-[84px] truncate">{active?.presentation.displayName ?? "执行器"}</span>
        {activeModel && (
          <>
            <span className="text-ash" aria-hidden>
              ·
            </span>
            <span className="max-w-[92px] truncate text-graphite">{activeModel.displayName}</span>
          </>
        )}
        <ChevronDown size={11} className="shrink-0 text-ash" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-40 mb-1.5 max-h-[420px] w-[320px] overflow-y-auto rounded-input border border-line bg-canvas py-1"
        >
          <p className="px-3 pb-1 pt-0.5 text-caption text-ash">六家平级，切换只影响下一条消息</p>
          {runtimes.map((r) => {
            const caps = Object.values(r.capabilities);
            const on = caps.filter(Boolean).length;
            const isActive = r.id === activeId;
            const notInstalled = r.state.status === "not_installed";
            const pickedModel = runtimeModels[r.id] ?? r.defaultModel;
            return (
              <div key={r.id}>
                <button
                  role="option"
                  aria-selected={isActive}
                  onClick={() => select(r.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                    isActive ? "bg-teal-tint" : "hover:bg-line-soft",
                    notInstalled && "opacity-55",
                  )}
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn text-[10px] font-medium text-white"
                    style={{ background: r.presentation.accent }}
                    aria-hidden
                  >
                    {r.presentation.glyph}
                  </span>

                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2">
                      <span className={cn("truncate text-body-sm", isActive ? "font-medium text-ink" : "text-graphite")}>
                        {r.presentation.displayName}
                      </span>
                      <span className="tnum shrink-0 text-caption text-ash">
                        {on}/{caps.length}
                      </span>
                    </span>
                    <span className="truncate font-mono text-caption text-ash">{r.transportKind}</span>
                  </span>

                  {isActive && <Check size={12} className="shrink-0 text-teal" />}
                </button>

                {/* 只有当前执行器展开模型。别的执行器的清单不必占屏 */}
                {isActive && (
                  <div className="border-l-2 border-line-soft pb-1 pl-5 pr-3 pt-0.5">
                    <p className="mb-1 flex items-center gap-1 text-caption text-ash">
                      <Cpu size={10} aria-hidden />
                      可选模型 · {activeModels.length}
                    </p>
                    {activeModels.map((spec) => (
                      <ModelRow
                        key={spec.id}
                        spec={spec}
                        active={pickedModel === spec.id}
                        supportsVision={r.capabilities.multimodal}
                        onClick={() => selectModel(spec.id)}
                      />
                    ))}
                  </div>
                )}
                {!isActive && (
                  <p className="px-3 pb-1 pl-11 text-caption text-ash">
                    可选模型 {modelCounts[r.id] ?? 0} 个
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TIER_LABEL = { frontier: "旗舰", balanced: "均衡", fast: "快速" } as const;

function ModelRow({
  spec,
  active,
  supportsVision,
  onClick,
}: {
  spec: ModelSpec;
  active: boolean;
  supportsVision: boolean;
  onClick: () => void;
}) {
  // 只有纯视觉模型才禁选。支持视觉的普通模型在文本 CLI 上照常可选 ——
  // 拿 multimodal 去禁选会把 Codex 变成一个模型都选不了的死路。
  const blocked = spec.visionOnly === true && !supportsVision;
  // 「能看图但这个 CLI 收不到图」是提示，不是禁用
  const visionOnly = spec.multimodal && !supportsVision && !blocked;

  return (
    <button
      role="option"
      aria-selected={active}
      disabled={blocked}
      onClick={onClick}
      title={
        blocked
          ? `${spec.displayName} 只能处理图像，而该执行器没有多模态通道`
          : visionOnly
            ? `${spec.displayName} · ${spec.note}（该执行器没有多模态通道，附件只能是文本）`
            : spec.note
      }
      className={cn(
        "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left",
        blocked ? "cursor-not-allowed opacity-50" : "hover:bg-line-soft",
        active && "bg-teal-tint hover:bg-teal-tint",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={cn("truncate text-body-sm", active ? "font-medium text-ink" : "text-graphite")}>
            {spec.displayName}
          </span>
          <span className="shrink-0 text-caption text-ash">{TIER_LABEL[spec.tier]}</span>
          {visionOnly && <span className="shrink-0 text-caption text-ash">仅文本</span>}
        </span>
        {/* 价格 / 窗口 / 厂商 —— 选模型时最关心的三件事，压到一行 */}
        <span className="tnum mt-0.5 block truncate font-mono text-caption text-ash">
          {formatPrice(spec.inputPerMTok)}/{formatPrice(spec.outputPerMTok)} · {formatContext(spec.contextWindow)} ·{" "}
          {spec.vendorLabel}
        </span>
      </span>
      {active && <Check size={11} className="shrink-0 text-teal" />}
    </button>
  );
}
