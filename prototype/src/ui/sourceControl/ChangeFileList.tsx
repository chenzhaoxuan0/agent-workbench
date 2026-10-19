import { useState } from "react";
import { ChevronDown, ChevronRight, Code2, Copy, FolderOpen, Loader2, Minus, Plus } from "lucide-react";
import type { GitChangeEntry, GitDiffResult } from "../../core/git.ts";
import { fetchGitDiff, openInEditor } from "../../adapters/daemon/client.ts";
import { cn } from "../cn.ts";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "../QuickContextMenu.tsx";
import { ChangeDiffView } from "./ChangeDiffView.tsx";

/**
 * 改动文件列表（一组 entry）+ 行内 stage/unstage + 点击展开单文件 diff。
 *
 * 提交对话框与源代码管理页的「改动」区共用同一份渲染 —— 两处对「改动长什么样」
 * 必须有同一口径（ADR 0010 的 ③）。diff 是**展开式**而不是右侧预览 pane：
 * 右侧 pane 要重排页面信息架构，展开式先把「看得见」这件事做到。
 */

export type ChangeSourceId = "staged" | "unstaged";

/** porcelain v2 的状态字母 → 人话标签（只覆盖常见形态，其余原样显示） */
function statusLabel(entry: GitChangeEntry, sourceId: ChangeSourceId): string {
  if (entry.xy === "??") return "未跟踪";
  const letter = sourceId === "staged" ? entry.xy.charAt(0) : entry.xy.charAt(1);
  switch (letter) {
    case "M":
      return "修改";
    case "A":
      return "新增";
    case "D":
      return "删除";
    case "R":
      return "重命名";
    case "C":
      return "复制";
    case "U":
      return "冲突";
    default:
      return letter === "." || letter === " " ? "修改" : letter;
  }
}

export function ChangeFileList(props: {
  rootPath: string;
  entries: readonly GitChangeEntry[];
  sourceId: ChangeSourceId;
  disabled?: boolean;
  busy?: boolean;
  /** 行尾的暂存/取消暂存动作。给 null 就不渲染按钮（只读预览） */
  onStage?: (paths: readonly string[]) => void;
  onUnstage?: (paths: readonly string[]) => void;
  emptyText: string;
}) {
  const { entries, sourceId } = props;
  if (entries.length === 0) {
    return <div className="px-3 py-4 text-center text-caption text-ash">{props.emptyText}</div>;
  }
  return (
    <div>
      {entries.map((entry) => (
        <ChangeFileRow
          key={`${sourceId}/${entry.path}`}
          rootPath={props.rootPath}
          entry={entry}
          sourceId={sourceId}
          disabled={props.disabled}
          busy={props.busy}
          onStage={props.onStage}
          onUnstage={props.onUnstage}
        />
      ))}
    </div>
  );
}

