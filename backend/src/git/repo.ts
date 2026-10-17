/**
 * git 仓库操作 —— 「源代码管理」面板（改动 / 分支 / 工作树）与对话页落库入口的
 * daemon 侧实现。
 *
 * 决策（ADR 0008）：spawn 本机 git CLI，不引入 JS git 库 —— 行为与命令行完全
 * 一致、零抽象税，代价是依赖用户 PATH 里有 git（与依赖各执行器 CLI 同一前提）。
 *
 * 分支面对齐 ZCode 的窄模型（ADR 0009）：只做「在哪个分支上工作」——
 * 列出 / 新建即切换 / 切换。合并、改名、删除等低频操作留给终端，不做面板入口。
 *
 * 提交面（ADR 0010，从 ADR 0008 的「v1 不做」转正）：改了什么（changes / diff）、
 * 要不要落库（stage / commit / push / identity）。**discard（丢改动）明确不做**——
 * 不可逆且无安全网，等 checkpoint 路线。
 *
 * 工作树是会话隔离的承重墙，完整保留：
 * - 删除有未提交改动的工作树先普通 remove，失败回 worktree_dirty，UI 确认后 --force
 * - 一个分支同时只能被一个工作树检出：git 报错映射为
 *   branch_checked_out_elsewhere（带 data.path），UI 引导「打开那个工作树」
 *
 * 安全口径：所有到达 git argv 的 ref/分支名先过校验（check-ref-format 或
 * 拒绝前导 "-"），文件路径经 resolvePathInside 收敛到仓库根之下且一律带 `--`
 * 分隔符，防止客户端把选项当路径传进来（如 --force）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveCommand, type ResolvedCommand } from "../runtime/exec.ts";
import { log } from "../log.ts";
import {
  GIT_ERROR_CODES,
  type GitBranchInfo,
  type GitBranchesResult,
  type GitChangeEntry,
  type GitChangesResult,
  type GitCommitResult,
  type GitDiffResult,
  type GitGraphCommit,
  type GitGraphRef,
  type GitGraphResult,
  type GitIdentity,
  type GitPushResult,
  type GitStatusResult,
  type GitWorktree,
} from "../contract.ts";

// ---- 错误 -----------------------------------------------------------------

/** 带 wire 协议错误码的 git 失败。code 词表见 core/git.ts 的 GIT_ERROR_CODES */
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
  gitResolve ??= resolveCommand("git").catch((err: unknown) => {
    // 失败不缓存：git 是后来才装的（或 PATH 环境变了）时，下一次调用应重试，
    // 而不是把 rejected promise 钉死到 daemon 重启
    gitResolve = null;
    throw err;
  }) as Promise<ResolvedCommand>;
  return gitResolve;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 在 root 里跑一条 git 命令；退出码非 0 映射为 GitError，stdout 原样返回。
 *
 * Windows 上快速连发 spawn git.exe 偶发 NTSTATUS 级失败（实测 0xC0000142
 * STATUS_DLL_INIT_FAILED / spawn UNKNOWN —— 杀软或 desktop-heap 的锅）：
 * 进程根本没跑起来，不是 git 的判定结果。这类失败重试即过，不重试就成了
 * 随机红灯。判定口径：win32 上 close code ≥ 0x80000000 视为进程初始化失败。
 */
async function run(root: string, args: readonly string[], timeoutMs = 30000): Promise<string> {
  const cmd = await gitCmd();
  const maxAttempts = process.platform === "win32" ? 3 : 1;
  let last: RunResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runOnce(cmd, root, args, timeoutMs);
    if (r === "spawn_failed") {
      if (attempt === maxAttempts) {
        throw new GitError(GIT_ERROR_CODES.gitUnavailable, `cannot spawn git: ${args[0] ?? ""}（重试 ${maxAttempts} 次后仍失败）`);
      }
      await new Promise((res) => setTimeout(res, 60));
      continue;
    }
    if (process.platform === "win32" && r.code >= 0x80000000) {
      last = r;
      if (attempt === maxAttempts) break;
      await new Promise((res) => setTimeout(res, 60));
      continue;
    }
    last = r;
    break;
  }
  if (last !== null && last.code !== 0) throw mapError(args, last);
  return last?.stdout ?? "";
}

