import { useEffect, useMemo, useState } from "react";
import { Loader2, TerminalSquare } from "lucide-react";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { cn } from "./cn.ts";

/**
 * 执行器原生斜杠命令菜单 —— 数据全部来自当前执行器自己的声明面
 * （Claude SDK supportedCommands / Codex prompts 目录 / OpenCode GET /command），
 * 工作台不再内置任何本地命令。选中只把 "/name " 放进草稿，Enter 后原样
 * 透传给执行器分发 —— 菜单是「发现 + 提示」，不是「执行器」。
 */

/**
 * 过滤谓词（导出给 Composer 复用）：Composer 需要在菜单无可选项时放行 Enter
 * 直接发送（避免「菜单开着但没匹配项，Enter 按不动」）。
 */
export function filterNativeCommands(
  commands: readonly NativeCommandInfo[],
  query: string,
): readonly NativeCommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false) ||
      (c.description?.toLowerCase().includes(q) ?? false),
  );
}

interface SlashCommandMenuProps {
  filter: string;
  onSelect: (cmd: NativeCommandInfo) => void;
  onClose: () => void;
  /** 当前执行器的原生命令面（清单 + 拉取状态），由 Composer 注入 */
  readonly native: {
    readonly commands: readonly NativeCommandInfo[];
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly executorName: string;
    readonly error?: string;
  };
}

export function SlashCommandMenu({ filter, onSelect, onClose, native }: SlashCommandMenuProps) {
  const matched = useMemo(() => filterNativeCommands(native.commands, filter), [native.commands, filter]);

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter, matched.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 这个 effect 挂在早退 return 之前（hooks 顺序不能变），「菜单没内容」
      // 必须在处理函数里自己挡掉：否则输入框里的 ↑↓ 会被 preventDefault 吞掉。
      if (matched.length === 0) return;
      // 输入法组字中的 Enter 是「选词」，不是「执行这条指令」
      if (e.isComposing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % matched.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + matched.length) % matched.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matched[activeIndex]) {
          e.preventDefault();
          onSelect(matched[activeIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [matched, activeIndex, onSelect, onClose]);

  const showMenu = matched.length > 0 || native.status === "loading" || native.status === "error" || (native.status === "ready" && native.commands.length === 0);
  if (!showMenu) return null;

  return (
    <div className="absolute bottom-full left-0 mb-3 w-[460px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-card/95 p-1.5 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-line-soft flex items-center justify-between text-[11px] text-graphite">
        <span className="font-medium text-ink flex items-center gap-1.5">
          <span className="font-mono text-teal font-bold">/</span>
          <span>{native.executorName} 原生命令</span>
        </span>
        <span className="font-mono text-[10px]">↑↓ 导航 · Enter 执行 · Esc 关闭</span>
      </div>

      <div className="max-h-72 overflow-y-auto py-1 space-y-0.5">
        {matched.map((cmd, idx) => {
          const isActive = idx === activeIndex;
          return (
            <button
              key={cmd.name}
              type="button"
              onClick={() => onSelect(cmd)}
              onMouseEnter={() => setActiveIndex(idx)}
              className={cn(
                "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition select-none",
                isActive
                  ? "bg-teal-tint/50 text-ink shadow-sm"
                  : "text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent transition",
                  isActive ? "bg-canvas text-teal shadow-xs border-teal/20" : "bg-line-soft text-graphite",
                )}
              >
                <TerminalSquare size={14} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-ink">/{cmd.name}</span>
                  {cmd.argumentHint ? (
                    <span className="font-mono text-[10px] text-graphite/70 shrink-0">{cmd.argumentHint}</span>
                  ) : null}
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded px-1.5 py-0.2 text-[10px] font-medium leading-tight",
                      cmd.builtin ? "text-teal bg-teal-tint" : "text-blue-600 bg-blue-500/10",
                    )}
                  >
                    {cmd.builtin ? "内置" : "自定义"}
                  </span>
                </div>
                {cmd.description ? <p className="text-[11px] text-graphite truncate mt-0.5">{cmd.description}</p> : null}
              </div>
            </button>
          );
        })}

        {native.status === "loading" && native.commands.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-graphite">
            <Loader2 size={13} className="animate-spin text-teal" />
            <span>正在从 {native.executorName} 拉取原生命令清单…</span>
          </div>
        )}
        {native.status === "ready" && native.commands.length === 0 && matched.length === 0 && (
          <div className="px-3 py-2 text-xs text-graphite">
            {native.executorName} 没有原生命令面 —— "/" 开头的文本会原样发给执行器，直接输入任务即可。
          </div>
        )}
        {native.status === "error" && native.commands.length === 0 && (
          <div className="px-3 py-2 text-xs text-graphite">
            原生命令拉取失败（{native.error ?? "daemon 不可达"}）。"/" 文本仍会原样发给执行器。
          </div>
        )}
      </div>
    </div>
  );
}
