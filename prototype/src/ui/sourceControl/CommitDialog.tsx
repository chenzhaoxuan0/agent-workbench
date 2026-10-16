import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import {
  GIT_ERROR_CODES,
  resolveGitActionMenuPrimaryAction,
  sumChanges,
  type GitAction,
  type GitIdentity,
} from "../../core/git.ts";
import { commitGitChanges, fetchGitIdentity, pushGitBranch } from "../../adapters/daemon/client.ts";
import { useGitChanges } from "../../store/useGitChanges.ts";
import { useGit } from "../../store/useGit.ts";
import { BranchPicker } from "../BranchPicker.tsx";
import { DialogShell } from "./DialogShell.tsx";
import { ChangeFileList } from "./ChangeFileList.tsx";

/**
 * 提交对话框 —— git 三分入口的 ②「要不要落库」（ADR 0010 / docs/15 §四）。
 *
 * 为什么是重对话框而不是轻弹层：分支是「列表选一下」，提交是「填表单」，
 * 两种交互形态不该互相迁就（docs/15 §一.3）。
 *
 * 三个动作并列（提交 / 提交并推送 / 仅推送），Enter 走**主动作**——主动作由
 * 仓库状态解析（core/git.ts 的 resolveGitActionMenuPrimaryAction），触发器芯片
 * 与这里共用同一条判定，不各写一份。
 */
