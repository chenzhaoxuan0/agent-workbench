/**
 * git 仓库操作 —— 「源代码管理」面板（分支 / 工作树）的 daemon 侧实现。
 *
 * 决策（ADR 0008）：spawn 本机 git CLI，不引入 JS git 库 —— 行为与命令行完全
 * 一致、零抽象税，代价是依赖用户 PATH 里有 git（与依赖各执行器 CLI 同一前提）。
 *
 * 分支面对齐 ZCode 的窄模型（ADR 0009）：只做「在哪个分支上工作」——
 * 列出 / 新建即切换 / 切换。合并、改名、删除等低频操作留给终端，不做面板入口。
 *
 * 工作树是会话隔离的承重墙，完整保留：
 * - 删除有未提交改动的工作树先普通 remove，失败回 worktree_dirty，UI 确认后 --force
 * - 一个分支同时只能被一个工作树检出：git 报错映射为
 *   branch_checked_out_elsewhere（带 data.path），UI 引导「打开那个工作树」
 *
 * 安全口径：所有到达 git argv 的 ref/分支名先过校验（check-ref-format 或
 * 拒绝前导 "-"），防止客户端把选项当分支名传进来（如 --force）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveCommand, type ResolvedCommand } from "../runtime/exec.ts";
import { log } from "../log.ts";
import { GIT_ERROR_CODES, type GitBranchInfo, type GitBranchesResult, type GitStatus, type GitStatusResult, type GitWorktree } from "../contract.ts";

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
    }
  }
  return { isRepo: true, branch, detached, headShort, upstream, ahead, behind, dirty };
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
