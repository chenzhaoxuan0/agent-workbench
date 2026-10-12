/**
 * 临时验收 —— 自动化 TUI 模式（launchMode=terminal）派发链路。
 *
 *   terminal 模式 runNow → daemon 建 autoterm_ 终端（autoExit + yolo 档案）
 *   → created 帧广播 → 运行记录 running 且挂上 terminalId
 *   → 假执行器（git，打印用法即退）退出 → exit 帧回灌 → 运行记录落终态
 *   → daemon 重启自愈：autoterm_ 前缀的 running 记录按「终端已随进程关闭」收口
 *
 * 用 git 当假执行器：不走任何真 TUI，秒退 + 非零码，正好验证 exit 结算。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("no free port"));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

let daemon: ChildProcess | undefined;

function startDaemon(port: number, home: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return Promise.resolve(daemon?.exitCode ?? null);
  return new Promise((resolve) => {
    const d = daemon!;
    // daemon.stop 已发：优先等自然退出（含 ConPTY 排空，最长 ~8s）。
    // 立即 SIGTERM 会硬杀正在收尾句柄的进程（libuv 断言 / code null）。
    const kill = setTimeout(() => {
      d.kill("SIGKILL");
      resolve(null);
    }, 15000);
    d.once("exit", (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });
}

async function waitHealthy(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 等待 */ }
    await sleep(200);
  }
  return false;
}

