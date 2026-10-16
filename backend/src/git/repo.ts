/**
 * git 仓库操作 —— 「源代码管理」面板（分支 / 工作树）的 daemon 侧实现。
 *
 * 决策（ADR 0008）：spawn 本机 git CLI，不引入 JS git 库 —— 行为与命令行完全
 * 一致、零抽象税，代价是依赖用户 PATH 里有 git（与依赖各执行器 CLI 同一前提）。
 *
 * 交互范式对齐 VSCode SCM：
 * - 删除未合并分支先 `branch -d`，失败回 branch_not_merged，由 UI 确认后转 `-D`
 * - 删除有未提交改动的工作树先普通 remove，失败回 worktree_dirty，UI 确认后 --force
 * - 一个分支同时只能被一个工作树检出：git 报错映射为
 *   branch_checked_out_elsewhere（带 path），UI 引导「打开那个工作树」
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveCommand, type ResolvedCommand } from "../runtime/exec.ts";
import { log } from "../log.ts";

// ---- 错误 -----------------------------------------------------------------

/** 带 wire 协议错误码的 git 失败。code 词表见 docs/07-wire-protocol.md git.* 各行 */
export class GitError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ---- 基础执行 -------------------------------------------------------------

let gitResolve: Promise<ResolvedCommand> | null = null;

