import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { ChevronsDown, RotateCcw, X } from "lucide-react";
import { isUnitTab, visibleTabsForUnit, type SidePaneTab } from "../core/sidePaneTabs.ts";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { SIDE_PANE_TAB_META } from "./sidePaneTabMeta.tsx";
import { fuzzyMatchItem } from "./fuzzySearch.ts";
import { cn } from "./cn.ts";

/**
 * 标签总览弹层（ZCode SidePaneTabOverview 的对位）—— tab 条最左的 ⌄ 锚定：
 * 搜索 + 两组列表「打开的标签 / 最近关闭」。tab 多到条里放不下时这里是完整
 * 的寻址入口；最近关闭让误关（尤其跨 bot 的隐藏 tab 关错了视角）有后悔药。
 *
 * 弹层是 createPortal + 手写锚定定位（项目无浮层库，BranchPicker /
 * RuntimePicker 同款口径）；键盘 ↑↓/Enter/Esc 对齐 CommandCenter。
 * 无打开 tab 且无最近关闭时锚点按钮整体隐藏（SidePaneHome 已承担选择职责）。
 */

type Row = { kind: "open"; tab: SidePaneTab } | { kind: "closed"; tab: SidePaneTab };

export function SidePaneTabOverview(): ReactElement | null {
  const tabs = useSidePane((s) => s.tabs);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const recentlyClosed = useSidePane((s) => s.recentlyClosed);
  const units = useWorkbench((s) => s.units);
  const visible = useMemo(() => visibleTabsForUnit(tabs, scopeUnitId), [tabs, scopeUnitId]);

  if (visible.length === 0 && recentlyClosed.length === 0) return null;
  return <OverviewTrigger visible={visible} recentlyClosed={recentlyClosed} units={units} />;
}

