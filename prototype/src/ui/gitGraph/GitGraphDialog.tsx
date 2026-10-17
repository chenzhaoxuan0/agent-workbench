import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { AlertCircle, GitBranch, GitGraph, GitMerge, Loader2, RefreshCw, Tag } from "lucide-react";
import type { GitGraphCommit, GitGraphRef } from "../../core/git.ts";
import { fetchGitGraph } from "../../adapters/daemon/client.ts";
import { DialogShell } from "../sourceControl/DialogShell.tsx";
import { cn } from "../cn.ts";
import { layoutGitGraph, type GitGraphLayoutPath } from "./layout.ts";

/**
 * 提交图对话框（docs/16，ZCode GitGraphDialog 同款交互）：泳道 SVG + 四列表
 * （描述 / 时间 / 作者 / 哈希），50 条一页、近底部自动加载更多，可手动刷新。
 * 点行选中并展开详情脚（不嵌 diff —— 看元数据；看改动走 ③ 审阅入口）。
 * 入口在 BranchPicker 弹层底栏（ZCode 同款：提交框内嵌的精简 picker 不带）。
 */

const PAGE_SIZE = 50;
const LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
const GRAPH_COLUMN_MIN_WIDTH_PX = 56;

/** 泳道四色轮转（亮暗双主题下都是实色 token） */
const LANE_STROKE_CLASSES = ["stroke-secondary", "stroke-teal", "stroke-highlight", "stroke-gain"];

function laneClass(laneIndex: number): string {
  return LANE_STROKE_CLASSES[laneIndex % LANE_STROKE_CLASSES.length]!;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function formatCommitTime(sec: number): string {
  if (sec <= 0) return "";
  const d = new Date(sec * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RefBadge(props: { ref: GitGraphRef }) {
  const r = props.ref;
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-md border border-line bg-rail px-1.5 text-caption text-graphite",
        r.kind === "head" && "border-teal-edge bg-teal-tint text-ink",
        r.kind === "tag" && "border-highlight/40 text-ink",
      )}
      title={r.kind === "head" ? "HEAD" : r.kind === "tag" ? "标签" : r.kind === "remote" ? "远端分支" : "分支"}
    >
      {r.kind === "tag" ? <Tag size={10} className="shrink-0" /> : <GitBranch size={10} className="shrink-0" />}
      <span className="max-w-32 truncate font-mono">{r.name}</span>
    </span>
  );
}

function isPathRelated(path: GitGraphLayoutPath, hash: string | null): boolean {
  return hash !== null && path.relatedHashes.includes(hash);
}

