import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Sparkles, SquareSlash } from "lucide-react";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { cn } from "./cn.ts";

/**
 * 执行器原生斜杠面板 —— 数据全部来自当前执行器自己的声明面
 * （zcode readPresentation + skills/referenceCatalog / claude supportedCommands
 * 或 ~/.claude 三段 / codex prompts 目录 / opencode GET /command+/agent）。
 * 按 ZCode 斜杠面板的节奏分三组：命令 / 技能 / 子智能体。
 * 选中只把 "/name " 放进草稿，Enter 后原样透传给执行器分发 ——
 * 面板是「发现 + 提示」，不是「执行器」。
 */

/** 条目种类 → 分组定义（顺序即渲染顺序） */
const GROUPS = [
  {
    kind: "command" as const,
    label: "命令",
    icon: SquareSlash,
    /** 徽标文案 */
    badge: (c: NativeCommandInfo) => (c.builtin ? "内置" : c.source === "project" ? "项目" : c.source === "plugin" ? "插件" : "自定义"),
  },
  {
    kind: "skill" as const,
    label: "技能",
    icon: Sparkles,
    badge: (c: NativeCommandInfo) => (c.source === "project" ? "项目" : c.source === "plugin" ? "插件" : "用户"),
  },
  {
    kind: "agent" as const,
    label: "子智能体",
    icon: Bot,
    badge: (c: NativeCommandInfo) => (c.source === "project" ? "项目" : "用户"),
  },
];

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

/**
 * 描述清洗：执行器给的 description 常是整段 markdown（"## Usage" 起头），
 * 面板只要一行人话 —— 取首个非标题行，剥掉反引号/井号/YAML 引号，截断到 96 字符。
 * 清洗后只剩 "Usage" 这类章节标题残渣（zcode 会把正文首行当 description 抽出来）
 * 视为没有描述 —— 显示一行无意义词比不显示更糟。
 */
function cleanDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("---"));
  const text = (firstLine ?? raw.trim()).replace(/`+/g, "").replace(/^#+\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (text === "" || /^usage$/i.test(text)) return undefined;
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
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

  // 分组（只渲染非空组；扁平后的顺序即 ↑↓ 遍历顺序）
  const sections = useMemo(() => {
    const out: Array<{ group: (typeof GROUPS)[number]; items: readonly NativeCommandInfo[] }> = [];
    for (const group of GROUPS) {
      const items = matched.filter((c) => (c.kind ?? "command") === group.kind);
      if (items.length > 0) out.push({ group, items });
    }
    return out;
  }, [matched]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter, flat.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 这个 effect 挂在早退 return 之前（hooks 顺序不能变），「菜单没内容」
      // 必须在处理函数里自己挡掉：否则输入框里的 ↑↓ 会被 preventDefault 吞掉。
      if (flat.length === 0) return;
      // 输入法组字中的 Enter 是「选词」，不是「执行这条指令」
      if (e.isComposing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % flat.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + flat.length) % flat.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (flat[activeIndex]) {
          e.preventDefault();
          onSelect(flat[activeIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flat, activeIndex, onSelect, onClose]);

  // 滚动跟随：键盘选中项滚进可视区
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showMenu = flat.length > 0 || native.status === "loading" || native.status === "error" || (native.status === "ready" && native.commands.length === 0);
  if (!showMenu) return null;

  let runningIndex = -1; // 扁平下标（键盘导航与渲染行一一对应）

  return (
    <div className="absolute bottom-full left-0 mb-3 w-[480px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-card/95 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
      {/* 头部：执行器 + 入口标识 */}
      <div className="px-3.5 py-2 border-b border-line-soft flex items-center justify-between bg-canvas/60">
        <span className="text-[12px] font-medium text-ink flex items-center gap-2">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-ink text-canvas font-mono text-[11px] font-bold leading-none">/</span>
          <span>{native.executorName}</span>
          <span className="text-graphite font-normal">命令面板</span>
        </span>
        <span className="font-mono text-[10px] text-graphite/80">↑↓ 选择 · Enter 插入 · Esc 关闭</span>
      </div>

      <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
        {sections.map(({ group, items }) => {
          const Icon = group.icon;
          return (
            <div key={group.kind} className="mb-0.5">
              {/* 分组头：小字号大写字距，ZCode 面板同款节奏 */}
              <div className="px-3.5 pt-1.5 pb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-graphite/80">
                <Icon size={11} className="text-graphite/60" />
                <span>{group.label}</span>
                <span className="font-mono text-graphite/50 font-normal">{items.length}</span>
              </div>
              {items.map((cmd) => {
                runningIndex += 1;
                const idx = runningIndex;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={`${cmd.kind ?? "command"}:${cmd.name}`}
                    data-idx={idx}
                    type="button"
                    onClick={() => onSelect(cmd)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      "w-[calc(100%-0.5rem)] flex items-center gap-3 rounded-lg px-2.5 py-[7px] mx-1 text-left transition select-none",
                      isActive ? "bg-ink text-canvas" : "text-graphite hover:bg-line-soft hover:text-ink",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                        isActive ? "border-canvas/30 bg-canvas/10 text-canvas" : "border-transparent bg-line-soft text-graphite",
                      )}
                    >
                      <Icon size={13} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={cn("font-mono text-xs font-bold truncate", isActive ? "text-canvas" : "text-ink")}>
                          /{cmd.name}
                        </span>
                        {cmd.argumentHint ? (
                          <span
                            className={cn(
                              "font-mono text-[10px] shrink-0 min-w-0 max-w-[170px] truncate",
                              isActive ? "text-canvas/60" : "text-graphite/70",
                            )}
                            title={cmd.argumentHint}
                          >
                            {cmd.argumentHint}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            "ml-auto shrink-0 rounded px-1.5 py-px text-[9px] font-medium leading-tight border",
                            isActive ? "border-canvas/25 text-canvas/80" : "border-line text-graphite",
                          )}
                        >
                          {group.badge(cmd)}
                        </span>
                      </div>
                      {cleanDescription(cmd.description) ? (
                        <p className={cn("text-[11px] truncate mt-px", isActive ? "text-canvas/70" : "text-graphite")}>
                          {cleanDescription(cmd.description)}
                        </p>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}

        {native.status === "loading" && native.commands.length === 0 && (
          <div className="flex items-center gap-2 px-3.5 py-3 text-xs text-graphite">
            <Loader2 size={13} className="animate-spin text-teal" />
            <span>正在从 {native.executorName} 拉取命令面板…</span>
          </div>
        )}
        {native.status === "ready" && native.commands.length === 0 && flat.length === 0 && (
          <div className="px-3.5 py-3 text-xs text-graphite leading-relaxed">
            {native.executorName} 没有原生命令面 —— "/" 开头的文本会原样发给执行器，直接输入任务即可。
          </div>
        )}
        {native.status === "error" && native.commands.length === 0 && (
          <div className="px-3.5 py-3 text-xs text-graphite leading-relaxed">
            命令面板拉取失败（{native.error ?? "daemon 不可达"}）。"/" 文本仍会原样发给执行器。
          </div>
        )}
      </div>
    </div>
  );
}
