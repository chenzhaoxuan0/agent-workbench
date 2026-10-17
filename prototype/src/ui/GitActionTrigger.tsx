import { useEffect, useState } from "react";
import { AlertTriangle, GitCommitHorizontal, Upload } from "lucide-react";
import { resolveGitActionMenuPrimaryAction, type GitAction, type GitStatus } from "../core/git.ts";
import { fetchGitStatus } from "../adapters/daemon/client.ts";
import { useGit } from "../store/useGit.ts";
import { CommitDialog } from "./sourceControl/CommitDialog.tsx";
import { PushDialog } from "./sourceControl/PushDialog.tsx";
import { DialogShell } from "./sourceControl/DialogShell.tsx";
import { cn } from "./cn.ts";

/**
 * Composer 顶栏的落库触发器 —— git 三分入口的 ②「要不要落库」（ADR 0010）。
 *
 * **状态驱动，而不是菜单驱动**：有改动亮提交图标、领先远端亮推送图标，用户不点开
 * 就知道该做什么。这个价值只有独立入口才有 —— 折进一个菜单里，信号就消失了。
 *
 * **始终展示、异常置灰、不消失**（ZCode 踩过的可用性坑）：按钮不见了，用户分不清
 * 是仓库干净、功能坏了，还是压根不是 git 仓库。所以干净且同步时它还在，只是灰的。
 */
export function GitActionTrigger(props: { rootPath: string | undefined }) {
  const rootPath = props.rootPath;
  const badge = useGit((s) => (rootPath === undefined ? undefined : s.badgeByRoot[rootPath]));
  const refreshBadge = useGit((s) => s.refreshBranchBadge);
  const [dialog, setDialog] = useState<{ kind: "commit"; action: GitAction } | { kind: "push" } | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusFetch, setStatusFetch] = useState<"idle" | "loading" | "failed">("idle");

  // 与 BranchPicker 同一道 TTL 闸：共用同一份徽章快照，不另起 git 进程
  useEffect(() => {
    if (rootPath !== undefined) void refreshBadge(rootPath);
  }, [rootPath, refreshBadge]);

  // 推送对话框要展示完整的 status（upstream / behind），徽章里没带这些字段，
  // 所以只在真的打开推送对话框时补拉一次。每次打开都重拉并复位 —— 拉失败
  // 也要给反馈：静默不开框看起来就像按钮坏了
  useEffect(() => {
    if (dialog?.kind !== "push" || rootPath === undefined) return;
    setStatus(null);
    setStatusFetch("loading");
    void fetchGitStatus(rootPath)
      .then((r) => {
        if (r.isRepo) {
          setStatus(r);
          setStatusFetch("idle");
        } else {
          setStatusFetch("failed");
        }
      })
      .catch(() => setStatusFetch("failed"));
  }, [dialog, rootPath]);

  if (rootPath === undefined || badge == null) return null;

  const primary = resolveGitActionMenuPrimaryAction({
    dirtyFileCount: badge.dirtyFileCount,
    ahead: badge.ahead,
  });
  const enabled = primary !== null;
  const pushOnly = primary === "push";

  const Icon = pushOnly ? Upload : GitCommitHorizontal;
  const label = pushOnly
    ? `推送 ${badge.ahead} 个提交到远端`
    : badge.dirtyFileCount > 0
      ? `提交 ${badge.dirtyFileCount} 个改动`
      : "没有待提交或待推送的改动";

  return (
    <>
      <button
        type="button"
        disabled={!enabled}
        onClick={() => {
          if (pushOnly) setDialog({ kind: "push" });
          else setDialog({ kind: "commit", action: primary ?? "commit" });
        }}
        title={label}
        aria-label={label}
        className={cn(
          "flex items-center gap-1 rounded-md border border-line/60 px-1.5 py-0.5 text-[11px] transition select-none",
          enabled
            ? "bg-line-soft/60 font-mono text-graphite hover:text-ink active:scale-95"
            : // 置灰而不是消失：消失即信号丢失
              "cursor-not-allowed border-line/40 text-ash/60",
        )}
      >
        <Icon size={11} className={cn("shrink-0", enabled ? "text-teal" : "text-ash/60")} />
        {/* 窄屏只留图标（Tailwind v4 的任意断点写法；ZCode 同款处理） */}
        <span className="tnum font-mono max-[560px]:hidden">
          {badge.dirtyFileCount > 0 ? badge.dirtyFileCount : badge.ahead}
        </span>
      </button>

      {dialog?.kind === "commit" && (
        <CommitDialog
          rootPath={rootPath}
          ahead={badge.ahead}
          initialAction={dialog.action}
          onClose={() => setDialog(null)}
          onDone={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "push" && status !== null && (
        <PushDialog rootPath={rootPath} status={status} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "push" && status === null && statusFetch === "failed" && (
        <DialogShell title="推送" onClose={() => setDialog(null)}>
          <div className="flex items-start gap-2 p-4 text-caption text-loss">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>读取仓库状态失败，稍后再试一次。</span>
          </div>
        </DialogShell>
      )}
    </>
  );
}
