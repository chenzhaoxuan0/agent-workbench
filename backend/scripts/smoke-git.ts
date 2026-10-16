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
 *   → 会话工作树：session.start 带 worktree（mockperm 夹具执行器）→ 工作树被
 *     ensure 出来并注册；同 spec 二连发幂等复用
 *   → daemon.stop 优雅退出 → 夹具清理
 *
 * 全程只碰临时目录，不碰任何真实仓库。用法：cd backend && pnpm smoke:git
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1" },
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
    const errorOf = async (method: string, params: unknown): Promise<{ code?: string; data?: { path?: string }; message?: string }> => {
      const r = await call(method, params);
      check(`${method} → ${(r["error"] as { code?: string } | undefined)?.code ?? "(no error)"}`, r["ok"] === false, r);
      return (r["error"] ?? {}) as { code?: string; data?: { path?: string }; message?: string };
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
    const sessionWt = path.join(worktreeHome, "session-wt");
    const session = await ok<{ id: string; status: string }>("session.start", {
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

    // 8. 优雅退出
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
    for (const dir of [fixture, notRepo, worktreeHome]) {
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
