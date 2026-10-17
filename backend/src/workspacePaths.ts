/**
 * 工作区路径建议 —— 对话输入 @ 提及菜单的 daemon 侧实现（workspace.paths.list）。
 *
 * 移植自 ZCode 的 createWorkspacePathSuggestionProvider
 * （apps/zcode-cli/packages/cli/src/tui-workspace-paths.ts），语义逐条对齐：
 * - 一次只列一层：token 按 `/` 拆成「目录段 + 末段过滤」，目录段为空即列根；
 * - 安全闸：拒绝绝对路径与 `..` 段，resolve 后必须仍在 rootPath 之内；
 * - 跳过 .git / node_modules 等；query 不以 `.` 开头时隐藏 dotfile；
 * - 匹配 = 末段名字大小写不敏感 substring；排序 = 目录优先 → 前缀命中优先 → 路径字典序；
 * - 目录条目带尾随 `/`（前端选中后继续下钻），limit 截断带 truncated 标记。
 *
 * 与 git/repo.ts 的 resolveRepoPath 同一安全口径：resolve 后比对前缀。
 * 目录读取失败（不存在/无权限）按 ZCode 口径返回空清单而非报错 —— 菜单
 * 不该因为一个不存在的中间目录就整个报错。
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspacePathKind, WorkspacePathSuggestion, WorkspacePathsResult } from "./contract.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PATH_SEPARATOR_PATTERN = /[\\/]+/gu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/u;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".bzr",
  ".git",
  ".hg",
  ".jj",
  ".sl",
  ".svn",
  "node_modules",
]);

export async function listWorkspacePaths(
  rootPath: string,
  token: string,
  limit?: number,
): Promise<WorkspacePathsResult> {
  const root = path.resolve(rootPath);
  const parsed = parseWorkspacePathToken(token);
  if (!parsed) return EMPTY_RESULT;

  const directory = path.resolve(root, parsed.directoryToken);
  if (!isPathInside(root, directory)) return EMPTY_RESULT;

  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true })).map((e) => e.name);
  } catch {
    return EMPTY_RESULT;
  }

  const effectiveLimit = normalizeLimit(limit);
  const candidates: WorkspacePathSuggestion[] = [];

  for (const name of names.sort()) {
    const absolute = path.join(directory, name);
    let kind: WorkspacePathKind;
    let size: number | undefined;
    try {
      const st = await stat(absolute);
      kind = st.isDirectory() ? "directory" : "file";
      if (kind === "file") size = st.size;
    } catch {
      continue; // 竞态：列出后被删/无权限，跳过该条目
    }
    if (kind === "directory" && EXCLUDED_DIRECTORY_NAMES.has(name)) continue;
    if (!parsed.query.startsWith(".") && name.startsWith(".")) continue;
    if (!matchesPathQuery(name, parsed.query)) continue;

    const relativePath = toWorkspaceRelativePath(root, absolute);
    if (!relativePath) continue;
    candidates.push({
      kind,
      path: kind === "directory" ? `${relativePath}/` : relativePath,
      name,
      ...(size !== undefined ? { size } : {}),
    });
    if (candidates.length >= effectiveLimit) break;
  }

  sortSuggestions(candidates, parsed.query);
  return {
    items: candidates,
    truncated: candidates.length >= effectiveLimit,
  };
}

const EMPTY_RESULT: WorkspacePathsResult = { items: [], truncated: false };

/**
 * token 解析（ZCode parseWorkspacePathToken 同款）：
 * - 剥掉可能被一起带进来的 `@`；
 * - 拒绝绝对路径（`/`、`\`、盘符）与含 `..` 段的 token —— 不给越出工作区的口子；
 * - `a/b/c` → 目录段 `a/b/` + 过滤段 `c`；无 `/` → 列根、全名过滤。
 * 解析不出来返回 undefined（列表为空），不抛错。
 */
function parseWorkspacePathToken(rawToken: string): { directoryToken: string; query: string } | undefined {
  const trimmed = rawToken.replace(/^@/u, "");
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed) ||
    path.isAbsolute(trimmed)
  ) {
    return undefined;
  }

  const normalized = trimmed.replace(PATH_SEPARATOR_PATTERN, "/");
  if (normalized.split("/").some((part) => part === "..")) return undefined;
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return { directoryToken: "", query: normalized };
  }
  return {
    directoryToken: normalized.slice(0, slashIndex + 1),
    query: normalized.slice(slashIndex + 1),
  };
}

function matchesPathQuery(name: string, query: string): boolean {
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

/** 目录优先 → basename 前缀命中优先 → 路径字典序（ZCode compareWorkspacePathSuggestion 同款） */
function sortSuggestions(items: WorkspacePathSuggestion[], query: string): void {
  const queryLower = query.toLowerCase();
  items.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    const leftPrefix = leftName.startsWith(queryLower);
    const rightPrefix = rightName.startsWith(queryLower);
    if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

function toWorkspaceRelativePath(root: string, absolute: string): string | undefined {
  const relativePath = path.relative(root, absolute);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  return relativePath.split(path.sep).join("/");
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT));
}
