import { useState } from "react";
import { Play } from "lucide-react";
import type { GitWorktree } from "../../core/git.ts";
import { DialogCancelBtn, DialogShell } from "./DialogShell.tsx";
import { worktreeTitle } from "./WorktreeRow.tsx";

export function StartSessionDialog(props: {
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
