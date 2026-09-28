import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { deriveTrajectory, trajTokenText, type TrajKind } from "../core/trajectory.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 轨迹视图 —— 对齐 dsh 的 TrajectoryView（会话内与「对话」并列的页签，
 * 激活后占据整个会话视口，composer 保持在底部）。
 *
 * 账本行 = dsh 的 TrajectoryTable 行：类型色标（系统/用户/助手/工具/…）
 * + 单行省略摘要 + 工具行内联「→ 结果」；轮次 sticky 头（第 N 轮 +
 * token/步数/工具直方图）；工具栏提供折叠轮次与搜索。
 * 三泳道时间轴（dsh TrajectoryTimeline）待真实运行时的精确计时接入后再补。
 */

const KIND_TAG: Record<TrajKind, { label: string; cls: string }> = {
  system: { label: "系统", cls: "bg-line-soft text-graphite" },
  user: { label: "用户", cls: "bg-ink text-canvas" },
  assistant: { label: "助手", cls: "bg-teal-tint text-teal" },
  tool: { label: "工具", cls: "bg-line-soft text-graphite" },
  plan: { label: "计划", cls: "bg-line-soft text-graphite" },
  permission: { label: "权限", cls: "bg-line-soft text-graphite" },
  subagent: { label: "子代理", cls: "bg-line-soft text-graphite" },
  diff: { label: "变更", cls: "bg-line-soft text-graphite" },
  deliverable: { label: "产出", cls: "bg-teal-tint text-teal" },
};

export function TrajectoryView() {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const traj = useMemo(() => deriveTrajectory(timeline), [timeline]);

  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visibleTurns = traj.turns
    .map((t) => ({
      ...t,
      rows: t.records
        .filter((r) => !needle || r.text.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle))
        .map((r) => ({ ...r, kindTag: KIND_TAG[r.kind] })),
    }))
    .filter((t) => t.rows.length > 0);

  const allCollapsed = visibleTurns.length > 0 && visibleTurns.every((t) => collapsedTurns.has(t.turn));
  const toggleTurn = (turn: number) =>
    setCollapsedTurns((s) => {
      const next = new Set(s);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏（dsh TrajectoryToolbar：折叠轮次 + 搜索） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-2">
        <button
          onClick={() =>
            setCollapsedTurns((s) => {
              const all = visibleTurns.length > 0 && visibleTurns.every((t) => collapsedTurns.has(t.turn));
              return all ? new Set<number>() : new Set(visibleTurns.map((t) => t.turn));
            })
          }
          aria-pressed={allCollapsed}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink aria-pressed:border-teal-edge aria-pressed:bg-teal-tint aria-pressed:text-ink"
        >
          折叠轮次
        </button>
        <div className="ml-auto flex w-64 items-center gap-1.5 rounded-input border border-line bg-rail px-2 py-1">
          <Search size={11} className="shrink-0 text-ash" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索轨迹…"
            aria-label="搜索轨迹"
            className="min-w-0 flex-1 bg-transparent text-caption text-ink outline-none placeholder:text-ash"
          />
        </div>
      </div>

      {/* 账本 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-[900px]">
          {visibleTurns.length === 0 ? (
            <p className="py-10 text-center text-body-sm text-ash">
              {needle ? "没有匹配的记录。" : "本会话还没有轨迹。"}
            </p>
          ) : (
            visibleTurns.map((turn) => {
              const isCollapsed = collapsedTurns.has(turn.turn);
              return (
                <section key={turn.turn} className="mb-5">
                  {/* 轮次头（dsh TrajectoryTurnHeader：Turn N + token/步数/工具） */}
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-canvas py-1.5">
                    <button
                      onClick={() => toggleTurn(turn.turn)}
                      aria-expanded={!isCollapsed}
                      className="flex shrink-0 items-center gap-1 rounded-btn px-1 py-0.5 text-caption font-medium text-ink hover:bg-line-soft"
                    >
                      <ChevronDown size={11} className={cn("transition-transform", isCollapsed && "-rotate-90")} />
                      第 {turn.turn} 轮
                    </button>
                    <span className="ml-auto tnum shrink-0 text-caption text-ash">
                      {trajTokenText(turn.tokens)} · {turn.steps} 步 · 工具×{turn.toolCalls}
                    </span>
                  </div>

                  {!isCollapsed && (
                    <div className="space-y-px border-t border-line-soft pt-1">
                      {turn.rows.map((r) => {
                        const tag = KIND_TAG[r.kind];
                        return (
                          <LedgerLine
                            key={r.id}
                            kindLabel={tag.label}
                            kindCls={tag.cls}
                            isError={r.isError}
                            clock={r.clock}
                            text={r.text}
                            result={r.result}
                            detail={r.detail}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })
          )}
          {busy && (
            <p className="flex items-center gap-2 py-2 text-caption text-graphite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              采集中…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 账本行 */

function LedgerLine({
  kindLabel,
  kindCls,
  isError,
  clock,
  text,
  result,
  detail,
}: {
  kindLabel: string;
  kindCls: string;
  isError?: boolean;
  clock: string;
  text: string;
  result?: string;
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => detail && setOpen((o) => !o)}
        aria-expanded={detail ? open : undefined}
        className={cn(
          "flex w-full items-baseline gap-2 rounded-btn px-1 py-1 text-left",
          detail ? "cursor-pointer hover:bg-line-soft" : "cursor-default",
        )}
      >
        <span className="tnum w-14 shrink-0 text-[10px] text-ash">{clock}</span>
        <span
          className={cn(
            "shrink-0 rounded-chip px-1.5 py-px text-[10px] leading-4",
            kindCls,
            isError && "bg-loss/10 text-loss",
          )}
        >
          {kindLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption text-ink">
          {text}
          {result && <span className="text-ash"> → {result}</span>}
        </span>
        {detail && (
          <ChevronRight size={11} className={cn("shrink-0 text-ash transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && detail && (
        <pre className="ml-[76px] mr-1 mb-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-btn bg-rail p-2 font-mono text-caption leading-relaxed text-graphite">
          {detail}
        </pre>
      )}
    </div>
  );
}
