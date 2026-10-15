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
import type { QuotaProbe } from "../src/backlog/probe.ts";
import type { BacklogConfig, QuotaHeadroom } from "../../prototype/src/core/backlog.ts";
import { DEFAULT_BACKLOG_CONFIG } from "../../prototype/src/core/backlog.ts";
import { buildRelativeDelaySchedule, computeScheduleNextRunAt } from "../../prototype/src/core/automation.ts";

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

  // ---- 9. 真实 daemon 上 RPC 通 ------------------------------------------
  // 单测只覆盖到 watcher 这一层；界面上真正读的是 quotaResume.state 这个 RPC，
  // 注册漏了 / 字段名对不上，前面的全绿也救不了「界面上什么都不显示」。
  console.log("\n【9】真实 daemon 上 quotaResume.state 回环");
  await liveRpcCheck();
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
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