async function runOnce(
  cmd: ResolvedCommand,
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RunResult | "spawn_failed"> {
  return await new Promise<RunResult | "spawn_failed">((resolve, reject) => {
    const child = spawn(cmd.file, [...cmd.prefixArgs, "-C", root, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new GitError(GIT_ERROR_CODES.gitTimeout, `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // settled 后不再积攒输出：超时 reject 之后进程若仍在吐数据，缓冲不该无界增长
    child.stdout?.on("data", (c: Buffer) => {
      if (!settled) out.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (!settled) err.push(c);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn("git spawn error（将重试）", { file: cmd.file, error: e.message });
      resolve("spawn_failed");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/** 从 git 的带引号话术里抠出路径：git 会把路径写成 'C:/...'，引号必须剥掉 */
function quotedPathAfter(text: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    const m = text.match(new RegExp(`${p}\\s+'([^']+)'`, "i"));
    if (m?.[1] !== undefined) return m[1];
  }
  for (const p of patterns) {
    // 无引号兜底（老版本 git / 本地化输出）：取非空白段并剥可能残留的引号
    const m = text.match(new RegExp(`${p}\\s+(\\S+)`, "i"));
    if (m?.[1] !== undefined) return m[1].replace(/^'+|'+$/g, "");
  }
  return null;
}

/** stderr + stdout 合并后按 git 的已知话术归类。未识别的原样透传第一行有效信息 */
function mapError(args: readonly string[], r: RunResult): GitError {
  const text = `${r.stderr}\n${r.stdout}`.trim();

  // 分支被别的（主/链接）工作树占用 —— worktree add / checkout / branch -d 都会说这句族
  const elsewhere = quotedPathAfter(text, [
    "is already used by worktree at",
    "is already checked out at",
    "cannot delete branch '.+' used by worktree at",
  ]);
  if (elsewhere !== null) {
    return new GitError(GIT_ERROR_CODES.branchCheckedOutElsewhere, "该分支已被另一个工作树检出", { path: elsewhere });
  }
  if (/not a git repository/i.test(text)) return new GitError(GIT_ERROR_CODES.notARepo, "该目录不是 git 仓库");
  // 只认分支专属话术：裸 "already exists" 可能是路径/引用冲突，误报成分支重名会误导确认流
  if (/a branch named .+ already exists/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.branchExists, "同名分支已存在");
  }
  if (/would be overwritten by checkout|Please commit your changes or stash them/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.dirtyWorktree, "本地有未提交改动会被切换覆盖，请先提交或暂存");
  }
  if (/is not a valid branch name|invalid branch name|funny ref/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.invalidBranchName, "分支名不合法");
  }
  if (/contains modified or untracked files.*--force|is dirty/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.worktreeDirty, "工作树里有未提交改动，删除被拒绝（需强制删除）");
  }
  if (/is a main working tree/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.worktreeIsMain, "主工作树不能删除");
  }
  // 提交面话术族（ADR 0010）
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.nothingToCommit, "没有可提交的内容");
  }
  if (/please tell me who you are|empty ident|unable to auto-detect email|please set your name/i.test(text)) {
    return new GitError(GIT_ERROR_CODES.identityMissing, "未配置 git 身份（user.name / user.email），git 拒绝提交");
  }
  if (/\[! ?rejected\]|non-fast-forward|behind its remote counterpart|fetch first|failed to push some refs/i.test(text)) {
    // push 的 stderr 里 `remote:` 开头的行是**服务器给的理由**（认证失败、保护分支、
    // non-fast-forward…），比 git 那句通用提示有用得多：剥掉前缀当标题，
    // 全量留进 data.detail 供推送对话框展示与复制。
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const hint = lines.find((l) => /^remote:/i.test(l))?.replace(/^remote:\s*/i, "") ?? "";
    return new GitError(
      GIT_ERROR_CODES.pushRejected,
      hint.length > 0 ? `远端拒绝推送：${hint}` : "远端拒绝了这次推送（多为 non-fast-forward，需要先拉取）",
      { detail: lines.join("\n") },
    );
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? `git ${args.join(" ")} failed (${r.code})`;
  log.warn("git command failed", { args, code: r.code, stderr: r.stderr.trim() });
  return new GitError(GIT_ERROR_CODES.gitError, firstLine.trim());
}

/** ref/commitish 只做选项防护：合法 ref 不以前导 "-" 开头，够挡 argv 选项注入 */
function assertNotOptionArg(value: string, what: string): void {
  if (value.startsWith("-")) {
    throw new GitError(GIT_ERROR_CODES.invalidBranchName, `${what} 不能以 "-" 开头（会被 git 当成选项）`);
  }
}

// ---- 状态 -----------------------------------------------------------------

export async function status(root: string): Promise<GitStatusResult> {
  // --porcelain=v2 -b：一行头部（branch.head/upstream/ab）+ N 行改动。
  // 非 git 目录 / 裸仓库：git 以非 0 退出 —— 按契约折成 {isRepo:false}
  // （诚实缺席：裸仓库没有可管理的工作树，对面板而言等同不可用），侧栏
  // 标记与面板空态都依赖这个而不是异常流。
  let out: string;
  try {
    out = await run(root, ["status", "--porcelain=v2", "--branch"]);
  } catch (err) {
    if (err instanceof GitError && (err.code === GIT_ERROR_CODES.notARepo || /must be run in a work tree/i.test(err.message))) {
      return { isRepo: false };
    }
    throw err;
  }
  let branch: string | null = null;
  let detached = false;
  let headShort = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  let dirtyFileCount = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length);
      if (v === "(detached)") detached = true;
      else branch = v;
    } else if (line.startsWith("# branch.oid ")) {
      const v = line.slice("# branch.oid ".length);
      // 还没有任何提交时 oid 是 "(initial)" 哨兵，不是 hash —— 留空而不是截成 "(initi"
      headShort = v === "(initial)" ? "" : v.slice(0, 7);
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
      dirtyFileCount += 1;
    }
  }
  return { isRepo: true, branch, detached, headShort, upstream, ahead, behind, dirty, dirtyFileCount };
}

/**
 * 客户端给的路径必须落在仓库根之下，且不含前导 "-"（否则 git 当成选项）。
 *
 * 提交面全是按路径操作（stage / diff / commit），这里就是 argv 注入的闸门：
 * 一律 resolve 后比对前缀，并让调用方在 argv 里补 `--` 分隔符。
 */