export function CommitDialog(props: {
  rootPath: string;
  /** 进对话框时的 ahead 数：判定「提交并推送」要不要显示 */
  ahead: number;
  /** 打开时想直接执行的动作（触发器按状态决定）；null = 只打开表单 */
  initialAction: GitAction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { rootPath } = props;
  const changes = useGitChanges((s) => s.changes);
  const reload = useGitChanges((s) => s.reload);
  const openChangesRepo = useGitChanges((s) => s.openRepo);
  const busyChanges = useGitChanges((s) => s.busy);
  const changesError = useGitChanges((s) => s.error);
  const stage = useGitChanges((s) => s.stage);
  const unstage = useGitChanges((s) => s.unstage);

  const [message, setMessage] = useState("");
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  // "loading" = 还没问；"unknown" = 问不到（老 daemon 没这个方法），此时**不**报身份缺失
  const [identity, setIdentity] = useState<GitIdentity | null | "loading" | "unknown">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);

  useEffect(() => {
    // 绑定仓库：用户可能从没打开过源代码管理页，那时这个 store 的 rootPath 还是 null
    openChangesRepo(rootPath);
    void fetchGitIdentity(rootPath)
      .then(setIdentity)
      .catch(() => setIdentity("unknown"));
  }, [rootPath, openChangesRepo]);

  const staged = changes?.staged ?? [];
  const unstaged = changes?.unstaged ?? [];
  const untracked = changes?.untracked ?? [];
  const stagedTotals = sumChanges(staged);
  const restTotals = sumChanges(unstaged, untracked);
  const restFiles = unstaged.length + untracked.length;

  // 主动作：勾上「包含未暂存改动」时，提交面覆盖了未暂存那部分，ahead 就不再让
  // 「提交并推送」降级成「提交」——它依然是「一起做了更好」的那一个
  const primary = resolveGitActionMenuPrimaryAction({
    dirtyFileCount: includeUnstaged ? stagedTotals.files + restTotals.files : stagedTotals.files,
    ahead: props.ahead,
  });

  const canSubmit = message.trim().length > 0 && !busy && identity !== "loading";
  const hasAnything = stagedTotals.files + restTotals.files > 0;

  async function run(action: GitAction): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // stagedOnly = !includeUnstaged：勾上就把未暂存那部分先落进索引再提交，
      // 未跟踪文件因此也能进这次提交（daemon 侧口径见 docs/07 git.commit）。
      // 但**没有额外路径时不能走这条路** —— daemon 的 paths 非空校验会判 bad_params
      // （全都暂存好了的用户勾着这个开关，是常态而不是错误）。
      const extraPaths = includeUnstaged ? [...unstaged, ...untracked].map((f) => f.path) : [];
      const stagedOnly = extraPaths.length === 0;
      await commitGitChanges({
        rootPath,
        message: message.trim(),
        paths: extraPaths,
        stagedOnly,
      });
      let pushError: { text: string; code?: string } | null = null;
      if (action !== "commit") {
        try {
          await pushGitBranch({ rootPath });
        } catch (err: unknown) {
          // 提交已经落地了，推送失败**不能**把整件事报成失败——否则用户会
          // 以为要重提一次。把推送的真实原因留在对话框里给出路。
          const e = err as { message?: string; code?: string };
          pushError = { text: `提交成功，但推送失败：${e.message ?? "未知错误"}`, code: e.code };
        }
      }
      // 图标立刻收敛：不让触发器在对话框关掉后还亮着（等满 TTL 才灭）
      useGit.getState().markSettled(rootPath);
      useGit.getState().refresh();
      props.onDone();
      if (pushError !== null) {
        setError(pushError);
        setBusy(false);
        return;
      }
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      setError({ text: e.message ?? "未知错误", code: e.code });
      setBusy(false);
      // 索引可能已经被提交动作改动过，重新拉一次让列表回到真实状态
      void reload();
    }
  }

  return (
    <DialogShell title="提交改动" onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        {/* 顶栏：精简版分支切换器（不带新建底栏）+ 本次提交的行数统计 */}
        <div className="flex items-center gap-2">
          <BranchPicker rootPath={rootPath} showFooterActions={false} />
          <span className="tnum ml-auto font-mono text-[11px] text-ash">
            <span className="text-gain">+{stagedTotals.added + restTotals.added}</span>
            <span className="mx-1 text-graphite">/</span>
            <span className="text-loss">-{stagedTotals.removed + restTotals.removed}</span>
            <span className="ml-2 text-ash">
              {stagedTotals.files + restTotals.files} 个文件
            </span>
          </span>
        </div>

        {/* 身份缺失警告条：daemon 会拦，但先在这里说一句，用户不用试错 */}
        {identity === null && (
          <div className="flex items-start gap-2 rounded-card border border-line bg-line-soft/60 px-2.5 py-2 text-caption text-graphite">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" />
            <span>
              未配置 git 身份（user.name / user.email），提交会被 git 拒绝。可在终端执行：
              <code className="ml-1 rounded bg-rail px-1 py-0.5 font-mono text-[10px] text-ink">
                git config user.name &quot;你的名字&quot;
              </code>
            </span>
          </div>
        )}

        {changesError !== null && (
          // 读取失败不是「没有改动」：后者会让用户以为提交是安全的
          <div className="flex items-start gap-2 rounded-card border border-line bg-card px-2.5 py-2 text-caption text-loss">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">读取改动失败：{changesError.text}</span>
            <button
              type="button"
              onClick={() => void reload()}
              className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
            >
              重试
            </button>
          </div>
        )}

        {/* 暂存区 */}
        <section className="overflow-hidden rounded-card border border-line">
          <header className="flex h-7 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2.5">
            <span className="text-caption font-medium text-ink">已暂存</span>
            <span className="tnum text-[11px] text-ash">({staged.length})</span>
          </header>
          <ChangeFileList
            rootPath={rootPath}
            entries={staged}
            sourceId="staged"
            disabled={busy}
            busy={busyChanges}
            onUnstage={(paths) => void unstage(paths)}
            emptyText="暂存区是空的"
          />
        </section>

        {/* 未暂存 + 未跟踪 */}
        <section className="overflow-hidden rounded-card border border-line">
          <header className="flex h-7 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2.5">
            <span className="text-caption font-medium text-ink">未暂存</span>
            <span className="tnum text-[11px] text-ash">({restFiles})</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1 text-caption text-graphite hover:text-ink">
              <input
                type="checkbox"
                checked={includeUnstaged}
                onChange={(e) => setIncludeUnstaged(e.target.checked)}
                className="accent-[var(--color-teal)]"
              />
              <span>包含未暂存改动（{restFiles}）</span>
            </label>
          </header>
          <ChangeFileList
            rootPath={rootPath}
            entries={[...unstaged, ...untracked]}
            sourceId="unstaged"
            disabled={busy}
            busy={busyChanges}
            onStage={(paths) => void stage(paths)}
            emptyText="没有未暂存的改动"
          />
        </section>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter 走主动作；Shift+Enter 才是换行（多行提交信息必须能写）
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (primary !== null) void run(primary);
            }
          }}
          rows={3}
          autoFocus
          placeholder="提交信息（Enter 提交，Shift+Enter 换行）"
          className="w-full resize-y rounded-input border border-line bg-rail px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-ink outline-none placeholder:text-ash focus:border-teal"
        />

        {error !== null && (
          <div className="flex items-start gap-2 rounded-card border border-line bg-line-soft/60 px-2.5 py-2 text-caption text-loss">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error.text}</span>
            {error.code === GIT_ERROR_CODES.identityMissing && (
              <span className="shrink-0 text-ash">配置身份后再试</span>
            )}
          </div>
        )}

        {/* 动作三连。主动作给实心，次要动作描边 */}
        <div className="flex items-center justify-end gap-1.5">
          {props.initialAction !== "push" && (
            <button
              type="button"
              disabled={!canSubmit || !hasAnything}
              onClick={() => void run("commit")}
              className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
            >
              提交
            </button>
          )}
          <button
            type="button"
            disabled={!canSubmit || (props.initialAction !== "push" && !hasAnything)}
            onClick={() => void run("push")}
            className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
          >
            <Upload size={10} />
            仅推送
          </button>
          <button
            type="button"
            disabled={!canSubmit || !hasAnything}
            onClick={() => void run("commitAndPush")}
            className="flex items-center gap-1 rounded-btn bg-ink px-2.5 py-1 text-caption font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 size={10} className="animate-spin" />}
            提交并推送
          </button>
        </div>
        {!hasAnything && (
          <p className="-mt-1 text-right text-caption text-ash">没有可提交的改动</p>
        )}
      </div>
    </DialogShell>
  );
}
