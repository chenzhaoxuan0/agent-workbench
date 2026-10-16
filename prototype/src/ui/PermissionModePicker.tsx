import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Check,
  Hand,
  NotepadText,
  ShieldAlert,
  ShieldCheck,
  X,
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

/**
 * 权限模式面板 —— 只渲染选项列表，不带触发器、不带浮层定位。
 *
 * 抽出来是为了让同一个选项集有两种宿主：
 * - `PermissionModePicker`：composer 里原来的下拉（绝对定位浮层）
 * - `RunConfigMenu`：composer 右侧 ⋯ 面板里的手风琴段（就地展开）
 * 两种宿主共用一份选项渲染，避免两处实现分叉。
 */
export function PermissionModePanel({ onDone }: { onDone?: () => void }) {
  const mode = useWorkbench((s) => s.permissionMode);
  const setMode = useWorkbench((s) => s.setPermissionMode);

  return (
    <div role="listbox" aria-label="权限模式" className="overflow-y-auto overscroll-contain touch-pan-y">
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
              onDone?.();
            }}
            className={cn(
              "flex min-h-[56px] w-full items-start gap-3 px-3.5 py-3 text-left transition active:bg-line-soft/80",
              active ? "bg-teal-tint" : "hover:bg-line-soft",
            )}
          >
            <Icon
              size={18}
              className={cn("mt-0.5 shrink-0", m.danger ? "text-loss" : "text-ink")}
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span
                className={cn(
                  "truncate text-body-sm",
                  m.danger ? "font-medium text-loss" : active ? "font-medium text-ink" : "text-graphite",
                )}
              >
                {m.label}
              </span>
              <span className="text-caption leading-relaxed text-ash">{m.desc}</span>
            </span>
            {active && <Check size={16} className="ml-auto mt-0.5 shrink-0 text-teal" />}
          </button>
        );
      })}
    </div>
  );
}

export function PermissionModePicker({
  compact = false,
  align = "right",
}: {
  compact?: boolean;
  align?: "left" | "right";
} = {}) {
  const mode = useWorkbench((s) => s.permissionMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (compact) return;
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
  }, [open, compact]);

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
          "flex items-center justify-center transition rounded-lg",
          "h-7 sm:h-8 px-1.5 sm:px-2 gap-1 sm:gap-1.5 text-xs sm:text-body-sm",
          compact ? "border border-line-soft bg-card/60 active:scale-95" : "hover:bg-line-soft",
          open
            ? "bg-line-soft text-ink ring-1 ring-teal/30"
            : def.danger
              ? "text-loss hover:bg-loss/5 border-loss/30"
              : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <TriggerIcon size={14} className={cn("shrink-0", def.danger ? "text-loss" : "text-ink")} />
        <span className="hidden sm:inline max-w-[84px] truncate font-medium sm:font-normal">{def.label}</span>
        <ChevronDown size={11} className="hidden sm:inline shrink-0 opacity-60" />
      </button>

      {open && (
        compact && typeof window !== "undefined" && window.innerWidth < 640 ? (
          createPortal(
            <div
              className="fixed inset-0 z-50 flex flex-col justify-end bg-black/65 backdrop-blur-xs animate-in fade-in duration-200 select-none"
              onClick={(e) => {
                if (e.target === e.currentTarget) setOpen(false);
              }}
            >
              <div
                style={{ height: "65dvh", maxHeight: "75dvh" }}
                className="mx-auto w-full max-w-[500px] flex flex-col overflow-hidden rounded-t-3xl border-t border-line bg-canvas shadow-2xl animate-in slide-in-from-bottom-6 duration-250"
              >
                {/* 顶部拉手条 */}
                <div className="flex h-5 shrink-0 items-center justify-center pt-2">
                  <span className="h-1 w-10 rounded-full bg-zinc-650/40" />
                </div>

                {/* 抽屉头部 */}
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5 bg-card/70 shrink-0">
                  <span className="text-body-sm font-semibold text-ink">运行模式设置</span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="关闭选择器"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* 抽屉主体：纵向自由触控滚动 */}
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y">
                  <PermissionModePanel onDone={() => setOpen(false)} />
                </div>
              </div>
            </div>,
            document.body,
          )
        ) : (
          <div
            className={cn(
              "absolute bottom-full z-40 mb-1.5 w-64 max-w-[calc(100vw-32px)] overflow-hidden rounded-input border border-line bg-canvas py-1 shadow-lg",
              align === "left" ? "left-0" : "right-0",
            )}
          >
            <PermissionModePanel onDone={() => setOpen(false)} />
          </div>
        )
      )}
    </div>
  );
}