function resolveRepoPath(root: string, p: string): string {
  const trimmed = p.trim();
  if (trimmed.length === 0) throw new GitError(GIT_ERROR_CODES.badParams, "路径不能为空");
  if (trimmed.startsWith("-")) {
    throw new GitError(GIT_ERROR_CODES.badParams, "路径不能以 - 开头（会被 git 当成选项）");
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, trimmed);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new GitError(GIT_ERROR_CODES.badParams, `路径越出仓库根：${p}`);
  }
  // 统一成正斜杠：git 的 pathspec 与输出都是正斜杠，反斜杠在 -z 下会变成两个字符
  return target.split(path.sep).join("/");
}

/** 一组路径的公共校验：空数组是 bad_params（没有全量操作入口，语义要显式） */
function resolveRepoPaths(root: string, paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitError(GIT_ERROR_CODES.badParams, "paths 不能为空");
  }
  return paths.map((p) => resolveRepoPath(root, typeof p === "string" ? p : ""));
}

// ---- 分支 -----------------------------------------------------------------

export async function listBranches(root: string): Promise<GitBranchesResult> {
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

  const branches: GitBranchInfo[] = [];
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
  const cmd = await gitCmd().catch(() => null);
  if (cmd === null) return null;
  return await new Promise((resolve) => {
    const child = spawn(cmd.file, [...cmd.prefixArgs, "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    // 与 run() 同口径的超时：挂死的 git（锁死的 index / 死掉的 SMB 路径）不能拖死整个 RPC
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      resolve(null);
    }, 10000);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

export async function createBranch(root: string, name: string, opts: { readonly ref?: string } = {}): Promise<void> {
  await assertValidBranchName(root, name);
  const ref = opts.ref?.trim() || undefined;
  if (ref !== undefined) assertNotOptionArg(ref, "基点 ref");
  // VSCode/ZCode 同款语义：新建即切换；从远程 ref 建时不自动挂 upstream
  await run(root, ["checkout", "-q", "-b", name, "--no-track", ...(ref ? [ref] : [])]);
}

export async function checkoutBranch(root: string, name: string): Promise<void> {
  // 全量校验（含前导 "-"）：没有它，name="--force" 会被 git 当选项吞掉，
  // 绕过 dirty_worktree 确认流直接丢改动
  await assertValidBranchName(root, name);
  await run(root, ["checkout", "-q", name]);
}

async function assertValidBranchName(root: string, name: string): Promise<void> {
  if (name.trim().length === 0) throw new GitError(GIT_ERROR_CODES.invalidBranchName, "分支名不能为空");
  await run(root, ["check-ref-format", "--branch", name]);
}

// ---- 工作树 ---------------------------------------------------------------

interface WtRecord {
  readonly path: string;
  readonly branch: string | null;
  readonly headShort: string;
  readonly bare: boolean;
}

/**
 * 解析 `git worktree list --porcelain -z`。-z 下 token 以 NUL 分隔、路径不转义
 * 不加引号（LF 版对含中文/特殊字符的路径会 C-quote，喂给 existsSync 全是坑）。
 */
function parseWorktreePorcelain(out: string): WtRecord[] {
  const records: WtRecord[] = [];
  let cur: { path?: string; branch?: string; headShort?: string; bare?: boolean } | null = null;
  for (const token of out.split("\0")) {
    if (token.length === 0) {
      if (cur?.path !== undefined) records.push(toRecord(cur));
      cur = null;
      continue;
    }
    if (token.startsWith("worktree ")) cur = { path: token.slice("worktree ".length) };
    else if (cur !== null && token.startsWith("HEAD ")) cur.headShort = token.slice("HEAD ".length).slice(0, 7);
    else if (cur !== null && token.startsWith("branch ")) cur.branch = token.slice("branch refs/heads/".length);
    else if (cur !== null && token === "bare") cur.bare = true;
  }
  if (cur?.path !== undefined) records.push(toRecord(cur));
  return records;
}

function toRecord(cur: { path?: string; branch?: string; headShort?: string; bare?: boolean }): WtRecord {
  return { path: cur.path ?? "", branch: cur.branch ?? null, headShort: cur.headShort ?? "", bare: cur.bare === true };
}

export async function listWorktrees(root: string): Promise<readonly GitWorktree[]> {
  const out = await run(root, ["worktree", "list", "--porcelain", "-z"]);
  const records = parseWorktreePorcelain(out);
  const outArr: GitWorktree[] = records.map((r, i) => ({
    path: r.path,
    branch: r.branch,
    headShort: r.headShort,
    dirty: false,
    isMain: i === 0,
  }));

  // dirty 状态逐个工作树问一次 status（个人工作台规模下工作树个数为个位数）。
  // --no-optional-locks：探测不该与会话里的 git 抢 index 锁。
  const withDirty = await Promise.all(
    outArr.map(async (w) => {
      if (w.branch === null && w.headShort === "") return w; // bare 行没有工作目录可言
      try {
        // --no-optional-locks 是 git 的全局选项（须在子命令之前）：探测不该
        // 与会话里的 git 抢 index 锁
        const s = await run(w.path, ["--no-optional-locks", "status", "--porcelain"], 10000);
        return { ...w, dirty: s.trim().length > 0 };
      } catch {
        // 探测失败（目录被外部删掉 / 超时 / 盘不在了）按「不保证干净」处理：
        // 标 dirty 会让用户多看一眼，标 clean 则可能在脏树上放行删除
        return { ...w, dirty: true };
      }
    }),
  );
  return withDirty;
}

/** branch → 检出它的 worktree 路径（含主仓库）。分支列表的 checkedOutIn 数据源 */
async function worktreeBranchMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const out = await run(root, ["worktree", "list", "--porcelain", "-z"]);
    for (const r of parseWorktreePorcelain(out)) {
      if (r.branch !== null && r.path !== "") map.set(r.branch, r.path);
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
  if (commitish !== undefined) assertNotOptionArg(commitish, "commitish");
  // 新分支名与检出 ref 至少其一：没有「从当前 HEAD 凭空 detached」的形态（UI 也无入口）
  const seg = branch ?? commitish;
  if (seg === undefined) {
    throw new GitError(GIT_ERROR_CODES.badParams, "worktree.create 需要 branch 或 commitish 至少其一");
  }

  // 校验先行：分支名非法时不该先去看磁盘
  if (branch !== undefined) await assertValidBranchName(root, branch);

  // 路径缺省：VSCode 约定 <仓库父目录>/<仓库名>.worktrees/<分支名>。
  // 用户给了相对路径时按 **仓库根** 解析（git -C root 的口径），而不是 daemon cwd。
  const branchSeg = seg.replace(/[\\/]/g, "-");
  const target = path.resolve(
    root,
    opts.path?.trim() ||
      path.join(path.dirname(path.resolve(root)), `${path.basename(path.resolve(root))}.worktrees`, branchSeg),
  );
  if (existsSync(target)) {
    throw new GitError(GIT_ERROR_CODES.worktreePathExists, "目标路径已存在，换一个路径或分支名", { path: target });
  }

  if (branch !== undefined) {
    await run(root, ["worktree", "add", "-b", branch, "--no-track", target, ...(commitish ? [commitish] : [])]);
  } else if (commitish !== undefined) {
    // 从已有分支/ref 检出（该分支不能已被别的工作树占用，否则 branch_checked_out_elsewhere）
    await run(root, ["worktree", "add", target, commitish]);
  }
  return { path: target, branch: branch ?? commitish ?? null };
}

export async function removeWorktree(root: string, target: string, force = false): Promise<void> {
  await run(root, ["worktree", "remove", ...(force ? ["--force"] : []), target]);
  await run(root, ["worktree", "prune"]);
}

/** 在系统文件管理器里显示该目录（win32 explorer / darwin open / xdg-open） */
export async function revealPath(target: string): Promise<void> {
  if (!existsSync(target)) throw new GitError(GIT_ERROR_CODES.pathMissing, "目录不存在", { path: target });
  const opener =
    process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

// ---- 会话工作树（StartSessionRequest.worktree 的 daemon 侧兑现） ----------

/** 同一 worktree 路径的并发 ensure 去重：两个 session.start 同时建一棵树，输家会炸出莫名 git_error */
const ensuringWorktrees = new Map<string, Promise<string>>();

/**
 * 确保会话要的 worktree 存在：在就直接用（幂等），不在就建。
 *
 * 分支已存在 → 检出它（而不是 -b 重建）；分支不存在 → 从当前 HEAD 建。
 * 这让「同一会话槽位重开」天然复用上次的 worktree 与分支。
 * 复用前校验两件事：目录确实属于本仓库（common dir 一致），且当前检出分支
 * 与 spec 一致（被人在树里切走了就切回来 —— UI 承诺了「分支 X」）。
 */
export async function ensureWorktree(
  root: string,
  spec: { readonly path: string; readonly branch: string },
): Promise<string> {
  const wtPath = path.resolve(root, spec.path);
  await assertValidBranchName(root, spec.branch);
  const inflight = ensuringWorktrees.get(wtPath);
  if (inflight !== undefined) return inflight;
  const p = doEnsureWorktree(root, wtPath, spec.branch).finally(() => ensuringWorktrees.delete(wtPath));
  ensuringWorktrees.set(wtPath, p);
  return p;
}

async function doEnsureWorktree(root: string, wtPath: string, branch: string): Promise<string> {
  if (existsSync(path.join(wtPath, ".git"))) {
    await assertSameRepo(root, wtPath);
    await alignWorktreeBranch(wtPath, branch);
    return wtPath;
  }
  // 分支存在性一条命令判定（show-ref --verify 比 for-each-ref 全量列省两个进程）
  const branchExists = await branchExistsIn(root, branch);
  if (branchExists) {
    await run(root, ["worktree", "add", wtPath, branch]);
  } else {
    await run(root, ["worktree", "add", "-b", branch, "--no-track", wtPath]);
  }
  return wtPath;
}

/** 复用已有目录前确认它是本仓库的工作树：common dir 不一致 = 别的仓库/克隆混进来了 */
async function assertSameRepo(root: string, wtPath: string): Promise<void> {
  const [rootCommon, wtCommon] = await Promise.all([
    run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10000),
    run(wtPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10000),
  ]);
  if (path.resolve(rootCommon.trim()) !== path.resolve(wtCommon.trim())) {
    throw new GitError(
      GIT_ERROR_CODES.gitError,
      `目标目录是另一个 git 仓库，不是 ${path.basename(root)} 的工作树，拒绝复用`,
      { path: wtPath },
    );
  }
}

/** 树里被切到别的分支时切回 spec 分支（只在分支存在于树中时；否则保持现状） */
async function alignWorktreeBranch(wtPath: string, branch: string): Promise<void> {
  const cur = await symbolicRef(wtPath);
  if (cur === branch) return;
  try {
    await run(wtPath, ["checkout", "-q", branch], 15000);
  } catch {
    // 分支在树中不可检出（比如又被别处占用）—— 保持现状，会话照样能跑
    log.warn("session worktree branch align failed, keeping current checkout", { wtPath, want: branch, got: cur });
  }
}

async function branchExistsIn(root: string, branch: string): Promise<boolean> {
  try {
    await run(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], 10000);
    return true;
  } catch {
    return false;
  }
}

// ---- 改动面（ADR 0010）：改了什么 / 要不要落库 ------------------------------

/** 单文件 diff 的字节上限；超出的按行截断并在 result.truncated 里如实说 */
const DIFF_MAX_BYTES = 256 * 1024;
/** 截断时保留的行数（截断点在「多少行之后」，与字节上限取先到者） */
const DIFF_MAX_LINES = 4000;
/** 未跟踪文件算行数时的体积闸门：超过就只读前若干字节判二进制，不把整个文件读进内存 */
const NEW_FILE_SNIFF_MAX = 512 * 1024;
/** 含 NUL 即判二进制（与 git 的启发式同源，够用） */
const BINARY_SNIFF_BYTES = 8000;

interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

const ZERO_COUNTS: LineCounts = { added: 0, removed: 0 };

function numOrZero(s: string): number {
  if (s === "-" || s === "") return 0; // 二进制文件 git 给 "-"
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析 `git diff --numstat -z`。
 *
 * 普通记录是**一个** token：`<added>\t<removed>\t<path>`；重命名/复制是**三个**
 * token：`<added>\t<removed>` \0 `<原路径>` \0 `<新路径>`（实测确认 header 没有
 * 尾随 tab，所以「token 内只有一个 tab」就是重命名的判据）。
 * 行数记在**新路径**名下 —— 改动审阅展示的是文件当前的样子。
 */
function parseNumstatZ(out: string): Map<string, LineCounts> {
  const map = new Map<string, LineCounts>();
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.length === 0) continue;
    const t1 = tok.indexOf("\t");
    if (t1 < 0) continue;
    const t2 = tok.indexOf("\t", t1 + 1);
    const counts: LineCounts = { added: numOrZero(tok.slice(0, t1)), removed: numOrZero(tok.slice(t1 + 1, t2 < 0 ? undefined : t2)) };
    if (t2 < 0) {
      const target = tokens[i + 2]; // 原路径在 i+1，新路径在 i+2
      if (target !== undefined && target.length > 0) map.set(target, counts);
      i += 2;
      continue;
    }
    map.set(tok.slice(t2 + 1), counts);
  }
  return map;
}

async function numstatOf(root: string, cached: boolean): Promise<Map<string, LineCounts>> {
  const out = await run(root, [
    "--no-optional-locks",
    "diff",
    ...(cached ? ["--cached"] : []),
    "--numstat",
    "-z",
    "-M",
    "--",
  ]);
  return parseNumstatZ(out);
}

/** 取第 n 个单空格之后的全部内容（路径里可以含空格，靠字段数定位而不是 lastIndexOf） */
function fieldAfterSpaces(token: string, n: number): string {
  let idx = -1;
  for (let k = 0; k < n; k++) {
    idx = token.indexOf(" ", idx + 1);
    if (idx < 0) return "";
  }
  return token.slice(idx + 1);
}

interface StatusEntry {
  readonly xy: string;
  readonly path: string;
  readonly untracked: boolean;
}

/**
 * 解析 `git status --porcelain=v2 -z` 的改动条目。
 *
 * 字段数按类型固定：`1` 前 8 个字段、`2`/`u` 前 9 个、忽略项前 1 个 —— 路径从第 n 个
 * 空格之后取，所以含空格的路径不会像 lastIndexOf 那样被截断。
 * 重命名记录在 -z 下是**新路径在前、原路径在后**（实测），原路径只是跳过不取。
 */
function parseStatusV2Z(out: string): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined || tok.length === 0) continue;
    if (tok.startsWith("? ")) {
      entries.push({ xy: "??", path: fieldAfterSpaces(tok, 1), untracked: true });
      continue;
    }
    if (tok.startsWith("! ")) continue; // 忽略项不在面板里显示
    if (tok.startsWith("# ")) continue; // --branch 的头部行（保底：本函数不传 --branch）
    const kind = tok.slice(0, 1);
    const xy = fieldAfterSpaces(tok, 1).slice(0, 2);
    if (kind === "2") {
      entries.push({ xy, path: fieldAfterSpaces(tok, 9), untracked: false });
      i += 1; // 跳过紧随其后的原路径 token
      continue;
    }
    entries.push({ xy, path: fieldAfterSpaces(tok, kind === "u" ? 9 : 8), untracked: false });
  }
  return entries;
}