function gitCmd(): Promise<ResolvedCommand> {
  gitResolve ??= resolveCommand("git");
  return gitResolve;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 在 root 里跑一条 git 命令；退出码非 0 映射为 GitError，stdout 原样返回 */
async function run(root: string, args: readonly string[], timeoutMs = 30000): Promise<string> {
  const cmd = await gitCmd();
  const r = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd.file, [...cmd.prefixArgs, "-C", root, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new GitError("git_timeout", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitError("git_unavailable", `cannot spawn git: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
  if (r.code !== 0) throw mapError(args, r);
  return r.stdout;
}

/** stderr + stdout 合并后按 git 的已知话术归类。未识别的原样透传第一行有效信息 */
function mapError(args: readonly string[], r: RunResult): GitError {
  const text = `${r.stderr}\n${r.stdout}`.trim();

  const elsewhere = text.match(/(?:is already used by worktree at|is already checked out at)\s+(\S+)/i);
  if (elsewhere) {
    return new GitError("branch_checked_out_elsewhere", "该分支已被另一个工作树检出", { path: elsewhere[1] ?? "" });
  }
  if (/not a git repository/i.test(text)) return new GitError("not_a_repo", "该目录不是 git 仓库");
  if (/not fully merged/i.test(text)) {
    return new GitError("branch_not_merged", "该分支还有未合入的提交，普通删除被拒绝（需强制删除）");
  }
  if (/branch named .+ already exists|already exists/i.test(text)) {
    return new GitError("branch_exists", "同名分支已存在");
  }
  if (/would be overwritten by checkout|Please commit your changes or stash them/i.test(text)) {
    return new GitError("dirty_worktree", "本地有未提交改动会被切换覆盖，请先提交或暂存");
  }
  if (/Automatic merge failed|CONFLICT \(|merge conflict/i.test(text)) {
    return new GitError("merge_conflicts", "合并出现冲突，请到终端解决后提交（或放弃合并）");
  }
  if (/There is no merge to abort/i.test(text)) {
    return new GitError("no_merge_in_progress", "当前没有进行中的合并");
  }
  if (/is not a valid branch name|invalid branch name|funny ref/i.test(text)) {
    return new GitError("invalid_branch_name", "分支名不合法");
  }
  if (/contains modified or untracked files.*--force|is dirty/i.test(text)) {
    return new GitError("worktree_dirty", "工作树里有未提交改动，删除被拒绝（需强制删除）");
  }
  if (/is a main working tree/i.test(text)) {
    return new GitError("worktree_is_main", "主工作树不能删除");
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? `git ${args.join(" ")} failed (${r.code})`;
  log.warn("git command failed", { args, code: r.code, stderr: r.stderr.trim() });
  return new GitError("git_error", firstLine.trim());
}

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

export type GitStatusResult = GitStatus | { readonly isRepo: false };

export async function status(root: string): Promise<GitStatusResult> {
  // --porcelain=v2 -b：一行头部（branch.head/upstream/ab）+ N 行改动。
  // 非 git 目录：git 以非 0 退出并说 not a git repository —— 按契约折成
  // {isRepo:false}（诚实缺席），侧栏标记与面板空态都依赖这个而不是异常流。
  let out: string;
  try {
    out = await run(root, ["status", "--porcelain=v2", "--branch"]);
  } catch (err) {
    if (err instanceof GitError && err.code === "not_a_repo") return { isRepo: false };
    throw err;
  }
  let branch: string | null = null;
  let detached = false;
  let headShort = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length);
      if (v === "(detached)") detached = true;
      else branch = v;
    } else if (line.startsWith("# branch.oid ")) {
      headShort = line.slice("# branch.oid ".length).slice(0, 7);
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return { isRepo: true, branch, detached, headShort, upstream, ahead, behind, dirty };
}

// ---- 分支 -----------------------------------------------------------------

export interface BranchInfo {
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly shortHash: string;
  /** 末次提交 ISO 时间（author date） */
  readonly dateIso: string;
  readonly author: string;
  readonly subject: string;
  /** 该分支被哪个工作树检出（主仓库本身也是工作树）；仅本地分支可能有值 */
  readonly checkedOutIn: string | null;
}

export interface BranchesResult {
  readonly current: string | null;
  readonly detached: boolean;
  readonly branches: readonly BranchInfo[];
}

export async function listBranches(root: string): Promise<BranchesResult> {
  const [refs, wtPaths] = await Promise.all([
    // NUL 分隔，subject 里的空格/竖线不再有歧义
    run(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname:short)%00%(authordate:iso-strict)%00%(authorname)%00%(contents:subject)",
      "refs/heads",
      "refs/remotes",
    ]),
    worktreeBranchMap(root),
  ]);

  const branches: BranchInfo[] = [];
  for (const line of refs.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [ref, shortHash = "", dateIso = "", author = "", ...subjectParts] = line.split("\0");
    if (ref === undefined) continue;
    const subject = subjectParts.join("\0"); // subject 理论上无 NUL；join 保底
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      branches.push({
        name,
        kind: "local",
        shortHash,
        dateIso,
        author,
        subject,
        checkedOutIn: wtPaths.get(name) ?? null,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (name.endsWith("/HEAD")) continue; // origin/HEAD 指针行没有信息量
      branches.push({ name, kind: "remote", shortHash, dateIso, author, subject, checkedOutIn: null });
    }
  }
  // 当前分支单独问 symbolic-ref（detached 时它非 0 退出，不能用 run()）
  const current = await symbolicRef(root);
  return { current, detached: current === null, branches };
}

async function symbolicRef(root: string): Promise<string | null> {
  const cmd = await gitCmd();
  return await new Promise((resolve) => {
    const child = spawn(cmd.file, [...cmd.prefixArgs, "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

export async function createBranch(
  root: string,
  name: string,
  opts: { readonly ref?: string; readonly checkout?: boolean } = {},
): Promise<void> {
  await assertValidBranchName(root, name);
  const ref = opts.ref?.trim() || undefined;
  if (opts.checkout === false) {
    await run(root, ["branch", name, ...(ref ? [ref] : [])]);
  } else {
    // VSCode 同款：checkout -b --no-track，从远程 ref 建时不自动挂 upstream
    await run(root, ["checkout", "-q", "-b", name, "--no-track", ...(ref ? [ref] : [])]);
  }
}

export async function checkoutBranch(root: string, name: string): Promise<void> {
  await run(root, ["checkout", "-q", name]);
}

/** 只重命名当前分支（VSCode 同款语义，不给 ref 选择器） */
export async function renameBranch(root: string, newName: string): Promise<void> {
  await assertValidBranchName(root, newName);
  await run(root, ["branch", "-m", newName]);
}

export async function deleteBranch(root: string, name: string, force = false): Promise<void> {
  const current = await symbolicRef(root);
  if (current === name) {
    throw new GitError("branch_is_current", "不能删除当前所在分支，请先切换到别的分支");
  }
  await run(root, ["branch", force ? "-D" : "-d", name]);
}

export async function merge(root: string, name: string): Promise<void> {
  await run(root, ["merge", name]);
}

export async function mergeAbort(root: string): Promise<void> {
  await run(root, ["merge", "--abort"]);
}

async function assertValidBranchName(root: string, name: string): Promise<void> {
  if (name.trim().length === 0) throw new GitError("invalid_branch_name", "分支名不能为空");
  await run(root, ["check-ref-format", "--branch", name]);
}

// ---- 工作树 ---------------------------------------------------------------

export interface WorktreeInfo {
  readonly path: string;
  /** 分支名；detached / bare 为 null */
  readonly branch: string | null;
  readonly headShort: string;
  readonly dirty: boolean;
  readonly isMain: boolean;
}

export async function listWorktrees(root: string): Promise<readonly WorktreeInfo[]> {
  const out = await run(root, ["worktree", "list", "--porcelain"]);
  const outArr: WorktreeInfo[] = [];
  let cur: { path?: string; branch?: string; headShort?: string; bare?: boolean } | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.length === 0) {
      if (cur?.path !== undefined) outArr.push(toInfo(cur, outArr.length === 0));
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) cur = { path: line.slice("worktree ".length) };
    else if (cur !== null && line.startsWith("HEAD ")) cur.headShort = line.slice("HEAD ".length).slice(0, 7);
    else if (cur !== null && line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (cur !== null && line === "bare") cur.bare = true;
  }
  if (cur?.path !== undefined) outArr.push(toInfo(cur, outArr.length === 0));

  // dirty 状态逐个工作树问一次 status（个人工作台规模下工作树个数为个位数）
  const withDirty = await Promise.all(
    outArr.map(async (w) => {
      if (w.branch === null && w.headShort === "") return w.dirty ? w : { ...w, dirty: false };
      try {
        const s = await run(w.path, ["status", "--porcelain"], 10000);
        return { ...w, dirty: s.trim().length > 0 };
      } catch {
        return { ...w, dirty: false }; // 工作树目录被外部删掉时列表不该整体失败
      }
    }),
  );
  return withDirty;
}

function toInfo(
  cur: { path?: string; branch?: string; headShort?: string; bare?: boolean },
  isMain: boolean,
): WorktreeInfo {
  return {
    path: cur.path ?? "",
    branch: cur.branch ?? null,
    headShort: cur.headShort ?? "",
    dirty: false,
    isMain,
  };
}

/** branch → 检出它的 worktree 路径（含主仓库）。分支列表的 checkedOutIn 数据源 */
async function worktreeBranchMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const out = await run(root, ["worktree", "list", "--porcelain"]);
    let curPath = "";
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/") && curPath !== "") {
        map.set(line.slice("branch refs/heads/".length), curPath);
      }
    }
  } catch {
    // 老 git 或异常仓库：checkedOutIn 全空，不阻断分支列表
  }
  return map;
}

export interface CreateWorktreeResult {
  readonly path: string;
  readonly branch: string | null;
}

export async function createWorktree(
  root: string,
  opts: { readonly path?: string; readonly branch?: string; readonly commitish?: string } = {},
): Promise<CreateWorktreeResult> {
  const branch = opts.branch?.trim() || undefined;
  const commitish = opts.commitish?.trim() || undefined;

  // 路径缺省：VSCode 约定 <仓库父目录>/<仓库名>.worktrees/<分支名>
  const branchSeg = (branch ?? commitish ?? "worktree").replace(/[\\/]/g, "-");
  const target =
    opts.path?.trim() ||
    path.join(path.dirname(path.resolve(root)), `${path.basename(path.resolve(root))}.worktrees`, branchSeg);
  if (existsSync(target)) {
    throw new GitError("worktree_path_exists", "目标路径已存在，换一个路径或分支名", { path: target });
  }

  if (branch !== undefined) {
    await assertValidBranchName(root, branch);
    await run(root, ["worktree", "add", "-b", branch, "--no-track", target, ...(commitish ? [commitish] : [])]);
  } else if (commitish !== undefined) {
    // 从已有分支/ref 检出（该分支不能已被别的工作树占用，否则 branch_checked_out_elsewhere）
    await run(root, ["worktree", "add", target, commitish]);
  } else {
    // 既没给新分支也没给 ref：从当前 HEAD 建一个 detached 工作树（少用但合法）
    await run(root, ["worktree", "add", "--detach", target]);
  }
  return { path: target, branch: branch ?? commitish ?? null };
}

export async function removeWorktree(root: string, target: string, force = false): Promise<void> {
  await run(root, ["worktree", "remove", ...(force ? ["--force"] : []), target]);
  await run(root, ["worktree", "prune"]);
}

/** 在系统文件管理器里显示该目录（win32 explorer / darwin open / xdg-open） */
export async function revealPath(target: string): Promise<void> {
  if (!existsSync(target)) throw new GitError("path_missing", "目录不存在", { path: target });
  const opener =
    process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

// ---- 会话工作树（StartSessionRequest.worktree 的 daemon 侧兑现） ----------

/**
 * 确保会话要的 worktree 存在：在就直接用（幂等），不在就建。
 *
 * 分支已存在 → 检出它（而不是 -b 重建）；分支不存在 → 从当前 HEAD 建。
 * 这让「同一会话槽位重开」天然复用上次的 worktree 与分支。
 */
export async function ensureWorktree(
  root: string,
  spec: { readonly path: string; readonly branch: string },
): Promise<string> {
  if (existsSync(path.join(spec.path, ".git")) || existsSync(path.join(spec.path, ".gitdir"))) {
    // 已有 worktree 目录：校验它确实是可用的 git 工作树
    await run(spec.path, ["rev-parse", "--git-dir"], 10000);
    return spec.path;
  }
  const localNames = new Set(
    (await listBranches(root)).branches.filter((b) => b.kind === "local").map((b) => b.name),
  );
  const branchExists = localNames.has(spec.branch);
  if (branchExists) {
    await run(root, ["worktree", "add", spec.path, spec.branch]);
  } else {
    await run(root, ["worktree", "add", "-b", spec.branch, "--no-track", spec.path]);
  }
  return spec.path;
}
