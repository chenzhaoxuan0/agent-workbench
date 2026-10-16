/**
 * 源代码管理（git.*）冒烟 —— Phase：源代码管理（ADR 0008）。
 *
 *   自起 daemon（随机空闲端口）→ 临时 git 仓库夹具
 *   → git.status / branches.list
 *   → 分支：创建（含立即切换）/ 切换 / 未合并删除拒绝（branch_not_merged）→ 强删
 *   → 工作树：创建（默认路径约定）/ 列表（dirty 探测）/ 脏删除拒绝（worktree_dirty）→ 强删
 *   → session.start 带 worktree（mockperm 夹具执行器）→ 工作树被 ensure 出来
 *   → 非 git 目录 status 返回 {isRepo:false}（诚实缺席，不抛错）
 *   → daemon.stop 优雅退出
 *
 * 全程只碰临时目录，不碰任何真实仓库。用法：cd backend && pnpm smoke:git
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const expectError = async (method: string, params: unknown, code: string): Promise<WsFrame> => {
      const r = await call(method, params);
      check(`${method} → ${code}`, r["ok"] === false && (r["error"] as { code?: string } | undefined)?.code === code, r["error"]);
      return r;
    };

    // 1. 状态
    const st1 = await ok<{ isRepo: boolean; branch: string; dirty: boolean }>("git.status", { rootPath: fixture });
    check("git.status on clean repo", st1.isRepo === true && st1.branch === "main" && st1.dirty === false, st1);

    const notRepo = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-norepo-"));
    const st0 = await ok<{ isRepo: boolean }>("git.status", { rootPath: notRepo });
    check("git.status on non-repo → isRepo:false（诚实缺席）", st0.isRepo === false, st0);

    // 2. 分支：创建（立即切换）→ 列表 → 未合并删除 → 强删
    await ok("git.branch.create", { rootPath: fixture, name: "feat/smoke", checkout: true });
    const st2 = await ok<{ branch: string }>("git.status", { rootPath: fixture });
    check("branch.create(checkout) switched HEAD", st2.branch === "feat/smoke", st2);

    writeFileSync(path.join(fixture, "feat.txt"), "x");
    g("git add . && git commit -m feat");
    await ok("git.branch.checkout", { rootPath: fixture, name: "main" });

    const list1 = await ok<{ current: string; branches: { name: string; kind: string; checkedOutIn: string | null }[] }>(
      "git.branches.list",
      { rootPath: fixture },
    );
    check(
      "branches.list has current + local + checkedOutIn",
      list1.current === "main" && list1.branches.some((b) => b.name === "feat/smoke" && b.checkedOutIn === null),
      list1,
    );

    await expectError("git.branch.delete", { rootPath: fixture, name: "feat/smoke" }, "branch_not_merged");
    await ok("git.branch.delete", { rootPath: fixture, name: "feat/smoke", force: true });
    const list2 = await ok<{ branches: { name: string }[] }>("git.branches.list", { rootPath: fixture });
    check("branch gone after force delete", !list2.branches.some((b) => b.name === "feat/smoke"), list2);

    // 3. 工作树：创建（默认路径约定）→ dirty 探测 → 脏删除拒绝 → 强删
    const wt = await ok<{ path: string; branch: string }>("git.worktree.create", {
      rootPath: fixture,
      branch: "wt/smoke",
    });
    check("worktree default path follows <repo>.worktrees/<branch>", wt.path.includes(".worktrees") && wt.path.endsWith("wt-smoke"), wt);

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
    // git 输出正斜杠、path.join 是反斜杠：比较前统一分隔符
    const norm = (p: string): string => p.replace(/\\/g, "/");
    check("worktrees.list detects dirty", wl2.worktrees.find((w) => norm(w.path) === norm(wt.path))?.dirty === true, wl2);

    await expectError("git.worktree.remove", { rootPath: fixture, path: wt.path }, "worktree_dirty");
    await ok("git.worktree.remove", { rootPath: fixture, path: wt.path, force: true });
    const wl3 = await ok<{ worktrees: unknown[] }>("git.worktrees.list", { rootPath: fixture });
    check("worktree gone after force remove", wl3.worktrees.length === 1, wl3);

    // 4. 会话工作树：session.start 带 worktree（mockperm 夹具执行器）→ ensure 出目录
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
    check("session worktree ensured on disk", existsSync(path.join(sessionWt, ".git")) || existsSync(sessionWt), sessionWt);
    await call("session.cancel", { sessionId: session.id }).catch(() => undefined);

    // 5. 优雅退出
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