export function GitGraphDialog(props: { rootPath: string; branchName: string | null; onClose: () => void }) {
  const { rootPath, branchName } = props;
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commits, setCommits] = useState<readonly GitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  const layout = useMemo(() => layoutGitGraph(commits), [commits]);
  const expanded = commits.find((c) => c.hash === expandedHash) ?? null;
  const graphColumnWidth = Math.max(layout.width + 12, GRAPH_COLUMN_MIN_WIDTH_PX);

  const loadFirstPage = useCallback(
    async (mode: "initial" | "refresh"): Promise<void> => {
      if (mode === "initial") {
        setLoading(true);
        setCommits([]);
        setHasMore(false);
        setSelectedHash(null);
      } else {
        setRefreshing(true);
      }
      setErrorMessage(null);
      try {
        const result = await fetchGitGraph({ rootPath, skip: 0, maxCount: PAGE_SIZE });
        setCommits(result.commits);
        setHasMore(result.hasMore);
        setSelectedHash(result.commits[0]?.hash ?? null);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(mode === "initial" ? `读取提交历史失败：${message}` : null);
      } finally {
        if (mode === "initial") setLoading(false);
        else setRefreshing(false);
      }
    },
    [rootPath],
  );

  useEffect(() => {
    void loadFirstPage("initial");
  }, [loadFirstPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loading || loadingMore || refreshing || loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await fetchGitGraph({ rootPath, skip: commits.length, maxCount: PAGE_SIZE });
      setCommits((current) => [...current, ...result.commits]);
      setHasMore(result.hasMore);
    } catch (err: unknown) {
      setErrorMessage(`加载更多失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [commits.length, hasMore, loading, loadingMore, refreshing, rootPath]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>): void => {
      if (!hasMore || loadingMore) return;
      const target = e.currentTarget;
      if (target.scrollHeight - target.scrollTop - target.clientHeight <= LOAD_MORE_SCROLL_THRESHOLD_PX) {
        void loadMore();
      }
    },
    [hasMore, loadMore, loadingMore],
  );

  const tableCols = "minmax(0,1fr) 110px 128px 72px";

  return (
    <DialogShell
      title={`提交图${branchName === null ? "" : ` · ${branchName}`}`}
      onClose={props.onClose}
      widthClass="h-[min(78vh,720px)] w-[min(1060px,92vw)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <GitGraph size={13} className="shrink-0 text-teal" />
            <span className="truncate text-body-sm font-medium text-ink">可见历史（分支 · 标签 · 远端）</span>
          </div>
          <button
            type="button"
            disabled={refreshing || loading}
            onClick={() => void loadFirstPage("refresh")}
            title="刷新"
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
          </button>
        </div>

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-ash">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : errorMessage !== null && commits.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="flex max-w-md items-start gap-2 rounded-card border border-line bg-rail p-3 text-body-sm text-graphite">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-loss" />
              <span className="break-all">{errorMessage}</span>
            </div>
          </div>
        ) : commits.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
            <GitGraph size={22} className="text-ash" />
            <p className="text-body-sm text-ink">还没有任何提交</p>
            <p className="text-caption text-ash">第一次提交之后，这里会画出分支历史</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
            {/* 外层恒为两轨：图列 + 表格区。表头与行各自内嵌同一套 tableCols
                四列网格 —— 列定义绝不能拼进外层模板（那会让子元素按 5 条轨道
                错位落格，泳道/行会被塞进时间、作者列的轨道里） */}
            <div className="grid min-w-[720px]" style={{ gridTemplateColumns: `minmax(${GRAPH_COLUMN_MIN_WIDTH_PX}px, ${graphColumnWidth}px) minmax(0, 1fr)` }}>
              {/* 表头行 */}
              <div className="border-b border-r border-line bg-rail px-2 py-2 text-caption text-ash">图</div>
              <div className="grid border-b border-line bg-rail text-caption text-ash" style={{ gridTemplateColumns: tableCols }}>
                <div className="border-r border-line-soft px-3 py-2">描述</div>
                <div className="border-r border-line-soft px-3 py-2">时间</div>
                <div className="border-r border-line-soft px-3 py-2">作者</div>
                <div className="px-3 py-2">提交</div>
              </div>

              {/* 泳道 SVG：行高对齐右侧行网格（rowHeight 一致才能点圈对行） */}
              <div className="relative border-r border-line-soft bg-canvas/40" style={{ height: layout.height + layout.rowHeight }}>
                <svg
                  className="absolute inset-0 overflow-visible"
                  width={graphColumnWidth}
                  height={layout.height + layout.rowHeight}
                  viewBox={`0 0 ${graphColumnWidth} ${layout.height + layout.rowHeight}`}
                  role="img"
                  aria-label="提交图泳道"
                >
                  {layout.paths.map((path) => (
                    <path
                      key={path.id}
                      d={path.path}
                      className={cn(
                        "fill-none stroke-2 transition-opacity",
                        laneClass(path.laneIndex),
                        hoveredHash !== null && !isPathRelated(path, hoveredHash) && "opacity-25",
                      )}
                    />
                  ))}
                  {layout.rows.map((row) => {
                    const isSelected = row.commit.hash === selectedHash;
                    return (
                      <g key={row.commit.hash}>
                        <circle
                          cx={row.x}
                          cy={row.y}
                          r={isSelected ? 4.25 : 4}
                          className={cn("stroke-canvas stroke-2 transition-all", laneClass(row.laneIndex))}
                        />
                        {isSelected && (
                          <circle cx={row.x} cy={row.y} r={5.5} className={cn("fill-none stroke-1 opacity-85", laneClass(row.laneIndex))} />
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* 行 */}
              <div className="min-w-0">
                {layout.rows.map((row) => {
                  const c = row.commit;
                  const isSelected = c.hash === selectedHash;
                  const isHovered = c.hash === hoveredHash;
                  return (
                    <button
                      key={c.hash}
                      type="button"
                      className={cn(
                        "grid w-full min-w-0 items-center border-y border-transparent text-left transition-colors",
                        isSelected ? "border-b-line bg-teal-tint" : "hover:bg-line-soft",
                        isHovered && !isSelected && "bg-line-soft",
                      )}
                      style={{ gridTemplateColumns: tableCols, height: layout.rowHeight }}
                      onClick={() => {
                        setSelectedHash(c.hash);
                        setExpandedHash((cur) => (cur === c.hash ? null : c.hash));
                      }}
                      onMouseEnter={() => setHoveredHash(c.hash)}
                      onMouseLeave={() => setHoveredHash(null)}
                    >
                      <span className="flex min-w-0 items-center gap-2 px-3">
                        {c.refs.length > 0 && (
                          <span className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">
                            {c.refs.slice(0, 4).map((r) => (
                              <RefBadge key={`${c.hash}:${r.kind}:${r.name}`} ref={r} />
                            ))}
                          </span>
                        )}
                        <span className="truncate text-body-sm text-ink" title={c.subject}>
                          {c.subject.length > 0 ? c.subject : shortHash(c.hash)}
                        </span>
                        {c.parents.length > 1 && <GitMerge size={12} className="shrink-0 text-highlight" />}
                      </span>
                      <span className="truncate border-l border-line-soft px-3 text-caption text-ash">{formatCommitTime(c.authorAtSec)}</span>
                      <span className="truncate border-l border-line-soft px-3 text-caption text-graphite">{c.authorName || "-"}</span>
                      <span className="truncate border-l border-line-soft px-3 font-mono text-caption text-ash">{shortHash(c.hash)}</span>
                    </button>
                  );
                })}
                {hasMore && (
                  <div className="flex h-10 items-center border-b border-line-soft px-3">
                    <button
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      className="w-full rounded-btn px-2 py-1 text-caption text-ash transition-colors hover:bg-line-soft hover:text-ink disabled:opacity-50"
                    >
                      {loadingMore ? "加载中…" : "加载更多"}
                    </button>
                  </div>
                )}
                {errorMessage !== null && (
                  <div className="break-all border-b border-line-soft px-3 py-2 text-caption text-loss">{errorMessage}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 详情脚：点行展开 */}
        {expanded !== null && (
          <div className="grid shrink-0 gap-3 border-t border-line bg-rail/60 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <div className="mb-1 text-caption text-ash">描述</div>
              <div className="break-words text-body-sm text-ink">{expanded.subject.length > 0 ? expanded.subject : shortHash(expanded.hash)}</div>
              {expanded.refs.length > 0 && (
                <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                  {expanded.refs.map((r) => (
                    <RefBadge key={`${expanded.hash}:all:${r.kind}:${r.name}`} ref={r} />
                  ))}
                </div>
              )}
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="text-caption text-ash">提交</div>
                <div className="truncate font-mono text-caption text-ink" title={expanded.hash}>
                  {expanded.hash}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-caption text-ash">作者</div>
                <div className="truncate text-caption text-ink">{expanded.authorName || "-"}</div>
              </div>
              <div className="min-w-0">
                <div className="text-caption text-ash">时间</div>
                <div className="truncate text-caption text-ink">{formatCommitTime(expanded.authorAtSec) || "-"}</div>
              </div>
              <div className="min-w-0">
                <div className="text-caption text-ash">父提交</div>
                <div className="truncate font-mono text-caption text-ink">
                  {expanded.parents.length > 0 ? expanded.parents.map(shortHash).join(", ") : "-"}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
