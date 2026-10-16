import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Star } from "lucide-react";
import { formatContext, formatPrice, type ModelSpec } from "../core/models.ts";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import type { RuntimeEntry } from "../core/registry.ts";
import { useShell } from "../store/useShell.ts";
import { modelSpecFor, selectVisibleModels, useWorkbench, visibleModelsFor, isHiddenByUser } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";
import { RuntimeIcon } from "./RuntimeIcon.tsx";

/**
 * 执行器 + 模型选择器 —— 形态对齐 T3code 的 ProviderModelPicker：
 * 「左 rail 竖排执行器图标（★ 收藏视图在最上）+ 右侧搜索 + 模型列表」双栏弹层。
 *
 * 与 T3code 同构的几点：
 *  - rail 选中项右缘有指示条；★ 视图聚合**全部执行器**的收藏模型，
 *    点别的执行器的收藏 = 同时切换执行器（T3 的跨实例 favorites 同语义）；
 *  - 列表行：模型名 + 元信息行 + 选中勾 + 收藏星标（星标就地切换）；
 *  - 底部「打开模型设置」入口直达设置页对应分区；
 *  - 收藏的排前面（resolveVisibleModels 的 groupFavorites）。
 *
 * 保留本项目差异：执行器是六家 CLI（T3 是 provider 实例），每家清单由
 * 适配器声明；价格 / 上下文窗口是我们目录里的事实数据，保留在行上。
 */

type Rail = "favorites" | string;

interface PickerRow {
  readonly runtime: RuntimeEntry;
  readonly spec: ModelSpec;
}

/**
 * 执行器 + 模型面板 —— 只渲染双栏弹层内容，不带触发器。
 *
 * 抽出来给 RunConfigMenu 的 ⋯ 面板复用：composer 里它可以是绝对定位的下拉，
 * 也可以就地展开成手风琴段。**同一份 rail / 搜索 / 键盘导航逻辑**，
 * 不做第二套实现。
 */
export function RuntimePanel({ onDone }: { onDone?: () => void }) {
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

  const pick = (row: PickerRow) => {
    const s = useWorkbench.getState();
    if (row.runtime.state.status === "not_installed") return;
    if (row.runtime.id !== s.activeRuntimeId) s.selectRuntime(row.runtime.id);
    s.selectModel(row.spec.id);
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
  // 此时 rail 内部滚动兜底。下限保持原 346px，执行器少时观感不变。
  const railNatural = 40 * enabledRuntimes.length + 66;
  const maxPanelH = typeof window === "undefined" ? 640 : window.innerHeight - 240;
  const panelH = Math.max(346, Math.min(railNatural, maxPanelH));

  return (
    <div
      role="dialog"
      aria-label="选择执行器与模型"
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
      style={{ height: panelH }}
      className="flex w-full overflow-hidden rounded-card border border-line bg-canvas"
    >
      {/* 左 rail：★ 收藏视图 + 执行器图标（T3 的 ModelPickerSidebar）；行高恒定，超高时内部滚动。
          宽 48px = 36px 按钮 + 8px 竖向滚动条刚好放满，横向绝不出现滚动条 */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-line-soft bg-rail py-2">
        <RailButton selected={rail === "favorites"} title="收藏的模型" onClick={() => setRail("favorites")}>
          <Star size={16} className={cn(rail === "favorites" && "fill-current")} />
        </RailButton>
        <span className="my-0.5 h-px w-6 shrink-0 bg-line" aria-hidden />
        {enabledRuntimes.map((r) => (
          <RailButton
            key={r.id}
            selected={rail === r.id}
            dimmed={r.state.status === "not_installed"}
            title={`${r.presentation.displayName}${r.testOnly ? " · 测试夹具（假执行器）" : ""} · 可选 ${visibleModelsFor(useWorkbench.getState(), r.id).length} 个模型`}
            onClick={() => setRail(r.id)}
          >
            <RuntimeIcon runtime={r} size={20} />
          </RailButton>
        ))}
      </div>

      {/* 右区：搜索 + 模型列表 + 设置入口 */}
      <div className="flex min-w-0 flex-1 flex-col">
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

        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
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

        <div className="shrink-0 border-t border-line-soft px-2.5 py-2">
          <p className="text-caption text-ash">切换只影响下一条消息</p>
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

export function RuntimePicker() {
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const activeModels = useWorkbench(selectVisibleModels(activeId));
  const runtimes = useWorkbench((s) => s.runtimes);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const active = runtimes.find((r) => r.id === activeId);
  const activeModelId = useWorkbench((s) => s.runtimeModels[s.activeRuntimeId] ?? s.runtimes.find((r) => r.id === s.activeRuntimeId)?.defaultModel);

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

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          active
            ? `${active.presentation.displayName}${active.testOnly ? " · 测试夹具" : ""} · ${label}` +
              (modelStale ? "\n⚠ 该模型已不在可选清单里（多半是下线了），发送时会回落到该执行器的第一个可用模型（时间线会标注「已回落」）" : "") +
              (modelHidden ? "\n🔒 该模型已被你手动隐藏，发送时会改用当前列表的第一个模型；到设置里取消隐藏可继续用它" : "") +
              `\n${active.presentation.tagline}`
            : "选择执行器与模型"
        }
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        {active && <RuntimeIcon runtime={active} size={16} className="rounded-[3px]" />}
        <span className="max-w-[84px] truncate">{active?.presentation.displayName ?? "执行器"}</span>
        {activeModel && (
          <>
            <span className="text-ash" aria-hidden>·</span>
            <span className={cn("max-w-[92px] truncate", modelStale ? "text-amber-600 line-through" : "text-graphite")}>
              {activeModel.displayName}
            </span>
          </>
        )}
        <ChevronDown size={12} className="shrink-0 text-ash" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 w-[360px] shadow-subtle">
          <RuntimePanel onDone={() => setOpen(false)} />
        </div>
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
        "group/row flex w-full cursor-pointer items-center gap-2 rounded-btn px-2 py-1.5",
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
