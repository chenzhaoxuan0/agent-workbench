/**
 * 源代码管理（git 分支 / 工作树）的领域类型与纯工具 —— 「源代码管理」主视图
 * （ui/SourceControlPage.tsx）与侧栏分支标记共用。
 *
 * 类型与 daemon git.* RPC 的 result 一一对应（backend/src/git/repo.ts 是实现）。
 * core 层保持零依赖：这里只有类型和纯函数，DOM / RPC 都不碰。
 */

// ---- 状态 -----------------------------------------------------------------

export interface GitStatus {
  readonly isRepo: true;
  /** 当前分支名；detached 时为 null */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly headShort: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
}

/** 非 git 仓库时 status 的返回形态 */
export type GitStatusResult = GitStatus | { readonly isRepo: false };

// ---- 分支 -----------------------------------------------------------------

export interface GitBranchInfo {
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly shortHash: string;
  /** 末次提交 ISO 时间（author date） */
  readonly dateIso: string;
  readonly author: string;
  readonly subject: string;
  /** 被哪个工作树检出（含主仓库）；仅本地分支可能有值 */
  readonly checkedOutIn: string | null;
}

export interface GitBranchesResult {
  readonly current: string | null;
  readonly detached: boolean;
  readonly branches: readonly GitBranchInfo[];
}

// ---- 工作树 ---------------------------------------------------------------

export interface GitWorktree {
  readonly path: string;
  /** 分支名；detached / bare 为 null */
  readonly branch: string | null;
  readonly headShort: string;
  readonly dirty: boolean;
  readonly isMain: boolean;
}

// ---- 分支名校验（对齐 VSCode git.branchValidation 的 sanitize-and-inform） --

/** 非法字符 → "-"（VSCode 默认 git.branchWhitespaceChar）。只做替换，不 trim 尾部点 */
export function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/^-+/, "") // 前导 - 会被命令行当选项
    .replace(/[\s~^:?*[\]\\]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+\.$/, "")
    .replace(/[/.]+$/, "");
}

export type BranchNameValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly sanitized: string };

/** 新建/重命名分支前的前端实时校验；最终裁决仍在 daemon 侧 git check-ref-format */
export function validateBranchName(name: string, existing: readonly string[] = []): BranchNameValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "分支名不能为空", sanitized: "" };
  if (trimmed.startsWith("-")) return { ok: false, reason: "不能以 - 开头", sanitized: sanitizeBranchName(trimmed) };
  if (trimmed.includes("..")) return { ok: false, reason: "不能包含连续的点（..）", sanitized: sanitizeBranchName(trimmed) };
  if (trimmed.endsWith("/")) return { ok: false, reason: "不能以 / 结尾", sanitized: sanitizeBranchName(trimmed) };
  if (trimmed.endsWith(".lock")) return { ok: false, reason: "不能以 .lock 结尾", sanitized: sanitizeBranchName(trimmed) };
  if (trimmed.endsWith(".")) return { ok: false, reason: "不能以点结尾", sanitized: sanitizeBranchName(trimmed) };
  if (/[~^:?*[\]\\]/.test(trimmed) || /\s/.test(trimmed)) {
    return { ok: false, reason: "包含非法字符（空格 ~ ^ : ? * [ ] \\）", sanitized: sanitizeBranchName(trimmed) };
  }
  if (existing.includes(trimmed)) return { ok: false, reason: "同名分支已存在", sanitized: trimmed };
  return { ok: true };
}