/** 文本文件的行数；二进制给 0。未跟踪目录条目（`dist/`）没有行数可言，也给 0 */
function countNewFileLines(root: string, relPath: string): number {
  if (relPath.endsWith("/")) return 0;
  try {
    const abs = path.resolve(root, relPath);
    const st = statSync(abs);
    if (!st.isFile() || st.size > NEW_FILE_SNIFF_MAX) return 0;
    return linesIn(readFileSync(abs));
  } catch {
    return 0; // 文件在探测与读取之间被删/移走：给 0，不让面板整个失败
  }
}

function linesIn(buf: Buffer): number {
  if (buf.length === 0) return 0;
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1; // 末行没有换行符也还算一行
}

/**
 * 改动列表：staged / unstaged / untracked 三组（ADR 0010 的「改了什么」）。
 *
 * 刻意用 `-unormal`（默认）而不是 `-uall`：完全未跟踪的目录折叠成一条 `dist/`，
 * 否则一个没 gitignore 的 node_modules 会让单次面板刷新吐出上万行。
 *
 * 每次现拉现算，不缓存暂存意图 —— 并发执行器正在写文件时，缓存出来的「有哪些改动」
 * 本来就是假的（提交前的 races 对策，见 docs/15 §七）。
 */
export async function changes(root: string): Promise<GitChangesResult> {
  const [statusOut, cachedStat, workStat] = await Promise.all([
    run(root, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "-unormal"]),
    numstatOf(root, true),
    numstatOf(root, false),
  ]);

  const staged: GitChangeEntry[] = [];
  const unstaged: GitChangeEntry[] = [];
  const untracked: GitChangeEntry[] = [];
  for (const e of parseStatusV2Z(statusOut)) {
    if (e.untracked) {
      untracked.push({ path: e.path, xy: e.xy, added: countNewFileLines(root, e.path), removed: 0 });
      continue;
    }
    // X 是索引（暂存区）状态、Y 是工作区状态：一个文件可以同时落在两组里
    const x = e.xy.charAt(0);
    const y = e.xy.charAt(1);
    if (x !== "." && x !== " ") staged.push({ path: e.path, xy: e.xy, ...(cachedStat.get(e.path) ?? ZERO_COUNTS) });
    if (y !== "." && y !== " ") unstaged.push({ path: e.path, xy: e.xy, ...(workStat.get(e.path) ?? ZERO_COUNTS) });
  }
  return { staged, unstaged, untracked };
}

