import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, Sparkles, Star, X } from "lucide-react";
import { formatContext, formatPrice, type ModelSpec } from "../core/models.ts";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import type { RuntimeEntry } from "../core/registry.ts";
import type { LoopParamsState } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { modelSpecFor, runtimeSwitchBlocked, selectVisibleModels, useWorkbench, visibleModelsFor, isHiddenByUser } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";
import { RuntimeIcon } from "./RuntimeIcon.tsx";
import { StopSlider } from "./StopSlider.tsx";

/**
 * 执行器 + 模型 + 思考强度 —— 一颗按钮（原 RuntimePicker 与 ReasoningEffortPicker
 * 合并；两颗按钮各占一个图标位太冗余，而且调的都是同一件事「下一轮怎么跑」）。
 *
 * 形态对齐 T3code 的 ProviderModelPicker：
 * 「左 rail 竖排执行器图标（★ 收藏视图在最上）+ 右侧搜索 + 模型列表」双栏弹层，
 * 尾部追加两根档位滑动条（思考强度 / 上下文长度，codex 同款观感，见 StopSlider）。
 *
 * 与 T3code 同构的几点：
 *  - rail 选中项右缘有指示条；★ 视图聚合**全部执行器**的收藏模型，
 *    点别的执行器的收藏 = 同时切换执行器（T3 的跨实例 favorites 同语义）；
 *  - 列表行：模型名 + 元信息行 + 选中勾 + 收藏星标（星标就地切换）；
 *  - 底部「打开模型设置」入口直达设置页对应分区；
 *  - 收藏的排前面（resolveVisibleModels 的 groupFavorites）。
 *
 * 本项目差异：
 *  - **点 rail 即切执行器**（旧版必须再点一个模型才生效，用户选完执行器直接
 *    开聊的期望会落空）：selectRuntime 自带「沿用该执行器上次选的模型，
 *    不合法则落默认模型」，所以单击图标 = 执行器 + 模型一次到位；
 *  - 思考强度 / 上下文长度是每执行器记忆的 loop 参数（localStorage 持久化），
 *    上下文档位只在该模型声明了 ≥2 档时出现（mcode 的 512K/1M 一类）。
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

const EMPTY_LOOP: LoopParamsState = {};

type Rail = "favorites" | string;

interface PickerRow {
  readonly runtime: RuntimeEntry;
  readonly spec: ModelSpec;
}

/**
 * 执行器 + 模型面板 —— 只渲染双栏弹层内容，不带触发器。
 *
 * composer 里它可以是绝对定位的下拉，也可以就地展开成手风琴段 / 手机抽屉
 * （fillHeight）。**同一份 rail / 搜索 / 键盘导航 / 滑动条逻辑**，不做第二套实现。
 */
