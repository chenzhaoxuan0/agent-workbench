/**
 * 跨会话追溯搜索（docs/10 §4.4）。
 *
 * 形态刻意是「现场扫 + 流式匹配」，不是「查索引」（§2.2）：
 * - 先按 pathHint / 时间收窄，再流式扫
 * - 每个块现算 bigram 集合、现匹配，**内存 O(1)**，不建倒排
 * - 命中后靠 `lineNo` 回头读上下文（`loadContext`）
 *
 * 排序：**时间衰减 × 匹配分**。
 * 没有「历史命中加权」——那是索引方案才有的东西，索引已砍（docs/10 §2.2）。
 * 改成半衰期衰减：越近的越靠前，越老的越往下沉，但不删。
 *
 * 同会话去重：一个会话里命中 40 次不代表比命中 1 次更重要，
 * 同一个 sessionId 每家最多留 N 条，剩下的让位给别的会话。
 */

import { bigrams, gramSet, matchScore, prepareQuery, type PreparedQuery } from "./bigram.ts";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { scan, type ScanOptions, type ScannedBlock, type CliKind } from "./scanner.ts";
import { redact } from "./redact.ts";

export interface SearchHit {
  readonly block: ScannedBlock;
  readonly score: number;
  /** 该命中排第几（同一会话内） */
  readonly rank: number;
}

export interface SearchResult {
  readonly hits: SearchHit[];
  readonly scannedBlocks: number;
  readonly scannedFiles: number;
  /** 各家命中数 —— 让调用方知道「搜到了但只有这家有」这类情况 */
  readonly byCli: Record<string, number>;
  readonly elapsedMs: number;
  /** 查询被截到多少 gram；0 字查询返回 0 */
  readonly queryGrams: number;
}

export interface SearchOptions extends ScanOptions {
  readonly query: string;
  /** 返回条数上限 */
  readonly limit?: number;
  /** 时间衰减半衰期（天）。90 = 90 天前的命中权重减半 */
  readonly halfLifeDays?: number;
  /** 同一个会话最多留几条 */
  readonly perSession?: number;
  /** 低于此分丢弃 */
  readonly minScore?: number;
  /** 只看某一类块（日报提炼用 text，追溯默认全要） */
  readonly kinds?: readonly ScannedBlock["kind"][];
}

const DAY = 24 * 60 * 60 * 1000;

/** 0.5^(age/halfLife)：越老权重越低，但永远 > 0（不删历史）。 */
export function timeDecay(ts: number, now: number, halfLifeDays: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0.5;
  const ageDays = Math.max(0, now - ts) / DAY;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export async function search(opts: SearchOptions): Promise<SearchResult> {
  const t0 = Date.now();
  const limit = opts.limit ?? 20;
  const halfLife = opts.halfLifeDays ?? 90;
  const perSession = opts.perSession ?? 3;
  const minScore = opts.minScore ?? 0.34;
  const now = Date.now();
  const kinds = opts.kinds === undefined ? null : new Set(opts.kinds);

  const q: PreparedQuery = prepareQuery(opts.query);
  const qgrams = q.grams.size;

  if (qgrams === 0) {
    return { hits: [], scannedBlocks: 0, scannedFiles: 0, byCli: {}, elapsedMs: Date.now() - t0, queryGrams: 0 };
  }

  // 保留一个「每会话计数」的有序数组：会话多时别让 Map 无限涨
  const kept: SearchHit[] = [];
  const perSess = new Map<string, number>();
  const files = new Set<string>();
  const byCli: Record<string, number> = {};
  let scanned = 0;

  const scanOpts: ScanOptions = {
    ...(opts.cli === undefined ? {} : { cli: opts.cli }),
    ...(opts.pathHint === undefined ? {} : { pathHint: opts.pathHint }),
    ...(opts.since === undefined ? {} : { since: opts.since }),
    ...(opts.limitBytesPerCli === undefined ? {} : { limitBytesPerCli: opts.limitBytesPerCli }),
    ...(opts.chunkChars === undefined ? {} : { chunkChars: opts.chunkChars }),
    ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }),
    ...(opts.sources === undefined ? {} : { sources: opts.sources }),
  };

  for await (const b of scan(scanOpts)) {
    scanned++;
    files.add(b.srcPath);
    if (kinds !== null && !kinds.has(b.kind)) continue;

    const s = matchScore(q, b.text);
    if (s < minScore) continue;

    const score = s * timeDecay(b.ts, now, halfLife);
    if (score < minScore * 0.5) continue;

    byCli[b.cli] = (byCli[b.cli] ?? 0) + 1;
    const key = `${b.cli}:${b.sessionId ?? b.srcPath}`;
    const n = perSess.get(key) ?? 0;
    if (n >= perSession) continue;
    perSess.set(key, n + 1);

    kept.push({ block: b, score, rank: n });
  }

  kept.sort((a, b) => b.score - a.score || b.block.ts - a.block.ts);
  return {
    hits: kept.slice(0, limit),
    scannedBlocks: scanned,
    scannedFiles: files.size,
    byCli,
    elapsedMs: Date.now() - t0,
    queryGrams: qgrams,
  };
}

