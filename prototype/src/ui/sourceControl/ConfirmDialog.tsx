import { Loader2 } from "lucide-react";
import { cn } from "../cn.ts";
import { DialogCancelBtn, DialogShell } from "./DialogShell.tsx";

/** 危险操作确认框。note 用于额外警示（如「有会话正在此工作树中运行」），带 note 时确认键禁用由调用方经 confirmDisabled 控制 */
export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  confirmDisabled?: boolean;
  note?: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <DialogShell title={props.title} onClose={props.onClose}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-body-sm text-ink">{props.body}</p>
        {props.note !== undefined && (
          <p className="rounded-input bg-loss/10 px-3 py-2 text-caption text-loss">{props.note}</p>
        )}
        <div className="flex justify-end gap-2">
          <DialogCancelBtn onClick={props.onClose} />
          <button
            disabled={props.busy || props.confirmDisabled === true}
            onClick={() => void props.onConfirm()}
            title={props.confirmDisabled === true ? props.note : undefined}
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
