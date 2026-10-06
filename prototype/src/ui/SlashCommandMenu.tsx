import { useEffect, useState } from "react";
import {
  Brain,
  Sparkles,
  RotateCcw,
  Sliders,
  Shield,
  Zap,
  SquareTerminal,
  HelpCircle,
  Activity,
  Layers,
} from "lucide-react";
import { cn } from "./cn.ts";

export interface SlashCommand {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: "记忆" | "技能" | "模式" | "执行器" | "系统";
  readonly icon: typeof Brain;
  readonly nativeCliHint?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "mem",
    name: "/mem",
    title: "记忆注入配置",
    description: "独立切换长期事实（MEMORY.md）与当日精炼摘要（daily/*.md）",
    category: "记忆",
    icon: Brain,
    nativeCliHint: "Workbench 原生上下文编排",
  },
  {
    id: "skill",
    name: "/skill",
    title: "技能与工作流",
    description: "查看与引用工作区内的 Skill 资产与岗位说明书 (AGENTS.md)",
    category: "技能",
    icon: Sparkles,
    nativeCliHint: "支持 skills/ 与 .claude/skills",
  },
  {
    id: "clear",
    name: "/clear",
    title: "清空会话",
    description: "结束当前对话上下文，开启全新会话（模拟 Claude Code /clear）",
    category: "执行器",
    icon: RotateCcw,
    nativeCliHint: "Claude Code / Codex 原生同名命令",
  },
  {
    id: "model",
    name: "/model",
    title: "切换模型",
    description: "快速选择与切换当前执行器的有效大模型",
    category: "执行器",
    icon: Sliders,
    nativeCliHint: "对齐各 CLI model 参数与命令",
  },
  {
    id: "plan",
    name: "/plan",
    title: "Plan 规划模式",
    description: "切换为规划模式（只读分析方案，不直接修改代码）",
    category: "模式",
    icon: Layers,
    nativeCliHint: "Codex / Claude plan mode",
  },
  {
    id: "yolo",
    name: "/yolo",
    title: "YOLO 免审批执行",
    description: "切换为全放行模式（跳过所有写文件与执行命令的人工审批）",
    category: "模式",
    icon: Zap,
    nativeCliHint: "ZCode yolo / Codex exec full-auto",
  },
  {
    id: "ask",
    name: "/ask",
    title: "Ask 询问审批模式",
    description: "切换为常规协作模式（执行文件变更或终端命令时提示审批）",
    category: "模式",
    icon: Shield,
    nativeCliHint: "默认安全审批档位",
  },
  {
    id: "terminal",
    name: "/terminal",
    title: "工作区终端",
    description: "展开或收起底部的内置终端抽屉 (快捷键 Ctrl+`)",
    category: "系统",
    icon: SquareTerminal,
    nativeCliHint: "内置 PTY 交互终端",
  },
  {
    id: "status",
    name: "/status",
    title: "运行状态与上下文",
    description: "查看当前 Bot 身份、活跃执行器、模型及记忆注入详情",
    category: "系统",
    icon: Activity,
    nativeCliHint: "运行时信息概览",
  },
  {
    id: "help",
    name: "/help",
    title: "指令帮助对照",
    description: "查看支持的所有斜杠指令与 CLI 原生指令映射",
    category: "系统",
    icon: HelpCircle,
    nativeCliHint: "命令大全",
  },
];

interface SlashCommandMenuProps {
  filter: string;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ filter, onSelect, onClose }: SlashCommandMenuProps) {
  const query = filter.toLowerCase().trim();
  const matched = SLASH_COMMANDS.filter(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      c.title.toLowerCase().includes(query) ||
      c.description.toLowerCase().includes(query) ||
      c.category.toLowerCase().includes(query),
  );

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (matched.length > 0 ? (prev + 1) % matched.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (matched.length > 0 ? (prev - 1 + matched.length) % matched.length : 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matched.length > 0 && matched[activeIndex]) {
          e.preventDefault();
          onSelect(matched[activeIndex]!);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [matched, activeIndex, onSelect, onClose]);

  if (matched.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-3 w-[420px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-canvas/95 p-1.5 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-line-soft flex items-center justify-between text-[11px] text-graphite">
        <span className="font-medium text-ink flex items-center gap-1.5">
          <span className="font-mono text-teal font-bold">/</span>
          <span>快捷指令 · 模拟原生 CLI 命令</span>
        </span>
        <span className="font-mono text-[10px]">↑↓ 导航 · Enter 确认 · Esc 关闭</span>
      </div>

      <div className="max-h-64 overflow-y-auto py-1 space-y-0.5">
        {matched.map((cmd, idx) => {
          const Icon = cmd.icon;
          const isActive = idx === activeIndex;

          const categoryColor =
            cmd.category === "记忆"
              ? "text-teal bg-teal-tint"
              : cmd.category === "技能"
                ? "text-amber-600 bg-amber-500/10"
                : cmd.category === "模式"
                  ? "text-purple-600 bg-purple-500/10"
                  : cmd.category === "执行器"
                    ? "text-blue-600 bg-blue-500/10"
                    : "text-graphite bg-line-soft";

          return (
            <button
              key={cmd.id}
              type="button"
              onClick={() => onSelect(cmd)}
              onMouseEnter={() => setActiveIndex(idx)}
              className={cn(
                "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition select-none",
                isActive
                  ? "bg-teal-tint/50 text-ink shadow-sm"
                  : "text-graphite hover:bg-canvas-soft hover:text-ink",
              )}
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent transition",
                  isActive ? "bg-canvas text-teal shadow-xs border-teal/20" : "bg-line-soft text-graphite",
                )}
              >
                <Icon size={14} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-ink">{cmd.name}</span>
                  <span className="text-xs font-medium text-ink truncate">{cmd.title}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded px-1.5 py-0.2 text-[10px] font-medium leading-tight",
                      categoryColor,
                    )}
                  >
                    {cmd.category}
                  </span>
                </div>
                <p className="text-[11px] text-graphite truncate mt-0.5">{cmd.description}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