/**
 * 上下文加载的护栏。
 *
 * `loadContext` 是**从第 1 行流式丢到命中行**的（没有 seek）。命中在第 5000 行
 * 就要先读 5000 行。而 `stewardSearch` 串行调它最多 20 次 —— 单个 codex rollout
 * 能到几百 MB，一次 UI 搜索最坏就是几 GB 的重读。所以：
 * - 命中太深就不给上下文（命中正文本来就已经显示给用户了）
 * - 一次搜索里能附上下文的条数有上限
 */
export const CONTEXT_MAX_LINE = 2000;
export const CONTEXT_MAX_HITS = 5;

/**
 * 读命中处的上下文 —— 「翻前后文」的落点（docs/10 §4.4）。
 * 靠 lineNo 重新扫源文件，**不缓存、不建索引**。
 */
export async function loadContext(
  srcPath: string,
  lineNo: number,
  opts: { before?: number; after?: number; chunkChars?: number } = {},
): Promise<string[]> {
  const before = opts.before ?? 2;
  const after = opts.after ?? 2;
  const chunkChars = opts.chunkChars ?? 400;
  // 护栏：太深就算了，不为一条上下文把整个文件读一遍
  if (lineNo > CONTEXT_MAX_LINE) return [];
  const out: string[] = [];
  const lo = Math.max(1, lineNo - before);
  const hi = lineNo + after;

  let stream;
  try {
    stream = createReadStream(srcPath, { encoding: "utf8" });
  } catch {
    return out;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      if (n < lo) continue;
      if (n > hi) break;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const t = flattenText(obj);
      if (t !== "") out.push(redact(t.slice(0, chunkChars * 3)));
    }
  } catch {
    /* 读一半被截断 → 已读到的照常给 */
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/** 把一行 JSON 里的可读文字拼出来（上下文展示用，比 scan 宽松）。 */
function flattenText(obj: unknown, depth = 0, acc: string[] = []): string {
  if (depth > 8) return acc.join(" ").trim();
  if (typeof obj === "string") {
    const t = obj.trim();
    if (t.length >= 8 && /[一-鿿a-zA-Z]/.test(t)) acc.push(t);
    return "";
  }
  if (Array.isArray(obj)) {
    for (const v of obj) flattenText(v, depth + 1, acc);
  } else if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/^(uuid|id|.*_id|sessionId|hash|signature|version|cwd|type|kind|role|timestamp)$/i.test(k)) continue;
      flattenText(v, depth + 1, acc);
    }
  }
  return acc.join(" ").trim();
}

/** 便捷：一次性拿到查询的 bigram（UI 上做「拆词预览」用）。 */
export function explainQuery(q: string): { grams: string[]; n: number } {
  const g = bigrams(q);
  return { grams: g, n: new Set(g).size };
}

export { gramSet };
export type { CliKind, ScannedBlock };
