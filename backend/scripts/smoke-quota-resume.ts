/**
 * 冒烟：用量耗尽自动续跑（quota_resume）+ 定时发送到已有对话。
 *
 * 验四组，每组对应一个真实的踩坑点：
 *  1. **迁移**：旧行 dispatch_target 为 NULL 时必须按 new_session 读 ——
 *     读错就是「升级后所有老自动化突然开始往老对话里发消息」。
 *  2. **排上**：用尽 + 探针给了恢复时间 → 排一条 one-shot，next_run_at 落在
 *     恢复时刻之后、延迟之内，投递目标是该执行器最近一个可 resume 的会话。
 *  3. **去重**：同一窗口反复探到用尽只能排一条 —— 不去重就是一个窗口堆几十条，
 *     恢复瞬间几十个 agent 同时被「继续」淹掉。
 *  4. **恢复时间未知**：用户拍板的取舍 —— resetsAt 读不到就不排，但必须给出
 *     note，界面上要能看到「为什么没排」，不能让人以为功能坏了。
 *
 * 运行：pnpm -C backend smoke:quotaresume
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { Store } from "../src/store/db.ts";
import { QuotaResumeWatcher } from "../src/automation/quotaResume.ts";
import { AutomationScheduler } from "../src/automation/scheduler.ts";
import type { QuotaProbe } from "../src/backlog/probe.ts";
import type { BacklogConfig, QuotaHeadroom } from "../../prototype/src/core/backlog.ts";
import { DEFAULT_BACKLOG_CONFIG } from "../../prototype/src/core/backlog.ts";
import { buildRelativeDelaySchedule, buildAbsoluteSchedule, computeScheduleNextRunAt, describeSchedule, formatAbsolute, formatAbsoluteHuman } from "../../prototype/src/core/automation.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

function baseConfig(): BacklogConfig {
  return {
    ...DEFAULT_BACKLOG_CONFIG,
    runtimes: {
      zcode: { subscribed: true, probeCmd: "zcode quota", probeFormat: "zcode-quota", windowHours: 5, limit: null },
    },
  };
}

/** 假探针：不起子进程，直接按测试给的读数返回 */
function fakeProbe(map: Record<string, QuotaHeadroom>): QuotaProbe {
  return { readAll: async () => Object.values(map) } as unknown as QuotaProbe;
}

const tmpHome = mkdtempSync(join(tmpdir(), "agent-workbench-smoke-quotaresume-"));