function ChangeFileRow(props: {
  rootPath: string;
  entry: GitChangeEntry;
  sourceId: ChangeSourceId;
  disabled?: boolean;
  busy?: boolean;
  onStage?: (paths: readonly string[]) => void;
  onUnstage?: (paths: readonly string[]) => void;
}) {
  const { entry, sourceId } = props;
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 行右键：复制路径 / 定位 / 编辑器打开（ZCode GitPaneChangeCard 同款，提交
  // 对话框与源码管理页共用本渲染，一处加两处生效）
  const [menu, setMenu] = useState<QuickMenuState | null>(null);

  // 未跟踪目录条目（dist/）没有可比对的内容，展开没意义
  const expandable = !entry.path.endsWith("/");
  const isDirEntry = entry.path.endsWith("/");
  const absPath = `${props.rootPath.replace(/[\\/]+$/, "")}/${entry.path}`;
  /** 目录条目开自身；文件条目开父目录（explorer 收到文件路径会用默认应用打开） */
  const revealPath = isDirEntry ? absPath : absPath.replace(/[\\/][^\\/]*$/, "") || absPath;

  async function fetchDiff(): Promise<void> {
    setLoading(true);
    setDiffError(null);
    try {
      setDiff(await fetchGitDiff({ rootPath: props.rootPath, path: entry.path, sourceId }));
    } catch (err: unknown) {
      // 拉取失败不缓存：缓成空 patch 会渲染成「没有差异」，且永远不再重试。
      // diff 留 null（重展自动重拉）+ 错误行给手动重试出口。
      setDiffError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (diff !== null) return; // 展开过一次就缓存，省得来回点反复拉
    await fetchDiff();
  }

  const Arrow = open ? ChevronDown : ChevronRight;

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <div
        className="flex items-center gap-1 px-2 py-1 hover:bg-line-soft/50"
        onContextMenu={(e) =>
          setMenu(
            quickMenuFromEvent(e, [
              {
                label: "复制路径",
                icon: Copy,
                onSelect: () => void navigator.clipboard.writeText(entry.path).catch(() => {}),
              },
              {
                label: "复制完整路径",
                icon: Copy,
                onSelect: () => void navigator.clipboard.writeText(absPath).catch(() => {}),
              },
              { separator: true },
              {
                label: "在资源管理器中打开",
                icon: FolderOpen,
                onSelect: () => void openInEditor({ path: revealPath, editorId: "explorer" }),
              },
              {
                label: "用 VS Code 打开",
                icon: Code2,
                onSelect: () => void openInEditor({ path: absPath, editorId: "vscode" }),
              },
            ]),
          )
        }
      >
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={!expandable}
          title={expandable ? (open ? "收起 diff" : "展开 diff") : "目录没有单文件 diff"}
          aria-label={expandable ? "展开 diff" : "目录条目"}
          className="shrink-0 rounded p-0.5 text-ash hover:text-ink disabled:opacity-30"
        >
          <Arrow size={11} />
        </button>
        <span className="w-8 shrink-0 font-mono text-[10px] text-ash">{statusLabel(entry, sourceId)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink" title={entry.path}>
          {entry.path}
        </span>
        <span className="tnum shrink-0 font-mono text-[10px]">
          {entry.added > 0 && <span className="text-gain">+{entry.added}</span>}
          {entry.added > 0 && entry.removed > 0 && <span className="text-ash"> </span>}
          {entry.removed > 0 && <span className="text-loss">-{entry.removed}</span>}
        </span>
        {props.onStage !== undefined && sourceId === "unstaged" && (
          <button
            type="button"
            disabled={props.disabled || props.busy}
            onClick={() => props.onStage?.([entry.path])}
            title="暂存该文件"
            aria-label="暂存该文件"
            className="shrink-0 rounded p-0.5 text-ash hover:bg-teal-tint hover:text-teal disabled:opacity-30"
          >
            <Plus size={11} />
          </button>
        )}
        {props.onUnstage !== undefined && sourceId === "staged" && (
          <button
            type="button"
            disabled={props.disabled || props.busy}
            onClick={() => props.onUnstage?.([entry.path])}
            title="取消暂存该文件"
            aria-label="取消暂存该文件"
            className="shrink-0 rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink disabled:opacity-30"
          >
            <Minus size={11} />
          </button>
        )}
      </div>
      {open && (
        <div className={cn("border-t border-line-soft bg-rail/40")}>
          {loading ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-caption text-ash">
              <Loader2 size={11} className="animate-spin" /> 读取中…
            </div>
          ) : diffError !== null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-caption text-loss">
              <span className="min-w-0 flex-1 break-all">读取 diff 失败：{diffError}</span>
              <button
                type="button"
                onClick={() => void fetchDiff()}
                className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                重试
              </button>
            </div>
          ) : (
            <ChangeDiffView
              patch={diff?.patch ?? ""}
              binary={diff?.binary === true}
              truncated={diff?.truncated === true}
              loading={false}
            />
          )}
        </div>
      )}
      <QuickContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
