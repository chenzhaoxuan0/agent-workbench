import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDown, Plus, RotateCcw, X } from "lucide-react";
import {
  buildSearchFields,
  canOpenTab,
  filterAndRankSearchItems,
  getVisibleTabs,
  listVisibleTabTypes,
  metaOf,
  NEEDS_RUNTIME,
  normalizeSearchQuery,
  scopeOf,
  SCOPE_LABEL,
} from "../core/sidepane.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { cn } from "./cn.ts";

/** 相对时间，最近关闭分组要用 */
function relTime(ts: number, now: number): string {
  const d = now - ts;
  const m = Math.round(d / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 标签总览 —— 对齐 ZCode 的 `SidePaneTabOverview`。
 *
 * 搜索评分权重与多关键词 AND 语义直接复用 `core/sidepane.ts`：
 * 标题前缀 120 > 词首 90 > 标题包含 70 > 提示 40 > 类型 20 > 其余 1。
 * 分组：已打开 / 最近关闭。最近关闭可一键恢复。
 *
 * 「已打开」这一组只列**当前会话下可见**的那些 —— 与标签栏看到的完全一致，
 * 不在这里列一屏点不动的页签。
 */
export function SidePaneOverview({ ownerId, onClose }: { ownerId: string | null; onClose: () => void }) {
  const state = useSidePane((s) => s.state);
  const recentlyClosed = useSidePane((s) => s.recentlyClosed);
  const setActive = useSidePane((s) => s.setActiveTab);
  const closeTab = useSidePane((s) => s.closeTab);
  const reopen = useSidePane((s) => s.reopenClosedTab);
  const openTabType = useSidePane((s) => s.openTabType);

  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const openItems = useMemo(() => {
    const parts = normalizeSearchQuery(query);
    return filterAndRankSearchItems(
      getVisibleTabs(state, ownerId).map((tab) => {
        const meta = metaOf(tab.type);
        return {
          tab,
          title: tab.title,
          openedLabel: tab.openedAt ? relTime(tab.openedAt, now) : "",
          // 搜的是「这一页是干什么的」，不是标题自己
          searchFields: buildSearchFields(tab.title, meta.hint, meta.typeLabel),
        };
      }),
      parts,
    );
  }, [state, ownerId, query, now]);

  const closedItems = useMemo(() => {
    const parts = normalizeSearchQuery(query);
    return filterAndRankSearchItems(
      recentlyClosed.map((r) => {
        const meta = metaOf(r.tab.type);
        return {
          ...r,
          title: r.tab.title,
          searchFields: buildSearchFields(r.tab.title, meta.hint, meta.typeLabel),
        };
      }),
      parts,
    );
  }, [recentlyClosed, query]);

  /**
   * 没开过的页签类型。
   *
   * ZCode 给每一种**类型**都备了 typeLabel + searchHint ——
   * 这两样只有在「能按类型搜」时才划算，只搜已开页签的话根本用不上。
   * 所以第三组必须存在：只搜已开页签的话，23 种里没开过的那十几种等于不存在，
   * 得先知道它叫什么、再去菜单里手动翻。
   */
  const openTypes = useMemo(() => new Set((state?.tabs ?? []).map((t) => t.type)), [state]);
  const catalogItems = useMemo(() => {
    const parts = normalizeSearchQuery(query);
    return filterAndRankSearchItems(
      listVisibleTabTypes()
        .filter((type) => !openTypes.has(type))
        .map((type) => {
          const meta = metaOf(type);
          return {
            type,
            title: meta.title,
            searchFields: buildSearchFields(meta.title, meta.hint, meta.typeLabel),
          };
        }),
      parts,
    );
  }, [openTypes, query]);

  const total = openItems.length + closedItems.length + catalogItems.length;

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-ink/20 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="面板总览"
        onClick={(e) => e.stopPropagation()}
        className="mt-16 w-[420px] max-w-full overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="搜索标签类型、已打开与最近关闭…"
            aria-label="搜索标签"
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-graphite"
          />
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {total === 0 && (
            <p className="px-4 py-8 text-center text-body-sm text-graphite">
              {query ? `没有匹配「${query}」的标签` : "没有标签"}
            </p>
          )}

          {openItems.length > 0 && (
            <Group title={`已打开 · ${openItems.length}`}>
              {openItems.map(({ tab, openedLabel }) => (
                <Row
                  key={tab.id}
                  title={tab.title}
                  sub={`${metaOf(tab.type).typeLabel} · ${SCOPE_LABEL[tab.scope]} · ${openedLabel}`}
                  active={state?.activeTabId === tab.id}
                  onActivate={() => {
                    setActive(tab.id);
                    onClose();
                  }}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </Group>
          )}

          {closedItems.length > 0 && (
            <Group title={`最近关闭 · ${closedItems.length}`}>
              {closedItems.map(({ tab, closedAt }) => (
                <Row
                  key={tab.id}
                  title={tab.title}
                  sub={`${metaOf(tab.type).typeLabel} · ${relTime(closedAt, now)}`}
                  onActivate={() => {
                    reopen();
                    onClose();
                  }}
                  restoreIcon
                />
              ))}
            </Group>
          )}

          {/* 第三组：还没开过的页签类型。搜得到 + 点得开，才谈得上「功能可见」 */}
          {catalogItems.length > 0 && (
            <Group title={`可打开的标签 · ${catalogItems.length}`}>
              {catalogItems.map(({ type, title }) => {
                const meta = metaOf(type);
                const note = canOpenTab(type, ownerId)
                  ? SCOPE_LABEL[scopeOf(type)]
                  : "需先打开一条会话";
                return (
                  <Row
                    key={type}
                    title={title}
                    sub={`${meta.typeLabel} · ${note}`}
                    disabled={!canOpenTab(type, ownerId)}
                    onActivate={() => {
                      openTabType(type, ownerId);
                      onClose();
                    }}
                    openIcon
                  />
                );
              })}
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-1">
      <p className="px-4 py-1.5 text-caption text-ash">{title}</p>
      {children}
    </section>
  );
}

function Row({
  title,
  sub,
  active,
  onActivate,
  onClose,
  restoreIcon,
  openIcon,
  disabled,
}: {
  title: string;
  sub: string;
  active?: boolean;
  onActivate: () => void;
  onClose?: () => void;
  restoreIcon?: boolean;
  openIcon?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-4 py-1.5",
        active ? "bg-teal-tint" : disabled ? "" : "hover:bg-line-soft",
      )}
    >
      <button
        onClick={onActivate}
        disabled={disabled}
        className={cn("flex min-w-0 flex-1 items-center gap-2 text-left", disabled && "cursor-not-allowed")}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-body-sm",
            active ? "text-ink" : disabled ? "text-ash" : "text-graphite",
          )}
        >
          {title}
        </span>
        <span className="shrink-0 font-mono text-caption text-ash">{sub}</span>
      </button>
      {onClose ? (
        <button
          onClick={onClose}
          aria-label={`关闭 ${title}`}
          className="shrink-0 rounded p-1 text-ash opacity-0 transition group-hover:opacity-100 hover:text-ink"
        >
          <X size={11} />
        </button>
      ) : openIcon ? (
        <Plus size={11} className="shrink-0 text-ash" aria-hidden />
      ) : (
        <RotateCcw size={11} className="shrink-0 text-ash" aria-hidden />
      )}
    </div>
  );
}

/**
 * 标签栏末尾的总览入口。
 *
 * 对齐 ZCode：`resolveSidePaneTabsOverflow` 决定的是 add button 放 tab 条**内**还是**外**。
 * 这里统一常驻；`compact` 时只留图标，因为此时 tab 条已经放不下了。
 */
export function OverviewTrigger({ onOpen, compact }: { onOpen: () => void; compact?: boolean }) {
  return (
    <button
      onClick={onOpen}
      title="面板总览与搜索"
      aria-label="面板总览与搜索"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-1 text-ash hover:bg-line-soft hover:text-ink",
        compact ? "" : "text-caption",
      )}
    >
      {compact ? <ChevronsDown size={12} /> : <Plus size={11} />}
      {!compact && <span>总览</span>}
    </button>
  );
}