async function isUntracked(root: string, relPath: string): Promise<boolean> {
  const out = await run(root, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "--", relPath], 10000);
  return out.trim().length > 0;
}

/** 未跟踪文件的「新增文件」patch：索引里没有可比对象，git 自己不会给 diff */
function untrackedPatch(root: string, relPath: string): GitDiffResult {
  let buf: Buffer;
  try {
    buf = readFileSync(path.resolve(root, relPath));
  } catch {
    return { patch: "", truncated: false, binary: false, untracked: true };
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { patch: `Binary files /dev/null and b/${relPath} differ`, truncated: false, binary: true, untracked: true };
  }
  const lines = buf.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const shown = lines.slice(0, DIFF_MAX_LINES);
  const head =
    `diff --git a/${relPath} b/${relPath}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${relPath}\n` +
    `@@ -0,0 +1,${total} @@\n`;
  const patch = shown.length === 0 ? head : head + shown.map((l) => `+${l}`).join("\n") + "\n";
  return { patch, truncated: total > shown.length, binary: false, untracked: true };
}

/** 单文件 patch。staged 看索引 vs HEAD，unstaged 看工作区 vs 索引 */
export async function diff(root: string, relPath: string, sourceId: "staged" | "unstaged"): Promise<GitDiffResult> {
  if (sourceId !== "staged" && sourceId !== "unstaged") {
    throw new GitError(GIT_ERROR_CODES.badParams, "sourceId 必须是 staged 或 unstaged");
  }
  const p = resolveRepoPath(root, relPath);
  if (sourceId === "unstaged" && (await isUntracked(root, p))) {
    return untrackedPatch(root, p);
  }
  const raw = await run(
    root,
    ["--no-optional-locks", "diff", "-M", ...(sourceId === "staged" ? ["--cached"] : []), "--", p],
    30000,
  );
  const truncated = raw.length > DIFF_MAX_BYTES;
  const patch = truncated ? raw.split(/\r?\n/).slice(0, DIFF_MAX_LINES).join("\n") : raw;
  // git 对二进制文件给的是「Binary files … differ」，不是可读的 patch
  return { patch, truncated, binary: /^Binary files /m.test(patch), untracked: false };
}

