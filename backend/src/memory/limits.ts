/**
 * 容量纪律 —— MEMORY.md 的 2200 字符硬上限（docs/10 §三）。
 *
 * 数值取自 hermes（MEMORY.md 2200 字符 / 约 800 tokens）。理由不是省 token，
 * 而是**上限本身就是最强的整理压力**：满了写不进去，agent 必须先整合再写，
 * 这比任何去重/合并算法都管用。
 *
 * 报错文案照抄 hermes 的形状（给出当前用量 + 本次增量 + 现有条目），
 * 因为那是「模型读到之后真的会去整改」的写法 —— 它把可执行的下一步写死在错误里。
 */

import { log } from "../log.ts";

/** MEMORY.md 字符上限。含文件内所有字符（标题、注释、空行）。 */
export const MEMORY_CHAR_LIMIT = 2200;

/** 用量超过这个比例就提醒先整合（hermes 的最佳实践：80%）。 */
export const MEMORY_WARN_RATIO = 0.8;

/** 每日摘要不设上限：按天分片，天然有界（docs/10 §三）。 */
export const DAILY_CHAR_LIMIT = Number.POSITIVE_INFINITY;

export function measure(content: string): number {
  return [...content].length;
}

export interface CapacityReport {
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  /** 本次写入会不会超 */
  readonly ok: boolean;
  /** 会不会触发「先整合」提醒 */
  readonly nearLimit: boolean;
}

/** 从 MEMORY.md 里抽出条目（`- ` 开头的行），供错误文案列出「可整合的素材」。 */
export function extractEntries(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && l.length > 2)
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
}

export function checkCapacity(current: string, incoming: string, limit = MEMORY_CHAR_LIMIT): CapacityReport {
  const used = measure(incoming);
  const ratio = used / limit;
  return {
    used,
    limit,
    ratio,
    ok: used <= limit,
    nearLimit: ratio >= MEMORY_WARN_RATIO,
  };
}

/**
 * 构造超限报错（**只构造，不抛** —— 调用点负责 throw，这样好测）。
 * 形状对齐 hermes：
 *   "Memory at 2,100/2,200 chars. Adding this entry (250 chars) would exceed
 *    the limit. Replace or remove existing entries first."
 * 额外附上现有条目，让 agent 不必回读文件就知道能整合什么。
 */
export function buildOverLimitError(current: string, incoming: string, limit = MEMORY_CHAR_LIMIT): Error {
  const usedNow = measure(current);
  const next = measure(incoming);
  const delta = next - usedNow;
  const entries = extractEntries(current);

  const lines = [
    `MEMORY.md 已到 ${usedNow}/${limit} 字符，本次写入需 ${next}（${delta >= 0 ? "+" : ""}${delta}），会超限。`,
    "先整合再写：把相近的条目合并成一条，或删掉已经不再成立的条目。",
  ];
  if (entries.length > 0) {
    lines.push("", "现有条目：");
    for (const e of entries) lines.push(`  - ${e}`);
  }
  lines.push("", `磁盘文件：<rootPath>/MEMORY.md（改动前自动备份）`);

  const err = Object.assign(new Error(lines.join("\n")), {
    code: "memory_over_limit",
    used: usedNow,
    limit,
    attempted: next,
    entries,
  });
  log.warn("memory over limit", { usedNow, next, limit, entries: entries.length });
  return err;
}