let ws: WebSocket | null = null;
let wsId = 0;
const terminalFrames: Array<{ terminalId: string; kind: string; executor?: string; unitId?: string }> = [];

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["type"] === "terminal") {
        terminalFrames.push({
          terminalId: String(frame["terminalId"]),
          kind: String(frame["kind"]),
          executor: frame["executor"] === undefined ? undefined : String(frame["executor"]),
          unitId: frame["unitId"] === undefined ? undefined : String(frame["unitId"]),
        });
      }
    });
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
    const id = `smoke-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), "aw-autoterm-"));
console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
startDaemon(port, home);
check("daemon healthy", await waitHealthy(port));
await connect(port);

try {
  // 1. terminal 模式创建（默认模式也可以由缺省证明：另建一条不传 launchMode）
  const created = await call<{ id: number; nextRunAt: number | null }>("automation.create", {
    unitId: "u-tui",
    unitName: "TUI 冒烟",
    name: "终端派发",
    runtimeId: "git",
    rootPath: home,
    prompt: "echo hi",
    cron: "0 0 1 1 *",
    launchMode: "terminal",
  });
  const listed = await call<Array<{ launchMode?: string }>>("automation.list", null);
  check("launchMode persisted as terminal", listed.some((a) => (a as { id?: number }).id === created.id && a.launchMode === "terminal"), listed.map((a) => a.launchMode));

  const defaulted = await call<{ id: number }>("automation.create", {
    unitId: "u-tui",
    runtimeId: "git",
    rootPath: home,
    prompt: "默认模式",
    cron: "0 0 1 1 *",
  });
  const listed2 = await call<Array<{ id?: number; launchMode?: string }>>("automation.list", null);
  check("launchMode defaults to terminal when omitted", listed2.find((a) => a.id === defaulted.id)?.launchMode === "terminal", listed2.find((a) => a.id === defaulted.id));

  // 2. runNow → terminal 派发：sessionId 是 autoterm_ 前缀，created 帧已广播
  const now = await call<{ runId: number; sessionId: string }>("automation.runNow", { id: created.id });
  check("runNow launches autoterm terminal", now.sessionId.startsWith("autoterm_"), now);
  await sleep(1500);
  const createdFrame = terminalFrames.find((f) => f.terminalId === now.sessionId && f.kind === "created");
  check("created frame broadcast with unitId", createdFrame !== undefined && createdFrame.unitId === "u-tui", createdFrame);

  const terms = await call<Array<{ terminalId: string; executor: string; unitId?: string }>>("terminal.list", null);
  const mine = terms.find((t) => t.terminalId === now.sessionId);
  check("terminal registered with executor+unitId", mine !== undefined && mine.executor === "git:yolo" && mine.unitId === "u-tui", mine);

  // 3. 假执行器（git 无参）退出 → exit 帧 → 运行记录终态
  const deadline = Date.now() + 15000;
  let runRow: { status?: string; detail?: string | null } | undefined;
  while (Date.now() < deadline) {
    const runs = await call<Array<{ id?: number; status?: string; detail?: string | null }>>("automation.runs", { id: created.id });
    runRow = runs.find((r) => r.id === now.runId);
    if (runRow !== undefined && runRow.status !== "running") break;
    await sleep(300);
  }
  check("run settled after executor exit (non-zero → failed)", runRow?.status === "failed" && String(runRow?.detail ?? "").includes("terminal exit"), runRow);
  check("exit frame observed", terminalFrames.some((f) => f.terminalId === now.sessionId && f.kind === "exit"), terminalFrames.filter((f) => f.terminalId === now.sessionId));

  // 3b. 待办 TUI 派发：launchMode=terminal（缺省）的待办 runNow → autoterm_ 终端，
  //     exit 帧回灌运行记录 + 状态机收口（failed → 回就绪挂 lastError）
  const bl = await call<{ item: { id: number; launchMode?: string } }>("backlog.create", {
    goal: "冒烟：待办 TUI 派发",
    unitId: "u-tui",
    unitName: "TUI 冒烟",
    rootPath: home,
    runtimeId: "git",
    prompt: "echo backlog",
  });
  check("backlog launchMode defaults to terminal", bl.item.launchMode === "terminal", bl.item);
  const blRun = await call<{ runId: number; sessionId: string }>("backlog.runNow", { id: bl.item.id });
  check("backlog runNow launches autoterm terminal", blRun.sessionId.startsWith("autoterm_"), blRun);
  const blDeadline = Date.now() + 15000;
  let blItem: { status?: string; lastError?: string | null } | undefined;
  while (Date.now() < blDeadline) {
    const list = await call<{ items: Array<{ id: number; status: string; lastError: string | null }> }>("backlog.list", null);
    blItem = list.items.find((i) => i.id === bl.item.id);
    if (blItem !== undefined && blItem.status !== "executing") break;
    await sleep(300);
  }
  check(
    "backlog item settles to ready with terminal exit error",
    blItem?.status === "ready" && String(blItem?.lastError ?? "").includes("terminal exit"),
    blItem,
  );

  // 3c. 单元历史：unit.history 合并自动化/待办/会话时间轴；session.messages
  //     对历史会话走 store 兜底（host 只认活会话）
  const hist = await call<{ entries: Array<{ key: string; kind: string; title: string; launchMode: string; status: string; startedAt: number; sessionId: string | null }> }>("unit.history", { unitId: "u-tui" });
  const autoEntry = hist.entries.find((e) => e.key === `automation-${now.runId}`);
  check(
    "unit.history lists terminal automation run (no sessionId)",
    autoEntry !== undefined && autoEntry.launchMode === "terminal" && autoEntry.sessionId === null && autoEntry.status === "failed",
    autoEntry,
  );
  const blEntry = hist.entries.find((e) => e.kind === "backlog" && e.title.includes("待办"));
  check("unit.history lists backlog run", blEntry !== undefined && blEntry.launchMode === "terminal", blEntry);
  check("unit.history sorted desc by time", hist.entries.every((e, i) => i === 0 || hist.entries[i - 1]!.startedAt >= e.startedAt), hist.entries.map((e) => e.key));

  const { DatabaseSync: DB } = await import("node:sqlite");
  const histDb = new DB(path.join(home, "state.db"));
  histDb.prepare(
    `INSERT INTO sessions (id, unit_id, runtime_id, title, status, started_at, ended_at, stats_json)
     VALUES ('sess-hist-fake', 'u-tui', 'git', '历史会话兜底', 'done', ?, ?, '{}')`,
  ).run(Date.now() - 120_000, Date.now() - 60_000);
  histDb.prepare(`INSERT INTO messages (session_id, at, role, text) VALUES ('sess-hist-fake', ?, 'user', '历史提问')`).run(Date.now() - 120_000);
  histDb.prepare(`INSERT INTO messages (session_id, at, role, text) VALUES ('sess-hist-fake', ?, 'assistant', '历史回答')`).run(Date.now() - 60_000);
  histDb.close();
  const msgs = await call<Array<{ role: string; text: string }>>("session.messages", { sessionId: "sess-hist-fake" });
  check("session.messages falls back to store for history", msgs.length === 2 && msgs[0]?.text === "历史提问" && msgs[1]?.text === "历史回答", msgs);
  const hist2 = await call<{ entries: Array<{ key: string; kind: string; sessionId: string | null }> }>("unit.history", { unitId: "u-tui" });
  const sessEntry = hist2.entries.find((e) => e.key === "session-sess-hist-fake");
  check("unclaimed session appears as session entry with sessionId", sessEntry !== undefined && sessEntry.sessionId === "sess-hist-fake", sessEntry);

  // 4. 重启自愈：塞一条挂 autoterm_ 的 running 记录 → 重启后按终端关闭收口
  //    （真实场景是 daemon 重启杀掉 PTY；这里直接造行验证 heal 分支）
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.prepare(
    `INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at)
     VALUES (?, 'autoterm_faked', 'running', 'schedule', ?)`,
  ).run(defaulted.id, Date.now() - 60_000);
  db.prepare(
    `INSERT INTO backlog_runs (item_id, session_id, runtime_id, status, trigger, started_at)
     VALUES (?, 'autoterm_faked_bl', 'git', 'running', 'gtd', ?)`,
  ).run(bl.item.id, Date.now() - 60_000);
  // heal 只收口 executing 状态的条目 —— 伪造行时把状态一并摆成执行中
  db.prepare(`UPDATE backlog_items SET status = 'executing' WHERE id = ?`).run(bl.item.id);
  db.close();

  await call("daemon.stop", null, 15000).catch(() => {});
  const code1 = await stopDaemon();
  check("daemon exits 0 after pty churn (ConPTY drain)", code1 === 0, code1);
  await sleep(500);
  startDaemon(port, home);
  check("daemon healthy after restart", await waitHealthy(port));
  await connect(port);
  const healed = await call<Array<{ sessionId?: string | null; status?: string; detail?: string | null }>>("automation.runs", { id: defaulted.id });
  const h = healed.find((r) => r.sessionId === "autoterm_faked");
  check("autoterm running row healed as failed on restart", h?.status === "failed" && String(h?.detail ?? "").includes("终端已随进程关闭"), h);
  const blHealed = await call<{ items: Array<{ id: number; status: string; lastError: string | null }> }>("backlog.list", null);
  const blH = blHealed.items.find((i) => i.id === bl.item.id);
  check(
    "backlog autoterm run healed on restart (item back to ready)",
    blH?.status === "ready" && String(blH?.lastError ?? "").includes("终端已随进程关闭"),
    blH,
  );

  await call("daemon.stop", null, 15000).catch(() => {});
  const code = await stopDaemon();
  check("daemon exits 0", code === 0, code);
} catch (err) {
  console.error("smoke crashed:", err);
  failures += 1;
  await stopDaemon();
}

if (failures > 0) {
  console.error(`smoke-autoterm: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("smoke-autoterm: all checks passed — terminal 模式派发 / created 帧 / exit 结算 / 重启自愈成立");
