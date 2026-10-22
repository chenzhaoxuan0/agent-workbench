/**
 * AI-native P4b 验收（docs/21 §2 P4b）：通知事实源上移。
 *
 *   自起 daemon（随机端口 + INSECURE）→ /rpc session.chat（mockperm）→
 *   notifications.list 出 `end:{sid}` 行（kind=session、source=cli、**行里无 read 字段**
 *   ——已读是客户端呈现，这是操作/呈现二分的边界断言）→
 *   第二轮再产生一条（自然键不堆叠，各会话各一行）→
 *   git.changed 聚合：init 仓库 + git.status 挂监听 + 改文件 → `git:{root}` 行。
 *
 * 用法：cd backend && pnpm smoke:ai-native-notifications
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 冒烟家（隔离 AGENT_WORKBENCH_HOME）：daemon 全部状态住临时目录，绝不碰真实 ~/.agent-workbench */
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "aw-notify-home-"));

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
const daemonOutput: string[] = [];

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1", AGENT_WORKBENCH_HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      daemonOutput.push(chunk.toString().trimEnd());
    });
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
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return false;
}

async function rpc<T>(port: number, method: string, params: unknown): Promise<T | { __error: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { ok?: boolean; result?: T; error?: unknown };
  return body.ok === true ? (body.result as T) : { __error: body.error };
}

interface ChatResult {
  sessionId: string;
  status: string;
}

interface NotificationRow {
  id: string;
  at: number;
  level: string;
  kind: string;
  title: string;
  text: string;
  source?: string;
  sessionId?: string;
}

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "aw-notify-"));
  const unitRoot = path.join(tmp, "unit");
  mkdirSync(path.join(unitRoot, ".agent-workbench"), { recursive: true });

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. 一轮对话 → end:{sid} 行
    const r1 = (await rpc<ChatResult>(port, "session.chat", {
      unitId: "u-notify-smoke",
      unitName: "Notify Smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "第一轮",
      waitMs: 30_000,
    })) as ChatResult;
    const rows1 = ((await rpc<{ items: NotificationRow[] }>(port, "notifications.list", null)) as { items: NotificationRow[] }).items;
    const endRow = rows1.find((r) => r.id === `end:${r1.sessionId}`);
    check(
      "session end recorded with source=cli",
      endRow !== undefined && endRow.kind === "session" && endRow.source === "cli" && endRow.level === "ok",
      { rows1, sessionId: r1.sessionId },
    );
    check(
      "rows carry no read field (read is client-side presentation)",
      endRow !== undefined && !("read" in endRow),
      endRow,
    );

    // 2. 第二轮（新会话）→ 各自一行，自然键不堆叠
    const r2 = (await rpc<ChatResult>(port, "session.chat", {
      unitId: "u-notify-smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "第二轮",
      waitMs: 30_000,
    })) as ChatResult;
    const rows2 = ((await rpc<{ items: NotificationRow[] }>(port, "notifications.list", null)) as { items: NotificationRow[] }).items;
    check(
      "second session gets its own row (no stacking)",
      rows2.some((r) => r.id === `end:${r2.sessionId}`) && rows2.filter((r) => r.kind === "session").length === rows2.filter((r) => r.id.startsWith("end:")).length,
      rows2.map((r) => r.id),
    );

    // 3. git.changed 聚合：挂监听（git.status）→ 改文件 → git:{root} 行
    const repoRoot = path.join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const { spawnSync } = await import("node:child_process");
    const gitInit = spawnSync("git", ["init", "-q", "--initial-branch=main", repoRoot], { encoding: "utf8" });
    if (gitInit.status !== 0) {
      check("git init fixture (git 不可用则跳过 git 断言)", false, gitInit.stderr);
    } else {
      writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
      spawnSync("git", ["-C", repoRoot, "add", "a.txt"], { encoding: "utf8" });
      await rpc(port, "git.status", { rootPath: repoRoot }); // isRepo → 挂文件监听
      await sleep(1500); // 监听句柄异步挂载的安顿期：写入要落在挂载之后
      appendFileSync(path.join(repoRoot, "a.txt"), "two\n"); // 前沿即发（docs/16）
      await sleep(4000);
      const rows3 = ((await rpc<{ items: NotificationRow[] }>(port, "notifications.list", null)) as { items: NotificationRow[] }).items;
      const gitRow = rows3.find((r) => r.id === `git:${repoRoot}`);
      check("git.changed aggregated as git:{root} row", gitRow !== undefined && gitRow.kind === "git" && gitRow.text === "repo", rows3.map((r) => r.id));
    }
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
