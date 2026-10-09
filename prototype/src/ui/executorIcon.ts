/**
 * 执行器品牌图标 —— 有官方 logo 的 CLI 用真图标，其余回落字母 glyph。
 * 图标来源：t3code marketing harnesses（claude/codex/opencode）与各家
 * CLI 仓库的官方图标（zcode/dsh/hermes/kimi/pi）。
 * 新增：把文件放进 public/icons/executors/ 后在此登记一行。
 */

const EXECUTOR_ICONS: Record<string, string> = {
  claude: "/icons/executors/claude.svg",
  codex: "/icons/executors/codex.svg",
  opencode: "/icons/executors/opencode.svg",
  zcode: "/icons/executors/zcode.png",
  dsh: "/icons/executors/dsh.svg",
  hermes: "/icons/executors/hermes.png",
  kimi: "/icons/executors/kimi.svg",
  pi: "/icons/executors/pi.svg",
};

/** runtimeId 兼容裸 id（mcode）与注册表命名空间（daemon:mcode）两种形态 */
export function executorIconSrc(runtimeId: string): string | null {
  const bare = runtimeId.replace(/^daemon:/, "").toLowerCase();
  return EXECUTOR_ICONS[bare] ?? null;
}