export function RuntimePanel({ onDone, fillHeight = false }: { onDone?: () => void; fillHeight?: boolean }) {
  const runtimes = useWorkbench((s) => s.runtimes);
  // 已停用的执行器不出现在 rail / 列表（T3：Disabled 实例仍列在设置里，但选择器不出现）
  const runtimePrefs = useWorkbench((s) => s.runtimePrefs);
  const enabledRuntimes = useMemo(() => runtimes.filter((r) => runtimePrefs[r.id]?.enabled !== false), [runtimes, runtimePrefs]);
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const activeModels = useWorkbench(selectVisibleModels(activeId));
  const modelPrefsMap = useWorkbench((s) => s.modelPrefs);
  const apply = useWorkbench((s) => s.applyModelPrefs);

  const [rail, setRail] = useState<Rail>(activeId);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

  const activeModelId = useWorkbench((s) => s.runtimeModels[s.activeRuntimeId] ?? s.runtimes.find((r) => r.id === s.activeRuntimeId)?.defaultModel);

  // 切换执行器后 rail 跟着走（首挂载由 useState 的初值负责）
  useEffect(() => setRail(activeId), [activeId]);

  // 当前 rail 的行：★ = 跨执行器收藏；执行器 = 它的有效清单（收藏排前）
  const rows = useMemo<readonly PickerRow[]>(() => {
    if (rail === "favorites") {
      const out: PickerRow[] = [];
      for (const r of enabledRuntimes) {
        const prefs = prefsOf(modelPrefsMap, r.id);
        for (const spec of resolveVisibleModels(r.models, prefs)) {
          if (prefs.favoriteModels.includes(spec.id)) out.push({ runtime: r, spec });
        }
      }
      return out;
    }
    const r = runtimes.find((x) => x.id === rail);
    if (!r) return [];
    return resolveVisibleModels(r.models, prefsOf(modelPrefsMap, rail), { groupFavorites: true }).map((spec) => ({
      runtime: r,
      spec,
    }));
  }, [rail, runtimes, modelPrefsMap, activeModels, activeId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.spec.displayName} ${r.spec.id} ${r.spec.vendorLabel}`.toLowerCase().includes(needle));
  }, [rows, q]);

  useEffect(() => setCursor(0), [q, rail]);

  /**
   * 点 rail 即切执行器（详见组件头注释）：selectRuntime 内部会沿用该执行器
   * 上次选的模型（不合法则落默认模型）。门禁拒绝（对话在等回答）时只浏览不切换。
   */
  const pickRail = (r: RuntimeEntry) => {
    setRail(r.id);
    const s = useWorkbench.getState();
    if (r.id !== s.activeRuntimeId) s.selectRuntime(r.id);
  };

  const pick = (row: PickerRow) => {
    const s = useWorkbench.getState();
    if (row.runtime.state.status === "not_installed") return;
    // 门禁拒绝时不能继续 selectModel：那会把「别家执行器的模型」写进当前执行器
    // 的 runtimeModels（ADR 0012 的 idle-only 切换门禁）
    if (row.runtime.id !== s.activeRuntimeId && !s.selectRuntime(row.runtime.id)) return;
    s.selectModel(row.spec.id);
    // 换模型时校验已选上下文档：新模型没有这一档就回落默认 —— 否则会把
    // A 模型的档值原样发给 B（CLI 收到未知 value 要么报错要么静默忽略）
    const cur = s.loopParams[row.runtime.id]?.contextLength;
    if (cur !== undefined && !(row.spec.contextLengths ?? []).some((o) => o.value === cur)) {
      s.setLoopParam(row.runtime.id, { contextLength: undefined });
    }
    onDone?.();
  };

  const toggleFavorite = (row: PickerRow) =>
    apply(row.runtime.id, [(p) => ({
      ...p,
      favoriteModels: p.favoriteModels.includes(row.spec.id)
        ? p.favoriteModels.filter((x) => x !== row.spec.id)
        : [...p.favoriteModels, row.spec.id],
    })]);

  // 面板高度跟随执行器数量：rail 每行恒定 36px + 4px 间距（★ 行 + 分隔线 + 上下 padding ≈ 66px 常量）。
  // 执行器变多时整体长高，而不是把 rail 行挤扁；超过视口可用高度（留出 header/composer）后封顶，
  // 此时 rail 内部滚动兜底。下限 470px：尾部两根滑动条（思考强度 + 上下文长度）比旧版
  // 单行 footer 高约 120px，下限太矮会把模型列表压成一条缝。
  const railNatural = 40 * enabledRuntimes.length + 66;
  const maxPanelH = typeof window === "undefined" ? 640 : window.innerHeight - 240;
  const panelH = Math.max(470, Math.min(railNatural, maxPanelH));

  return (
    <div
      role="dialog"
      aria-label="选择执行器、模型与思考强度"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCursor((c) => Math.min(filtered.length - 1, c + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setCursor((c) => Math.max(0, c - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const row = filtered[cursor];
          if (row) pick(row);
        }
      }}
      style={fillHeight ? undefined : { height: panelH }}
      className={cn(
        "flex w-full overflow-hidden bg-canvas",
        fillHeight ? "flex-1 min-h-0 h-full border-0" : "rounded-card border border-line",
      )}
    >
      {/* 左 rail：★ 收藏视图 + 执行器图标（T3 的 ModelPickerSidebar）；行高恒定，超高时内部滚动。
          宽 48px = 36px 按钮 + 8px 竖向滚动条刚好放满，横向绝不出现滚动条。
          点击即切执行器（pickRail）：不用再点模型，图标按下那刻执行器+模型就位 */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain touch-pan-y border-r border-line-soft bg-rail py-2 h-full">
        <RailButton selected={rail === "favorites"} title="收藏的模型" onClick={() => setRail("favorites")}>
          <Star size={16} className={cn(rail === "favorites" && "fill-current")} />
        </RailButton>
        <span className="my-0.5 h-px w-6 shrink-0 bg-line" aria-hidden />
        {enabledRuntimes.map((r) => (
          <RailButton
            key={r.id}
            selected={rail === r.id}
            dimmed={r.state.status === "not_installed"}
            title={`${r.presentation.displayName}${r.testOnly ? " · 测试夹具（假执行器）" : ""} · 点击即切换（模型自动沿用/落默认） · 可选 ${visibleModelsFor(useWorkbench.getState(), r.id).length} 个模型`}
            onClick={() => pickRail(r)}
          >
            <RuntimeIcon runtime={r} size={20} />
          </RailButton>
        ))}
      </div>

      {/* 右区：搜索 + 模型列表 + 滑动条（思考强度/上下文长度）+ 设置入口 */}
      <div className="flex min-w-0 flex-1 flex-col h-full">
        <div className="px-2 pt-2">
          <div className="flex h-7 items-center gap-1.5 border-b border-line-soft px-1 pb-1.5 transition-colors focus-within:border-teal">
            <Search size={12} className="shrink-0 text-ash" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索模型…"
              aria-label="搜索模型"
              className="min-w-0 flex-1 bg-transparent text-body-sm text-ink outline-none placeholder:text-ash"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y px-1.5 py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-body-sm text-ash">
              {rail === "favorites" ? "还没有收藏的模型 —— 列表行右侧的星标可以收藏" : "没有匹配的模型"}
            </p>
          ) : (
            filtered.map((row, i) => {
              const fav = prefsOf(modelPrefsMap, row.runtime.id).favoriteModels.includes(row.spec.id);
              const selected = row.runtime.id === activeId && row.spec.id === activeModelId;
              return (
                <ModelRow
                  key={`${row.runtime.id}:${row.spec.id}`}
                  row={row}
                  selected={selected}
                  fav={fav}
                  highlighted={i === cursor}
                  showRuntime={rail === "favorites"}
                  onHover={() => setCursor(i)}
                  onPick={() => pick(row)}
                  onToggleFavorite={() => toggleFavorite(row)}
                />
              );
            })
          )}
        </div>

        <LoopSlidersSection />

        <div className="shrink-0 border-t border-line-soft px-2.5 py-2">
          <SwitchHintCopy />
          <button
            onClick={() => {
              useShell.getState().openSettings("models");
              onDone?.();
            }}
            className="mt-0.5 text-caption text-teal hover:underline"
          >
            打开模型设置
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 思考强度 / 上下文长度 —— 「默认」独立圆点 + 右侧档位滑动条（codex 同款观感）。
 *
 * 「默认」（跟随当前执行器与模型原生配置）**不是最低档**：它是最左侧一枚独立
 * 圆点按钮，与右侧可滑动的真实档位之间有分隔线隔开；默认激活时滑动条无填充、
 * 圆钮半透明（muted）—— 不做这层区分，最左档会被误读成「低档位」。点圆点回到
 * 默认，拖动/点右侧滑动条任一位置即选中该档。两根都写进每执行器各记一份的
 * loopParams（localStorage 持久化）。
 *
 * 思考强度恒显；上下文长度只在当前模型声明了 ≥2 档时出现（mcode 的 512K/1M
 * 一类 —— 档位来自 CLI 自己的 configOption 声明，本地目录不做猜测）。
 */
function LoopSlidersSection() {
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const activeRuntime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const activeModelId = useWorkbench((s) => s.runtimeModels[s.activeRuntimeId] ?? activeRuntime?.defaultModel);
  const activeModel = activeRuntime?.models.find((m) => m.id === activeModelId);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  const setLoopParam = useWorkbench((s) => s.setLoopParam);

  // 模型声明了特定档位就按它收窄，否则展示通用档（不含「默认」—— 它是左侧独立圆点）
  const supported = activeModel?.reasoningLevels;
  const effortStops = useMemo(() => {
    if (supported && supported.length > 0) {
      return supported.map((id) => {
        const known = REASONING_LEVELS.find((r) => r.id === id);
        return known ?? { id, label: id, desc: `模型原生支持档位 (${id})` };
      });
    }
    return REASONING_LEVELS.slice(1);
  }, [supported]);
  const curEffort = loop.reasoningLevel ?? "";
  const effortIdx = effortStops.findIndex((s) => s.id === curEffort);
  const effortDefault = effortIdx < 0;
  const effortStop = effortDefault
    ? { label: "默认", desc: "跟随当前执行器与模型原生配置" }
    : (effortStops[effortIdx] ?? effortStops[0]!);

  const ctxOptions = activeModel?.contextLengths ?? [];
  const ctxStops = useMemo(
    () => ctxOptions.map((o) => ({ id: o.value, label: o.label })),
    [ctxOptions],
  );
  const curCtx = loop.contextLength ?? "";
  const ctxIdx = ctxStops.findIndex((s) => s.id === curCtx);
  const ctxDefault = ctxIdx < 0;

  /** 默认档圆点（两种旋钮共用）：激活时 teal 实心，未激活是描边空点 */
  const defaultDot = (
    isDefault: boolean,
    title: string,
    onReset: () => void,
    label: string,
  ) => (
    <button
      type="button"
      onClick={onReset}
      aria-pressed={isDefault}
      aria-label={`${label}：默认`}
      title={title}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition",
        isDefault
          ? "border-teal bg-teal text-white shadow-xs"
          : "border-line bg-canvas hover:border-graphite",
      )}
    >
      {isDefault && <Check size={11} strokeWidth={3} />}
    </button>
  );

  return (
    <div className="shrink-0 border-t border-line-soft px-3.5 py-2.5">
      {/* 思考强度：默认圆点 | 分隔 | 档位滑动条 */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption font-semibold text-ink">思考强度</span>
        <span className="min-w-0 truncate text-caption font-medium text-teal" aria-live="polite">
          {effortStop.label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        {defaultDot(
          effortDefault,
          "默认 —— 跟随当前执行器与模型的原生配置",
          () => setLoopParam(activeRuntimeId, { reasoningLevel: undefined }),
          "思考强度",
        )}
        <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden />
        <StopSlider
          stops={effortStops}
          valueIndex={Math.max(0, effortIdx)}
          onChange={(i) =>
            setLoopParam(activeRuntimeId, {
              reasoningLevel: effortStops[i]?.id ?? undefined,
            })
          }
          ariaLabel="思考强度档位"
          className="min-w-0 flex-1"
          muted={effortDefault}
        />
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-ash">{effortStop.desc}</p>

      {/* 上下文长度（模型声明了 ≥2 档才有 —— 单档没有可选择的余地） */}
      {ctxOptions.length >= 2 && (
        <div className="mt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption font-semibold text-ink">上下文长度</span>
            <span className="min-w-0 truncate text-caption font-medium text-teal" aria-live="polite">
              {ctxDefault ? "默认" : (ctxStops[ctxIdx]?.label ?? "默认")}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {defaultDot(
              ctxDefault,
              "默认 —— 用执行器会话当前的上下文窗口",
              () => setLoopParam(activeRuntimeId, { contextLength: undefined }),
              "上下文长度",
            )}
            <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden />
            <StopSlider
              stops={ctxStops}
              valueIndex={Math.max(0, ctxIdx)}
              onChange={(i) =>
                setLoopParam(activeRuntimeId, {
                  contextLength: ctxStops[i]?.id ?? undefined,
                })
              }
              ariaLabel="上下文长度档位"
              className="min-w-0 flex-1"
              muted={ctxDefault}
            />
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-ash">
            {activeModel!.displayName} 可选的上下文窗口档位，随下一轮会话生效
          </p>
        </div>
      )}
    </div>
  );
}

export function RunConfigPicker({
  compact = false,
  align = "right",
}: {
  compact?: boolean;
  align?: "left" | "right";
} = {}) {
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const activeModels = useWorkbench(selectVisibleModels(activeId));
  const runtimes = useWorkbench((s) => s.runtimes);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId]);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const active = runtimes.find((r) => r.id === activeId);
  const activeModelId = useWorkbench((s) => s.runtimeModels[s.activeRuntimeId] ?? s.runtimes.find((r) => r.id === s.activeRuntimeId)?.defaultModel);

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

  // 选中的模型不在可见清单里时，先去失效留档里找 —— 找不到才叫「未选模型」。
  // 以前直接落进 "未选模型"：模型一被下线，顶栏就变成「执行器 · 未选模型」，
  // 用户既看不到自己原来选的是什么，也完全不知道出了什么事。
  const activeModel = active ? modelSpecFor(active, activeModelId ?? undefined) : undefined;
  // 「不在可见清单」要拆成两态（复审 P1）：被用户隐藏 ≠ 已下线，混在一起会把
  // 自己藏的模型划线标成「下线」，tooltip 还说反了发送行为。
  const modelMissing = activeModelId !== null && activeModelId !== undefined && !activeModels.some((m) => m.id === activeModelId);
  const hiddenNow = useWorkbench((s) => (activeId !== null && modelMissing ? isHiddenByUser(s, activeId, String(activeModelId)) : false));
  const modelHidden = modelMissing && hiddenNow;
  const modelStale = modelMissing && !hiddenNow;
  const label = active ? (activeModel?.displayName ?? "未选模型") : "执行器";

  // 思考强度 / 上下文档的触发钮指示：有自定义值时火花转 teal 并带短标签，
  // 默认态只留一枚灰火花（不占额外宽度 —— 两颗按钮合一后省下的就是这些）
  const effort = loop?.reasoningLevel;
  const effortKnown = effort !== undefined && effort !== "" ? REASONING_LEVELS.find((r) => r.id === effort) : undefined;
  const effortShort = effort
    ? (effortKnown?.label ?? effort).split(/\s/)[0]
    : undefined;
  const ctxValue = loop?.contextLength;
  const ctxLabel = ctxValue
    ? ((activeModel?.contextLengths ?? []).find((o) => o.value === ctxValue)?.label ?? ctxValue)
    : undefined;
  const tuned = Boolean(effort || ctxValue);

  const tooltip =
    (active
      ? `${active.presentation.displayName}${active.testOnly ? " · 测试夹具" : ""} · ${label}` +
        (modelStale ? "\n⚠ 该模型已不在可选清单里（多半是下线了），发送时会回落到该执行器的第一个可用模型（时间线会标注「已回落」）" : "") +
        (modelHidden ? "\n🔒 该模型已被你手动隐藏，发送时会改用当前列表的第一个模型；到设置里取消隐藏可继续用它" : "") +
        `\n${active.presentation.tagline}`
      : "选择执行器与模型") +
    `\n思考强度：${effortKnown?.label ?? (effort || "默认（跟随执行器原生配置）")}` +
    (ctxLabel !== undefined ? `\n上下文长度：${ctxLabel}` : "");

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={tooltip}
        className={cn(
          "flex items-center justify-center rounded-lg transition",
          "h-7 @min-[480px]:h-8 px-1.5 @min-[480px]:px-2 gap-1 @min-[480px]:gap-1.5 text-xs @min-[480px]:text-body-sm",
          compact
            ? "border border-line-soft bg-card/60 text-graphite hover:bg-line-soft hover:text-ink active:scale-95"
            : "text-graphite hover:bg-line-soft hover:text-ink",
          open ? "bg-line-soft text-ink ring-1 ring-teal/30" : "",
        )}
      >
        {active ? (
          <RuntimeIcon runtime={active} size={16} className="rounded-[3px] shrink-0" />
        ) : (
          <span className="text-caption font-bold text-teal">CLI</span>
        )}
        {/* 执行器名称：对话列宽充裕才显示（容器查询，跟着列实际宽度走而非整窗） */}
        <span className="hidden @min-[760px]:inline max-w-[80px] @min-[1100px]:max-w-[100px] truncate">
          {active?.presentation.displayName ?? "执行器"}
        </span>
        {activeModel && (
          <>
            <span className="hidden @min-[760px]:inline text-ash" aria-hidden>·</span>
            {/* 模型名称：列宽过窄先隐藏（容器查询） */}
            <span
              className={cn(
                "hidden @min-[480px]:inline max-w-[84px] @min-[760px]:max-w-[110px] truncate font-medium @min-[480px]:font-normal",
                modelStale ? "text-amber-600 line-through" : "text-graphite",
              )}
            >
              {activeModel.displayName}
            </span>
          </>
        )}
        {/* 思考强度指示（原第二颗按钮的信息并进来）：默认=灰火花，自定义=teal 火花+短档名 */}
        <Sparkles
          size={12}
          aria-hidden
          className={cn("shrink-0", tuned ? "fill-teal/25 text-teal" : "text-ash/70")}
        />
        {tuned && (
          <span className="hidden @min-[560px]:inline max-w-[64px] truncate text-[11px] font-medium text-teal">
            {[effortShort, ctxLabel].filter(Boolean).join("·")}
          </span>
        )}
        <ChevronDown size={11} className="hidden @min-[480px]:inline shrink-0 text-ash" />
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
                style={{ height: "82dvh", maxHeight: "90dvh" }}
                className="mx-auto w-full max-w-[500px] flex flex-col overflow-hidden rounded-t-3xl border-t border-line bg-canvas shadow-2xl animate-in slide-in-from-bottom-6 duration-250"
              >
                {/* 顶部拉手条 (指示可滑动抽屉) */}
                <div className="flex h-5 shrink-0 items-center justify-center pt-2">
                  <span className="h-1 w-10 rounded-full bg-zinc-650/40" />
                </div>

                {/* 抽屉头部 */}
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5 bg-card/70 shrink-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {active && <RuntimeIcon runtime={active} size={16} className="rounded-[3px]" />}
                    <span className="text-body-sm font-semibold text-ink shrink-0">执行器与模型</span>
                    {activeModel && (
                      <span className="rounded-full bg-teal-tint px-2 py-0.5 text-[11px] font-medium text-teal truncate max-w-[140px]">
                        {activeModel.displayName}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="关闭选择器"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* 抽屉主体：高度撑满，列表上下自由滚动；滑动条钉在列表与 footer 之间 */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  <RuntimePanel onDone={() => setOpen(false)} fillHeight />
                </div>
              </div>
            </div>,
            document.body,
          )
        ) : (
          <div
            className={cn(
              // max-w 用容器查询单位（cqw）：面板/侧栏挤窄对话列时弹层跟着收，
              // 不再按 100vw 摆阔溢出
              "absolute bottom-full z-40 mb-1.5 w-[400px] max-w-[calc(100cqw-16px)] shadow-subtle",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <RuntimePanel onDone={() => setOpen(false)} />
          </div>
        )
      )}
    </div>
  );
}

function RailButton({
  selected,
  dimmed,
  title,
  onClick,
  children,
}: {
  selected: boolean;
  dimmed?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={selected}
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-btn",
        selected ? "bg-line-soft" : "hover:bg-line-soft",
        dimmed && "opacity-50",
      )}
    >
      {children}
      {selected && (
        // T3 的滑动指示条：rail 选中项右缘的圆角短棒
        <span
          className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-teal"
          aria-hidden
        />
      )}
    </button>
  );
}

const TIER_LABEL = { frontier: "旗舰", balanced: "均衡", fast: "快速" } as const;

/**
 * 面板底部切换语义文案 —— 三态（ADR 0012）：
 * 门禁中（本轮未落定，切换会被拒）/ 有活跃段（切换 = 开新段，上一段保留）/ 无段（首段前的切换无边界）。
 * 替换掉旧文案「切换只影响下一条消息」——它低估了后果（实际会开新段，旧段不再续）。
 * 有活跃段时附「携带上文」勾选（opt-in，默认关）。
 */
function SwitchHintCopy() {
  const blocked = useWorkbench(runtimeSwitchBlocked);
  const hasActiveSegment = useWorkbench((s) => s.activeSessionId !== null && s.sessions.some((x) => x.id === s.activeSessionId));
  const handoffOn = useWorkbench((s) => s.handoffOnSwitch);
  const setHandoffOn = useWorkbench((s) => s.setHandoffOnSwitch);
  if (blocked) {
    return <p className="text-caption text-amber-600">当前对话在等你回答（待裁决 / 待输入）—— 处理后才能切换执行器</p>;
  }
  if (hasActiveSegment) {
    return (
      <div>
        <p className="text-caption text-ash">切换执行器 = 下一条消息开启新对话段；上一段保留、可回看</p>
        <p className="text-caption text-ash">
          想回到某一轮换个方向：悬停那条消息点「从此处分叉」（分叉段带只读前缀，旧分支同样保留）
        </p>
        <label
          className="mt-0.5 flex cursor-pointer items-center gap-1 text-caption text-graphite"
          title="把上一段的最近对话以只读转录拼进新执行器的首条消息（有损交接；该内容会成为新执行器原生历史的一部分）。作用于切换执行器/旧段终结后重开等场景；「从此处分叉」不受这个开关影响 —— 分叉恒定携带分叉点之前的只读前缀"
        >
          <input
            type="checkbox"
            checked={handoffOn}
            onChange={(e) => setHandoffOn(e.target.checked)}
            className="h-3 w-3 accent-teal"
          />
          开新段时携带上文（只读转录，进入新执行器历史）
        </label>
      </div>
    );
  }
  return <p className="text-caption text-ash">同执行器换模型不影响上下文；切换只影响下一条消息</p>;
}

function ModelRow({
  row,
  selected,
  fav,
  highlighted,
  showRuntime,
  onHover,
  onPick,
  onToggleFavorite,
}: {
  row: PickerRow;
  selected: boolean;
  fav: boolean;
  highlighted: boolean;
  showRuntime: boolean;
  onHover: () => void;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  const spec = row.spec;
  const notInstalled = row.runtime.state.status === "not_installed";
  // 只有纯视觉模型才禁选。支持视觉的普通模型在文本 CLI 上照常可选
  const blocked = spec.visionOnly === true && !row.runtime.capabilities.multimodal;
  const visionOnly = spec.multimodal && !row.runtime.capabilities.multimodal && !blocked;

  return (
    <div
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={() => !blocked && !notInstalled && onPick()}
      title={
        notInstalled
          ? `未检测到 ${row.runtime.presentation.displayName}，可先在设置里安装或改用其他工具`
          : blocked
            ? `${spec.displayName} 只能处理图像，而该执行器没有多模态通道`
            : visionOnly
              ? `${spec.displayName} · ${spec.note}（该执行器没有多模态通道，附件只能是文本）`
              : spec.note
      }
      className={cn(
        "group/row flex w-full cursor-pointer items-center gap-2 rounded-btn px-2.5 py-2 min-h-[46px] touch-pan-y active:scale-[0.99] transition",
        highlighted ? "bg-teal-tint" : "hover:bg-line-soft",
        selected && !highlighted && "bg-teal-tint/60",
        (blocked || notInstalled) && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={cn("truncate text-body-sm", selected || highlighted ? "text-ink" : "text-graphite")}>
            {spec.displayName}
          </span>
          <span className="shrink-0 text-caption text-ash">{TIER_LABEL[spec.tier]}</span>
          {visionOnly && <span className="shrink-0 text-caption text-ash">仅文本</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          {showRuntime && (
            <>
              <RuntimeIcon runtime={row.runtime} size={12} className="rounded-[3px]" />
              <span className="truncate text-caption text-ash">{row.runtime.presentation.displayName}</span>
              <span className="text-ash">·</span>
            </>
          )}
          <span className="tnum truncate font-mono text-caption text-ash">
            {spec.inputPerMTok > 0
              ? `${formatPrice(spec.inputPerMTok)}/${formatPrice(spec.outputPerMTok)}`
              : spec.vendorLabel === "未收录"
                ? "价格未知"
                : "订阅内含"}
            {spec.contextWindow > 0 ? ` · ${formatContext(spec.contextWindow)}` : ""}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {selected && <Check size={12} className="text-teal" />}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label={fav ? `取消收藏 ${spec.displayName}` : `收藏 ${spec.displayName}`}
          title={fav ? "取消收藏" : "收藏"}
          className={cn(
            "rounded p-0.5",
            fav ? "text-teal" : "text-ash/70 hover:text-ink",
          )}
        >
          <Star size={12} fill={fav ? "currentColor" : "none"} />
        </button>
      </span>
    </div>
  );
}
