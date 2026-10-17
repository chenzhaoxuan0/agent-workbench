/**
 * 源代码管理（git.*）冒烟 —— Phase：源代码管理（ADR 0008）。
 *
 *   自起 daemon（随机空闲端口）→ 临时 git 仓库夹具
 *   → 状态：干净仓库 / 非 git 目录 isRepo:false / bare 与 unborn 由契约约定
 *   → 参数面：bad_params（缺 rootPath、空 name、半个 worktree spec、worktree:null、
 *     worktree.create 无 branch 无 commitish）
 *   → 分支（ADR 0009 窄面）：创建（新建即切换）/ 切换 / 选项注入防护
 *     （"--force" 不是分支名）/ 分支重名（branch_exists）/ detached HEAD 解析
 *   → 工作树：创建（默认路径约定）/ 分支被占用（branch_checked_out_elsewhere 带
 *     data.path）/ dirty 探测 / 脏删除拒绝（worktree_dirty）→ 强删 /
 *     主工作树拒删 / 目标路径已存在
 *   → 提交面（ADR 0010）：changes 三组分组 / diff（staged+unstaged+未跟踪合成）/
 *     stage → commit → push 全链（远端是**本地 bare 仓库**，全程不碰网络）/
 *     首推 setUpstream / non-fast-forward → push_rejected / nothing_to_commit /
 *     identity 缺失 / no_remote / 路径越界与选项注入的 bad_params
 *   → 提交图（docs/16）：分页 / hasMore / skip / refs 解析 / unborn 空列表
 *   → 自动刷新（docs/16）：status 心跳挂监听 → 改文件 → git.changed 广播
 *   → 会话工作树：session.start 带 worktree（mockperm 夹具执行器）→ 工作树被
 *     ensure 出来并注册；同 spec 二连发幂等复用
 *   → daemon.stop 优雅退出 → 夹具清理
 *
 * 全程只碰临时目录，不碰任何真实仓库。用法：cd backend && pnpm smoke:git
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 小工具（与 smoke-health 同构） -----------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

let daemon: ChildProcess | undefined;
/** 传给 daemon 的空 git 全局配置（见 startDaemon 注释） */
let emptyGlobalConfig = "";

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOST: "127.0.0.1",
      AGENT_WORKBENCH_INSECURE: "1",
      // 让 git 的身份解析**只**看仓库本地配置：否则这台机器的 ~/.gitconfig 一旦
      // 配了 user.email，「身份缺失」用例就永远测不到（提交面要靠它证明
      // identity_missing 这个码真的会抛出来）。文件本身是空的，放临时目录。
      GIT_CONFIG_GLOBAL: emptyGlobalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      // 自动刷新的节流窗压到 250ms：smoke 里「改文件 → 等 git.changed 广播」
      // 不用等默认的 60s（docs/16）
      AGENT_WORKBENCH_GIT_WATCH_INTERVAL_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => console.log(`  daemon | ${chunk.toString().trimEnd()}`));
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => {
    daemon?.once("exit", (code) => resolve(code));
  });
  daemon.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    daemon.kill("SIGKILL");
    return null;
  }
  return code;
}

async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  return false;
}

interface WsFrame {
  [k: string]: unknown;
}

function nextMessage(ws: WebSocket, pred: (f: WsFrame) => boolean, timeoutMs = 20000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for ws frame"));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as WsFrame;
      if (!pred(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
  });
}

function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)));
  });
}

/** git 输出正斜杠、path.join 是反斜杠：比较前统一分隔符 */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---- 主流程 -----------------------------------------------------------------

