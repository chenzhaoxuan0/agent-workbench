import PinyinMatch from "pinyin-match";

// Safe wrapper across ESM and CJS bundling targets
const pinyinMatcher: ((input: string, keys: string) => [number, number] | false) | null =
  typeof (PinyinMatch as any)?.match === "function"
    ? (PinyinMatch as any).match
    : typeof (PinyinMatch as any)?.default?.match === "function"
      ? (PinyinMatch as any).default.match
      : typeof PinyinMatch === "function"
        ? (PinyinMatch as any)
        : null;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calculate relevance score for a single token against a target text string.
 * Returns 0 if no match found. Higher numbers indicate higher relevance.
 */
export function scoreTokenInText(text: string | undefined | null, token: string): number {
  if (!text || !token) return 0;
  const tLower = text.toLowerCase();
  const tokLower = token.toLowerCase();

  // 1. Exact match
  if (tLower === tokLower) {
    return 1000;
  }

  // 2. Prefix match (with bonus for matching a larger fraction of the text)
  if (tLower.startsWith(tokLower)) {
    return 800 + Math.max(0, 50 - tLower.length);
  }

  // 3. Word-boundary match (e.g. "Send test message" -> "test", "claude_code" -> "code")
  try {
    const boundaryRe = new RegExp(`(?:^|[\\s_\\-\\/:.])${escapeRegExp(tokLower)}`);
    if (boundaryRe.test(tLower)) {
      return 650;
    }
  } catch {
    // ignore regex compilation issues
  }

  // 4. Substring match
  const subIdx = tLower.indexOf(tokLower);
  if (subIdx !== -1) {
    return Math.max(300, 500 - subIdx * 5);
  }

  // 5. Chinese Pinyin match (full pinyin, initials, polyphones e.g. "zdh" -> "自动化")
  if (pinyinMatcher) {
    try {
      const py = pinyinMatcher(text, token);
      if (py && Array.isArray(py)) {
        const [start, end] = py;
        let pyScore = 420;
        if (start === 0) pyScore += 120; // Matches from start of text
        const span = end - start + 1;
        pyScore -= Math.min(100, Math.max(0, span - token.length) * 10);
        return Math.max(200, pyScore);
      }
    } catch {
      // pinyin matching error fallback
    }
  }

  // 6. Subsequence match (fzf style abbreviation, e.g. "cld" -> "claude", "sndtst" -> "Send test")
  if (tokLower.length >= 2) {
    let tIdx = 0;
    let pIdx = 0;
    let subSeqScore = 0;
    let consecutive = 0;
    let firstIdx = -1;

    while (tIdx < tLower.length && pIdx < tokLower.length) {
      const char = tLower[tIdx];
      const tokChar = tokLower[pIdx];
      if (char !== undefined && char === tokChar) {
        if (firstIdx === -1) firstIdx = tIdx;
        subSeqScore += 20;
        if (consecutive > 0) subSeqScore += consecutive * 15;
        consecutive++;
        // Word boundary bonus
        const prev = tIdx > 0 ? tLower[tIdx - 1] : "";
        if (tIdx === 0 || (prev && /[\s_\-\/:.]/.test(prev))) {
          subSeqScore += 30;
        }
        pIdx++;
      } else {
        consecutive = 0;
      }
      tIdx++;
    }

    if (pIdx === tokLower.length) {
      const span = tIdx - firstIdx;
      const penalty = Math.max(0, (span - tokLower.length) * 2);
      return Math.max(50, Math.min(320, subSeqScore - penalty));
    }
  }

  return 0;
}

export interface MatchableItem {
  label: string;
  hint?: string;
  meta?: string;
  group?: string;
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

/**
 * Match and score an item against a multi-token query.
 * - Multi-token whitespace separation with AND semantics: each token must match at least one field.
 * - Field weighting: label has highest weight (3.0), followed by hint (1.5), meta (1.2), group (1.0).
 * - Full query coherence bonus when entire multi-word query matches label directly.
 * Returns null if any token does not match.
 */
export function fuzzyMatchItem<T extends MatchableItem>(
  item: T,
  query: string,
): ScoredMatch<T> | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return { item, score: 0 };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { item, score: 0 };
  }

  let totalScore = 0;

  for (const token of tokens) {
    const scoreLabel = scoreTokenInText(item.label, token) * 3.0;
    const scoreHint = item.hint ? scoreTokenInText(item.hint, token) * 1.5 : 0;
    const scoreMeta = item.meta ? scoreTokenInText(item.meta, token) * 1.2 : 0;
    const scoreGroup = item.group ? scoreTokenInText(item.group, token) * 1.0 : 0;

    const bestTokenScore = Math.max(scoreLabel, scoreHint, scoreMeta, scoreGroup);
    if (bestTokenScore <= 0) {
      // AND semantics: every token must match at least one field
      return null;
    }

    totalScore += bestTokenScore;

    // Small multi-field bonus if matched both label and hint/meta
    if (scoreLabel > 0 && (scoreHint > 0 || scoreMeta > 0)) {
      totalScore += 30;
    }
  }

  // If query consists of multiple tokens, grant bonus if the raw string matches label directly
  if (tokens.length > 1) {
    const rawLabelScore = scoreTokenInText(item.label, trimmed);
    if (rawLabelScore > 0) {
      totalScore += rawLabelScore * 1.5;
    }
  }

  return { item, score: totalScore };
}
