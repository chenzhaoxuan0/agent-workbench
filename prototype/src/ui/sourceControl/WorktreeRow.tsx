import { FolderGit2, GitBranch, Rocket, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import type { GitWorktree } from "../../core/git.ts";
import { RowBtn } from "./RowBtn.tsx";

/** 工作树的短标题：路径末段（对话框标题、终端标签共用） */
export function worktreeTitle(wt: GitWorktree): string {
  const segs = wt.path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? wt.path;
}

/** 工作树列表行：分支徽标 / 主工作树 / 脏标记 + 行内操作 */
export function WorktreeRow(props: {
  wt: GitWorktree;
  rootPath: string;
  disabled: boolean;
  sessionWorktreeSupported: boolean;
  onStartSession: () => void;
  onTerminal: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const { wt, disabled } = props;
  const segs = wt.path.split(/[\\/]/).filter(Boolean);
  const name = segs[segs.length - 1] ?? wt.path;
  return (
    <div className="group flex items-center gap-2 border-b border-line-soft px-3 py-2 last:border-b-0 hover:bg-line-soft/60">
      <FolderGit2 size={13} className="shrink-0 text-graphite" />
      <span className="min-w-0 max-w-[30%] truncate text-body-sm text-ink" title={wt.path}>
        {name}
      </span>
      {wt.branch !== null ? (
        <span className="flex shrink-0 items-center gap-1 rounded-chip border border-line bg-rail px-1.5 py-px text-[11px] text-graphite">
          <GitBranch size={10} />
          {wt.branch}
        </span>
      ) : (
        <span className="shrink-0 rounded-chip bg-rail px-1.5 py-px text-[11px] text-ash">@{wt.headShort}</span>
      )}
      {wt.isMain && (
        <span className="shrink-0 rounded-chip bg-rail px-1.5 py-px text-[10px] text-graphite">主工作树</span>
      )}
      {wt.dirty && (
        <span className="flex shrink-0 items-center gap-1 rounded-chip bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600">
          有改动
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-caption text-ash" title={wt.path}>
        {wt.path}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <RowBtn
          label={
            props.sessionWorktreeSupported
              ? "在此工作树启动会话"
              : "当前执行器不支持工作树会话（切换执行器后可用）"
          }
          icon={Rocket}
          disabled={disabled || !props.sessionWorktreeSupported || wt.branch === null}
          onClick={props.onStartSession}
        />
        <RowBtn label="在终端中打开" icon={TerminalIcon} disabled={disabled} onClick={props.onTerminal} />
        <RowBtn label="在文件管理器中显示" icon={FolderGit2} disabled={disabled} onClick={props.onReveal} />
        {!wt.isMain && <RowBtn label="删除工作树" icon={Trash2} disabled={disabled} onClick={props.onDelete} danger />}
      </div>
    </div>
  );
}
