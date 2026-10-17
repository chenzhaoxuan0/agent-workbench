import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { validateBranchName } from "../../core/git.ts";
import { cn } from "../cn.ts";

/**
 * 源代码管理对话框的共用外壳与表单基元。
 *
 * Esc 关闭：bindShellShortcuts 的 Esc 链只认 shell 级弹窗，页面级对话框自管
 * （与 AddBotDialog / ImportBotDialog 的最新约定一致）。
 */

export function DialogShell(props: { title: string; children: ReactNode; onClose: () => void; widthClass?: string }) {
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
        className={cn(
          "flex max-h-[92vh] max-w-[92vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl",
          props.widthClass ?? "w-[520px]",
        )}
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

/** 各对话框共用的取消按钮 */
export function DialogCancelBtn(props: { onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
    >
      取消
    </button>
  );
}

/** 分支名输入：实时校验 + 「改用建议名」（VSCode 的 sanitize-and-inform） */
export function NameField(props: {
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