async function main(): Promise<void> {
  // 夹具：临时仓库，main 一个提交
  const fixture = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-git-"));
  const g = (cmd: string): string => execSync(cmd, { cwd: fixture, stdio: "pipe" }).toString();
  g("git init -b main");
  g("git config user.email smoke@awb");
  g("git config user.name awb-smoke");
  writeFileSync(path.join(fixture, "readme.md"), "# smoke\n");
  g("git add . && git commit -m init");
  const worktreeHome = path.join(os.tmpdir(), `awb-smoke-git-home-${Date.now()}`);
  const notRepo = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-norepo-"));

  // 提交面夹具：本地 bare 仓库当 remote（全程离线）。两个仓库分工明确 ——
  // cRepo 有本地身份 + remote，跑「改 → 暂存 → 提交 → 推送」全链；
  // noIdRepo 是 git 仓库但**没有**任何身份配置，专测 identity_missing / no_remote。
  const commitHome = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-git-commit-"));
  emptyGlobalConfig = path.join(commitHome, "empty.gitconfig");
  writeFileSync(emptyGlobalConfig, "");
  const bareRemote = path.join(commitHome, "remote.git");
  const cRepo = path.join(commitHome, "repo");
  const cClone = path.join(commitHome, "clone");
  const noIdRepo = path.join(commitHome, "noid");
  for (const dir of [bareRemote, cRepo, noIdRepo]) mkdirSync(dir, { recursive: true });

  const gc = (cmd: string, cwd: string): string => execSync(cmd, { cwd, stdio: "pipe" }).toString();
  execSync("git init --bare -q", { cwd: bareRemote, stdio: "ignore" });
  // bare 仓库的 HEAD 默认指向 init.defaultBranch（各家 git 不一），钉死成 main，
  // 后面的 clone 才不会 checkout 到一个不存在的分支
  gc("git symbolic-ref HEAD refs/heads/main", bareRemote);
  gc("git init -q -b main", cRepo);
  gc("git config user.email smoke@awb", cRepo);
  gc("git config user.name awb-smoke", cRepo);
  gc(`git remote add origin "${bareRemote}"`, cRepo);
  writeFileSync(path.join(cRepo, "readme.md"), "# commit surface\n");
  gc("git add . && git commit -q -m init", cRepo);
  gc("git init -q -b main", noIdRepo); // 故意不配 user.name / user.email

  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  try {
    check("GET /healthz responds", await waitHealthy(port));
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(ws, (f) => f["type"] === "hello");

    let seq = 0;
    const call = async (method: string, params: unknown): Promise<WsFrame> => {
      const id = `smoke-git-${++seq}`;
      ws.send(JSON.stringify({ v: 1, id, method, params }));
      return await nextMessage(ws, (f) => f["id"] === id);
    };
    const ok = async <T>(method: string, params: unknown): Promise<T> => {
      const r = await call(method, params);
      if (r["ok"] !== true) throw new Error(`${method} failed: ${JSON.stringify(r["error"])}`);
      return r["result"] as T;
    };
    const errorOf = async (method: string, params: unknown): Promise<{ code?: string; data?: { path?: string; detail?: string }; message?: string }> => {
      const r = await call(method, params);
      check(`${method} → ${(r["error"] as { code?: string } | undefined)?.code ?? "(no error)"}`, r["ok"] === false, r);
      return (r["error"] ?? {}) as { code?: string; data?: { path?: string; detail?: string }; message?: string };
    };

    // 1. 状态
    const st1 = await ok<{ isRepo: boolean; branch: string; dirty: boolean }>("git.status", { rootPath: fixture });
    check("git.status on clean repo", st1.isRepo === true && st1.branch === "main" && st1.dirty === false, st1);
    const st0 = await ok<{ isRepo: boolean }>("git.status", { rootPath: notRepo });
    check("git.status on non-repo → isRepo:false（诚实缺席）", st0.isRepo === false, st0);

    // 2. 参数面：bad_params 一族（不改动仓库状态，先测）
    await errorOf("git.status", {});
    await errorOf("git.branch.create", { rootPath: fixture, name: "" });
    await errorOf("session.start", {
      runtimeId: "mockperm", unitId: "smoke-git", rootPath: fixture, prompt: "x",
      worktree: { path: path.join(worktreeHome, "half") }, // 半个 spec
    });
    await errorOf("session.start", {
      runtimeId: "mockperm", unitId: "smoke-git", rootPath: fixture, prompt: "x",
      worktree: null, // null 不是合法 spec，也不该 TypeError → internal
    });
    await errorOf("git.worktree.create", { rootPath: fixture }).then((e) =>
      check("worktree.create without branch/commitish → bad_params", e.code === "bad_params", e));

    // 3. 分支：创建（新建即切换）→ 选项注入防护 → 列表
    await ok("git.branch.create", { rootPath: fixture, name: "feat/smoke" });
    const st2 = await ok<{ branch: string }>("git.status", { rootPath: fixture });
    check("branch.create switched HEAD", st2.branch === "feat/smoke", st2);

    // 前导 "-" 的"分支名"会被 git 当选项：必须拦成 invalid_branch_name 而不是执行
    const inj = await errorOf("git.branch.checkout", { rootPath: fixture, name: "--force" });
    check("option-looking branch name rejected", inj.code === "invalid_branch_name", inj);

    writeFileSync(path.join(fixture, "feat.txt"), "x");
    g("git add . && git commit -m feat");
    await ok("git.branch.checkout", { rootPath: fixture, name: "main" });

    const list1 = await ok<{ current: string; branches: { name: string; kind: string; checkedOutIn: string | null }[] }>(
      "git.branches.list",
      { rootPath: fixture },
    );
    check(
      "branches.list has current + checkedOutIn",
      list1.current === "main" &&
        list1.branches.some((b) => b.name === "main" && b.checkedOutIn !== null) &&
        list1.branches.some((b) => b.name === "feat/smoke" && b.checkedOutIn === null),
      list1,
    );

    // 4. 分支重名（分支面收窄后无删除/改名/合并，见 ADR 0009）
    await errorOf("git.branch.create", { rootPath: fixture, name: "main" }).then((e) =>
      check("duplicate branch → branch_exists", e.code === "branch_exists", e));

    // 5. detached HEAD 解析
    g("git checkout -q --detach");
    const stD = await ok<{ isRepo: boolean; branch: string | null; detached: boolean }>("git.status", { rootPath: fixture });
    check("status on detached HEAD", stD.isRepo === true && stD.branch === null && stD.detached === true, stD);
    const lbD = await ok<{ current: string | null; detached: boolean }>("git.branches.list", { rootPath: fixture });
    check("branches.list on detached HEAD", lbD.current === null && lbD.detached === true, lbD);
    g("git checkout -q main");

    // 6. 工作树：创建（默认路径约定）→ 分支被占用 → dirty → 脏删除 → 强删 → 主树拒删 → 路径已存在
    const wt = await ok<{ path: string; branch: string }>("git.worktree.create", {
      rootPath: fixture,
      branch: "wt/smoke",
    });
    check("worktree default path follows <repo>.worktrees/<branch>", wt.path.includes(".worktrees") && wt.path.endsWith("wt-smoke"), wt);

    // 同一分支再开一棵树：branch_checked_out_elsewhere + data.path（不带引号）
    const dup = await errorOf("git.worktree.create", {
      rootPath: fixture,
      path: path.join(worktreeHome, "dup-wt"),
      commitish: "wt/smoke",
    });
    check(
      "checked-out branch → branch_checked_out_elsewhere + clean data.path",
      dup.code === "branch_checked_out_elsewhere" &&
        typeof dup.data?.path === "string" && dup.data.path.length > 0 && !dup.data.path.includes("'"),
      dup,
    );

    const wl1 = await ok<{ worktrees: { path: string; branch: string; isMain: boolean; dirty: boolean }[] }>(
      "git.worktrees.list",
      { rootPath: fixture },
    );
    check(
      "worktrees.list: main + new, both clean",
      wl1.worktrees.length === 2 && wl1.worktrees.every((w) => w.dirty === false) && wl1.worktrees.some((w) => w.isMain),
      wl1,
    );

    writeFileSync(path.join(wt.path, "dirty.txt"), "x");
    const wl2 = await ok<{ worktrees: { path: string; dirty: boolean }[] }>("git.worktrees.list", { rootPath: fixture });
    check("worktrees.list detects dirty", wl2.worktrees.find((w) => norm(w.path) === norm(wt.path))?.dirty === true, wl2);

    await errorOf("git.worktree.remove", { rootPath: fixture, path: wt.path }).then((e) =>
      check("remove dirty → worktree_dirty", e.code === "worktree_dirty", e));
    await errorOf("git.worktree.remove", { rootPath: fixture, path: fixture }).then((e) =>
      check("remove main → worktree_is_main", e.code === "worktree_is_main", e));
    await errorOf("git.worktree.create", { rootPath: fixture, path: fixture, branch: "wt/again" }).then((e) =>
      check("create on existing path → worktree_path_exists", e.code === "worktree_path_exists", e));
    await ok("git.worktree.remove", { rootPath: fixture, path: wt.path, force: true });
    const wl3 = await ok<{ worktrees: unknown[] }>("git.worktrees.list", { rootPath: fixture });
    check("worktree gone after force remove", wl3.worktrees.length === 1, wl3);

    // 7. 会话工作树：ensure 创建 → 注册可见 → 同 spec 二连发幂等
    const sessionWt = path.join(worktreeHome, "session-wt");    const session = await ok<{ id: string; status: string }>("session.start", {
      runtimeId: "mockperm",
      unitId: "smoke-git",
      unitName: "git 冒烟",
      rootPath: fixture,
      prompt: "你好",
      worktree: { path: sessionWt, branch: "session/smoke" },
    });
    check("session.start with worktree returns session", typeof session.id === "string", session);
    check("session worktree is a real git worktree", existsSync(path.join(sessionWt, ".git")), sessionWt);
    const wlS = await ok<{ worktrees: { path: string; branch: string | null }[] }>("git.worktrees.list", { rootPath: fixture });
    check(
      "session worktree registered with its branch",
      wlS.worktrees.some((w) => norm(w.path) === norm(sessionWt) && w.branch === "session/smoke"),
      wlS,
    );
    const session2 = await ok<{ id: string }>("session.start", {
      runtimeId: "mockperm",
      unitId: "smoke-git2",
      rootPath: fixture,
      prompt: "再开",
      worktree: { path: sessionWt, branch: "session/smoke" },
    });
    check("second session.start reuses worktree (idempotent)", typeof session2.id === "string", session2);
    await call("session.cancel", { sessionId: session.id }).catch(() => undefined);
    await call("session.cancel", { sessionId: session2.id }).catch(() => undefined);

    // 8. 提交面（ADR 0010）：改了什么 → 要不要落库。远端是本地 bare 仓库，全程离线
    const idC = await ok<{ name: string; email: string } | null>("git.identity", { rootPath: cRepo });
    check(
      "git.identity resolves local config",
      idC?.name === "awb-smoke" && idC.email === "smoke@awb",
      idC,
    );
    const idNone = await ok<{ name: string } | null>("git.identity", { rootPath: noIdRepo });
    check("git.identity → null when unset", idNone === null, idNone);

    // 分组正确性：改一个已跟踪文件 + 加一个未跟踪文件
    writeFileSync(path.join(cRepo, "readme.md"), "# commit surface\nline2\n");
    writeFileSync(path.join(cRepo, "fresh.txt"), "n1\nn2\nn3\n");
    const ch1 = await ok<{ staged: unknown[]; unstaged: { path: string; added: number; removed: number }[]; untracked: { path: string; added: number }[] }>(
      "git.changes",
      { rootPath: cRepo },
    );
    check("changes: staged empty on fresh repo", ch1.staged.length === 0, ch1);
    check(
      "changes: modified file in unstaged with line counts",
      ch1.unstaged.some((f) => f.path === "readme.md" && f.added === 1 && f.removed === 0),
      ch1.unstaged,
    );
    check(
      "changes: untracked counted by real lines",
      ch1.untracked.some((f) => f.path === "fresh.txt" && f.added === 3),
      ch1.untracked,
    );

    const stDirty = await ok<{ dirty: boolean; dirtyFileCount: number }>("git.status", { rootPath: cRepo });
    check("status.dirtyFileCount counts porcelain entries", stDirty.dirty === true && stDirty.dirtyFileCount === 2, stDirty);

    // 未跟踪文件的 diff：git 索引里没有可比对象，daemon 合成「新增文件」patch
    const dUntracked = await ok<{ patch: string; untracked: boolean; truncated: boolean }>("git.diff", {
      rootPath: cRepo, path: "fresh.txt", sourceId: "unstaged",
    });
    check(
      "diff: untracked → synthesized new-file patch",
      dUntracked.untracked === true && dUntracked.patch.includes("+n1") && dUntracked.patch.includes("@@ -0,0 +1,3 @@"),
      dUntracked,
    );

    // 参数面与 argv 注入防护
    await errorOf("git.diff", { rootPath: cRepo, path: "readme.md" }).then((e) =>
      check("git.diff without sourceId → bad_params", e.code === "bad_params", e));
    await errorOf("git.stage", { rootPath: cRepo, paths: [] }).then((e) =>
      check("git.stage with empty paths → bad_params", e.code === "bad_params", e));
    await errorOf("git.stage", { rootPath: cRepo, paths: ["--force"] }).then((e) =>
      check("option-looking path rejected", e.code === "bad_params", e));
    await errorOf("git.stage", { rootPath: cRepo, paths: ["../outside.txt"] }).then((e) =>
      check("path escaping repo root rejected", e.code === "bad_params", e));
    await errorOf("git.commit", { rootPath: cRepo, message: "   " }).then((e) =>
      check("blank commit message → bad_params", e.code === "bad_params", e));

    // 提交空索引 → nothing_to_commit（这一步在改完之后，索引仍然是空的）
    await errorOf("git.commit", { rootPath: cRepo, message: "空提交", stagedOnly: true }).then((e) =>
      check("empty index → nothing_to_commit", e.code === "nothing_to_commit", e));

    // 身份缺失：noIdRepo 有内容但没身份
    writeFileSync(path.join(noIdRepo, "x.txt"), "x\n");
    await ok("git.stage", { rootPath: noIdRepo, paths: ["x.txt"] });
    await errorOf("git.commit", { rootPath: noIdRepo, message: "无身份", stagedOnly: true }).then((e) =>
      check("missing user.name/email → identity_missing", e.code === "identity_missing", e));

    // 无远端的仓库 → no_remote
    await errorOf("git.push", { rootPath: noIdRepo }).then((e) =>
      check("push without remote → no_remote", e.code === "no_remote", e));

    // 暂存 → staged diff → 提交（只提交索引）→ 首推
    await ok("git.stage", { rootPath: cRepo, paths: ["readme.md", "fresh.txt"] });
    const ch2 = await ok<{ staged: { path: string; added: number }[]; untracked: unknown[] }>("git.changes", { rootPath: cRepo });
    check(
      "stage moves entries into staged and clears untracked",
      ch2.staged.some((f) => f.path === "readme.md") &&
        ch2.staged.some((f) => f.path === "fresh.txt") &&
        ch2.untracked.length === 0,
      ch2,
    );
    const dStaged = await ok<{ patch: string }>("git.diff", { rootPath: cRepo, path: "readme.md", sourceId: "staged" });
    check("diff(staged) shows the staged hunk", dStaged.patch.includes("+line2"), dStaged);

    // 「包含未暂存改动」：暂存后再改同一文件，不勾开关就只能提交已暂存的那一版
    writeFileSync(path.join(cRepo, "readme.md"), "# commit surface\nline2\nline3\n");
    const com1 = await ok<{ commitHash: string; branchName: string }>("git.commit", {
      rootPath: cRepo, message: "提交面冒烟", paths: [], stagedOnly: true,
    });
    check("commit returns hash + branch", /^[0-9a-f]{7,}$/.test(com1.commitHash) && com1.branchName === "main", com1);
    const leftOver = await ok<{ unstaged: { path: string }[] }>("git.changes", { rootPath: cRepo });
    check(
      "stagedOnly leaves later edits untouched (no accidental -a)",
      leftOver.unstaged.some((f) => f.path === "readme.md"),
      leftOver.unstaged,
    );

    const push1 = await ok<{ remoteName: string; setUpstream: boolean; trackingBranchName: string | null; branchName: string | null }>(
      "git.push",
      { rootPath: cRepo },
    );
    check(
      "first push sets upstream (-u)",
      push1.setUpstream === true && push1.remoteName === "origin" && push1.branchName === "main",
      push1,
    );
    const bareLog = gc("git log --oneline", bareRemote);
    check("bare remote received the commit", bareLog.includes(com1.commitHash), bareLog);
    const stPushed = await ok<{ ahead: number; upstream: string | null }>("git.status", { rootPath: cRepo });
    check("after push: upstream set and nothing ahead", stPushed.upstream === "origin/main" && stPushed.ahead === 0, stPushed);

    // 取消暂存
    writeFileSync(path.join(cRepo, "extra.txt"), "e\n");
    await ok("git.stage", { rootPath: cRepo, paths: ["extra.txt"] });
    await ok("git.unstage", { rootPath: cRepo, paths: ["extra.txt"] });
    const ch3 = await ok<{ staged: { path: string }[]; untracked: { path: string }[] }>("git.changes", { rootPath: cRepo });
    check(
      "unstage returns the file to untracked",
      ch3.staged.length === 0 && ch3.untracked.some((f) => f.path === "extra.txt"),
      ch3,
    );

    // 「包含未暂存改动」= 勾上后连未跟踪文件一起进这次提交
    const com2 = await ok<{ commitHash: string }>("git.commit", {
      rootPath: cRepo, message: "带上未跟踪", paths: ["extra.txt", "readme.md"], stagedOnly: false,
    });
    const ch4 = await ok<{ staged: unknown[]; unstaged: unknown[]; untracked: unknown[] }>("git.changes", { rootPath: cRepo });
    check(
      "commit(paths) folds unstaged + untracked in and leaves a clean tree",
      typeof com2.commitHash === "string" && ch4.staged.length === 0 && ch4.unstaged.length === 0 && ch4.untracked.length === 0,
      ch4,
    );

    // non-fast-forward：让远端领先一个提交，本地再推就是拒绝
    gc(`git clone -q "${bareRemote}" "${cClone}"`, commitHome);
    gc("git config user.email other@awb", cClone);
    gc("git config user.name other", cClone);
    writeFileSync(path.join(cClone, "other.txt"), "other\n");
    gc("git add . && git commit -q -m other && git push -q", cClone);
    writeFileSync(path.join(cRepo, "diverged.txt"), "d\n");
    gc("git add . && git commit -q -m diverged", cRepo);
    const rej = await errorOf("git.push", { rootPath: cRepo });
    check(
      "non-fast-forward → push_rejected with server detail",
      rej.code === "push_rejected" && typeof rej.data?.detail === "string" && rej.data.detail.length > 0,
      rej,
    );

    // 9. 提交图（docs/16）：可见历史分页 + parents/refs。cRepo 的线性历史此刻是
    //    diverged → 带上未跟踪 → 提交面冒烟 → init，且 HEAD 在 main 上
    type SmokeGraphCommit = { hash: string; parents: string[]; subject: string; refs: { name: string; kind: string }[] };
    const g1 = await ok<{ commits: SmokeGraphCommit[]; hasMore: boolean }>("git.graph", { rootPath: cRepo });
    check(
      "graph: HEAD first with head+branch refs",
      g1.commits[0]?.subject === "diverged" &&
        (g1.commits[0]?.refs.some((r) => r.kind === "head" && r.name === "HEAD") ?? false) &&
        (g1.commits[0]?.refs.some((r) => r.kind === "branch" && r.name === "main") ?? false),
      g1.commits[0],
    );
    check(
      "graph: linear parents chain links to next row",
      (g1.commits[0]?.parents.length ?? 0) === 1 && g1.commits[0]?.parents[0] === g1.commits[1]?.hash,
      { p: g1.commits[0]?.parents, next: g1.commits[1]?.hash },
    );
    const g1full = await ok<{ commits: unknown[]; hasMore: boolean }>("git.graph", { rootPath: cRepo, maxCount: 200 });
    check("graph: full page covers all 4 commits, no more", g1full.commits.length === 4 && g1full.hasMore === false, g1full);
    const gPage = await ok<{ commits: SmokeGraphCommit[]; hasMore: boolean }>("git.graph", { rootPath: cRepo, maxCount: 1 });
    check("graph: max-count truncates and flags hasMore", gPage.commits.length === 1 && gPage.hasMore === true, gPage);
    const gSkip = await ok<{ commits: SmokeGraphCommit[] }>("git.graph", { rootPath: cRepo, skip: 1, maxCount: 1 });
    check("graph: skip pages past HEAD", gSkip.commits[0]?.subject === "带上未跟踪", gSkip.commits[0]);
    const gUnborn = await ok<{ commits: unknown[]; hasMore: boolean }>("git.graph", { rootPath: noIdRepo });
    check("graph: unborn repo → empty (honest absence)", gUnborn.commits.length === 0 && gUnborn.hasMore === false, gUnborn);
    await errorOf("git.graph", { rootPath: cRepo, maxCount: "1" }).then((e) =>
      check("graph: string maxCount → bad_params", e.code === "bad_params", e));
    await errorOf("git.graph", { rootPath: notRepo }).then((e) =>
      check("graph: non-repo → not_a_repo", e.code === "not_a_repo", e));

    // 10. 自动刷新（docs/16）：status 心跳挂监听 → 改文件 → 节流广播 git.changed。
    //     节流窗由 env 压到 250ms（见 startDaemon），前沿即触发，不用等窗
    const graphEvt = nextMessage(
      ws,
      (f) =>
        f["type"] === "event" &&
        (f["event"] as { type?: string } | undefined)?.type === "git.changed" &&
        (f["event"] as { rootPath?: string } | undefined)?.rootPath === path.resolve(cRepo),
      5000,
    );
    await sleep(400); // 让上一轮（non-ff 期间的写入）事件先过窗，别认领到旧事件
    writeFileSync(path.join(cRepo, "watch-probe.txt"), "watch\n");
    const evt = await graphEvt;
    check(
      "git.changed broadcast after fs change",
      evt["type"] === "event" && (evt["event"] as { rootPath?: string }).rootPath === path.resolve(cRepo),
      evt,
    );

    // 11. 优雅退出
    ws.send(JSON.stringify({ v: 1, id: "smoke-git-stop", method: "daemon.stop" }));
    const stopAck = await nextMessage(ws, (f) => f["id"] === "smoke-git-stop");
    check("daemon.stop acks", stopAck["ok"] === true, stopAck);

    const exitPromise = new Promise<number | null>((resolve) => {
      daemon?.once("exit", (code) => resolve(code));
    });
    const exitCode = await Promise.race([exitPromise, sleep(8000).then(() => "timeout" as const)]);
    check("daemon exits 0 after daemon.stop", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    await stopDaemon();
    // 夹具清理：daemon 已退（避免 Windows 上执行器还占着工作树目录导致 EPERM），
    // 先 prune 让 git 忘掉外链工作树，再删目录。清不掉不能掩盖测试结果。
    try {
      execSync("git worktree prune", { cwd: fixture, stdio: "ignore" });
    } catch { /* 夹具已坏也无所谓 */ }
    for (const dir of [fixture, notRepo, worktreeHome, commitHome]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* 留给系统临时目录清理 */ }
    }
  }

  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("smoke: crashed", err);
  void stopDaemon();
  process.exit(1);
});
