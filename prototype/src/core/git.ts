/**
 * 源代码管理（git 分支 / 工作树 / 改动）的领域类型与纯工具 —— 「源代码管理」主视图
 * （ui/SourceControlPage.tsx）、Composer 顶栏的分支芯片与落库入口共用。
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
  /** porcelain v2 的改动条目数（非 `#` 行）。dirty 的计数版，触发器据此亮提交图标 */
  readonly dirtyFileCount: number;
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

// ---- 改动面（提交 / 推送） -------------------------------------------------

/**
 * 一个改动条目。`xy` 是 porcelain v2 的双字母状态码：**X 是索引（暂存区）、
 * Y 是工作区**，所以同一个文件可能同时出现在 staged 与 unstaged 两组里。
 * 未跟踪为 `"??"`，未合并为 `UU` 等。
 */
export interface GitChangeEntry {
  /** 仓库相对路径，git 输出的正斜杠形态；未跟踪目录带尾斜杠（如 `dist/`） */
  readonly path: string;
  readonly xy: string;
  /** 新增行数；未跟踪文件按文件实际行数给，二进制给 0 */
  readonly added: number;
  readonly removed: number;
}

export interface GitChangesResult {
  readonly staged: readonly GitChangeEntry[];
  readonly unstaged: readonly GitChangeEntry[];
  readonly untracked: readonly GitChangeEntry[];
}

export interface GitDiffResult {
  /** unified diff 文本；超长已按 daemon 侧阈值截断（见 truncated） */
  readonly patch: string;
  readonly truncated: boolean;
  /** 二进制文件：git 的 patch 对它没意义，UI 直接给提示 */
  readonly binary: boolean;
  /** 未跟踪文件：索引里没有可比对象，daemon 合成「新增文件」patch */
  readonly untracked: boolean;
}

export interface GitCommitResult {
  readonly commitHash: string;
  /** 提交时的当前分支；detached 时为 null */
  readonly branchName: string | null;
}

export interface GitPushResult {
  readonly branchName: string | null;
  readonly remoteName: string;
  /** 推送的远端分支名；无 upstream 的首推为 null */
  readonly trackingBranchName: string | null;
  /** true = daemon 补了 `-u`（首推顺带建立追踪关系） */
  readonly setUpstream: boolean;
}

/** 提交身份。name / email 任一缺失即为 null —— 提交对话框据此显示警告条 */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

// ---- 提交图 -----------------------------------------------------------------

/** 提交上的 ref 装饰（git log %D 解析）。head = HEAD 指针（含 detached） */
export interface GitGraphRef {
  readonly name: string;
  readonly kind: "head" | "branch" | "remote" | "tag";
}

/** 提交图的一行。parents 供前端画泳道连线；分页窗口外的 parent 就是 truncated 边 */
export interface GitGraphCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly refs: readonly GitGraphRef[];
  readonly subject: string;
  readonly authorName: string;
  /** author date 的 epoch 秒（%at）；前端展示时转毫秒 */
  readonly authorAtSec: number;
}

export interface GitGraphResult {
  readonly commits: readonly GitGraphCommit[];
  /** 再往下还有历史（按 maxCount+1 探测），前端据此出「加载更多」 */
  readonly hasMore: boolean;
}

// ---- git.* 的稳定错误码词表（ADR 0008） ------------------------------------
// daemon 的 mapError 产生、SourceControlPage 按码走确认流、smoke-git 按码断言。
// 三处曾各写裸字符串，一处改名其余静默退化 —— 收进唯一词表。

export const GIT_ERROR_CODES = {
  badParams: "bad_params",
  notARepo: "not_a_repo",
  gitUnavailable: "git_unavailable",
  gitTimeout: "git_timeout",
  gitError: "git_error",
  invalidBranchName: "invalid_branch_name",
  branchExists: "branch_exists",
  branchCheckedOutElsewhere: "branch_checked_out_elsewhere",
  dirtyWorktree: "dirty_worktree",
  worktreeDirty: "worktree_dirty",
  worktreeIsMain: "worktree_is_main",
  worktreePathExists: "worktree_path_exists",
  pathMissing: "path_missing",
  /** 没有可提交的内容（索引为空且未勾选「包含未暂存改动」） */
  nothingToCommit: "nothing_to_commit",
  /** user.name / user.email 缺失，git 会拒绝提交 */
  identityMissing: "identity_missing",
  /** 远端拒绝推送：non-fast-forward / fetch first / protected branch */
  pushRejected: "push_rejected",
  /** 仓库一个 remote 都没有（或没指定且无法唯一确定） */
  noRemote: "no_remote",
  /** 删工作树时有活跃会话的 cwd 在树里（含 UI 台账外的自动化/渠道会话） */
  worktreeInUse: "worktree_in_use",
} as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[keyof typeof GIT_ERROR_CODES];

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

/** 新建分支前的前端实时校验；最终裁决仍在 daemon 侧 git check-ref-format */
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

// ---- 落库入口的主动作解析 -------------------------------------------------

export type GitAction = "commit" | "commitAndPush" | "push";

/** 一组改动行的合计。提交对话框与源代码管理页的行数统计共用，别各写一遍 reduce */
export interface ChangeTotals {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

export function sumChanges(...groups: readonly (readonly GitChangeEntry[])[]): ChangeTotals {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const group of groups) {
    for (const entry of group) {
      files += 1;
      added += entry.added;
      removed += entry.removed;
    }
  }
  return { files, added, removed };
}

/**
 * 按仓库状态解析「主动作」（ZCode `resolveGitActionMenuPrimaryAction` 同款）：
 * 既有待提交改动又有领先远端 → 提交并推送；只有改动 → 提交；只有领先 → 推送；
 * 两者都没有 → null，触发器置灰（**置灰不消失**，消失即信号丢失）。
 *
 * 纯函数放 core：触发器芯片与提交对话框的 Enter 键走同一条判定，不各写一份。
 */
export function resolveGitActionMenuPrimaryAction(input: {
  readonly dirtyFileCount: number;
  readonly ahead: number;
}): GitAction | null {
  const canCommit = input.dirtyFileCount > 0;
  const canPush = input.ahead > 0;
  if (canCommit && canPush) return "commitAndPush";
  if (canCommit) return "commit";
  if (canPush) return "push";
  return null;
}
