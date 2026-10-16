import { useState } from "react";
import { Loader2 } from "lucide-react";
import { validateBranchName, type GitBranchInfo } from "../../core/git.ts";
import { cn } from "../cn.ts";
import { DialogCancelBtn, DialogShell, NameField } from "./DialogShell.tsx";

export function CreateWorktreeDialog(props: {
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