/**
 * 暂存 / 取消暂存：一律按**精确路径** + `--` 分隔符。
 *
 * 用 `.` 会把整个工作区（连带 agent 正在写的文件）一次性卷进索引 —— 那正是
 * docs/15 §七 里点名的竞态。stage 用 `-A` 是为了覆盖「已删除的文件」，
 * 否则 pathspec 匹配不上直接报错。
 */
export async function stagePaths(root: string, paths: readonly string[]): Promise<void> {
  const ps = resolveRepoPaths(root, paths);
  await run(root, ["add", "-A", "--", ...ps]);
}

export async function unstagePaths(root: string, paths: readonly string[]): Promise<void> {
  const ps = resolveRepoPaths(root, paths);
  try {
    await run(root, ["restore", "--staged", "--", ...ps]);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    // 老 git（< 2.23）没有 restore 子命令
    if (/is not a git command/i.test(err.message)) {
      await run(root, ["reset", "-q", "--", ...ps]);
      return;
    }
    // unborn HEAD（一个提交都还没有）时 restore / reset 都以 HEAD 为基点会失败，
    // 此时只能用 rm --cached 把条目从索引里摘下来
    if (/could not resolve HEAD|ambiguous argument 'HEAD'/i.test(err.message)) {
      await run(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...ps]);
      return;
    }
    throw err;
  }
}

