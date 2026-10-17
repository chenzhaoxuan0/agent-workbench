/**
 * 工作区路径引用（@ 提及）的领域类型与纯工具 —— Composer 输入 `@` 弹出的
 * 工作区文件/目录建议菜单的数据契约。
 *
 * 交互对齐 ZCode 的 file-mention（apps/zcode-cli/packages/cli/src/tui-workspace-paths.ts）：
 * - 一次只列一层目录，token 里带 `/` 时前半段定位目录、末段做名字过滤；
 * - 目录条目带尾随 `/`，选中后菜单不收起，继续下钻；
 * - 隐藏 .git / node_modules 等目录与 dotfile（query 以 . 开头才显示）。
 *
 * 类型与 daemon workspace.paths.list RPC 的 result 一一对应
 * （backend/src/workspacePaths.ts 是实现）。core 层保持零依赖。
 */

// ---- RPC 结果 --------------------------------------------------------------

export type WorkspacePathKind = "directory" | "file";

export interface WorkspacePathSuggestion {
  readonly kind: WorkspacePathKind;
  /** 工作区相对路径，一律正斜杠；目录带尾随 `/`（下钻语义） */
  readonly path: string;
  /** 末段名字（菜单主标题） */
  readonly name: string;
  /** 文件字节数；目录无此字段 */
  readonly size?: number;
}

export interface WorkspacePathsResult {
  readonly items: readonly WorkspacePathSuggestion[];
  /** 命中数超过 limit 被截断时为 true（UI 提示「还有更多，继续输入缩小范围」） */
  readonly truncated: boolean;
}

// ---- 触发解析（纯函数，daemon 侧 provider 与前端共用同一套语义） --------------

export const MENTION_SIGIL = "@";

/** 活跃 @ 提及：草稿里光标之前最近的 `@`（须在行首/空白后），token 不得含空白 */
export interface ActiveMention {
  /** `@` 在草稿中的下标 */
  readonly triggerIndex: number;
  /** 光标位置（提及串的结束下标） */
  readonly endOffset: number;
  /** `@` 与光标之间的 token（不含 `@` 本身） */
  readonly token: string;
}

/**
 * 解析光标处是否有一个活跃的 @ 提及。规则对齐 ZCode resolveActiveFileMention：
 * - 取光标前文本里**最后一个** `@`；
 * - `@` 必须在文本开头或前面是空白字符（邮箱、代码里的 a@b 不触发）；
 * - `@` 到光标之间不能有空白（有空格即视为提及已结束）。
 */
export function resolveActiveMention(text: string, cursorOffset: number): ActiveMention | undefined {
  const endOffset = clampOffset(cursorOffset, text.length);
  const beforeCursor = text.slice(0, endOffset);
  const triggerIndex = beforeCursor.lastIndexOf(MENTION_SIGIL);
  if (triggerIndex < 0) return undefined;

  const beforeTrigger = triggerIndex === 0 ? undefined : text[triggerIndex - 1];
  if (beforeTrigger !== undefined && !/\s/u.test(beforeTrigger)) return undefined;

  const token = beforeCursor.slice(triggerIndex + MENTION_SIGIL.length);
  if (/\s/u.test(token)) return undefined;
  return { triggerIndex, endOffset, token };
}

/** 把选中的建议替换进草稿：目录落 `@path`（继续下钻），文件落 `@path `（提及完成） */
export function draftWithMentionReplaced(
  draft: string,
  mention: ActiveMention,
  suggestionPath: string,
  isDirectory: boolean,
): { draft: string; caret: number } {
  const replacement = `${MENTION_SIGIL}${suggestionPath}${isDirectory ? "" : " "}`;
  const next = `${draft.slice(0, mention.triggerIndex)}${replacement}${draft.slice(mention.endOffset)}`;
  return { draft: next, caret: mention.triggerIndex + replacement.length };
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.max(0, Math.min(Math.trunc(offset), length));
}
