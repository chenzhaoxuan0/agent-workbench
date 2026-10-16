import { useState } from "react";
import { validateBranchName } from "../../core/git.ts";
import { DialogCancelBtn, DialogShell, NameField } from "./DialogShell.tsx";

export function RenameDialog(props: {
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