function OverviewTrigger({
  visible,
  recentlyClosed,
  units,
}: {
  visible: readonly SidePaneTab[];
  recentlyClosed: readonly SidePaneTab[];
  units: ReadonlyArray<{ id: unknown; name: string }>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // 面板收起（Ctrl+Alt+B / 切全局页）时弹层一并关 —— portal 不受列裁剪，
  // 不关就是一个悬浮在别的内容上的孤儿
  const collapsed = useSidePane((s) => s.collapsed);
  const mainView = useShell((s) => s.mainView);
  const paneOpen = !collapsed && mainView === "chat";
  useEffect(() => {
    if (!paneOpen) setOpen(false);
  }, [paneOpen]);
  // 面板拖宽时锚点横移但不触发 window resize —— 宽度变化作为重定位信号下传
  const paneWidth = useSidePane((s) => s.paneWidth);
  if (!open) {
    return (
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="标签总览"
        aria-haspopup="dialog"
        aria-expanded={false}
        title="标签总览（搜索打开的标签 / 重开最近关闭）"
        className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
      >
        <ChevronsDown size={12} />
      </button>
    );
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(false)}
        aria-label="收起标签总览"
        aria-haspopup="dialog"
        aria-expanded
        className="shrink-0 rounded-btn bg-line-soft p-1 text-ink"
      >
        <ChevronsDown size={12} />
      </button>
      <OverviewPopover
        anchorRef={anchorRef}
        visible={visible}
        recentlyClosed={recentlyClosed}
        units={units}
        repositionKey={paneWidth}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function OverviewPopover({
  anchorRef,
  visible,
  recentlyClosed,
  units,
  repositionKey,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  visible: readonly SidePaneTab[];
  recentlyClosed: readonly SidePaneTab[];
  units: ReadonlyArray<{ id: unknown; name: string }>;
  /** 面板宽度（拖宽时锚点横移但不触发 window resize，靠它重定位） */
  repositionKey: number;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const unitNameOf = (tab: SidePaneTab): string =>
    isUnitTab(tab)
      ? (units.find((u) => String(u.id) === String(tab.ownerUnitId))?.name ?? String(tab.ownerUnitId))
      : "工作区";

  const titleOf = (tab: SidePaneTab): string => SIDE_PANE_TAB_META[tab.type].title(tab);

  // 过滤：打开组 + 最近关闭组都按 query 模糊匹配（标题 / 所属 / 类型）。
  // units 进 deps —— bot 改名后 tabs 引用不变，不进的话 hint 停在旧名
  const filtered = useMemo(() => {
    const rows: Row[] = [
      ...visible.map((tab) => ({ kind: "open" as const, tab })),
      ...recentlyClosed.map((tab) => ({ kind: "closed" as const, tab })),
    ];
    if (query.trim() === "") return rows;
    return rows.filter((row) => {
      const matched = fuzzyMatchItem(
        { label: titleOf(row.tab), hint: unitNameOf(row.tab), meta: row.tab.type },
        query,
      );
      return matched !== null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titleOf/unitNameOf 是本组件内联函数，随 units/visible 变化
  }, [visible, recentlyClosed, units, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 锚定定位：按钮下方、向左展开（面板贴右缘），视口收拢。面板拖宽
  // （repositionKey 变化）时重测量 —— 那不触发 window resize，不会走关闭路径
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = popRef.current;
    if (anchor === null || el === null) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 8);
    setPos({ left, top });
  }, [anchorRef, filtered.length, repositionKey]);

  // 关闭路径：外部按下 / 外部滚动 / 缩放 / Esc（输入框失焦后 Esc 也能关）。
  // 弹层**自己列表内**的滚动不算外部 —— 列表封顶 60vh 本来就会滚，滚一下
  // 就自关等于没给长列表留活路（QuickContextMenu 全关是有意为之，口径不同）
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = popRef.current;
      if (el !== null && el.contains(e.target as Node)) return;
      if (anchorRef.current === e.target) return;
      onClose();
    };
    const onScroll = (e: Event): void => {
      const el = popRef.current;
      if (el !== null && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const close = (): void => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  const openRows = filtered.filter((r) => r.kind === "open");
  const closedRows = filtered.filter((r) => r.kind === "closed");
  const firstClosedIndex = openRows.length;

  const triggerRow = (row: Row): void => {
    if (row.kind === "open") {
      useSidePane.getState().activateTab(row.tab.id);
    } else {
      // 跨 bot 重开先切单元（tab 按 owner 过滤可见，不切就「点了没反应」）
      const scope = useSidePane.getState().scopeUnitId;
      if (isUnitTab(row.tab) && (scope === null || String(scope) !== String(row.tab.ownerUnitId))) {
        useWorkbench.getState().selectUnit(row.tab.ownerUnitId);
      }
      useSidePane.getState().reopenClosedTab(row.tab);
    }
    onClose();
  };

  const step = (dir: 1 | -1): void => {
    if (filtered.length === 0) return;
    if (activeIndex === null) {
      setActiveIndex(dir === 1 ? 0 : filtered.length - 1);
      return;
    }
    setActiveIndex((activeIndex + dir + filtered.length) % filtered.length);
  };

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label="标签总览"
      style={pos === null ? { visibility: "hidden", left: 0, top: 0 } : { left: pos.left, top: pos.top }}
      className="fixed z-[80] flex max-h-[60vh] w-[300px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
    >
      <div className="shrink-0 border-b border-line-soft p-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              step(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              step(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (activeIndex !== null && filtered[activeIndex] !== undefined) triggerRow(filtered[activeIndex]);
            }
          }}
          placeholder="搜索标签（标题 / 单元 / 类型）"
          className="w-full rounded-btn bg-rail px-2 py-1.5 text-caption text-ink outline-none placeholder:text-ash"
        />
      </div>
      <div role="listbox" aria-label="标签列表" className="min-h-0 flex-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-caption text-ash">没有匹配「{query}」的标签</p>
        ) : (
          <>
            {openRows.length > 0 && <GroupLabel label={`打开的标签（${openRows.length}）`} />}
            {openRows.map((row, i) => (
              <OverviewRow
                key={row.tab.id}
                row={row}
                title={titleOf(row.tab)}
                hint={unitNameOf(row.tab)}
                active={activeIndex === i}
                onHover={() => setActiveIndex(i)}
                onTrigger={() => triggerRow(row)}
              />
            ))}
            {closedRows.length > 0 && <GroupLabel label={`最近关闭（${closedRows.length}）`} />}
            {closedRows.map((row, i) => (
              <OverviewRow
                key={`closed-${row.tab.id}`}
                row={row}
                title={titleOf(row.tab)}
                hint={unitNameOf(row.tab)}
                active={activeIndex === firstClosedIndex + i}
                onHover={() => setActiveIndex(firstClosedIndex + i)}
                onTrigger={() => triggerRow(row)}
              />
            ))}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function GroupLabel({ label }: { label: string }): ReactElement {
  return <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium tracking-wide text-ash">{label}</p>;
}

function OverviewRow({
  row,
  title,
  hint,
  active,
  onHover,
  onTrigger,
}: {
  row: Row;
  title: string;
  hint: string;
  active: boolean;
  onHover: () => void;
  onTrigger: () => void;
}): ReactElement {
  const unread = useSidePane((s) => row.kind === "open" && row.tab.type === "live" && s.unreadTabIds[row.tab.id] === true);
  const Icon = SIDE_PANE_TAB_META[row.tab.type].icon;
  return (
    <div
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onTrigger}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-btn px-2 py-1.5",
        active ? "bg-line-soft" : "hover:bg-line-soft/60",
      )}
    >
      <Icon size={12} className="shrink-0 text-ash" />
      <span className="min-w-0 flex-1 truncate text-caption text-ink">{title}</span>
      {unread && <span role="img" aria-label="有未读事件" className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />}
      <span className="max-w-20 shrink-0 truncate text-[10px] text-ash">{hint}</span>
      {row.kind === "open" ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={`关闭 ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            useSidePane.getState().closeTab(row.tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              useSidePane.getState().closeTab(row.tab.id);
            }
          }}
          className="rounded p-0.5 text-ash opacity-0 transition hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={11} />
        </span>
      ) : (
        <RotateCcw size={11} className="shrink-0 text-ash" />
      )}
    </div>
  );
}
