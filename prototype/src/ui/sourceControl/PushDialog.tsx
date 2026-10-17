import { useState } from "react";
import { AlertTriangle, Copy, Loader2, Upload } from "lucide-react";
import type { GitStatus } from "../../core/git.ts";
import { pushGitBranch } from "../../adapters/daemon/client.ts";
import { useGit } from "../../store/useGit.ts";
import { DialogShell } from "./DialogShell.tsx";

/**
 * 推送确认对话框 —— git 三分入口的 ②「要不要落库」的推送那一半（ADR 0010）。
 *
 * 只在「没有待提交改动、但领先远端」时单独出现（触发器按状态分流）。
 * 失败时给**可复制的完整详情**：`push_rejected` 的 data.detail 是远端的原话，
 * 认证失败 / 保护分支 / non-fast-forward 的真正理由都在里面，比一句
 * 「推送失败」有用得多。
 */
export function PushDialog(props: { rootPath: string; status: GitStatus; onClose: () => void }) {
  const { rootPath, status } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const upstream = status.upstream ?? "（无，将建立新的追踪关系）";

  async function doPush(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pushGitBranch({ rootPath });
      useGit.getState().markSettled(rootPath, { pushed: true });
      useGit.getState().refresh();
      props.onClose();
    } catch (err: unknown) {
      const e = err as { message?: string; data?: { detail?: string } };
      setError({ text: e.message ?? "推送失败", ...(e.data?.detail !== undefined ? { detail: e.data.detail } : {}) });
      setBusy(false);
    }
  }

  async function copyDetail(): Promise<void> {
    if (error?.detail === undefined) return;
    try {
      await navigator.clipboard.writeText(error.detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）：详情本来就在框里可手动选中
      setCopied(false);
    }
  }

  return (
    <DialogShell title="推送到远端" onClose={props.onClose}>
      <div className="flex flex-col gap-3 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-body-sm">
          <dt className="text-ash">当前分支</dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-ink">{status.branch ?? "（分离头指针）"}</dd>
          <dt className="text-ash">追踪分支</dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-ink">{upstream}</dd>
          <dt className="text-ash">领先 / 落后</dt>
          <dd className="tnum font-mono text-[11px] text-ink">
            <span className="text-teal">↑{status.ahead}</span>
            <span className="mx-1 text-graphite">/</span>
            <span className="text-ash">↓{status.behind}</span>
          </dd>
        </dl>

        {status.behind > 0 && (
          <p className="text-caption text-loss">
            远端有 {status.behind} 个提交不在本地 —— 直接推送会被拒绝（non-fast-forward），需要先拉取。
          </p>
        )}

        {error !== null && (
          <div className="flex flex-col gap-1.5 rounded-card border border-line bg-line-soft/60 p-2.5">
            <div className="flex items-start gap-2 text-caption text-loss">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error.text}</span>
            </div>
            {error.detail !== undefined && (
              <>
                <pre className="max-h-32 overflow-auto rounded bg-rail p-2 font-mono text-[10px] leading-[1.5] whitespace-pre-wrap text-graphite">
                  {error.detail}
                </pre>
                <button
                  type="button"
                  onClick={() => void copyDetail()}
                  className="flex w-fit items-center gap-1 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  <Copy size={10} />
                  {copied ? "已复制" : "复制详情"}
                </button>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || status.ahead === 0}
            onClick={() => void doPush()}
            className="flex items-center gap-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            推送
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
