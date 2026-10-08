/**
 * 记忆规则模板 —— 注入给 agent 的那段文案（docs/10 §4.2）。
 *
 * 形态参照 hermes 的 memory.md（`hermes-agent/website/.../features/memory.md`）的
 * 「什么该保存 / 什么该跳过 / 容量管理」三节，翻译成中文并改成**文件直改**的写法。
 *
 * 两条设计原则：
 * 1. 规则要**可执行**，不是劝导。写清楚「用什么工具改哪个文件」，别写「请妥善维护记忆」。
 * 2. 长度受控 —— 规则本身也吃每轮的 token。保持在 ~900 字符以内。
 *
 * 刻意不注入的：skills/ 的正文。各 CLI 原生会读自己的 skills 目录，
 * 重复注入既浪费 token 又可能和它自己读到的打架。规则里只提一句位置。
 */

import { MEMORY_CHAR_LIMIT } from "./limits.ts";

export interface RuleContext {
  /** MEMORY.md 的绝对路径 —— agent 要照这个路径写 */
  readonly memoryPath: string;
  /** 当前已用字符 */
  readonly used: number;
  /** 上限 */
  readonly limit?: number;
  /** 是否已过 80% 提醒线 */
  readonly nearLimit: boolean;
  /** 是否已经超了上限（注入侧会截断） */
  readonly over?: boolean;
  /** 现有条目数 */
  readonly keptEntries?: number;
}

const SEPARATOR = "─".repeat(64);

export function renderRule(ctx: RuleContext): string {
  const limit = ctx.limit ?? MEMORY_CHAR_LIMIT;
  const pct = Math.round((ctx.used / limit) * 100);

  const lines: string[] = [
    SEPARATOR,
    `项目记忆 · MEMORY.md　[${pct}% — ${ctx.used}/${limit} 字符]`,
    SEPARATOR,
    "",
    "上面已经把这个项目的长期事实放在下面了。以下是维护它的规则。",
    "",
    "怎么写：用你自带的文件工具直接编辑这个文件 ——",
    `　　${ctx.memoryPath}`,
    "改动前系统会自动备份到工作台目录。",
    "",
    "⚠ 重要：**你直接改文件时不会有任何拦截**。超过上限时系统只会在下次",
    "对话里截断注入，让你知道该整合了 —— 但它不会阻止你写下去。",
    "所以上限要靠你自己守：写之前先看一眼上面的用量。",
    "",
    "应该写：",
    "· 用户偏好与工作方式（\"写文案先出 3 版再选\"）",
    "· 环境事实（\"这台机器访问 github 需挂 127.0.0.1:7897\"）",
    "· 纠正与约定（\"这个仓库用 pnpm，不用 npm\"）",
    "· 踩过的坑与结论（\"Windows 上 grep -P 不支持，改用 rg\"）",
    "· 已完成的重要工作（\"2026-10-04 把记忆系统接进了 host.ts\"）",
    "",
    "不要写：",
    "· 琐碎或显而易见（\"用户问了 Python\"）",
    "· 能重新查到的事实（\"Python 3.12 支持嵌套 f-string\"）",
    "· 大段代码、日志、数据表",
    "· 临时路径、一次性调试上下文",
    "· 已经写在 skills/ 或 AGENTS.md 里的内容（那些地方才是它们的家）",
    "",
    "怎么组织：一条一行，以 \"- \" 开头，信息密度要高。",
    "· 好：This repo uses pnpm, Node 22, vitest. Run tests with 'pnpm test'.",
    "· 差：On January 5th, 2026, the user asked me to look at their project…",
  ];

  if (ctx.over === true) {
    lines.push(
      "",
      `🚨 已经超限：${ctx.used}/${limit} 字符。下面给你看的是**截断版**（${ctx.keptEntries ?? "?"} 条里的一部分）。`,
      "　　现在就整合：把相近的条目合并，删掉已不成立的。",
    );
  } else if (ctx.nearLimit) {
    lines.push(
      "",
      `⚠ 已用 ${pct}%。写新条目前先整合：把相近的条目合并成一条，或删掉已不成立的。`,
    );
  }

  return lines.join("\n");
}

/** 注入块的开头标记。分发日志和 UI 靠它把注入内容从用户原话里分开。 */
export const MEMORY_BLOCK_OPEN = "<project-memory>";
/** 注入块的结尾标记。 */
export const MEMORY_BLOCK_CLOSE = "</project-memory>";

/** 常驻指令块的开头标记。 */
export const STANDING_BLOCK_OPEN = "<standing-instructions>";
/** 常驻指令块的结尾标记。 */
export const STANDING_BLOCK_CLOSE = "</standing-instructions>";

/** 注入块与用户原话之间的分隔（紧跟在 close 标记之后）。 */
export const INJECTION_SEPARATOR = "\n\n---\n\n";

