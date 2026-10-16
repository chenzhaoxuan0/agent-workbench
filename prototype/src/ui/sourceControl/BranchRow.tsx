import { Check, Cloud, FolderGit2, GitBranch } from "lucide-react";
import type { GitBranchInfo } from "../../core/git.ts";
import { formatRelative } from "../../core/automation.ts";
import { cn } from "../cn.ts";
import { RowBtn } from "./RowBtn.tsx";

/** 分支列表行：当前分支高亮 + 勾选，hash·相对时间·提交摘要；hover 出行内操作。
 * 分支面收窄后（ADR 0009）只留「切换」与「基于此分支新建工作树」两个动作 */
export function BranchRow(props: {
  branch: GitBranchInfo;
  current: string | null;
  disabled: boolean;
  onCheckout: () => void;
  onCreateWorktreeFrom: () => void;
}) {
  const { branch, current, disabled } = props;
  const isCurrent = branch.kind === "local" && branch.name === current;
  const ts = Date.parse(branch.dateIso);
  return (
    <div
      className={cn(
        "group flex items-center gap-2 border-b border-line-soft px-3 py-2 last:border-b-0",
        isCurrent ? "bg-teal-tint" : "hover:bg-line-soft/60",
        branch.kind === "remote" && "text-ash",
      )}
    >
      {branch.kind === "remote" ? (
        <Cloud size={13} className="shrink-0 text-graphite" />
      ) : (
        <GitBranch size={13} className={cn("shrink-0", isCurrent ? "text-teal" : "text-graphite")} />
      )}
      <span className={cn("min-w-0 truncate text-body-sm", isCurrent ? "font-medium text-ink" : "text-ink")}>
        {branch.name}
      </span>
      {isCurrent && <Check size={12} className="shrink-0 text-teal" />}
      {branch.checkedOutIn !== null && !isCurrent && (
        <span className="shrink-0 rounded-chip bg-rail px-1.5 py-px text-[10px] text-ash" title={branch.checkedOutIn}>
          已被工作树检出
        </span>
      )}
      <span className="tnum min-w-0 flex-1 truncate text-caption text-ash">
        {branch.shortHash} · {Number.isFinite(ts) ? formatRelative(ts) : ""} · {branch.subject}
      </span>

      {/* 行内操作：hover 浮现；当前分支没有行内动作 */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {!isCurrent && (
          <>
            {branch.kind === "local" && (
              <RowBtn label={`切换到 ${branch.name}`} icon={Check} disabled={disabled} onClick={props.onCheckout} />
            )}
            <RowBtn
              label="基于此分支新建工作树"
              icon={FolderGit2}
              disabled={disabled}
              onClick={props.onCreateWorktreeFrom}
            />
          </>
        )}
      </div>
    </div>
  );
}
