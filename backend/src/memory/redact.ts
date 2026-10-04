/**
 * 敏感内容遮蔽（docs/10 红线 3）。
 *
 * 出口统一做：扫描结果、搜索结果、日报摘要，凡是给人或给模型看的文本
 * 都要先过这里。**入口不设防** —— 因为不做索引、不复制任何内容，
 * 没有「入库前过滤」这个环节。少一道过滤，少一处可能漏的地方。
 *
 * 遮蔽策略：保留前缀便于识别（「哦是 OpenAI 的 key」），
 * 但**不保留任何可复原的片段**。前缀长度按样式单独定。
 */

interface Rule {
  readonly re: RegExp;
  /** 掩码里保留的前缀长度（含样式标记本身，如 "sk-"） */
  readonly keep: number;
  readonly label: string;
}

const RULES: readonly Rule[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, keep: 3, label: "sk-" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, keep: 4, label: "gh" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4, label: "AKIA" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keep: 5, label: "xox" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, keep: 4, label: "AIza" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, keep: 0, label: "PRIVATE KEY" },
];

/** 不依赖具体厂商样式的兜底：key/token/secret 后面跟一个像凭证的东西 */
const GENERIC: readonly Rule[] = [
  { re: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/gi, keep: 0, label: "secret" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, keep: 7, label: "Bearer " },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 3, label: "jwt" },
];

/** 单个块超过这个长度就跳过 —— 宁可漏，不可炸。 */
const MAX_MATCH = 4096;

function mask(match: string, keep: number): string {
  if (match.length <= keep + 3) return "[REDACTED]";
  return `${match.slice(0, keep)}…[REDACTED]`;
}

/** 单段文本遮蔽。返回遮蔽后的副本；无法安全处理时返回「已遮蔽」占位而非原文。 */
export function redact(text: string): string {
  if (text.length === 0) return text;
  try {
    let out = text;
    for (const r of [...RULES, ...GENERIC]) {
      out = out.replace(r.re, (m) => mask(m.slice(0, MAX_MATCH), r.keep));
    }
    return out;
  } catch {
    // 正则在超长串上回溯炸了就别冒险，直接整段替换
    return "[REDACTED: 该段内容过长，未能安全遮蔽]";
  }
}

/** 结果里是否命中过遮蔽（UI 上给个标记，别让人以为原文就这么短）。 */
export function hadRedaction(text: string): boolean {
  try {
    for (const r of [...RULES, ...GENERIC]) {
      const re = new RegExp(r.re.source, r.re.flags);
      if (re.test(text)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** 多块一起遮蔽（搜索结果列表用）。 */
export function redactAll(texts: readonly string[]): string[] {
  return texts.map(redact);
}
