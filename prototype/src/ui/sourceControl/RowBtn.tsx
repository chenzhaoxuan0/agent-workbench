import type { Check } from "lucide-react";
import { cn } from "../cn.ts";

/** 分支 / 工作树行内的小图标操作按钮：hover 浮现，danger 走 loss 语义色 */
export function RowBtn(props: {
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
