import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  Cloud,
  FolderGit2,
  GitBranch,
  GitMerge,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Terminal as TerminalIcon,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  GIT_ERROR_CODES,
  validateBranchName,
  type GitBranchInfo,
  type GitStatus,
  type GitWorktree,
} from "../core/git.ts";
import { formatRelative } from "../core/automation.ts";
import {
  abortGitMerge,
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  deleteGitBranch,
  mergeGitBranch,
  removeGitWorktree,
  renameGitBranch,
  revealGitWorktree,
} from "../adapters/daemon/client.ts";
import { useGit } from "../store/useGit.ts";
import { useShell } from "../store/useShell.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { selectActiveUnit, useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 源代码管理主视图 —— 激活单元仓库的分支 / 工作树管理。
 *
 * 交互范式对齐 VSCode SCM（ADR 0008）：
 * - 分支行内操作：切换 / 重命名（仅当前分支）/ 删除 / 合并；远程分支只读展示，
 *   可作为新建分支 / 新建工作树的基点
 * - 删除未合并分支：`-d` 失败（branch_not_merged）→ 确认 → `-D`
 * - 删除有改动的工作树：remove 失败（worktree_dirty）→ 确认 → --force
 * - 分支已被别的工作树检出（branch_checked_out_elsewhere，带 data.path）→
 *   引导「打开那个工作树」而不是让用户干瞪眼
 * - 新建分支实时校验 + 「非法字符将替换为 -」的 sanitize-and-inform
 *
 * v1 不做：改动列表 / 暂存 / 提交 / rebase / tag（见 ADR 0008 的后续清单）。
 */

// ---- RPC 错误的形状（daemon GitError → wire error {code,message,data}） --------

interface RpcErrorShape {
  readonly code?: string;
  readonly message?: string;
  readonly data?: { readonly path?: string };
}

