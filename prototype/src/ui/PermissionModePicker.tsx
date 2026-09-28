import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Check,
  Hand,
  NotepadText,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { PERMISSION_MODES, getMode, type PermissionMode } from "../core/permission.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 权限模式选择器 —— 对齐 ZCode chat-input-toolbar 的 ConfigSelect（mode 类目）。
 *
 * ZCode 的做法（display.tsx 的 ConfigSelect）：
 *  - 每个模式一个**语义图标**：ask=Hand、acceptEdits=ShieldCheck、
 *    plan=NotepadText、危险档=ShieldAlert；图标随当前模式切换；
 *  - 菜单行 = 图标 + 标题 + 两行描述（`min-h-13 items-start gap-3`），
 *    **没有能力标签**——模式的读/写/命令差异用一句话讲清，不铺 tag；
 *  - 危险档（bypass）在触发器上持续保持警示色，避免用户忽略当前风险级别。
 *
 * 触发器上直接显示模式名，危险档位用警示色 —— 因为 bypass 一旦点下去，
 * 后面所有授权框都不再出现，用户必须当场知道自己关掉了什么。
 */

function modeIcon(id: PermissionMode): LucideIcon {
  switch (id) {
    case "acceptEdits":
      return ShieldCheck;
    case "plan":
      return NotepadText;
    case "bypass":
      return ShieldAlert;
    default:
      return Hand;
  }
}

export function PermissionModePicker() {
  const mode = useWorkbench((s) => s.permissionMode);
  const setMode = useWorkbench((s) => s.setPermissionMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const def = getMode(mode);
  const TriggerIcon = modeIcon(mode);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${def.label} · ${def.desc}`}
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm",
          open
            ? "bg-line-soft text-ink"
            : def.danger
              ? "text-loss hover:bg-loss/5"
              : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <TriggerIcon size={13} className="shrink-0" />
        <span className="max-w-[84px] truncate">{def.label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full right-0 z-40 mb-1.5 w-64 overflow-hidden rounded-input border border-line bg-canvas py-1"
        >
          {PERMISSION_MODES.map((m) => {
            const active = m.id === mode;
            const Icon = modeIcon(m.id);
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={active}
                onClick={() => {
                  setMode(m.id as PermissionMode);
                  setOpen(false);
                }}
                className={cn(
                  "flex min-h-[52px] w-full items-start gap-3 py-2 pl-2 pr-8 text-left",
                  active ? "bg-teal-tint" : "hover:bg-line-soft",
                )}
              >
                <Icon
                  size={17}
                  className={cn("mt-0.5 shrink-0", m.danger ? "text-loss" : "text-ink")}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={cn(
                      "truncate text-body-sm",
                      m.danger ? "font-medium text-loss" : active ? "font-medium text-ink" : "text-graphite",
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="line-clamp-2 text-caption leading-relaxed text-ash">{m.desc}</span>
                </span>
                {active && <Check size={12} className="ml-auto mt-1 shrink-0 text-teal" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