export interface CommitOptions {
  readonly message: string;
  /** 要一并落库的路径。仅在 stagedOnly=false（对话框勾了「包含未暂存改动」）时必填 */
  readonly paths: readonly string[];
  /** true = 只提交索引当前内容，不碰工作区 */
  readonly stagedOnly?: boolean;
}

export async function commitChanges(root: string, opts: CommitOptions): Promise<GitCommitResult> {
  const message = opts.message.trim();
  if (message.length === 0) throw new GitError(GIT_ERROR_CODES.badParams, "提交信息不能为空");
  const stagedOnly = opts.stagedOnly === true;
  // stagedOnly 路径无关（提交的就是索引），非 stagedOnly 必须给出明确路径 ——
  // 没有「把整个仓库 add -A 掉」的入口
  const ps = stagedOnly ? [] : resolveRepoPaths(root, opts.paths);

  if (!stagedOnly) {
    // 「包含未暂存改动」：先把选中的路径（含未跟踪与删除）落进索引，
    // 随后统一提交索引。这样未跟踪文件也能进这次提交，且不会波及别的路径。
    await run(root, ["add", "-A", "--", ...ps]);
  }

  // 先说「没东西可提交」再说身份缺失：前者是常见态，git 原话也更具体。
  // 用 name-only 而不是 diff --quiet：后者靠退出码表达，会被 run() 当失败抛成 GitError。
  const pending = await run(root, ["--no-optional-locks", "diff", "--cached", "--name-only", "-z", "--"], 15000);
  if (pending.trim().length === 0) {
    throw new GitError(GIT_ERROR_CODES.nothingToCommit, "没有可提交的内容（暂存区是空的）");
  }

  // 身份预检：git 自己的报错是英文多行提示，前端没法据此给可操作的警告条
  if ((await identity(root)) === null) {
    throw new GitError(GIT_ERROR_CODES.identityMissing, "未配置 git 身份，git 拒绝提交", {
      hint: 'git config user.name "你的名字" / git config user.email "you@example.com"',
    });
  }

  await run(root, ["commit", "-m", message], 60000);
  const commitHash = (await run(root, ["rev-parse", "--short", "HEAD"], 10000)).trim();
  return { commitHash, branchName: await symbolicRef(root) };
}

/**
 * 推送当前分支。有 upstream 就推它，没有则用 `-u` 首推并顺带建立追踪。
 *
 * remote 的判定顺序：显式参数 → 已配置的 upstream → 仓库里唯一的 remote。
 * 一个都没有报 no_remote；有多个又无法确定，同样报 no_remote 但文案说明原因。
 */
export async function push(root: string, remoteHint?: string): Promise<GitPushResult> {
  const st = await status(root);
  if (!st.isRepo) throw new GitError(GIT_ERROR_CODES.notARepo, "该目录不是 git 仓库");
  const branchName = st.branch;
  if (branchName === null) {
    throw new GitError(GIT_ERROR_CODES.gitError, "当前处于分离头指针（detached HEAD），没有可推送的分支");
  }
  // upstream 形如 origin/main：第一个斜杠之前是 remote，之后是远端分支名
  const slash = st.upstream === null ? -1 : st.upstream.indexOf("/");
  const upstreamRemote = slash > 0 ? (st.upstream ?? "").slice(0, slash) : null;
  const upstreamBranch = slash > 0 ? (st.upstream ?? "").slice(slash + 1) : null;

  const remotes = (await run(root, ["remote"], 15000))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const remoteName = remoteHint?.trim() || upstreamRemote || (remotes.length === 1 ? remotes[0] : undefined);
  if (remoteName === undefined || remoteName === "") {
    throw new GitError(
      GIT_ERROR_CODES.noRemote,
      remotes.length === 0
        ? "仓库没有配置任何远端，无法推送"
        : `仓库有多个远端（${remotes.join("、")}），无法确定推送到哪个`,
    );
  }

  const hasUpstream = st.upstream !== null;
  await run(root, ["push", ...(hasUpstream ? [] : ["-u"]), remoteName, branchName], 120000);
  return {
    branchName,
    remoteName,
    trackingBranchName: hasUpstream ? upstreamBranch : branchName,
    setUpstream: !hasUpstream,
  };
}

/**
 * 提交身份。name / email 任一缺失即为 null（提交对话框据此显示警告条）。
 *
 * `git config -z --get-regexp` 的记录是 `key\nvalue\0`，作用域按**全局 → 本地**
 * 依次输出、后者覆盖前者（实测确认）—— 所以必须取最后一次命中，不能取第一次。
 */
export async function identity(root: string): Promise<GitIdentity | null> {
  let out: string;
  try {
    out = await run(root, ["config", "-z", "--get-regexp", "^user\\.(name|email)$"], 10000);
  } catch {
    return null; // 一项都没配
  }
  let name: string | null = null;
  let email: string | null = null;
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const nl = record.indexOf("\n");
    if (nl < 0) continue;
    const key = record.slice(0, nl);
    const value = record.slice(nl + 1);
    if (key === "user.name") name = value;
    else if (key === "user.email") email = value;
  }
  if (name === null || email === null) return null;
  if (name.trim().length === 0 || email.trim().length === 0) return null;
  return { name, email };
}

// ---- 提交图 -----------------------------------------------------------------

