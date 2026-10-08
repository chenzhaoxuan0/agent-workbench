/**
 * 记忆自动合并与重整器（Auto-Consolidator）。
 *
 * 借鉴 Hermes 的记忆合并机制（`hermes-agent/tools/memory_tool_store.py`）：
 * 当 MEMORY.md 接近或超过 2200 字符上限时，后台调度配置的 Guardian 辅助模型
 * 执行一次合并重整任务：
 *   - 合并同类项、去重；
 *   - 剔除失效与过时的条目；
 *   - 紧缩表述，压缩至 2200 字符以内；
 *   - 严格保持原子写与安全备份。
 */

import { log } from "../log.ts";
import { askModel, type AskResult } from "./llm.ts";
import { readLongTerm, resolvePaths, ensureLayout, type WriteResult } from "./projectMemory.ts";
import { measure, MEMORY_CHAR_LIMIT } from "./limits.ts";
import type { MemoryGuardianConfig } from "./guardianConfig.ts";

export interface ConsolidationResult {
  readonly ran: boolean;
  readonly success: boolean;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly backupPath?: string | null;
  readonly reason?: string;
}

const CONSOLIDATION_PROMPT_TEMPLATE = (content: string, limit: number) => `
你是一个精炼与整理记忆的后台引擎。
下面是一份项目的 MEMORY.md 长期记忆文件，当前字符数已经接近或超出上限（${limit} 字符）。

请将这份记忆进行整理重构：
1. 合并语义重叠或相关的条目；
2. 剔除已经失效、显而易见的临时琐碎记录；
3. 保留高价值的环境配置、避坑教训、用户习惯与核心约定；
4. 输出保持 Markdown 格式，条目以 "- " 开头，信息密度极高；
5. 必须严格确保整理后的总字符数在 ${limit - 200} 字符以内。

【重要】：直接输出整理后的完整 Markdown 内容，不要包含任何额外的问候、前言或总结解释！

以下是待整理的 MEMORY.md 原文：
--------------------------------
${content}
--------------------------------
`.trim();

/**
 * 检查并执行自动合并。
 */
export async function maybeConsolidate(
  rootPath: string,
  guardianConfig: MemoryGuardianConfig,
  opts: { homeDir: string; force?: boolean },
): Promise<ConsolidationResult> {
  const current = await readLongTerm(rootPath);
  if (!current.exists || current.content.trim() === "") {
    return { ran: false, success: true, beforeChars: 0, afterChars: 0, reason: "记忆文件为空" };
  }

  const limit = current.limit || MEMORY_CHAR_LIMIT;
  const threshold = limit * (guardianConfig.consolidateThresholdRatio ?? 0.95);
  const needsConsolidation = opts.force === true || current.chars >= threshold;

  if (!needsConsolidation) {
    return {
      ran: false,
      success: true,
      beforeChars: current.chars,
      afterChars: current.chars,
      reason: `未达到合并阈值 (${current.chars}/${limit}, 阈值: ${Math.round(threshold)})`,
    };
  }

  if (!guardianConfig.autoConsolidate && !opts.force) {
    return {
      ran: false,
      success: false,
      beforeChars: current.chars,
      afterChars: current.chars,
      reason: "自动合并开关已关闭 (autoConsolidate=false)",
    };
  }

  log.info("triggering auto-consolidation", {
    root: rootPath,
    chars: current.chars,
    limit,
    runner: guardianConfig.runner,
    model: guardianConfig.model,
  });

  const prompt = CONSOLIDATION_PROMPT_TEMPLATE(current.content, limit);
  const res: AskResult = await askModel(prompt, guardianConfig);

  if (!res.ok || res.text.trim() === "") {
    log.warn("auto-consolidation failed from model", { root: rootPath, reason: res.skipReason });
    return {
      ran: true,
      success: false,
      beforeChars: current.chars,
      afterChars: current.chars,
      reason: res.skipReason ?? "模型未返回有效文本",
    };
  }

  // 校验模型返回的内容是否有效且确实达成了压缩目标
  let newContent = res.text.trim();
  // 去除可能附带的 ```markdown 代码围栏
  if (newContent.startsWith("```markdown")) {
    newContent = newContent.slice(11);
  } else if (newContent.startsWith("```")) {
    newContent = newContent.slice(3);
  }
  if (newContent.endsWith("```")) {
    newContent = newContent.slice(0, -3);
  }
  newContent = newContent.trim();

  const newChars = measure(newContent);
  if (newChars >= current.chars && newChars > limit) {
    log.warn("auto-consolidation output did not reduce size", {
      before: current.chars,
      after: newChars,
      limit,
    });
    return {
      ran: true,
      success: false,
      beforeChars: current.chars,
      afterChars: newChars,
      reason: `合并后字符数并未减少 (${newChars} >= ${current.chars})`,
    };
  }

  // 执行写盘（导入 writeLongTerm 会触发容量校验，如果通过则写盘并生成备份）
  try {
    const { writeLongTerm } = await import("./projectMemory.ts");
    const writeRes: WriteResult = await writeLongTerm(rootPath, newContent, { homeDir: opts.homeDir });
    log.info("auto-consolidation completed successfully", {
      root: rootPath,
      before: current.chars,
      after: writeRes.chars,
      saved: current.chars - writeRes.chars,
    });
    return {
      ran: true,
      success: true,
      beforeChars: current.chars,
      afterChars: writeRes.chars,
      backupPath: writeRes.backupPath,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error("auto-consolidation write failed", { root: rootPath, error: errorMsg });
    return {
      ran: true,
      success: false,
      beforeChars: current.chars,
      afterChars: newChars,
      reason: `写回失败: ${errorMsg}`,
    };
  }
}
