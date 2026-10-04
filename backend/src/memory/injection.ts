/**
 * 记忆注入器 —— 读写通路的实现（docs/10 §4.2）。
 *
 * 读：派发前把 MEMORY.md 拼成 prefix 加在用户消息前 → **任何 CLI 都吃到**，
 *     不依赖它读不读文件（claude 读 CLAUDE.md、codex 读 AGENTS.md、pi 读自己的）。
 * 写：告诉 agent 用它自带的文件工具改 MEMORY.md → **零适配**。
 *
 * 关键取舍：本项目**不做 MCP、不做 memory 工具**。workbench 不拥有工具集，
 * 它把活派给外部进程；让 agent 改文件比给每家 CLI 挂一套工具便宜得多。
 * 代价是约束更宽松（靠 prompt 规则 + 2200 上限 + 备份 + curator 兜底），
 * 这是有意接受的 —— 见 docs/10 §4.2。
 *
 * 冻结快照：**只在 startSession 注入一次**。续聊不重复注入（保住 LLM 前缀缓存，
 * 也符合 hermes 的做法）；切换执行器会开新会话 → 冷启动时自然会重新注入。
 */

import { readLongTerm, resolvePaths } from "./projectMemory.ts";
import { measure } from "./limits.ts";
import {
  renderRule,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_CLOSE,
  INJECTION_SEPARATOR,
} from "./ruleTemplate.ts";

export type InjectionScope = "semantic" | "procedural";

export interface InjectedPart {
  readonly scope: InjectionScope;
  readonly sourcePath: string;
  readonly chars: number;
}

export interface InjectedPrompt {
  /** 注入后的完整 prompt = block + separator + userText */
  readonly prompt: string;
  /** 注入块本体（不含 userText），分发日志存这份就够还原「它当时知道什么」 */
  readonly block: string;
  /** 结构化清单，供 UI 展示与后续 curator 统计 */
  readonly parts: readonly InjectedPart[];
  /** 注入块总字符数 */
  readonly injectedChars: number;
}

/** host.ts 只认这个接口，不依赖 memory 模块的具体实现（保持依赖方向单一）。 */
export interface MemoryInjector {
  build(rootPath: string, userText: string): Promise<InjectedPrompt | null>;
}

/**
 * 默认注入器。
 *
 * 返回 null = 不注入。什么时候会 null：
 * - 项目文件夹里没有 MEMORY.md 也没有建过（不擅自往用户文件夹塞文件）
 * - MEMORY.md 是空模板（只有模板头，一条记忆都没有 —— 注入一堆规则不划算）
 */
export class FileMemoryInjector implements MemoryInjector {
  async build(rootPath: string, userText: string): Promise<InjectedPrompt | null> {
    const paths = resolvePaths(rootPath);
    const file = await readLongTerm(rootPath);

    // 模板刚建出来、还没有任何真实记忆 → 不注入（避免每轮白烧规则 token）
    if (!file.exists || !hasRealEntries(file.content)) return null;

    const rule = renderRule({
      memoryPath: paths.memoryMd,
      used: file.chars,
      nearLimit: file.chars / file.limit >= 0.8,
    });

    const block = [
      MEMORY_BLOCK_OPEN,
      "",
      rule,
      "",
      "以下是 MEMORY.md 的当前内容：",
      "",
      file.content.trim(),
      "",
      MEMORY_BLOCK_CLOSE,
    ].join("\n");

    return {
      prompt: `${block}${INJECTION_SEPARATOR}${userText}`,
      block,
      parts: [{ scope: "semantic", sourcePath: paths.memoryMd, chars: file.chars }],
      injectedChars: measure(block),
    };
  }
}

/**
 * 有没有「真实记忆」。
 * 模板本身是：`# 项目记忆` + 一行 HTML 注释 + 一行占位 `- （把项目级事实写在这里…）`。
 * 那行占位是 `- ` 开头，不能被当成真实条目 —— 否则新建的文件夹会被判成「有记忆」。
 */
export function hasRealEntries(content: string): boolean {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && l.length > 2)
    .filter((l) => !/^-\s*[（(]/.test(l)) // 排除模板占位行
    .length > 0;
}
