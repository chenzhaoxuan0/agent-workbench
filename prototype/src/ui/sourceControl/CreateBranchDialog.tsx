import { useState } from "react";
import { Loader2 } from "lucide-react";
import { validateBranchName, type GitBranchInfo } from "../../core/git.ts";
import { DialogCancelBtn, DialogShell, NameField } from "./DialogShell.tsx";

export function CreateBranchDialog(props: {
  existing: readonly string[];
  refs: readonly GitBranchInfo[];
  defaultRef?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, ref: string | undefined) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [ref, setRef] = useState(props.defaultRef ?? "");
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
        <div className="flex justify-end gap-2 pt-1">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={!v.ok || props.busy}
            onClick={async () => {
              // 新建即切换（ZCode 同款语义，ADR 0009）：没有「建完留在原分支」的选项
              if (await props.onSubmit(name.trim(), ref || undefined)) props.onClose();
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
