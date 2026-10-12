/**
 * Phase 5b 验收 —— 自动化 v2（scheduleRule 权威调度 / 一次性 / misfire / 持久化 / 失败徽章）。
 *
 *   scheduleRule 创建 → next_run_at 落库 + cron 兼容表达式派生
 *   → daemon 重启 → next_run_at / rule 原样保留（backfill 不重算错）
 *   → update 改规则 → next_run_at 重算
 *   → 「N 分钟后」一次性 → 到点发火一次 → 自动停用（终态），不再第二发
 *   → 锚点在过去的规则 → misfire 记 skipped 不补跑
 *   → runNow 未知执行器 → 运行记录 failed + 自动化挂失败徽章
 *   → 手动 runNow 不消耗 run_count
 *
 * 用法：cd backend && pnpm smoke:phase5b
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
    const timer = setTimeout(() => {
      d.kill("SIGKILL");
      resolve(null);
    }, 8000);
    d.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    d.kill("SIGTERM");
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

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

interface AutoRow {
  id: number;
  name: string;
  cron: string;
  scheduleRule: { frequency: string; hour?: number; minute?: number; interval?: number; unit?: string; anchorAt?: number } | null;
  recurring: boolean;
  maxRuns: number | null;
  runCount: number;
  enabled: boolean;
  nextRunAt: number | null;
  lastError: string | null;
  runs: Array<{ id: number; status: string; trigger: string; detail: string | null }>;
}

async function listOne(id: number): Promise<AutoRow> {
  const list = await call<AutoRow[]>("automation.list", null);
  const hit = list.find((a) => a.id === id);
  if (hit === undefined) throw new Error(`automation ${id} vanished`);
  return hit;
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke5b-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 1. scheduleRule 创建：next_run_at 落库 + cron 兼容表达式派生
    const daily = await call<{ id: number; nextRunAt: number | null }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "每天九点",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "规则冒烟",
      scheduleRule: { frequency: "daily", hour: 9, minute: 0, weekdays: [], dayOfMonth: 1 },
      launchMode: "headless",
    });
    const dailyRow = await listOne(daily.id);
    check("rule persisted", dailyRow.scheduleRule?.frequency === "daily" && dailyRow.scheduleRule?.hour === 9, dailyRow.scheduleRule);
    check("cron derived for display", dailyRow.cron === "0 9 * * *", dailyRow.cron);
    check("next_run_at computed and future", dailyRow.nextRunAt !== null && dailyRow.nextRunAt! > Date.now(), dailyRow.nextRunAt);

    // 2. 重启持久化：next_run_at / rule 原样保留
    const beforeRestart = dailyRow.nextRunAt;
    await call("daemon.stop", null, 15000);
    await stopDaemon();
    await sleep(500);
    startDaemon(port, home);
    check("daemon healthy after restart", await waitHealthy(port));
    await connect(port);
    const afterRestart = await listOne(daily.id);
    check("next_run_at survives restart", afterRestart.nextRunAt === beforeRestart, { beforeRestart, afterRestart: afterRestart.nextRunAt });
    check("rule survives restart", afterRestart.scheduleRule?.frequency === "daily", afterRestart.scheduleRule);

    // 3. update 改规则 → next_run_at 重算（anchorAt 缺省 = 现在重新锚定）
    const upd = await call<{ automation: AutoRow }>("automation.update", {
      id: daily.id,
      scheduleRule: { frequency: "hourly", hour: 0, minute: 15, weekdays: [], dayOfMonth: 1 },
    });
    check("update rewrites cron", upd.automation?.cron === "15 * * * *", upd.automation?.cron);
    check("update recomputes next_run_at", upd.automation?.nextRunAt !== null && upd.automation!.nextRunAt! > Date.now(), upd.automation?.nextRunAt);

    // 4. 「N 分钟后」一次性：到点发火一次 → 自动停用，不再第二发
    const oneShot = await call<{ id: number }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "两分钟后",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "一次性冒烟",
      delayMinutes: 2,
      launchMode: "headless",
    });
    const shotRow0 = await listOne(oneShot.id);
    check("one-shot defaults recurring=false maxRuns=1", shotRow0.recurring === false && shotRow0.maxRuns === 1, shotRow0);
    console.log("         waiting up to 150s for the one-shot to fire...");
    const fireDeadline = Date.now() + 150_000;
    let fired = false;
    while (Date.now() < fireDeadline) {
      const r = await listOne(oneShot.id);
      if (r.runCount >= 1) { fired = true; break; }
      await sleep(2000);
    }
    check("one-shot fired within 150s", fired);
    const shotRow = await listOne(oneShot.id);
    check("one-shot auto-disabled after fire", shotRow.enabled === false && shotRow.nextRunAt === null, shotRow);
    // 触发 ≠ 落定：run 行在派发瞬间就是 running，终态要等会话结束回灌。
    // 立刻断言会在 mockperm 慢半拍时假失败 —— 给它一个轮询窗口。
    const settleDeadline = Date.now() + 20_000;
    let settled = false;
    while (Date.now() < settleDeadline) {
      const r = await listOne(oneShot.id);
      if (r.runs.some((x) => x.status === "done" || x.status === "failed")) { settled = true; break; }
      await sleep(500);
    }
    check("one-shot run recorded", settled, (await listOne(oneShot.id)).runs);
    await sleep(25_000);
    const shotRow2 = await listOne(oneShot.id);
    check("one-shot does not fire twice", shotRow2.runCount === 1, shotRow2.runCount);

    // 5. misfire：持久化的 next_run_at 停滞超过宽限（= 停机/休眠错过）→ 记 skipped 不补跑。
    //    引擎在创建时永远排出未来时刻，所以真实 misfire 只能来自停机 —— 这里直接改库
    //    把 next_run_at 拨到 10 分钟前（> 5min 宽限），等一个 tick 看记账。
    const mis = await call<{ id: number }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "错过的窗口",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "misfire 冒烟",
      scheduleRule: { frequency: "daily", hour: 23, minute: 50, weekdays: [], dayOfMonth: 1 },
      launchMode: "headless",
    });
    const rawDb = new DatabaseSync(path.join(home, "state.db"));
    for (let i = 0; i < 5; i++) {
      try {
        rawDb.prepare(`UPDATE automations SET next_run_at = ? WHERE id = ?`).run(Date.now() - 10 * 60_000, mis.id);
        break;
      } catch (e: unknown) {
        if (i === 4) throw e;
        await sleep(300); // WAL 下与 daemon 偶发撞锁，重试即可
      }
    }
    rawDb.close();
    const misDeadline = Date.now() + 30_000;
    let skipped = false;
    let misRow: AutoRow | null = null;
    while (Date.now() < misDeadline) {
      misRow = await listOne(mis.id);
      if (misRow.runs.some((r) => r.status === "skipped")) { skipped = true; break; }
      await sleep(2000);
    }
    check("missed window recorded as skipped", skipped, misRow?.runs);
    check("misfire does not run a session", misRow?.runs.every((r) => r.status === "skipped") ?? false, misRow?.runs);
    check("misfire keeps automation enabled and rescheduled", misRow?.enabled === true && (misRow?.nextRunAt ?? 0) > Date.now(), misRow);

    // 6. 失败徽章：runNow 打到未知执行器 → 运行记录 failed + 自动化挂徽章
    const doomed = await call<{ id: number }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "坏执行器",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "失败徽章冒烟",
      cron: "0 0 1 1 *",
      launchMode: "headless",
    });
    await call("automation.update", { id: doomed.id, runtimeId: "no-such-runtime" });
    let runNowFailed = false;
    await call("automation.runNow", { id: doomed.id }).catch(() => {
      runNowFailed = true;
    });
    check("runNow with unknown runtime rejects", runNowFailed);
    const doomedRow = await listOne(doomed.id);
    check("failure badge set on automation", doomedRow.lastError !== null && doomedRow.lastError !== "", doomedRow.lastError);
    check("failed run recorded", doomedRow.runs.some((r) => r.status === "failed"), doomedRow.runs);

    // 7. 手动 runNow 不消耗 run_count（那是 scheduled 跑的账）
    const countBefore = (await listOne(doomed.id)).runCount;
    await call("automation.update", { id: doomed.id, runtimeId: "mockperm" });
    // 直接把失败徽章清掉再成功跑一次：徽章应被新的成功发火清除
    await call("automation.runNow", { id: doomed.id });
    const doomedRow2 = await listOne(doomed.id);
    check("manual runNow does not consume run_count", doomedRow2.runCount === countBefore, { countBefore, after: doomedRow2.runCount });
    check("successful manual run clears badge", doomedRow2.lastError === null, doomedRow2.lastError);

    // 8. 只传 delayMinutes 的更新必须把 recurring 一起收口成一次性 ——
    //    否则「只改提示词」的一次性任务保存完就悄悄变成永久循环
    const conv = await call<{ id: number }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "循环转一次性",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "转换冒烟",
      scheduleRule: { frequency: "daily", hour: 9, minute: 0, weekdays: [], dayOfMonth: 1 },
      launchMode: "headless",
    });
    const convUpd = await call<{ automation: AutoRow }>("automation.update", { id: conv.id, delayMinutes: 5 });
    check(
      "delayMinutes-only update forces one-shot",
      convUpd.automation?.recurring === false && convUpd.automation?.maxRuns === 1,
      { recurring: convUpd.automation?.recurring, maxRuns: convUpd.automation?.maxRuns },
    );

    // 9. 推不出任何未来的 cron 在 update 时也要拒（create 同拒）——
    //    否则写下去就是 enabled + next_run_at=null 的无声卡死行
    let impossibleRejected = false;
    await call("automation.update", { id: conv.id, cron: "0 0 31 2 *" }).catch(() => {
      impossibleRejected = true; // 2 月没有 31 日，永远不触发
    });
    check("impossible cron rejected at update", impossibleRejected);

    // 10. 每条 list 都带 runs（卡片渲染依赖）
    check("list includes runs", doomedRow2.runs.length > 0);

    // 11. 重启自愈：session→run 的回灌映射在内存里，重启即丢 —— 上个周期遗留的
    //     running 记录要按会话台账收口（已结束→终态；无会话→failed），卡片不再假「运行中」
    const healAuto = await call<{ id: number }>("automation.create", {
      unitId: "u5b",
      unitName: "v2 冒烟",
      name: "自愈冒烟",
      runtimeId: "mockperm",
      rootPath: home,
      prompt: "heal 冒烟",
      cron: "0 0 1 1 *",
      launchMode: "headless",
    });
    const healDb = new DatabaseSync(path.join(home, "state.db"));
    const endedSession = "sess-heal-ended";
    healDb
      .prepare(
        `INSERT INTO sessions (id, unit_id, runtime_id, title, status, started_at, ended_at, stats_json)
         VALUES (?, 'u5b', 'mockperm', 'heal', 'done', ?, ?, '{}')`,
      )
      .run(endedSession, Date.now() - 60_000, Date.now() - 30_000);
    healDb
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at)
                VALUES (?, ?, 'running', 'schedule', ?)`)
      .run(healAuto.id, endedSession, Date.now() - 60_000);
    healDb
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at)
                VALUES (?, NULL, 'running', 'schedule', ?)`)
      .run(healAuto.id, Date.now() - 30_000);
    healDb.close();

    await call("daemon.stop", null, 15000);
    await stopDaemon();
    await sleep(500);
    startDaemon(port, home);
    check("daemon healthy after restart #2", await waitHealthy(port));
    await connect(port);
    const healed = await call<Array<{ status: string; sessionId: string | null; detail: string | null }>>("automation.runs", {
      id: healAuto.id,
    });
    check(
      "heal settles run attached to ended session",
      healed.some((r) => r.sessionId === endedSession && r.status === "done"),
      healed,
    );
    check(
      "heal settles run without session as failed",
      healed.some((r) => r.sessionId === null && r.status === "failed"),
      healed,
    );

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const exitDeadline = Date.now() + 10000;
    while (Date.now() < exitDeadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { exitCode = c; break; }
      await sleep(150);
    }
    check("daemon exits 0", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase5b: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase5b: all checks passed — 规则调度 / 一次性终态 / misfire / 持久化 / 失败徽章成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase5b: crashed", err);
  void stopDaemon();
  process.exit(1);
});
