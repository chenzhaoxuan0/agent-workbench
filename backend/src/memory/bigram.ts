/**
 * 中文 bigram —— 中文短词检索的解法（docs/10 §4.3）。
 *
 * 背景（实测，Node 24 / node:sqlite）：
 *   `LIKE '%q%'`  —— 2 字中文能用，但跨词查询（"sqlite 检索"）完全无能
 *   `trigram` FTS5 —— **2 字查询全灭**（FTS5 trigram 要求 query ≥ 3 字符）
 *   `unicode61`   —— 中文基本报废（整句被当成一个 token）
 *   应用层 bigram  —— 2 字能用 + 跨词能用，**完全包含 LIKE 能力，无回归**
 *
 * 语义对齐 Lucene CJKAnalyzer：把连续 CJK 串切成**重叠的 bigram**，
 * 非 CJK（拉丁/数字/下划线）整词保留。
 *
 * 为什么是应用层而不是原生 tokenizer：hermes 的解法 `cjk_unicode61`
 * 是 Python 的原生 FTS5 扩展（`hermes-agent/hermes_state_fts.py`），
 * Node 的 node:sqlite 装不了扩展。等价实现在应用层做，效果一样、可移植。
 *
 * 同义词（「工作台」查不到「agent-workbench」）是关键词检索的硬天花板，
 * 只有 embedding 能救 —— v2。
 */

/** CJK 统一表意文字（含扩展 A / 兼容表意文字）+ 日文假名 + 全角。 */
const CJK =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uFF66-\uFF9D]/;

const RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uFF66-\uFF9D]+|[A-Za-z0-9_]+/g;

/** 切成一个连续 CJK 串（或一个非 CJK 词）。 */
function* runs(text: string): Generator<string> {
  for (const m of text.matchAll(RUN_RE)) {
    const r = m[0];
    if (r !== undefined && r.length > 0) yield r;
  }
}

/** bigram 列表。CJK 串长度 1 时原样保留；非 CJK 词整体保留。 */
export function bigrams(text: string): string[] {
  const out: string[] = [];
  for (const run of runs(text)) {
    if (CJK.test(run[0] ?? "") && run.length > 1) {
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    } else {
      out.push(run);
    }
  }
  return out;
}

/** bigram 集合（去重）。匹配时用它。 */
export function gramSet(text: string): Set<string> {
  return new Set(bigrams(text));
}

/** 预渲染查询：扫一遍只算一次，别在每个块上重复切。 */
export interface PreparedQuery {
  readonly raw: string;
  readonly grams: Set<string>;
  /** 命中即满分的阈值（覆盖率） */
  readonly minCoverage: number;
}

export function prepareQuery(raw: string, minCoverage = 0.999): PreparedQuery {
  return { raw, grams: gramSet(raw), minCoverage };
}

/**
 * 覆盖率打分。
 *
 * 覆盖率 = 查询 bigram 被块覆盖的比例。0 = 不命中。
 * 全覆盖才算「真命中」；部分覆盖给一个折扣分，让长查询的相关结果浮上来。
 *
 * 另加两项微调：
 * - **整串出现**给 1.0 上限加成（"网络代理"整体出现比只中两个字更相关）
 * - 短查询（≤2 gram，即 1–2 字）容易撞常见词，靠它自己的全覆盖兜住
 */
export function matchScore(q: PreparedQuery, text: string, grams?: Set<string>): number {
  if (q.grams.size === 0) return 0;
  const set = grams ?? gramSet(text);
  let hit = 0;
  for (const g of q.grams) if (set.has(g)) hit++;
  if (hit === 0) return 0;

  const coverage = hit / q.grams.size;
  // 整串出现 → 满分（这是精确匹配，不该被部分覆盖拉低）
  if (text.includes(q.raw)) return 1;
  return coverage >= q.minCoverage ? coverage : coverage * 0.5;
}