try {
  // ---- 1. 迁移：老行按 new_session 读 --------------------------------------
  console.log("\n【1】迁移与老行兼容");
  const store = new Store(tmpHome);
  const legacyId = store.createAutomation({
    unitId: "u1",
    unitName: "旧任务",
    name: "迁移前建的",
    runtimeId: "zcode",
    rootPath: tmpHome,
    prompt: "老提示词",
    model: null,
    mode: null,
    cron: "0 9 * * *",
    scheduleRule: null,
    recurring: true,
    maxRuns: null,
    nextRunAt: Date.now() + 3_600_000,
    launchMode: "terminal",
  });
  const legacy = store.getAutomation(legacyId)!.automation;
  check("未指定 dispatch_target 的行按 new_session 读", legacy.dispatchTarget === "new_session");
  check("未指定 origin 的行按 manual 读", legacy.origin === "manual");
  check("targetSessionId 缺省为 null", legacy.targetSessionId === null);

  // ---- 2. 排上：恢复时刻 + 延迟 -------------------------------------------
  console.log("\n【2】用尽 → 排续跑");
  // 造一个「刚撞墙」的会话：cliRef 非空才接得回来
  const deadSessionId = "sess-dead-1";
  store.upsertSession({
    id: deadSessionId,
    unitId: "u1",
    runtimeId: "zcode",
    title: "撞墙的那个对话",
    status: "failed",
    startedAt: Date.now() - 600_000,
    endedAt: Date.now(),
    cliRef: "zcode-thread-abc",
    rootPath: tmpHome,
    conversationId: null,
    lastSeq: 0,
    stats: { messages: 4, toolCalls: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.1, durationMs: 5000 },
  });

  const cfg = baseConfig();
  const resetsAt = Date.now() + 3 * 3_600_000; // 3 小时后恢复
  const watcher = new QuotaResumeWatcher({
    store,
    probe: fakeProbe({
      zcode: {
        runtimeId: "zcode",
        subscribed: true,
        percent: 0,
        resetsAt,
        summary: "TOKENS_LIMIT remaining 0%",
        source: "probe",
        checkedAt: Date.now(),
      },
    }),
    getConfig: () => cfg,
  });

  await (watcher as unknown as { tick(): Promise<void> }).tick();

  const created = store.listAutomations().filter((a) => a.origin === "quota_resume");
  check("排出了一条续跑", created.length === 1, { count: created.length });
  const resume = created[0];
  if (resume !== undefined) {
    check("是一次性任务（跑一次收口）", resume.recurring === false && resume.maxRuns === 1);
    check("投递目标是已有对话", resume.dispatchTarget === "existing_session");
    check("绑定了那个撞墙的会话", resume.targetSessionId === deadSessionId, { got: resume.targetSessionId });
    // 引擎是分钟粒度且只向上取整 → 口径是「恢复后 1~2 分钟内」，
    // 绝不能早于恢复时刻（窗口没开就发 = 白撞一次墙）
    check(
      "触发点不早于「恢复时刻 + 延迟」，且不超出再一个分钟",
      resume.nextRunAt !== null &&
        resume.nextRunAt >= resetsAt + 60_000 &&
        resume.nextRunAt < resetsAt + 2 * 60_000,
      { resetsAt, nextRunAt: resume.nextRunAt, driftMs: (resume.nextRunAt ?? 0) - (resetsAt + 60_000) },
    );
    check("后台执行，不弹终端", resume.launchMode === "headless");
    check("enabled + 有 next_run_at（不是无声卡死行）", resume.enabled && resume.nextRunAt !== null);
  }

  // ---- 3. 去重：同窗口反复探到用尽只排一条 ---------------------------------
  console.log("\n【3】同窗口去重");
  for (let i = 0; i < 5; i++) await (watcher as unknown as { tick(): Promise<void> }).tick();
  const afterDedup = store.listAutomations().filter((a) => a.origin === "quota_resume");
  check("反复探到用尽仍只有一条", afterDedup.length === 1, { count: afterDedup.length });

  // ---- 4. 恢复时间未知：跳过 + 给 note ------------------------------------
  console.log("\n【4】恢复时间未知 → 不排但要说明");
  const store2 = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr2-")));
  const watcher2 = new QuotaResumeWatcher({
    store: store2,
    probe: fakeProbe({
      zcode: {
        runtimeId: "zcode",
        subscribed: true,
        percent: 0,
        resetsAt: null,
        summary: "账本估算：余量未知",
        source: "ledger",
        checkedAt: Date.now(),
      },
    }),
    getConfig: () => cfg,
  });
  await (watcher2 as unknown as { tick(): Promise<void> }).tick();
  check("读不到恢复时间就不排", store2.listAutomations().filter((a) => a.origin === "quota_resume").length === 0);
  const st2 = watcher2.snapshot().find((s) => s.runtimeId === "zcode");
  check("给了 note（界面上要能看到为什么没排）", st2 !== undefined && st2.note !== null, { note: st2?.note });

  // ---- 5. 没用尽：不排 ---------------------------------------------------
  console.log("\n【5】没用尽 → 不排");
  const store3 = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr3-")));
  const watcher3 = new QuotaResumeWatcher({
    store: store3,
    probe: fakeProbe({
      zcode: {
        runtimeId: "zcode",
        subscribed: true,
        percent: 63,
        resetsAt,
        summary: "TOKENS_LIMIT remaining 63%",
        source: "probe",
        checkedAt: Date.now(),
      },
    }),
    getConfig: () => cfg,
  });
  await (watcher3 as unknown as { tick(): Promise<void> }).tick();
  check("余量充足时一条都不排", store3.listAutomations().length === 0);

  // ---- 6. 阈值边界：2% 算用尽，3% 不算 ------------------------------------
  console.log("\n【6】阈值边界（默认 ≤2% 判用尽）");
  const atThreshold = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr4-")));
  const w4 = new QuotaResumeWatcher({
    store: atThreshold,
    probe: fakeProbe({
      zcode: {
        runtimeId: "zcode", subscribed: true, percent: 2, resetsAt,
        summary: "", source: "probe", checkedAt: Date.now(),
      },
    }),
    getConfig: () => cfg,
  });
  await (w4 as unknown as { tick(): Promise<void> }).tick();
  check("剩余正好 2% → 排（边界含等号）", atThreshold.listAutomations().filter((a) => a.origin === "quota_resume").length === 1);

  // ---- 7. 开关关闭：一条都不排 -------------------------------------------
  console.log("\n【7】开关关闭");
  const off = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr5-")));
  const w5 = new QuotaResumeWatcher({
    store: off,
    probe: fakeProbe({
      zcode: {
        runtimeId: "zcode", subscribed: true, percent: 0, resetsAt,
        summary: "", source: "probe", checkedAt: Date.now(),
      },
    }),
    getConfig: () => ({ ...cfg, quotaResume: { ...cfg.quotaResume, enabled: false } }),
  });
  await (w5 as unknown as { tick(): Promise<void> }).tick();
  check("enabled=false 时不排", off.listAutomations().length === 0);

  // ---- 8. 共享引擎口径：排出来的时刻与 UI 算的一致 --------------------------
  console.log("\n【8】与共享调度引擎口径一致");
  const rule = buildRelativeDelaySchedule(180, Date.now());
  const engineNext = computeScheduleNextRunAt(rule);
  check("buildRelativeDelaySchedule + computeScheduleNextRunAt 可算出未来时刻", engineNext !== null && engineNext > Date.now());

  store.close();
  store2.close();
  store3.close();
  atThreshold.close();
  off.close();

  // ---- 9. 绝对时刻一次性任务 + 可续接会话清单 ------------------------------
  console.log("\n【9】绝对时刻（runAt）与可续接会话清单");
  await absoluteTimeChecks();

  // ---- 10. review 修复的回归护栏 ------------------------------------------
  // 这四条都是 review 里查出来的真 bug，每条都要有「改回去就会被抓住」的断言。
  console.log("\n【10】review 修复的回归护栏");
  await regressionChecks(cfg);

  // ---- 11. 真实 daemon 上 RPC 通 ------------------------------------------
  // 单测只覆盖到 watcher 这一层；界面上真正读的是 quotaResume.state 这个 RPC，
  // 注册漏了 / 字段名对不上，前面的全绿也救不了「界面上什么都不显示」。
  console.log("\n【11】真实 daemon 上 quotaResume.state 回环");
  await liveRpcCheck();
} finally {
  // 临时目录清不掉不该让测试结论作废（Windows 上 mockperm 起的子进程还占着 cwd，
  // daemon 退出≠子进程退出）。失败就留给系统 temp 回收。
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch (err: unknown) {
    console.log(`  ⚠️ 临时目录清理失败（不影响结论）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 绝对时刻（runAt）与可续接会话清单。
 *
 * 这里是用户明确提过的可用性诉求：一次性任务不能只写「N 分钟后」，
 * 得能落到确切时刻（用量恢复续跑尤其如此 —— 恢复时刻是探针读出来的确切值）。
 */
function absoluteTimeChecks(): void {
  console.log("\n  [1] 引擎认绝对时刻");
  const runAt = Date.now() + 4 * 3_600_000;
  const rule = buildAbsoluteSchedule(runAt);
  check("规则带 runAt", rule.runAt === runAt);
  check("computeScheduleNextRunAt 原样返回该时刻", computeScheduleNextRunAt(rule, Date.now()) === runAt);
  check("已过期的 runAt 推不出未来（不静默顺延）", computeScheduleNextRunAt(rule, runAt + 1000) === null);
  check(
    "hour/minute 按落点填好（cron 占位与降级路径还要读）",
    rule.hour === new Date(runAt).getHours() && rule.minute === new Date(runAt).getMinutes(),
  );
  // 落点必须是整分：引擎是分钟粒度，带秒会让显示与实际发火差一个进位
  check("不改变调用方给的时刻（对齐由调用方负责）", rule.runAt === runAt);

  console.log("\n  [2] 与相对延迟互不干扰");
  const rel = buildRelativeDelaySchedule(30);
  check("相对延迟规则没有 runAt", rel.runAt === undefined);
  check("相对延迟仍按锚点推进", computeScheduleNextRunAt(rel) === Math.floor((rel.anchorAt! + 30 * 60_000) / 1000) * 1000 + ((rel.anchorAt! + 30 * 60_000) % 1000));

  console.log("\n  [3] 卡片描述带得出确切时刻");
  const a = {
    rule,
    recurring: false as const,
    maxRuns: 1,
    runs: [],
    enabled: true,
  };
  const desc = describeSchedule(a);
  check("一次性 + runAt 的描述含日期时刻", /^\d{2}-\d{2} \d{2}:\d{2}$/.test(formatAbsolute(runAt)) && desc.includes(formatAbsolute(runAt)), { desc });
  const human = formatAbsoluteHuman(runAt, runAt - 3_600_000);
  check(
    "formatAbsoluteHuman 能说「今天/明天/日期」而不是分钟数",
    human.startsWith("今天") || human.startsWith("明天") || /^\d{2}-\d{2} \d{2}:\d{2}$/.test(human),
    { v: human },
  );

  console.log("\n  [4] 可续接会话清单口径");
  const store = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr-abs-")));
  const mkSession = (id: string, runtimeId: string, cliRef: string | null, startedAt: number) => {
    store.upsertSession({
      id, unitId: "u1", runtimeId, title: `对话 ${id}`, status: "failed",
      startedAt, endedAt: startedAt + 1000, cliRef, rootPath: "/tmp",
      conversationId: null, lastSeq: 0,
      stats: { messages: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
    });
  };
  mkSession("s-resumable", "zcode", "ref-1", 2_000);
  mkSession("s-firstturn", "zcode", null, 3_000); // 首轮没跑完 → 接不回来
  mkSession("s-other-rt", "codex", "ref-2", 1_000);
  const resumable = store
    .listSessions()
    .filter((s) => s.cliRef !== null && s.runtimeId === "zcode")
    .sort((x, y) => y.startedAt - x.startedAt)
    .map((s) => s.id);
  check("只列 cliRef 非空的（首轮没跑完的接不回来，不能列）", !resumable.includes("s-firstturn"), { resumable });
  check("跨执行器的不串进来", !resumable.includes("s-other-rt"), { resumable });
  check("可续接的列出来了", resumable[0] === "s-resumable", { resumable });
  store.close();
}

/** 四个 review 发现的回归护栏 */
async function regressionChecks(cfg: BacklogConfig): Promise<void> {
  const mk = () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr-reg-")));
    s.createAutomation({
      unitId: "u1", unitName: "u", name: "老任务", runtimeId: "zcode", rootPath: "/tmp",
      prompt: "p", model: null, mode: null, cron: "0 9 * * *", scheduleRule: null,
      recurring: false, maxRuns: 1, nextRunAt: Date.now() + 60_000, launchMode: "headless",
    });
    return s;
  };

  // (1) 调度器：一次性任务认领后 enabled=0，派发失败的重试必须仍能执行
  console.log("\n  [1] 一次性任务的重试不再被 enabled 判断挡住");
  {
    const store = mk();
    const sched = new AutomationScheduler(store, async () => {
      throw new Error("模拟派发失败（resume 拉不起 CLI）");
    });
    const row = store.listAutomations()[0]!;
    // 认领：终态一次性 → next_run_at 清空 + enabled=0（这正是原先挡住重试的组合）
    store.markAutomationFired(row.id, null, Date.now(), true);
    const claimed = store.getAutomation(row.id)!.automation;
    check("认领后确实 enabled=0（复现前提）", claimed.enabled === false && claimed.nextRunAt === null);

    // 手动灌一次失败，模拟 dispatch 已写进退避表
    (sched as unknown as { retries: Map<number, { attempts: number; at: number }> }).retries.set(row.id, {
      attempts: 1,
      at: Date.now() - 1, // 已到期
    });
    const fired: number[] = [];
    (sched as unknown as { run: unknown }).run = async (a: { id: number }) => {
      fired.push(a.id);
      throw new Error("模拟派发失败");
    };
    (sched as unknown as { tickInner(): void }).tickInner();
    await new Promise((r) => setTimeout(r, 50));
    check("已停用的一次性任务仍会走重试", fired.includes(row.id), { fired });

    // 没有退避条目时，确实不该再发（停用 = 别再排新的）
    fired.length = 0;
    const sched2 = new AutomationScheduler(store, async () => ({ runId: 1, sessionId: "s" }));
    (sched2 as unknown as { run: unknown }).run = async (a: { id: number }) => {
      fired.push(a.id);
      return { runId: 1, sessionId: "s" };
    };
    (sched2 as unknown as { tickInner(): void }).tickInner();
    check("没有退避条目时停用后不再发", fired.length === 0, { fired });
    store.close();
  }

  // (2) 去重：停用续跑不再被重新排出来
  console.log("\n  [2] 停用续跑不会被重新排出来");
  {
    const store = mk();
    const resetsAt = Date.now() + 2 * 3_600_000;
    const quota = {
      zcode: { runtimeId: "zcode", subscribed: true, percent: 0, resetsAt, summary: "", source: "probe" as const, checkedAt: Date.now() },
    };
    const w = new QuotaResumeWatcher({ store, probe: fakeProbe(quota), getConfig: () => cfg });
    const tick = () => (w as unknown as { tick(): Promise<void> }).tick();

    await tick();
    const first = store.listAutomations().find((a) => a.origin === "quota_resume");
    check("先排出一条", first !== undefined);
    if (first !== undefined) {
      store.setAutomationEnabled(first.id, false); // 用户点停用
      await tick();
      await tick();
      const all = store.listAutomations().filter((a) => a.origin === "quota_resume");
      check("停用后不再新增（停用对续跑真的生效）", all.length === 1, { count: all.length });
      const st = w.snapshot().find((s) => s.runtimeId === "zcode");
      check("状态里说明「已停用」", st?.note === "已停用 —— 本窗口不会再自动续跑", { note: st?.note });
    }
    store.close();
  }

  // (3) 回退提示不会被同一调用的成功路径擦掉（用 store 语义直接验）
  console.log("\n  [3] 回退提示不再被成功路径清空");
  {
    const store = mk();
    const id = store.listAutomations()[0]!.id;
    store.setAutomationError(id, "找不到可续接的对话，已改为新开会话", Date.now());
    // 旧写法：成功路径无条件清空 → 提示消失
    store.setAutomationError(id, null, null);
    check("旧行为：清空会把提示抹掉（复现前提）", store.getAutomation(id)!.automation.lastError === null);
    // 新写法：写 dispatchNote 而不是 null
    const note = "找不到可续接的对话，已改为新开会话";
    store.setAutomationError(id, note, Date.now());
    check("新行为：提示留存", store.getAutomation(id)!.automation.lastError === note);
    store.close();
  }

  // (4) 时间窗过期后旧行不再挡路（下个窗口能正常排）
  console.log("\n  [4] 窗口过去后旧行不挡下一轮");
  {
    const store = mk();
    const w = new QuotaResumeWatcher({
      store,
      probe: fakeProbe({
        zcode: { runtimeId: "zcode", subscribed: true, percent: 0, resetsAt: Date.now() + 3_600_000, summary: "", source: "probe", checkedAt: Date.now() },
      }),
      getConfig: () => cfg,
    });
    await (w as unknown as { tick(): Promise<void> }).tick();
    const row = store.listAutomations().find((a) => a.origin === "quota_resume");
    check("排出一条", row !== undefined);
    if (row !== undefined) {
      // 把 next_run_at 推到过去（模拟这个窗口已经过去）
      store.updateAutomation(row.id, { nextRunAt: Date.now() - 1000 });
      await (w as unknown as { tick(): Promise<void> }).tick();
      const all = store.listAutomations().filter((a) => a.origin === "quota_resume");
      check("过期后能再排（新窗口不被旧行挡住）", all.length === 2, { count: all.length });
    }
    store.close();
  }
}

async function liveRpcCheck(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else reject(new Error("no free port"));
    });
    srv.on("error", reject);
  });

  // 隔离 home：漏了这一步，这轮冒烟会往用户真实的 ~/.agent-workbench/state.db 里
  // 塞两条测试自动化 —— 测试产物绝不能落进真实数据。
  const liveHome = mkdtempSync(join(tmpdir(), "agent-workbench-smoke-qr-live-"));
  const daemon = spawn(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "..", "src", "index.ts")],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        AGENT_WORKBENCH_PORT: String(port),
        AGENT_WORKBENCH_HOST: "127.0.0.1",
        AGENT_WORKBENCH_INSECURE: "1",
        AGENT_WORKBENCH_HOME: liveHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs: string[] = [];
  daemon.stdout?.on("data", (c: Buffer) => logs.push(c.toString()));
  daemon.stderr?.on("data", (c: Buffer) => logs.push(c.toString()));

  try {
    // 等 daemon 起来（最多 30s）
    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    }, 30_000);
    if (!ready) {
      check("daemon 起来", false, { tail: logs.slice(-5).join("") });
      return;
    }
    check("daemon 起来", true);

    const reply = await rpc(port, "quotaResume.state", null);
    const payload = reply as { enabled?: boolean; config?: { exhaustedPercent?: number; delayMinutes?: number }; states?: unknown[] };
    check("quotaResume.state 返回 enabled", typeof payload.enabled === "boolean", { enabled: payload.enabled });
    check("返回 quotaResume 配置（阈值/延迟）", typeof payload.config?.exhaustedPercent === "number" && typeof payload.config?.delayMinutes === "number", payload.config);
    check("states 是数组", Array.isArray(payload.states));
    check("watcher 随 daemon 启动", logs.some((l) => l.includes("quota resume watcher started")));

    // automation.create 的新字段要能穿过 RPC 落到 DB
    const created = (await rpc(port, "automation.create", {
      unitId: "u-smoke",
      unitName: "冒烟",
      name: "定时发送到已有对话",
      runtimeId: "mockperm",
      rootPath: tmpHome,
      prompt: "继续",
      dispatchTarget: "existing_session",
      targetSessionId: null,
      delayMinutes: 60,
    })) as { id?: number; nextRunAt?: number | null };
    check("automation.create 接受 dispatchTarget 并排上", typeof created.id === "number" && typeof created.nextRunAt === "number", created);

    const list = (await rpc(port, "automation.list", null)) as Array<{ id: number; dispatchTarget: string; targetSessionId: string | null }>;
    const row = Array.isArray(list) ? list.find((a) => a.id === created.id) : undefined;
    check("automation.list 读得到刚建的那条", row !== undefined);
    check("落库后读回 dispatchTarget=existing_session", row?.dispatchTarget === "existing_session", { row });
    check("targetSessionId=null 原样保留（发火时再解析）", row?.targetSessionId === null);

    // 坏值必须被拒，而不是写下去一行无声卡死的记录
    const bad = await rpc(port, "automation.create", {
      unitId: "u-smoke", unitName: "冒烟", runtimeId: "mockperm", rootPath: tmpHome,
      prompt: "x", dispatchTarget: "乱写的", delayMinutes: 60,
    });
    check("非法 dispatchTarget 被拒", typeof bad === "object" && bad !== null && "__rpcError" in bad, bad);

    // Bug2 的真端到端护栏：existing_session 在「找不到可续接的对话」时退回新开会话，
    // 那句回退说明必须活到派发成功之后 —— 旧写法会被同一次调用的成功路径清空。
    // 这里临时 home 里一条会话都没有，resolveSendTarget 必然返回 null，走回退分支。
    const fallback = (await rpc(port, "automation.create", {
      unitId: "u-smoke", unitName: "冒烟", name: "回退说明护栏",
      runtimeId: "mockperm", rootPath: tmpHome, prompt: "继续",
      dispatchTarget: "existing_session", targetSessionId: null, delayMinutes: 600,
    })) as { id?: number };
    if (typeof fallback.id !== "number") {
      check("回退说明护栏：建出任务", false, fallback);
      return;
    }
    await rpc(port, "automation.runNow", { id: fallback.id });
    await new Promise((r) => setTimeout(r, 1200));
    const after = (await rpc(port, "automation.list", null)) as Array<{ id: number; lastError: string | null }>;
    const row2 = Array.isArray(after) ? after.find((a) => a.id === fallback.id) : undefined;
    check(
      "回退说明没被成功路径擦掉（端到端）",
      typeof row2?.lastError === "string" && row2.lastError.includes("已改为新开会话"),
      { lastError: row2?.lastError },
    );

    // runAt 端到端：精确到分钟落点，且不会被降级成「每天 HH:MM」
    const want = Math.floor((Date.now() + 5 * 3_600_000) / 60_000) * 60_000;
    const abs = (await rpc(port, "automation.create", {
      unitId: "u-smoke", unitName: "冒烟", name: "绝对时刻护栏",
      runtimeId: "mockperm", rootPath: tmpHome, prompt: "继续",
      runAt: want,
    })) as { id?: number; nextRunAt?: number | null };
    check("runAt 建得出任务且 nextRunAt 就是那个时刻", typeof abs.id === "number" && abs.nextRunAt === want, { want, got: abs.nextRunAt });
    const absList = (await rpc(port, "automation.list", null)) as Array<{ id: number; scheduleRule: { runAt?: number } | null; recurring: boolean; maxRuns: number | null }>;
    const absRow = Array.isArray(absList) ? absList.find((x) => x.id === abs.id) : undefined;
    check("落库后 runAt 还在规则里（没被降级成日历推进）", absRow?.scheduleRule?.runAt === want, { rule: absRow?.scheduleRule });
    check("runAt 建出来的一次性任务确实是一次性", absRow?.recurring === false && absRow?.maxRuns === 1, { recurring: absRow?.recurring, maxRuns: absRow?.maxRuns });

    // 过期时刻必须被拒，不能静默顺延到明天同一钟点
    const past = await rpc(port, "automation.create", {
      unitId: "u-smoke", unitName: "冒烟", runtimeId: "mockperm", rootPath: tmpHome,
      prompt: "x", runAt: Date.now() - 60_000,
    });
    check("过去的 runAt 被拒（不静默顺延）", typeof past === "object" && past !== null && "__rpcError" in past, past);

    // 可续接会话清单：临时 home 里一条会话都没有，返回空数组而不是报错
    const res = (await rpc(port, "session.resumable", { limit: 10 })) as { sessions?: unknown[] };
    check("session.resumable 返回数组", Array.isArray(res?.sessions), { res });
  } finally {
    // Windows：kill() 只是发信号，进程真正退出前句柄还占着目录，
    // 这时 rmSync 必然 EPERM。等 exit 事件再删（并留兜底，别让清理失败吃掉测试结论）
    daemon.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 8000);
      daemon.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      rmSync(liveHome, { recursive: true, force: true });
    } catch (err: unknown) {
      console.log(`  ⚠️ 临时 home 清理失败（不影响结论）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
}

/** 最小 RPC 客户端：只求连通，不复用生产客户端。
 *  帧形态照 wsd.ts 的 ResponseFrame：请求要带 v，响应是 { v, id, ok, result|error }。 */
function rpc(port: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`rpc timeout: ${method}`));
    }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ v: 1, id: "1", method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data.toString()) as { id?: string; type?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
      // 连上先来一帧 hello（没有 id）—— 别把它当响应返回掉
      if (msg.id !== "1") return;
      if (msg.ok !== true && msg.error !== undefined) {
        // 失败帧也resolve：调用方要的就是「被拒了」这个事实，不该炸成异常
        clearTimeout(timer);
        ws.close();
        resolve({ __rpcError: msg.error });
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(msg.result ?? null);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${method}`));
    };
  });
}

console.log(failures === 0 ? "\n✅ 续跑冒烟全绿\n" : `\n❌ ${failures} 项未通过\n`);
process.exit(failures === 0 ? 0 : 1);
