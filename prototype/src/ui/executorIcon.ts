/**
 * 执行器品牌图标 —— 有官方 logo 的 CLI 用真图标，其余回落字母 glyph。
 * 图标资产来自 t3code 的 marketing harnesses（public/icons/executors/）。
 */

const EXECUTOR_ICON_IDS = new Set(["claude", "codex", "opencode"]);

/** runtimeId 兼容裸 id（mcode）与注册表命名空间（daemon:mcode）两种形态 */
export function executorIconSrc(runtimeId: string): string | null {
  const bare = runtimeId.replace(/^daemon:/, "").toLowerCase();
  return EXECUTOR_ICON_IDS.has(bare) ? `/icons/executors/${bare}.svg` : null;
}
