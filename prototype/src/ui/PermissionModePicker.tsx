import { useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldCheck, TriangleAlert } from "lucide-react";
import { PERMISSION_MODES, getMode, type PermissionMode } from "../core/permission.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 权限模式选择器 —— 对齐 Claude Code / Codex / ZCode 的 composer 模式开关。
 *
 * 放在 composer **右侧**：它和执行器一样是「这条消息怎么跑」的参数，
 * 而右侧已经聚集了策略、执行器、发送键，所以归在一处最省认知。
 *
 * 触发器上直接显示模式名，危险档位用警示色 —— 因为 bypass 一旦点下去，
 * 后面所有授权框都不再出现，用户必须当场知道自己关掉了什么。
 */
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
        {def.danger ? (
          <TriangleAlert size={12} className="shrink-0" />
        ) : (
          <ShieldCheck size={12} className="shrink-0" />
        )}
        <span className="max-w-[84px] truncate">{def.label}</span>
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full right-0 z-40 mb-1.5 w-[300px] overflow-hidden rounded-input border border-line bg-canvas py-1"
        >
          <p className="px-3 pb-1 pt-0.5 text-caption text-ash">
            本次运行的默认权限策略
          </p>
          {PERMISSION_MODES.map((m) => {
            const active = m.id === mode;
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
                  "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
                  active ? "bg-teal-tint" : "hover:bg-line-soft",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {m.danger ? (
                    <TriangleAlert size={11} className="shrink-0 text-loss" />
                  ) : (
                    <ShieldCheck size={11} className={cn("shrink-0", active ? "text-teal" : "text-ash")} />
                  )}
                  <span
                    className={cn(
                      "text-body-sm",
                      m.danger ? "font-medium text-loss" : active ? "font-medium text-ink" : "text-graphite",
                    )}
                  >
                    {m.label}
                  </span>
                </span>
                <span className="text-caption text-ash">{m.desc}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {(
                    [
                      ["读", m.reads],
                      ["写", m.writes],
                      ["命令", m.shell],
                    ] as const
                  ).map(([k, v]) => (
                    <span
                      key={k}
                      className={cn(
                        "rounded-chip px-1.5 py-0.5 text-[10px]",
                        v === "自动"
                          ? "bg-[#1d3a2c] text-[#5fc99a]"
                          : v === "拦截"
                            ? "bg-loss/10 text-loss"
                            : "bg-line-soft text-graphite",
                      )}
                    >
                      {k} {v}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