/**
 * 仓库的 git 目录（供 watch.ts 挂监听）。链接工作树的 gitDir 在主仓
 * `.git/worktrees/` 之下、commonDir 即主仓 `.git`；普通仓库两者相同。
 * 非 git 仓库 / git 不可用返回 null。
 */
export async function gitDirs(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  try {
    const out = await run(root, ["rev-parse", "--git-dir", "--git-common-dir"], 10000);
    const lines = out.trim().split(/\r?\n/);
    if (lines.length < 2 || lines[0] === undefined || lines[1] === undefined) return null;
    return { gitDir: path.resolve(root, lines[0].trim()), commonDir: path.resolve(root, lines[1].trim()) };
  } catch {
    return null;
  }
}

const GRAPH_RECORD_SEP = "\x1e";
const GRAPH_FIELD_SEP = "\x00";
const GRAPH_DEFAULT_MAX_COUNT = 50;
const GRAPH_MAX_MAX_COUNT = 200;
const GRAPH_LOG_TIMEOUT_MS = 30000;

/** %D 里的一个装饰 → 结构化 ref。带斜杠又无 refs/ 前缀的按远端分支论（ZCode 同判） */
function graphDecorationRef(raw: string): GitGraphRef | null {
  const ref = raw.trim();
  if (ref.length === 0) return null;
  if (ref === "HEAD") return { name: "HEAD", kind: "head" };
  if (ref.startsWith("tag: ")) {
    const name = ref.slice("tag: ".length).trim().replace(/^refs\/tags\//, "");
    return name.length > 0 ? { name, kind: "tag" } : null;
  }
  if (ref.startsWith("refs/heads/")) return { name: ref.slice("refs/heads/".length), kind: "branch" };
  if (ref.startsWith("refs/remotes/")) return { name: ref.slice("refs/remotes/".length), kind: "remote" };
  if (ref.startsWith("refs/tags/")) return { name: ref.slice("refs/tags/".length), kind: "tag" };
  return { name: ref, kind: ref.includes("/") ? "remote" : "branch" };
}

/** %D 整行（逗号分隔）→ refs[]。`HEAD -> main` 拆成 head + branch 两条 */
function parseGraphRefs(decorations: string): GitGraphRef[] {
  const refs: GitGraphRef[] = [];
  const push = (r: GitGraphRef): void => {
    if (!refs.some((x) => x.kind === r.kind && x.name === r.name)) refs.push(r);
  };
  for (const part of decorations.split(",")) {
    const d = part.trim();
    if (d.length === 0) continue;
    if (d.startsWith("HEAD -> ")) {
      push({ name: "HEAD", kind: "head" });
      const pointed = graphDecorationRef(d.slice("HEAD -> ".length));
      if (pointed !== null) push(pointed);
      continue;
    }
    const parsed = graphDecorationRef(d);
    if (parsed !== null) push(parsed);
  }
  return refs;
}

/**
 * 提交图（docs/16）：`HEAD --branches --tags --remotes` 的可见历史分页。
 *
 * 不用 `--all`：它会把 stash / 各类内部 hidden refs 卷进图里，图只展示用户
 * 可见历史（ZCode 同款限定）。`--max-count=N+1` 探测 hasMore。unborn HEAD
 * （一条提交都没有）是诚实缺席，返回空列表而不是错误。
 */
export async function graph(
  root: string,
  opts: { readonly skip?: number; readonly maxCount?: number } = {},
): Promise<GitGraphResult> {
  const skip = Number.isFinite(opts.skip) ? Math.max(0, Math.floor(opts.skip as number)) : 0;
  const rawMax = Number.isFinite(opts.maxCount) ? (opts.maxCount as number) : GRAPH_DEFAULT_MAX_COUNT;
  const maxCount = Math.min(GRAPH_MAX_MAX_COUNT, Math.max(1, Math.floor(rawMax)));

  let out: string;
  try {
    out = await run(
      root,
      [
        "--no-optional-locks",
        "log",
        "HEAD",
        "--branches",
        "--tags",
        "--remotes",
        "--date-order",
        "--topo-order",
        `--skip=${skip}`,
        `--max-count=${maxCount + 1}`,
        `--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D${GRAPH_RECORD_SEP}`,
      ],
      GRAPH_LOG_TIMEOUT_MS,
    );
  } catch (err) {
    if (
      err instanceof GitError &&
      /does not have any commits yet|your current branch|bad default revision|ambiguous argument 'HEAD'/i.test(err.message)
    ) {
      return { commits: [], hasMore: false };
    }
    throw err;
  }

  const commits: GitGraphCommit[] = [];
  for (const record of out.split(GRAPH_RECORD_SEP)) {
    const trimmed = record.trim();
    if (trimmed.length === 0) continue;
    const [hash, parents, authorName, authorAt, subject, decorations] = trimmed.split(GRAPH_FIELD_SEP);
    if (hash === undefined || hash.length === 0) continue;
    const sec = Number.parseInt(authorAt ?? "", 10);
    commits.push({
      hash,
      parents: parents !== undefined && parents.length > 0 ? parents.split(" ").filter((p) => p.length > 0) : [],
      refs: parseGraphRefs(decorations ?? ""),
      subject: subject ?? "",
      authorName: authorName ?? "",
      authorAtSec: Number.isNaN(sec) ? 0 : sec,
    });
  }
  return { commits: commits.slice(0, maxCount), hasMore: commits.length > maxCount };
}
