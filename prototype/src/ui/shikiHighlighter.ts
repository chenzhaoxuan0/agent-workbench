import type { Highlighter } from "shiki";

/**
 * 聊天代码块的 shiki 高亮基建（借鉴 ZCode lib/shikiHighlighter.ts，按本项目需要裁剪）：
 * - 懒加载单例 highlighter（首个代码块才 import("shiki")，不拖累首屏）
 * - highlighter 只建一次（双主题同时装载，亮暗切换零成本）
 * - token 缓存：key = 主题:语言:长度:前100+后100字符（流式重渲染时同块代码反复命中）
 * - 伪语言标签（text/log/plain…）短路，不进 shiki
 * - 输出最小形状的 token（content + color），渲染端走 React span，无 innerHTML
 */

/** 渲染端需要的最小 token 形状（与 shiki ThemedToken 结构兼容，避免直接依赖内部类型） */
export interface CodeToken {
  content: string;
  color?: string;
}

export type CodeTokenLines = CodeToken[][];

/** 聊天里常见的伪语言标签：不值得也不需要进语法高亮 */
const PLAIN_LANGS = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
  "stdout",
  "stderr",
  "code",
  "undefined",
]);

/** 与应用亮暗主题配对的双主题（github 系：色板克制，与中性灰阶令牌相容） */
const THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] }),
    );
  }
  return highlighterPromise;
}

const TOKEN_CACHE_MAX = 300;
const tokenCache = new Map<string, CodeTokenLines>();

function cacheKey(theme: string, lang: string, code: string): string {
  return `${theme}:${lang}:${code.length}:${code.slice(0, 100)}\n${code.slice(-100)}`;
}

/**
 * 高亮一段代码。返回 null 表示「按纯文本渲染」：伪语言标签短路、
 * 未知语言加载失败、shiki 尚不可用等所有降级路径统一收敛到这里。
 */
export async function highlightCode(
  code: string,
  lang: string,
  appearance: "light" | "dark",
): Promise<CodeTokenLines | null> {
  const normalized = lang.trim().toLowerCase();
  if (PLAIN_LANGS.has(normalized)) return null;

  const theme = THEMES[appearance];
  const key = cacheKey(theme, normalized, code);
  const hit = tokenCache.get(key);
  if (hit !== undefined) return hit;

  try {
    const hl = await getHighlighter();
    // full bundle 的语言语法是懒动态导入：首次遇到某语言才拉对应 chunk
    if (!hl.getLoadedLanguages().includes(normalized)) {
      await hl.loadLanguage(normalized as Parameters<Highlighter["loadLanguage"]>[0]);
    }
    const { tokens } = hl.codeToTokens(code, {
      lang: normalized,
      theme,
    } as Parameters<Highlighter["codeToTokens"]>[1]);
    const lines: CodeTokenLines = tokens.map((line) =>
      line.map((t) => ({ content: t.content, color: t.color })),
    );
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
    tokenCache.set(key, lines);
    return lines;
  } catch {
    return null;
  }
}
