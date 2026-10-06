import { useEffect, useMemo, useState } from "react";
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
  Check,
  Calendar,
  FileCode,
} from "lucide-react";
import { selectVisibleModels, useWorkbench } from "../store/useWorkbench.ts";
import { useMemoryPanel } from "../store/useMemoryPanel.ts";
import { formatContext } from "../core/models.ts";
import { cn } from "./cn.ts";

export interface SlashCommand {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: "记忆" | "技能" | "模式" | "执行器" | "系统";
  readonly icon: typeof Brain;
  readonly nativeCliHint?: string;
  readonly modelId?: string;
  readonly skillName?: string;
  readonly memoryPreset?: readonly ("semantic" | "daily")[];
  readonly isSubOption?: boolean;
}

export const TOP_LEVEL_COMMANDS: readonly SlashCommand[] = [
  {
    id: "mem",
    name: "/mem",
    title: "记忆注入配置",
    description: "独立切换长期事实（MEMORY.md）与当日精炼摘要（daily/*.md）",
    category: "记忆",
    icon: Brain,
    nativeCliHint: "支持 /mem both, /mem semantic, /mem daily, /mem off",
  },
  {
    id: "model",
    name: "/model",
    title: "切换模型",
    description: "查看与即时切换当前执行器的生效大模型",
    category: "执行器",
    icon: Sliders,
    nativeCliHint: "对齐各 CLI model 参数与命令",
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
    id: "status",
    name: "/status",
    title: "运行状态与上下文",
    description: "在时间线输出当前 Bot、活跃执行器、模型及记忆注入诊断报告",
    category: "系统",
    icon: Activity,
    nativeCliHint: "运行时信息概览",
  },
  {
    id: "clear",
    name: "/clear",
    title: "清空会话",
    description: "重置当前对话上下文与历史，开启全新会话（模拟 Claude Code /clear）",
    category: "执行器",
    icon: RotateCcw,
    nativeCliHint: "Claude Code / Codex 原生同名命令",
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
    id: "help",
    name: "/help",
    title: "指令帮助对照",
    description: "在时间线输出支持的所有斜杠指令与 CLI 原生映射对照手册",
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
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const runtimeModels = useWorkbench((s) => s.runtimeModels);
  const visibleModels = useWorkbench(selectVisibleModels(activeRuntimeId));
  const memoryScopes = useWorkbench((s) => s.memoryScopes);
  const skills = useMemoryPanel((s) => s.skills);

  const rawQuery = filter.trim();
  const lowerQuery = rawQuery.toLowerCase();

  const matched = useMemo<readonly SlashCommand[]>(() => {
    // 1. 如果以 "model" 开头（如 "/model" 或 "/model claude"）
    if (lowerQuery.startsWith("model")) {
      const sub = lowerQuery.replace(/^model\s*/, "").trim();
      const currentModelId = runtimeModels[activeRuntimeId];

      const rows: SlashCommand[] = visibleModels
        .filter((m) => !sub || m.id.toLowerCase().includes(sub) || m.displayName.toLowerCase().includes(sub))
        .map((m) => {
          const isCurrent = m.id === currentModelId;
          return {
            id: `model:${m.id}`,
            name: `/model ${m.id}`,
            title: `${m.displayName}${isCurrent ? " (当前生效)" : ""}`,
            description: `切换执行器 [${activeRuntimeId}] 模型 · 上下文 ${formatContext(m.contextWindow)} · ${m.vendorLabel}`,
            category: "执行器",
            icon: Sliders,
            modelId: m.id,
            isSubOption: true,
          };
        });

      if (rows.length > 0) return rows;
    }

    // 2. 如果以 "mem" 开头（如 "/mem" 或 "/mem daily"）
    if (lowerQuery.startsWith("mem")) {
      const sub = lowerQuery.replace(/^mem\s*/, "").trim();
      const memSubCommands: SlashCommand[] = [
        {
          id: "mem:both",
          name: "/mem both",
          title: "双注入: 长期事实 + 当日精炼",
          description: "同时注入 MEMORY.md (长期积累) 与 daily/*.md (当日重点摘要)",
          category: "记忆",
          icon: Brain,
          memoryPreset: ["semantic", "daily"],
          isSubOption: true,
        },
        {
          id: "mem:semantic",
          name: "/mem semantic",
          title: "仅长期事实 (MEMORY.md)",
          description: "仅注入项目根目录沉淀的核心事实与约定 (2200 字符上限)",
          category: "记忆",
          icon: Brain,
          memoryPreset: ["semantic"],
          isSubOption: true,
        },
        {
          id: "mem:daily",
          name: "/mem daily",
          title: "仅当日精炼 (daily/*.md)",
          description: "仅注入今日由总管自动总结的每日会话关键结论与避坑",
          category: "记忆",
          icon: Calendar,
          memoryPreset: ["daily"],
          isSubOption: true,
        },
        {
          id: "mem:off",
          name: "/mem off",
          title: "关闭记忆注入 (无额外记忆)",
          description: "本轮会话不拼接任何外部长期记忆或每日摘要，保持最精简上下文",
          category: "记忆",
          icon: RotateCcw,
          memoryPreset: [],
          isSubOption: true,
        },
        {
          id: "mem:inspect",
          name: "/mem inspect",
          title: "记忆状态诊断报告",
          description: "在时间线输出长期记忆当前字数、上限及今日精炼文件状态",
          category: "记忆",
          icon: Activity,
          isSubOption: true,
        },
      ];

      const filteredMem = memSubCommands.filter(
        (c) =>
          !sub ||
          c.name.toLowerCase().includes(sub) ||
          c.title.toLowerCase().includes(sub) ||
          c.description.toLowerCase().includes(sub),
      );
      if (filteredMem.length > 0) return filteredMem;
    }

    // 3. 如果以 "skill" 开头（如 "/skill"）
    if (lowerQuery.startsWith("skill")) {
      const sub = lowerQuery.replace(/^skill\s*/, "").trim();
      const skillRows: SlashCommand[] = skills
        .filter((s) => !sub || s.name.toLowerCase().includes(sub))
        .map((s) => ({
          id: `skill:${s.name}`,
          name: `/skill ${s.name}`,
          title: `引用技能 · ${s.name}`,
          description: `在任务草稿中插入 @skills/${s.name} 技能说明书引用`,
          category: "技能",
          icon: Sparkles,
          skillName: s.name,
          isSubOption: true,
        }));

      if (skillRows.length > 0) return skillRows;

      return [
        {
          id: "skill:empty",
          name: "/skill",
          title: "当前工作区暂未检测到 skills/ 资产",
          description: "在项目根目录下创建 skills/*.md 即可被自动发现并在此列出",
          category: "技能",
          icon: Sparkles,
          isSubOption: true,
        },
      ];
    }

    // 4. 常规搜索顶级命令列表
    return TOP_LEVEL_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.title.toLowerCase().includes(lowerQuery) ||
        c.description.toLowerCase().includes(lowerQuery) ||
        c.category.toLowerCase().includes(lowerQuery),
    );
  }, [lowerQuery, activeRuntimeId, visibleModels, runtimeModels, skills]);

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter, matched.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 这个 effect 挂在 `if (matched.length === 0) return null` 之前（hooks 顺序不能变），
      // 所以「菜单没内容」这件事必须在处理函数里自己挡掉：否则输入框里的
      // ↑↓ 会被 preventDefault 吞掉，光标动不了，用户以为键盘坏了。
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
    <div className="absolute bottom-full left-0 mb-3 w-[460px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-canvas/95 p-1.5 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-line-soft flex items-center justify-between text-[11px] text-graphite">
        <span className="font-medium text-ink flex items-center gap-1.5">
          <span className="font-mono text-teal font-bold">/</span>
          <span>快捷指令 · 原生与工作台功能调度</span>
        </span>
        <span className="font-mono text-[10px]">↑↓ 导航 · Enter 执行 · Esc 关闭</span>
      </div>

      <div className="max-h-72 overflow-y-auto py-1 space-y-0.5">
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
                  : "text-graphite hover:bg-line-soft hover:text-ink",
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