function asRpcError(err: unknown): RpcErrorShape {
  // data 必须带出来：branch_checked_out_elsewhere 的 data.path 是
  // 「打开那个工作树」出口按钮的唯一数据源，丢了它按钮永远不渲染
  if (err instanceof Error) {
    const e = err as Error & { code?: string; data?: { path?: string } };
    return { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
  }
  return { message: String(err) };
}

/** 开终端并把用户带到看得见它的地方：sourceControl 视图下 TerminalPanel 不挂载，
 *  只 createTab 的话标签建在后台、用户原地不动（Codex 评审 P2） */
function openTerminalAt(cwd: string, title: string): void {
  useTerminalStore.getState().createTab({ cwd, title });
  useShell.getState().setMainView("chat");
  useShell.getState().setConversationView("terminal");
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

type Dialog =
  | { kind: "createBranch"; ref?: string }
  | { kind: "rename"; name: string }
  | { kind: "createWorktree"; branch?: string; commitish?: string }
  /** root 在打开时快照：删除确认跨仓库重试会强删错仓库的同名分支（评审 P1） */
  | { kind: "deleteBranch"; root: string; name: string; forceReason?: string }
  | { kind: "deleteWorktree"; root: string; wt: GitWorktree; forceReason?: string }
  | { kind: "startSession"; wt: GitWorktree }
  | null;

export function SourceControlPage() {
  const unit = useWorkbench(selectActiveUnit);
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const rootPath = useGit((s) => s.rootPath);
  const status = useGit((s) => s.status);
  const branches = useGit((s) => s.branches);
  const worktrees = useGit((s) => s.worktrees);
  const loading = useGit((s) => s.loading);
  const error = useGit((s) => s.error);
  const setError = useGit((s) => s.setError);
  const refresh = useGit((s) => s.refresh);
  const openRepo = useGit((s) => s.openRepo);
  const pendingDialog = useGit((s) => s.pendingDialog);
  const setPendingDialog = useGit((s) => s.setPendingDialog);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const activeRuntime = runtimes.find((r) => r.id === activeRuntimeId);
  /** 会话工作树按执行器能力门控（契约 RuntimeCapabilities.worktrees） */
  const sessionWorktreeSupported = activeRuntime?.capabilities.worktrees === true;

  // 跟随激活单元换仓库（key 用 rootPath：unit 对象身份每次 units 重建都变，
  // 拿它当依赖会让无关的列表刷新都触发一轮 4+ git 进程的 refresh）
  const unitRootPath = unit?.rootPath;
  useEffect(() => {
    if (unitRootPath !== undefined) openRepo(unitRootPath);
  }, [unitRootPath, openRepo]);

  // 没有激活单元时不消费：留着等单元就绪后面板挂载时再弹，而不是静默吞掉
  useEffect(() => {
    if (pendingDialog === null || unit === undefined) return;
    setDialog(pendingDialog === "createBranch" ? { kind: "createBranch" } : { kind: "createWorktree" });
    setPendingDialog(null);
  }, [pendingDialog, setPendingDialog, unit]);

  // 面板聚焦时刷新一次（从别处切回来看到的就不是旧数据）
  useEffect(() => {
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  /** 所有操作的统一外壳：busy 门闩 + 失败横幅 + 成功刷新 */
  const op = async (name: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (err: unknown) {
      const e = asRpcError(err);
      setError({ text: `${name}失败：${e.message ?? "未知错误"}`, code: e.code, data: e.data });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (unit === undefined) {
    return <EmptyState text="没有激活的工作单元 —— 先在侧栏选择一个 Agent 或项目" />;
  }

  // openRepo 生效前 rootPath 可能还是 null；页面级后续统一用收窄后的 root
  const root = rootPath ?? unit.rootPath;
  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* 头部：仓库 + 当前分支状态 */}
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <FolderGit2 size={15} className="shrink-0 text-teal" />
        <span className="truncate text-body font-medium text-ink" title={root}>
          {repoName}
        </span>
        {status?.isRepo && <BranchChip status={status} />}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void refresh()}
            disabled={loading || busy}
            title="刷新"
            aria-label="刷新"
            className="rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </button>
        </div>
      </header>

      {/* 错误横幅（合并冲突时给「放弃合并」出口） */}
      {error !== null && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-card border border-line bg-card px-3 py-2 text-body-sm text-ink">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-loss" />
          <span className="min-w-0 flex-1 break-all">{error.text}</span>
          {error.code === GIT_ERROR_CODES.mergeConflicts && (
            <>
              <button
                onClick={() => void op("放弃合并", () => abortGitMerge(root))}
                className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                放弃合并
              </button>
              <button
                onClick={() => openTerminalAt(root, "解决合并冲突")}
                className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                在终端解决
              </button>
            </>
          )}
          {error.code === GIT_ERROR_CODES.branchCheckedOutElsewhere && error.data?.path !== undefined && (
            <button
              onClick={() => void revealGitWorktree(error.data?.path ?? "")}
              className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
            >
              打开那个工作树
            </button>
          )}
          <button
            onClick={() => setError(null)}
            aria-label="关闭"
            className="shrink-0 rounded-btn p-0.5 text-ash hover:text-ink"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {status !== null && !status.isRepo ? (
        <EmptyState text="该目录不是 git 仓库（没有 .git）" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          {/* ---- 分支 ---- */}
          <section className="min-h-0">
            <SectionHeader
              icon={<GitBranch size={13} className="text-teal" />}
              title="分支"
              count={branches?.branches.length}
              action={
                <button
                  onClick={() => setDialog({ kind: "createBranch" })}
                  className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  <Plus size={11} />
                  <span>新建分支</span>
                </button>
              }
            />
            {branches === null ? (
              <LoadingRow />
            ) : (
              <div className="overflow-hidden rounded-card border border-line bg-card">
                {branches.branches.length === 0 && <EmptyState text="没有任何分支" inset />}
                {branches.branches.map((b) => (
                  <BranchRow
                    key={b.kind === "local" ? `l/${b.name}` : `r/${b.name}`}
                    branch={b}
                    current={branches.current}
                    disabled={busy}
                    onCheckout={() => void op(`切换到 ${b.name}`, () => checkoutGitBranch({ rootPath: root, name: b.name }))}
                    onRename={() => setDialog({ kind: "rename", name: b.name })}
                    onDelete={() => setDialog({ kind: "deleteBranch", root, name: b.name })}
                    onMerge={() => void op(`合并 ${b.name}`, () => mergeGitBranch({ rootPath: root, name: b.name }))}
                    onCreateWorktreeFrom={() =>
                      // 远程分支不是本地分支，不能走「检出已有分支」模式：
                      // 作为新分支的 commitish 基点传下去，否则会静默从当前 HEAD 建树
                      setDialog(
                        b.kind === "local"
                          ? { kind: "createWorktree", branch: b.name }
                          : { kind: "createWorktree", commitish: b.name },
                      )
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* ---- 工作树 ---- */}
          <section className="min-h-0">
            <SectionHeader
              icon={<FolderGit2 size={13} className="text-teal" />}
              title="工作树"
              count={worktrees?.length}
              action={
                <button
                  onClick={() => setDialog({ kind: "createWorktree" })}
                  className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  <Plus size={11} />
                  <span>新建工作树</span>
                </button>
              }
            />
            {worktrees === null ? (
              <LoadingRow />
            ) : (
              <div className="overflow-hidden rounded-card border border-line bg-card">
                {worktrees.length === 0 && <EmptyState text="没有工作树" inset />}
                {worktrees.map((w) => (
                  <WorktreeRow
                    key={w.path}
                    wt={w}
                    rootPath={root}
                    disabled={busy}
                    sessionWorktreeSupported={sessionWorktreeSupported}
                    onStartSession={() => setDialog({ kind: "startSession", wt: w })}
                    onTerminal={() => openTerminalAt(w.path, worktreeTitle(w))}
                    onReveal={() =>
                      void revealGitWorktree(w.path).catch((err: unknown) => {
                        const e = asRpcError(err);
                        setError({ text: `在文件管理器中显示失败：${e.message ?? "未知错误"}`, code: e.code });
                      })
                    }
                    onDelete={() => setDialog({ kind: "deleteWorktree", root, wt: w })}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---- 对话框 ---- */}
      {dialog?.kind === "createBranch" && (
        <CreateBranchDialog
          existing={branches?.branches.filter((b) => b.kind === "local").map((b) => b.name) ?? []}
          refs={branches?.branches ?? []}
          defaultRef={dialog.ref}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(name, ref, checkout) =>
            op("新建分支", () => createGitBranch({ rootPath: root, name, ...(ref ? { ref } : {}), checkout }))
          }
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          current={dialog.name}
          existing={branches?.branches.filter((b) => b.kind === "local").map((b) => b.name) ?? []}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => op("重命名", () => renameGitBranch({ rootPath: root, name }))}
        />
      )}
      {dialog?.kind === "createWorktree" && (
        <CreateWorktreeDialog
          branches={branches?.branches.filter((b) => b.kind === "local") ?? []}
          defaultBranch={dialog.branch}
          defaultCommitish={dialog.commitish}
          rootPath={root}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(payload) => op("新建工作树", () => createGitWorktree({ rootPath: root, ...payload }))}
        />
      )}
      {dialog?.kind === "deleteBranch" && (
        <ConfirmDialog
          title={`删除分支 ${dialog.name}`}
          body={
            dialog.forceReason !== undefined
              ? `${dialog.forceReason}。强制删除（git branch -D）后未合入的提交将只能靠 hash 找回，确定？`
              : `删除本地分支 ${dialog.name}？（未合入主线的分支会再向你确认一次）`
          }
          confirmLabel={dialog.forceReason !== undefined ? "强制删除" : "删除"}
          danger
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            // 用打开对话框时快照的 root：op 期间切了单元，也不能把确认弹窗
            // 换成新仓库的同名分支（评审 P1：延迟的 branch_not_merged 重开场景）
            const ok = await op(
              "删除分支",
              () =>
                deleteGitBranch({ rootPath: dialog.root, name: dialog.name, force: dialog.forceReason !== undefined }),
            );
            if (ok) {
              setDialog(null);
              return;
            }
            // 第一次 -d 失败不是流程终点：转成「未合并 → 强删确认」（仍钉在原仓库）
            if (useGit.getState().error?.code === GIT_ERROR_CODES.branchNotMerged) {
              useGit.getState().setError(null);
              setDialog({ ...dialog, forceReason: "该分支还有未合入的提交" });
            }
          }}
        />
      )}
      {dialog?.kind === "deleteWorktree" && (
        <ConfirmDialog
          title={`删除工作树 ${worktreeTitle(dialog.wt)}`}
          body={
            dialog.forceReason !== undefined
              ? `${dialog.forceReason}。强制删除（--force）会丢掉这些改动，确定？`
              : `删除工作树目录 ${dialog.wt.path}？（目录里有未提交改动时会再向你确认一次）`
          }
          confirmLabel={dialog.forceReason !== undefined ? "强制删除" : "删除"}
          danger
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const ok = await op(
              "删除工作树",
              () =>
                removeGitWorktree({
                  rootPath: dialog.root,
                  path: dialog.wt.path,
                  force: dialog.forceReason !== undefined,
                }),
            );
            if (ok) {
              setDialog(null);
              return;
            }
            if (useGit.getState().error?.code === GIT_ERROR_CODES.worktreeDirty) {
              useGit.getState().setError(null);
              setDialog({ ...dialog, forceReason: "该工作树里有未提交改动" });
            }
          }}
        />
      )}
      {dialog?.kind === "startSession" && (
        <StartSessionDialog
          wt={dialog.wt}
          runtimeName={activeRuntime?.presentation.displayName ?? "当前执行器"}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(prompt) => {
            const wt = dialog.wt;
            setDialog(null);
            useShell.getState().setMainView("chat");
            void useWorkbench
              .getState()
              .run(prompt.trim().length > 0 ? prompt : "在这个工作树中工作", {
                worktree: { path: wt.path, branch: wt.branch ?? "" },
              });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 行组件
// ---------------------------------------------------------------------------

function BranchChip({ status }: { status: GitStatus }) {
  if (status.detached) {
    return (
      <span className="flex items-center gap-1 rounded-chip border border-line bg-rail px-2 py-0.5 text-caption text-graphite">
        分离头指针 @{status.headShort}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-chip border border-teal-edge bg-teal-tint px-2 py-0.5 text-caption text-ink">
      <GitBranch size={11} className="shrink-0 text-teal" />
      <span className="truncate">{status.branch}</span>
      {status.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="有未提交改动" />}
      {(status.ahead > 0 || status.behind > 0) && (
        <span className="tnum shrink-0 text-ash">
          {status.behind > 0 && <span>↓{status.behind} </span>}
          {status.ahead > 0 && <span>↑{status.ahead}</span>}
        </span>
      )}
    </span>
  );
}

function BranchRow(props: {
  branch: GitBranchInfo;
  current: string | null;
  disabled: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMerge: () => void;
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

      {/* 行内操作：hover 浮现，当前分支只留「重命名」 */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {!isCurrent && (
          <>
            {branch.kind === "local" && (
              <>
                <RowBtn label={`切换到 ${branch.name}`} icon={Check} disabled={disabled} onClick={props.onCheckout} />
                <RowBtn label={`合并 ${branch.name} 到当前分支`} icon={GitMerge} disabled={disabled} onClick={props.onMerge} />
                <RowBtn label="删除分支" icon={Trash2} disabled={disabled} onClick={props.onDelete} danger />
              </>
            )}
            <RowBtn
              label="基于此分支新建工作树"
              icon={FolderGit2}
              disabled={disabled}
              onClick={props.onCreateWorktreeFrom}
            />
          </>
        )}
        {isCurrent && (
          <RowBtn label="重命名当前分支" icon={Pencil} disabled={disabled} onClick={props.onRename} />
        )}
      </div>
    </div>
  );
}

function WorktreeRow(props: {
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

function worktreeTitle(wt: GitWorktree): string {
  const segs = wt.path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? wt.path;
}

function RowBtn(props: {
  label: string;
  icon: typeof Check;
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-btn p-1 text-ash hover:bg-line hover:text-ink disabled:opacity-30",
        props.danger && "hover:text-loss",
      )}
    >
      <Icon size={12} />
    </button>
  );
}

function SectionHeader(props: { icon: ReactNode; title: string; count?: number; action: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between">
      <div className="flex items-center gap-1.5">
        {props.icon}
        <span className="text-caption font-medium text-ink">{props.title}</span>
        {props.count !== undefined && <span className="tnum text-[11px] text-ash">({props.count})</span>}
      </div>
      {props.action}
    </div>
  );
}

function EmptyState({ text, inset }: { text: string; inset?: boolean }) {
  const body = (
    <>
      <FolderGit2 size={18} className="mx-auto mb-2 text-graphite" />
      <p className="text-body-sm text-ash">{text}</p>
    </>
  );
  // 列表内嵌空态（inset）保持轻量单行；页面级空态包卡片，与 Backlog/Automations 同构
  if (inset) return <div className="py-8 text-center">{body}</div>;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="rounded-card border border-line bg-card px-6 py-10 text-center">{body}</div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 rounded-card border border-line px-3 py-3 text-caption text-ash">
      <Loader2 size={13} className="animate-spin" />
      读取中…
    </div>
  );
}

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------

function DialogShell(props: { title: string; children: ReactNode; onClose: () => void }) {
  // Esc 关闭：bindShellShortcuts 的 Esc 链只认 shell 级弹窗，页面级对话框自管
  // （与 AddBotDialog / ImportBotDialog 的最新约定一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-xs"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
          <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink" title={props.title}>
            {props.title}
          </span>
          <button onClick={props.onClose} aria-label="关闭" className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>
        {/* 矮视口下内容可滚 —— 外层 overflow-hidden 会直接裁掉（对齐 BacklogDialog 壳） */}
        <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      </div>
    </div>
  );
}

/** 五个对话框共用的取消按钮（原先五份逐字重复的 className） */
function DialogCancelBtn(props: { onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
    >
      取消
    </button>
  );
}

function NameField(props: {
  value: string;
  onChange: (v: string) => void;
  existing: readonly string[];
  placeholder: string;
}) {
  const v = validateBranchName(props.value, props.existing);
  return (
    <label className="block">
      <input
        autoFocus
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className={cn(
          "w-full rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none placeholder:text-ash",
          props.value.length > 0 && !v.ok ? "border-loss" : "border-line focus:border-teal",
        )}
      />
      {props.value.length > 0 && !v.ok && (
        <span className="mt-1 block text-caption text-ash">
          {v.reason}
          {"sanitized" in v && v.sanitized.length > 0 && v.sanitized !== props.value && (
            <button type="button" className="ml-1 text-teal hover:underline" onClick={() => props.onChange(v.sanitized)}>
              改用「{v.sanitized}」
          </button>
          )}
        </span>
      )}
    </label>
  );
}

function CreateBranchDialog(props: {
  existing: readonly string[];
  refs: readonly GitBranchInfo[];
  defaultRef?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, ref: string | undefined, checkout: boolean) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [ref, setRef] = useState(props.defaultRef ?? "");
  const [checkout, setCheckout] = useState(true);
  const v = validateBranchName(name, props.existing);
  return (
    <DialogShell title="新建分支" onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        <NameField value={name} onChange={setName} existing={props.existing} placeholder="分支名，如 feat/xxx" />
        <label className="flex flex-col gap-1">
          <span className="text-caption text-graphite">基于</span>
          <select
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            className="w-full rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
          >
            <option value="">当前 HEAD</option>
            {props.refs.map((b) => (
              <option key={`${b.kind}/${b.name}`} value={b.name}>
                {b.kind === "remote" ? "远程 " : ""}
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-body-sm text-ink">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} className="accent-teal" />
          创建后立即切换过去（VSCode 默认行为）
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={!v.ok || props.busy}
            onClick={async () => {
              if (await props.onSubmit(name.trim(), ref || undefined, checkout)) props.onClose();
            }}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            {props.busy && <Loader2 size={12} className="animate-spin" />}
            创建
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

function RenameDialog(props: {
  current: string;
  existing: readonly string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(props.current);
  const v = validateBranchName(name, props.existing.filter((n) => n !== props.current));
  return (
    <DialogShell title={`重命名分支 ${props.current}`} onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        <NameField value={name} onChange={setName} existing={props.existing.filter((n) => n !== props.current)} placeholder="新分支名" />
        <div className="flex justify-end gap-2">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={!v.ok || props.busy}
            onClick={async () => {
              if (await props.onSubmit(name.trim())) props.onClose();
            }}
            className="rounded-btn bg-ink px-3 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            重命名
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

/** merge 走分支行内按钮（选定目标即合并），没有独立对话框 */

function CreateWorktreeDialog(props: {
  branches: readonly GitBranchInfo[];
  defaultBranch?: string;
  /** 远程分支行入口：作为新分支的基点（commitish），不是可检出的本地分支 */
  defaultCommitish?: string;
  rootPath: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: { path?: string; branch?: string; commitish?: string }) => Promise<boolean>;
}) {
  // mode=new：建新分支（可带 commitish 基点）；mode=existing：检出已有本地分支
  const defaultIsExisting =
    props.defaultBranch !== undefined && props.branches.some((b) => b.name === props.defaultBranch);
  const [mode, setMode] = useState<"new" | "existing">(defaultIsExisting ? "existing" : "new");
  const [newBranch, setNewBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState(
    defaultIsExisting ? (props.defaultBranch ?? "") : (props.branches.find((b) => b.checkedOutIn === null)?.name ?? ""),
  );
  /** 新分支的基点：远程分支入口预填；清空 = 当前 HEAD */
  const [commitish, setCommitish] = useState(props.defaultCommitish ?? "");
  const [path, setPath] = useState("");

  const repoSegs = props.rootPath.split(/[\\/]/).filter(Boolean);
  const repoName = repoSegs[repoSegs.length - 1] ?? "repo";
  const branchSeg = (mode === "new" ? newBranch : existingBranch).replace(/[\\/]/g, "-");
  const defaultPath = `…/${repoName}.worktrees/${branchSeg || "<分支>"}`;
  const v = validateBranchName(newBranch, props.branches.map((b) => b.name));
  const canSubmit =
    (mode === "new" && v.ok) ||
    (mode === "existing" && existingBranch.length > 0 && props.branches.find((b) => b.name === existingBranch)?.checkedOutIn == null);

  return (
    <DialogShell title="新建工作树" onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex gap-1">
          {(["new", "existing"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                "flex h-7 items-center rounded-chip border px-2.5 text-caption",
                mode === m ? "border-teal-edge bg-teal-tint text-ink" : "border-line text-graphite hover:bg-line-soft",
              )}
            >
              {m === "new" ? "新分支" : "已有分支"}
            </button>
          ))}
        </div>
        {mode === "new" ? (
          <>
            <NameField value={newBranch} onChange={setNewBranch} existing={props.branches.map((b) => b.name)} placeholder="工作树用的分支名" />
            <label className="flex flex-col gap-1">
              <span className="text-caption text-graphite">基于（留空 = 当前 HEAD）</span>
              <input
                value={commitish}
                onChange={(e) => setCommitish(e.target.value)}
                placeholder="如 origin/release 或某次提交"
                className="w-full rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </label>
          </>
        ) : (
          <select
            value={existingBranch}
            onChange={(e) => setExistingBranch(e.target.value)}
            className="w-full rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
          >
            {props.branches.map((b) => (
              <option key={b.name} value={b.name} disabled={b.checkedOutIn !== null}>
                {b.name}
                {b.checkedOutIn !== null ? "（已被其他工作树检出）" : ""}
              </option>
            ))}
          </select>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-caption text-graphite">路径（留空用默认：{defaultPath}）</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={defaultPath}
            className="w-full rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
          />
        </label>
        <div className="flex justify-end gap-2">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={!canSubmit || props.busy}
            onClick={async () => {
              const payload =
                mode === "new"
                  ? {
                      branch: newBranch.trim(),
                      ...(commitish.trim() ? { commitish: commitish.trim() } : {}),
                      ...(path.trim() ? { path: path.trim() } : {}),
                    }
                  : { commitish: existingBranch, ...(path.trim() ? { path: path.trim() } : {}) };
              if (await props.onSubmit(payload)) props.onClose();
            }}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            {props.busy && <Loader2 size={12} className="animate-spin" />}
            创建
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <DialogShell title={props.title} onClose={props.onClose}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-body-sm text-ink">{props.body}</p>
        <div className="flex justify-end gap-2">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={props.busy}
            onClick={() => void props.onConfirm()}
            className={cn(
              "flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-body-sm font-medium",
              props.danger ? "bg-loss text-on-accent hover:opacity-90" : "bg-ink text-canvas hover:opacity-90",
              "disabled:opacity-40",
            )}
          >
            {props.busy && <Loader2 size={12} className="animate-spin" />}
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

function StartSessionDialog(props: {
  wt: GitWorktree;
  runtimeName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  return (
    <DialogShell title={`在工作树中启动会话 · ${worktreeTitle(props.wt)}`} onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-caption text-ash">
          分支 {props.wt.branch} · 执行器 {props.runtimeName} —— 会话的工作目录将指向该工作树
        </p>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="要它做什么？（留空则发「在这个工作树中工作」）"
          rows={3}
          className="w-full resize-none rounded-input border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
        />
        <div className="flex justify-end gap-2">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={props.busy}
            onClick={() => props.onSubmit(prompt)}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            <Play size={12} />
            启动
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
