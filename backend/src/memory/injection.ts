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

import { readLongTerm, readDaily, readStanding, resolvePaths } from "./projectMemory.ts";
import { localDate } from "./dailyDigest.ts";
import { measure, extractEntries } from "./limits.ts";
import { redact } from "./redact.ts";
import {
  renderRule,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_CLOSE,
  STANDING_BLOCK_OPEN,
  STANDING_BLOCK_CLOSE,
  INJECTION_SEPARATOR,
} from "./ruleTemplate.ts";

export type InjectionScope = "semantic" | "daily" | "procedural" | "standing";

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

export interface MemoryInjectorOptions {
  /** 允许指定要注入的记忆范围，缺省为 ["semantic"] 保持向后兼容 */
  readonly scopes?: readonly ("semantic" | "daily" | "procedural")[];
  /** 指定 daily 的日期，缺省为当天 localDate() */
  readonly dailyDate?: string;
  /** 每日摘要字符上限截断保护（防止当天日报过长，例如默认 4000 字符） */
  readonly dailyLimit?: number;
}

/** host.ts 只认这个接口，不依赖 memory 模块的具体实现（保持依赖方向单一）。 */
export interface MemoryInjector {
  build(rootPath: string, userText: string, opts?: MemoryInjectorOptions): Promise<InjectedPrompt | null>;
}

/**
 * 默认注入器。
 *
 * 返回 null = 不注入。什么时候会 null：
 * - 项目文件夹里没有 MEMORY.md 也没有建过，且没有当日精炼摘要
 * - MEMORY.md 是空模板（只有模板头，一条记忆都没有 —— 注入一堆规则不划算），且未请求/没有当日精炼
 * - 请求的 scopes 为空或无任何匹配内容
 */
export class FileMemoryInjector implements MemoryInjector {
  async build(rootPath: string, userText: string, opts?: MemoryInjectorOptions): Promise<InjectedPrompt | null> {
    const paths = resolvePaths(rootPath);
    const scopes = opts?.scopes ?? ["semantic"];
    if (scopes.length === 0) return null;

    const parts: InjectedPart[] = [];
    const sections: string[] = [];

    // 0. 常驻指令（红线与安全约束：STANDING.md，上限 1000 字符，只读禁令）
    try {
      const standing = await readStanding(rootPath);
      if (standing.exists && hasRealEntries(standing.content)) {
        const over = standing.chars > standing.limit;
        const body = over ? truncateToBudget(standing.content, standing.limit, "STANDING.md") : standing.content.trim();
        const standingSection = [
          STANDING_BLOCK_OPEN,
          "以下是当前项目的不可打破之常驻指令与红线（只读载入，严禁修改）：",
          "",
          body,
          STANDING_BLOCK_CLOSE,
        ].join("\n");
        sections.push(standingSection);
        parts.push({ scope: "standing", sourcePath: paths.standingMd, chars: standing.chars });
      }
    } catch {
      // STANDING.md 读取失败不阻断后续记忆注入
    }

    // 1. 语义记忆（长期事实：MEMORY.md，上限 2200 字符）
    if (scopes.includes("semantic")) {
      const file = await readLongTerm(rootPath);
      // 模板刚建出来、还没有任何真实记忆 → 不注入（避免每轮白烧规则 token）
      if (file.exists && hasRealEntries(file.content)) {
        const over = file.chars > file.limit;
        const entries = extractEntries(file.content);
        const body = over ? truncateToBudget(file.content, file.limit) : file.content.trim();

        const rule = renderRule({
          memoryPath: paths.memoryMd,
          used: file.chars,
          nearLimit: file.chars / file.limit >= 0.8,
          over,
          keptEntries: entries.length,
        });

        const semanticSection = [
          rule,
          "",
          over ? "以下是 MEMORY.md 的内容（**已截断**）：" : "以下是 MEMORY.md 的当前内容：",
          "",
          body,
        ].join("\n");

        sections.push(semanticSection);
        parts.push({ scope: "semantic", sourcePath: paths.memoryMd, chars: file.chars });
      }
    }

    // 2. 当日会话精炼提取（按天分片：memory/daily/YYYY-MM-DD.md，只读参考）
    if (scopes.includes("daily")) {
      const date = opts?.dailyDate ?? localDate();
      try {
        const dailyFile = await readDaily(rootPath, date);
        if (dailyFile.exists && dailyFile.content.trim().length > 0) {
          const limit = opts?.dailyLimit ?? 4000;
          const over = dailyFile.chars > limit;
          const body = over ? truncateToBudget(dailyFile.content, limit, "当日精炼") : dailyFile.content.trim();

          const dailySection = [
            `### 当日会话精炼（${date}）`,
            "",
            "以下是该项目当天的会话精炼与关键结论（自动提取，只读参考）：",
            "",
            body,
          ].join("\n");

          sections.push(dailySection);
          parts.push({ scope: "daily", sourcePath: dailyFile.path, chars: dailyFile.chars });
        }
      } catch {
        // 日期不合法或读取失败时不阻断其他记忆注入
      }
    }

    if (sections.length === 0 || parts.length === 0) return null;

    const block = [
      MEMORY_BLOCK_OPEN,
      "",
      sections.join("\n\n---\n\n"),
      "",
      MEMORY_BLOCK_CLOSE,
    ].join("\n");

    return {
      prompt: `${block}${INJECTION_SEPARATOR}${userText}`,
      // 注入块会整块落进 dispatches 表、还会经 memory.dispatches 原样返回 ——
      // MEMORY.md 里若粘了密钥，不遮蔽就是明文进库、进 RPC 响应（review 抓到的阻断项）
      block: redact(block),
      parts,
      injectedChars: measure(block),
    };
  }
}

/**
 * 超限时保留到预算内。**优先留尾部**（新写的通常在后面），并加一句显式截断标记，
 * 让模型知道「还有内容没给它」，而不是以为自己看到了全部。
 *
 * `label` 是给模型看的「谁超限了」：长期记忆与当日精炼共用一个函数，
 * 写死 MEMORY.md 会让「当日精炼被截断」被读成「MEMORY.md 超限了」，
 * 模型于是跑去整合一个其实没超限的文件。
 */
export function truncateToBudget(content: string, limit: number, label = "MEMORY.md"): string {
  // 放得下就原样返回：不该凭空插一句「省略 0 字符」（第一版有这个瑕疵）
  if (content.length <= limit) return content;
  // 4/6 分：尾部（新内容）多留一点 —— 与上面那句「优先留尾部」对齐
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const keepTail = content.slice(Math.max(0, content.length - tail));
  const keepHead = content.slice(0, Math.max(0, head));
  const omitted = Math.max(0, content.length - keepHead.length - keepTail.length);
  return [
    keepHead.trimEnd(),
    `\n…（中间省略 ${omitted} 字符：${label} 已超上限 ${limit}，需要整合）…\n`,
    keepTail.trimStart(),
  ].join("\n");
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
