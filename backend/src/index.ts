/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exec, spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { healthPayload, isLocalOrigin, isLoopbackAddr, startHttp, type HttpRoute } from "./httpd.ts";
import { ImageProfileStore, type ImageProfileRow } from "./image/profiles.ts";
import { handleImageCall } from "./image/proxy.ts";
import { log, setLogLevel } from "./log.ts";
import { setSecretsHome } from "./secrets.ts";
import { attachWs, broadcastBacklog, broadcastEvent, broadcastTerminal, registerMethod, WIRE_VERSION } from "./wsd.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { MockPermAdapter } from "./runtime/adapters/mockperm.ts";
import { ClaudeAdapter } from "./runtime/adapters/claude.ts";
import { RuntimeHost } from "./runtime/host.ts";
import { TraceSink } from "./runtime/trace.ts";
import { ZcodeAdapter } from "./runtime/adapters/zcode.ts";
import { CodexAdapter } from "./runtime/adapters/codex.ts";
import { PiAdapter } from "./runtime/adapters/pi.ts";
import { McodeAdapter } from "./runtime/adapters/mcode.ts";
import { DshAdapter } from "./runtime/adapters/dsh.ts";
import { OpencodeAdapter } from "./runtime/adapters/opencode.ts";
import { HermesAdapter } from "./runtime/adapters/hermes.ts";
import { KimiAdapter } from "./runtime/adapters/kimi.ts";
import { AgyAdapter } from "./runtime/adapters/agy.ts";
import { GrokAdapter } from "./runtime/adapters/grok.ts";
import { CursorAdapter } from "./runtime/adapters/cursor.ts";
import { OpenclawAdapter } from "./runtime/adapters/openclaw.ts";
import { buildSkillsInventory, copySkill, setSkillDisabled } from "./skills/inventory.ts";
import {
  mcpCopy,
  mcpInventory,
  mcpReadFile,
  mcpRemove,
  mcpSave,
  mcpSetEnabled,
  sanitizeEntry,
  type McpServiceDeps,
} from "./mcpadmin/service.ts";
import { TerminalManager } from "./terminal/terminals.ts";
import { Store } from "./store/db.ts";
import { listNativeSessions, readNativeSession } from "./history/index.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { QuotaResumeWatcher } from "./automation/quotaResume.ts";
import { QuotaProbe } from "./backlog/probe.ts";
import { cronNextAt, parseCron } from "./automation/cron.ts";
import {
  buildAbsoluteSchedule,
  buildRelativeDelaySchedule,
  computeScheduleNextRunAt,
  scheduleRuleToCron,
  type ScheduleRule,
} from "../../prototype/src/core/automation.ts";
import { MemoryService } from "./memory/memory.ts";
import { FileMemoryInjector } from "./memory/injection.ts";
import { readLongTerm, writeLongTerm, readDaily, listDaily } from "./memory/projectMemory.ts";
import {
  readAppearance,
  writeAppearance,
  readWallpaperDataUrl,
  saveWallpaper,
  deleteWallpaper,
} from "./appearance/store.ts";
import { DailyDigest } from "./memory/dailyDigest.ts";
import { stewardSearch, stewardRecent, ensureSteward, stewardRoot, stewardDefinition, STEWARD_ID } from "./memory/steward.ts";
import { runCurator, renderReport, DEFAULT_CURATOR, DbMetaStore, type CuratorConfig } from "./memory/curator.ts";
import { MemoryScheduler } from "./memory/scheduler.ts";
import { getGuardianConfig, setGuardianConfig, type MemoryGuardianConfig } from "./memory/guardianConfig.ts";
import { maybeConsolidate } from "./memory/consolidator.ts";

/** 记忆系统的后台调度（每日总结 + curator）。启动时挂上，停止时摘掉。 */
let memoryScheduler: MemoryScheduler | undefined;
/** 待办（GTD）引擎：在 wss 就绪后构造（广播要用），这里先声明给 host 回调引用。 */
let backlogEngine: BacklogEngine | undefined;
import { BacklogEngine } from "./backlog/heartbeat.ts";
import { getBacklogConfig, setBacklogConfig } from "./backlog/config.ts";
import {
  ensureHeartbeatBot,
  heartbeatBotDefinition,
  heartbeatBotShape,
  HEARTBEAT_BOT_ID,
  HEARTBEAT_DEFAULT_RUNTIME_ID,
} from "./backlog/heartbeatBot.ts";
import { draftPromptOf, type BacklogConfig, type BacklogSignal } from "../../prototype/src/core/backlog.ts";
import { BotRegistry } from "./bots/registry.ts";
import { TelegramGateway } from "./channels/telegram.ts";
import { FeishuGateway, diagnoseLarkAccount, larkIdentities, larkProfileList, addLarkProfile } from "./channels/feishu.ts";
import { askBot } from "./channels/askBot.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

const startedAt = Date.now();
const config = loadConfig();
// 密钥的 env: 引用可落到 <homeDir>/.env（README「密钥放在哪」）—— 家目录定下来就接上
setSecretsHome(config.homeDir);
setLogLevel(config.logLevel);

mkdirSync(config.homeDir, { recursive: true });

// ---- 端口预检（必须排在一切副作用之前）-------------------------------------
//
// 踩过的坑：Windows 的 Hyper-V / WSL 会保留一整段动态端口（本机实测
// 5141–5240 被占，5181 正在其中），撞上时 `listen` 报 EACCES。
// 而在这**之后**代码还会去起 telegram / feishu 网关、automation 调度器、
// 记忆调度器 —— 侧效应全发生了才崩，留下半启动状态。
//
// 所以：先探端口，探不通立刻带着**可执行的**提示退出，一个副作用都不留。

async function preflightPort(port: number, host: string): Promise<void> {
  const { createServer } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === "EACCES"
          ? "端口被系统保留了。Windows 的 Hyper-V / WSL 会留一整段动态端口，" +
            "用 `netsh interface ipv4 show excludedportrange protocol=tcp` 就能看到。\n" +
            `换一个不在保留段里的端口：后端 AGENT_WORKBENCH_PORT=<新端口>，前端 VITE_AGENT_WORKBENCH_PORT=<同一个>。`
          : err.code === "EADDRINUSE"
            ? "端口已被占用（可能已经有一个 daemon 在跑）。换个端口，或先停掉那个。"
            : "换个端口试试。";
      reject(Object.assign(new Error(`daemon 端口 ${host}:${port} 不可用 —— ${err.message}\n${hint}`), { code: "port_unavailable" }));
    });
    srv.once("listening", () => srv.close(() => resolve()));
    srv.listen(port, host);
  });
}

// top-level await：**await 真的挡住了后续初始化**。写成 `void preflightPort(...)`
// 的话预检和后面的同步代码是并发的，侧效应照样会发生，等于没加。
try {
  await preflightPort(config.port, "127.0.0.1");
} catch (err: unknown) {
  console.error(`\n启动中止：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// ---- 事件循环阻塞监视器（Worker 版）------------------------------------------
//
// 为什么必须是 worker：2026-10-15 实测 daemon 两次整体冻结（/healthz 无响应，
// CPU 静止 = 主线程卡在同步调用里，minidump 栈回溯定位到 conpty.node）。旧版
// 监视器是主线程 setInterval —— 主线程永久卡死时定时器根本不会触发，一行
// 证据都留不下。worker 有独立事件循环：主线程停止心跳后它照样跑，把停摆
// 的时间点/时长写进 <homeDir>/loop-stall.log（恢复时再补一行）。
// 正常情况零输出、零开销（主线程 1s 一次 unref 心跳）。

{
  const STALL_THRESHOLD_MS = 5_000;
  const stallLogPath = join(config.homeDir, "loop-stall.log");
  const watchdogSrc = `
    const { parentPort } = require("node:worker_threads");
    const { appendFileSync } = require("node:fs");
    const THRESHOLD = ${STALL_THRESHOLD_MS};
    const LOG = ${JSON.stringify(stallLogPath)};
    let lastBeat = Date.now();
    let stalledSince = 0;
    parentPort.on("message", () => { lastBeat = Date.now(); });
    setInterval(() => {
      const silent = Date.now() - lastBeat;
      if (silent > THRESHOLD && stalledSince === 0) {
        stalledSince = Date.now();
        const line = new Date().toISOString() + " main-loop stalled (> " + Math.round(silent / 100) / 10 + "s and counting)\\n";
        try { appendFileSync(LOG, line); } catch {}
        console.error("[loop-stall] " + line.trim());
      } else if (silent <= THRESHOLD && stalledSince !== 0) {
        const dur = Date.now() - stalledSince;
        stalledSince = 0;
        const line = new Date().toISOString() + " main-loop recovered, stalled " + Math.round(dur / 100) / 10 + "s\\n";
        try { appendFileSync(LOG, line); } catch {}
        console.error("[loop-stall] " + line.trim());
      }
    }, 1000).unref();
  `;
  try {
    const { Worker } = await import("node:worker_threads");
    const watchdog = new Worker(watchdogSrc, { eval: true });
    watchdog.unref();
    const beat = setInterval(() => watchdog.postMessage(1), 1000);
    beat.unref?.();
  } catch (err: unknown) {
    console.error("loop-stall watchdog 起不来（继续跑，只是没证据兜底）", err instanceof Error ? err.message : String(err));
  }
}

// ---- 服务与执行器（先建好，REST 路由要引用）---------------------------------

const store = new Store(config.homeDir);
const gate = new PermissionGate(store);
const traceSink = new TraceSink(config.homeDir);
const botRegistry = new BotRegistry(store);
const host = new RuntimeHost((event, seq) => {
  broadcastEvent(wss, event, seq);
  // 自动化运行记录的终态回灌（Phase 5）
  if (event.type === "session.ended") {
    const hit = automationRunBySession.get(event.sessionId);
    if (hit !== undefined) {
      automationRunBySession.delete(event.sessionId);
      const failed = event.reason === "error" || event.reason === "executor_exited";
      store.finishAutomationRun(hit.runId, failed ? "failed" : "done", `ended: ${event.reason}`);
      // 会话本身跑挂了也要挂失败徽章 —— 不然调度层看不到，卡片一直显示「已完成」
      if (failed) store.setAutomationError(hit.automationId, `ended: ${event.reason}`, Date.now());
    }
    // 待办（GTD）执行的终态回灌 —— 引擎内部按 sessionId 映射判归属，与自动化互不干扰
    backlogEngine?.onSessionEnded(event.sessionId, event.reason);
  }
}, traceSink, config.homeDir, store, gate, new FileMemoryInjector());
memoryScheduler = new MemoryScheduler({
  homeDir: config.homeDir,
  store,
  knownProjects: () => botRegistry.roots(),
  // 设置页「每日总结」开关的权威值在 kv（memory.guardian.set 写入）。
  // 每 tick 动态读，改开关不用重启 daemon —— 关掉只停定时跑，设置页的试跑按钮不受影响。
  digestEnabled: () => getGuardianConfig(store).digestEnabled,
  // 「用户最近一次有对话活动」：取会话行的 started_at / ended_at 与最后一条消息
  // 时间里的最大值。**不能只看 startedAt** —— 会话的开始时间在整个会话期间不变，
  // 早上开的会话到晚上仍报「早间空闲」，curator 的 idle 闸就会在用户正聊着的时候
  // 放行 600s 的后台记忆整理。
  lastActivityAt: () => {
    const rows = store.listSessions();
    let max = 0;
    for (const r of rows) {
      max = Math.max(max, r.startedAt, r.endedAt ?? 0);
    }
    return Math.max(max, store.latestMessageAt());
  },
});
host.register(new ZcodeAdapter());
host.register(new CodexAdapter());
host.register(new ClaudeAdapter());
host.register(new PiAdapter());
host.register(new McodeAdapter());
host.register(new DshAdapter());
host.register(new OpencodeAdapter());
host.register(new HermesAdapter());
host.register(new KimiAdapter());
host.register(new AgyAdapter());
host.register(new GrokAdapter());
host.register(new CursorAdapter());
host.register(new OpenclawAdapter());
host.register(new MockPermAdapter());
host.loadPersisted();
memoryScheduler?.start();
// 后台并发预热动态模型查询（不阻断启动）
void host.syncAllModels();

// 总管 bot：初始化即就位（docs/10 §4.6）。失败不阻断启动 ——
// 记忆是增强，不是前置条件。
void ensureSteward(config.homeDir)
  .then(({ rootPath }) => {
    botRegistry.addRoot(rootPath);
    // 幂等：已经在盘上且定义没变就别重写。
    // 每次启动都 putBot 会把 revision 一路顶高（实测重启 5 次就 revision=5），
    // 白写盘，还会和别处的乐观锁打架。
    return botRegistry.getBot(STEWARD_ID).then(async (existing) => {
      const want = stewardDefinition(rootPath);
      // 用户在设置页能改的都属于**用户数据**（执行器/模型/头像/渠道/记忆策略/
      // 名称/角色人设），启动引导只补结构，绝不覆盖 —— 否则每次重启都会把
      // 用户配置打回硬编码初始值（实测复现：改成非 mcode 的执行器后重启必被
      // 回写）。比对与写盘都用 merged。
      const prev = (existing ?? {}) as Record<string, unknown>;
      const userOwned: Record<string, unknown> = {};
      for (const k of ["name", "bindings", "avatar", "channels", "memory"] as const) {
        if (prev[k] !== undefined) userOwned[k] = prev[k];
      }
      // identity 里 sourcePath 是结构指针（跟 want），role/persona 是用户数据
      const prevIdentity = (prev.identity ?? {}) as Record<string, unknown>;
      const wantIdentity = (want.identity ?? {}) as Record<string, unknown>;
      userOwned.identity = {
        ...wantIdentity,
        ...(prevIdentity.role !== undefined ? { role: prevIdentity.role } : {}),
        ...(prevIdentity.persona !== undefined ? { persona: prevIdentity.persona } : {}),
      };
      const merged = { ...want, ...userOwned };
      if (existing !== undefined && stewardShape(existing) === stewardShape(merged)) {
        return { id: STEWARD_ID, revision: undefined, unchanged: true as const };
      }
      const r = await botRegistry.putBot(merged);
      return { id: STEWARD_ID, revision: r.revision, unchanged: false as const };
    });
  })
  .then((r) => log.info("steward bot ready", { id: r.id, revision: r.revision, unchanged: r.unchanged }))
  .catch((err: unknown) => log.warn("steward bot init failed", { error: err instanceof Error ? err.message : String(err) }));

// 心跳 bot（常驻合成 bot，对齐 steward 模式）：待办心跳会话的宿主身份。
// AGENTS.md 岗位说明书（决策依据/输出契约/红线）随目录播种 —— zcode 等执行器
// 在 cwd 原生读它，心跳 agent 的角色设定不靠 prompt 拼接。失败不阻断启动。
void ensureHeartbeatBot(config.homeDir)
  .then(({ rootPath }) => {
    botRegistry.addRoot(rootPath);
    // 幂等 + 用户数据不覆盖：与 steward 同一套口径（结构补齐，name/bindings/
    // avatar/channels/memory/identity.role/persona 归用户）
    return botRegistry.getBot(HEARTBEAT_BOT_ID).then(async (existing) => {
      const want = heartbeatBotDefinition(rootPath, HEARTBEAT_DEFAULT_RUNTIME_ID);
      const prev = (existing ?? {}) as Record<string, unknown>;
      const userOwned: Record<string, unknown> = {};
      for (const k of ["name", "bindings", "avatar", "channels", "memory", "tags"] as const) {
        if (prev[k] !== undefined) userOwned[k] = prev[k];
      }
      const prevIdentity = (prev.identity ?? {}) as Record<string, unknown>;
      const wantIdentity = (want.identity ?? {}) as Record<string, unknown>;
      userOwned.identity = {
        ...wantIdentity,
        ...(prevIdentity.role !== undefined ? { role: prevIdentity.role } : {}),
        ...(prevIdentity.persona !== undefined ? { persona: prevIdentity.persona } : {}),
      };
      const merged = { ...want, ...userOwned };
      if (existing !== undefined && heartbeatBotShape(existing) === heartbeatBotShape(merged)) {
        return { unchanged: true as const };
      }
      await botRegistry.putBot(merged);
      return { unchanged: false as const };
    });
  })
  .then((r) => log.info("heartbeat bot ready", { id: HEARTBEAT_BOT_ID, unchanged: r.unchanged }))
  .catch((err: unknown) => log.warn("heartbeat bot init failed", { error: err instanceof Error ? err.message : String(err) }));

/**
 * 管家定义的**规范形状**，用于幂等比较。
 *
 * 刻意**不手列字段**。前两版都手列过，两次都栽在同一处：
 * 加了新字段（`kind`、又 `tags`）却忘了加进这个列表 → 比较永远说「没变化」
 * → 新字段永远写不进盘，而且**没有任何报错**。
 *
 * 改成从定义本身派生：排除「hydrate 产物 + 每次都变的」那几个键，
 * 其余全参与比较。这样新增字段自动被覆盖，这类 bug 结构上不再可能发生。
 */
// hydrate 产物 + 每次都变的键。注意 `$meta` 带美元号 —— bot.list 里实际是这个键名。
//
// `identity` 也在排除之列：它带 sourcePath 指针，而 **AGENTS.md 是用户的** ——
// 用户手改岗位说明书时，identity 里的 loadedAt 等会变。把整块排除掉，
// 启动流程才不会把手改内容当成「配置漂移」再覆盖回去。
const STEWARD_VOLATILE = new Set([
  "updatedAt", "meta", "$meta", "agentsMd", "agentsMdMeta", "revision", "sourcePath", "identity",
]);

function stewardShape(def: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def).sort()) {
    if (STEWARD_VOLATILE.has(k)) continue;
    out[k] = def[k];
  }
  return JSON.stringify(out);
}

// ---- T3 式执行器目录（按需开启的可见性面）-----------------------------------
// 已注册的执行器出现在 adapter.list；未注册的已知驱动在这里以真实状态列出
//（not_installed / not_configured），前端可据此渲染灰色项与配置指引。
// 某家补齐安装/凭据后，probe 通过即可升级为注册执行器（新增 = adapter 文件 + 注册一行）。
registerMethod("driver.catalog", () => [
  { id: "zcode", installed: true, registered: true, hint: "" },
  { id: "codex", installed: true, registered: true, hint: "" },
  { id: "claude", installed: true, registered: true, hint: "网关偶发过载时 turn 失败，恢复即用" },
  { id: "pi", installed: true, registered: true, hint: "" },
  { id: "mcode", installed: true, registered: true, hint: "ACP 接入（mcode acp），权限审批走反向请求流" },
  { id: "dsh", installed: true, registered: true, hint: "ACP 接入（dsh acp），npm 全局 shim 指向源码 checkout 已失效，走桌面版 CLI" },
  { id: "mockperm", installed: true, registered: true, hint: "权限闸试金石" },
  {
    id: "opencode",
    installed: true,
    registered: true,
    hint:
      "ACP 接入（opencode acp），与 mcode/dsh 同构；不选模型即跟随 opencode 默认（实测 opencode/big-pickle），完整模型清单随 session/new 下发",
  },
  { id: "hermes", installed: true, registered: true, hint: "ACP 接入（hermes acp），模型/模式走 session/set_model、session/set_mode；终端裸命令 hermes 即全屏 TUI" },
  { id: "kimi", installed: true, registered: true, hint: "ACP 接入（kimi acp），模型走 session/set_config_option（无 set_model）；凭据过期时报 kimi login 指引，终端裸命令 kimi 即全屏 TUI" },
  { id: "cursor-agent", installed: false, registered: false, hint: "未安装（cursor-agent install）" },
  { id: "grok", installed: false, registered: false, hint: "未安装" },
  { id: "antigravity", installed: false, registered: false, hint: "未安装" },
]);

// ---- 自动化调度（Phase 5 v2）-------------------------------------------------

/** sessionId → { runId, automationId }：会话结束态回灌运行记录与失败徽章 */
const automationRunBySession = new Map<string, { runId: number; automationId: number }>();
/** terminalId → { runId, automationId }：TUI 模式（无 host 会话）的运行记录靠 exit 帧结算 */
const automationRunByTerminal = new Map<string, { runId: number; automationId: number }>();

// 终端必须在 runAutomation 之前构造（TUI 派发要用）。exit 帧在这里顺带结算
// TUI 模式的运行记录 —— 放进 TerminalManager 的 emit 回调，是唯一的全局出口。
const terminals = new TerminalManager((frame) => {
  if (frame.kind === "exit") {
    const hit = automationRunByTerminal.get(frame.terminalId);
    if (hit !== undefined) {
      automationRunByTerminal.delete(frame.terminalId);
      const ok = (frame.exitCode ?? 0) === 0;
      store.finishAutomationRun(hit.runId, ok ? "done" : "failed", `terminal exit ${frame.exitCode ?? "?"}`);
      if (!ok) store.setAutomationError(hit.automationId, `terminal exit ${frame.exitCode ?? "?"}`, Date.now());
      else store.setAutomationError(hit.automationId, null, null);
      log.info("automation terminal run settled", { runId: hit.runId, exitCode: frame.exitCode ?? "?" });
    }
    // 待办 TUI 模式的运行记录与状态机收口（engine 内部按 terminalId 判归属）
    backlogEngine?.onTerminalExited(frame.terminalId, frame.exitCode ?? 0);
    // 手动派发终端（terminal.dispatch）的运行记录收口（无行的 id 静默无操作）
    const isUserInterrupt =
      frame.exitCode === 130 ||
      frame.exitCode === 143 ||
      frame.exitCode === 3221225786 ||
      frame.exitCode === -1073741510;
    const manualDone = frame.killed || (frame.exitCode ?? 0) === 0 || isUserInterrupt;
    const transcript = frame.transcript ?? null;
    if (transcript) {
      store.saveTerminalTranscript(frame.terminalId, transcript);
    }
    if (manualDone) store.finishTerminalRun(frame.terminalId, "done", null, transcript);
    else store.finishTerminalRun(frame.terminalId, "failed", `terminal exit ${frame.exitCode ?? "?"}`, transcript);
  }
  if (frame.kind === "title") {
    if (typeof frame.title === "string") {
      store.setTerminalRunTitle(frame.terminalId, frame.title);
      log.info("terminal title captured from input", { terminalId: frame.terminalId, title: frame.title });
    }
    return;
  }
  broadcastTerminal(wss, { v: WIRE_VERSION, type: "terminal", ...frame });
});

/**
 * TUI 模式的 prompt 注入形态：括号粘贴序列包住全文再回车。
 * raw 写入的多行文本会被 ink 系 TUI 逐行当提交，括号粘贴让整块按一次粘贴
 * 处理（换行保留、不提前发车），随后的 \r 才是真正的提交键。
 */
function bracketedPaste(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~`;
}

/**
 * 共享的 TUI 派发（automations / backlog / 手动派发终端都走这里）：在 PTY 里以
 * yolo 免审批拉起执行器 TUI，prompt 非空时注入（手动派发不带 prompt，人自己敲），
 * args 透传给 CLI（历史会话恢复用，如 zcode 的 --resume <sessionId>），
 * 返回 autoterm_ 前缀的终端 id。终态不经 host —— 派发方各自挂 terminalId 映射，
 * 由上面的 exit 帧回调结算。
 */
async function launchExecutorTerminal(opts: {
  runtimeId: string;
  unitId: string;
  rootPath: string;
  prompt?: string;
  args?: readonly string[];
}): Promise<string> {
  const terminalId = `autoterm_${randomUUID()}`;
  terminals.create({
    terminalId,
    cwd: opts.rootPath,
    // :yolo 后缀 → TerminalManager 按执行器补免审批 flag（实测口径见其注释）
    executorId: tuiCommandFor(`${opts.runtimeId}:yolo`),
    unitId: opts.unitId,
    autoExit: true,
    ...(opts.args !== undefined && opts.args.length > 0 ? { args: opts.args } : {}),
  });
  if (opts.prompt !== undefined && opts.prompt !== "") {
    // TUI 起稳后把提示词「敲」进去 —— 失败不回滚派发（终端已开，人可以自己输入）
    void terminals.writeWhenQuiet(terminalId, bracketedPaste(opts.prompt) + "\r").then(() => {
      log.info("prompt injected to terminal", { terminalId, runtimeId: opts.runtimeId });
    });
  }
  return terminalId;
}

/**
 * 定时发送的收件对话（dispatch_target = existing_session）。
 *
 * 三级回退，宁可往前退也不能空发：
 *  1. 规则上钉死的 targetSessionId（用户手动指定的那一个）
 *  2. 该执行器最近一个还能 resume 的会话 ——「刚撞到用量墙的那个对话」就是它：
 *     cliRef 非空才接得回来（首轮没结束过的会话拿不到 cliRef，接不了）
 *  3. 全都接不回来 → 返回 null，调用方退回「新开会话」，绝不静默丢弃这条自动化
 */
function resolveSendTarget(
  automation: { runtimeId: string; targetSessionId?: string | null },
  fallbackSessionId?: string | null,
): string | null {
  const pick = (id: string): string | null => {
    const row = store.getSession(id);
    // runtimeId 必须一致：会话是执行器私有的，跨执行器的 cli_ref 根本接不回来，
    // 钉了别家执行器的会话还投出去 = 把提示词发进一个必然失败（或错误家）的对话
    return row !== undefined && row.cliRef !== null && row.runtimeId === automation.runtimeId ? id : null;
  };
  // 1. 如果用户显式钉死了目标会话，只认该会话；接不回则直接返回 null，由外层回退到新开会话，绝不乱投到其它无关会话
  if (automation.targetSessionId !== null && automation.targetSessionId !== undefined && automation.targetSessionId !== "") {
    return pick(automation.targetSessionId);
  }
  // 2. 自动续接模式：优先用显式传入的候选，否则挑该执行器最近一个可接回的会话
  if (fallbackSessionId !== undefined && fallbackSessionId !== null) {
    const hit = pick(fallbackSessionId);
    if (hit !== null) return hit;
  }
  for (const s of store.listSessions()) {
    if (s.runtimeId !== automation.runtimeId || s.cliRef === null) continue;
    return s.id;
  }
  return null;
}

async function runAutomation(
  a: {
    id: number;
    unitId: string;
    unitName: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    launchMode: "terminal" | "headless";
    dispatchTarget?: "new_session" | "existing_session";
    targetSessionId?: string | null;
  },
  opts: { trigger: "schedule" | "manual" },
): Promise<{ runId: number; sessionId: string }> {
  // 派发过程中要留在徽章上的说明（如「回退成新开会话了」）。
  // 成功路径默认把 last_error 清空，会把同一次调用里刚写下的说明一起抹掉 ——
  // 所以统一走这个变量，成功时写它而不是 null。
  let dispatchNote: string | null = null;

  // 定时发送到已有对话：不新开会话，把 prompt 当一条消息投进那个对话。
  // 会话多半已经因为用量耗尽而结束 —— resumeSession 把盘里的会话接回执行器
  // （cli_ref 续命），接回来后再发，agent 在原上下文里接着干。
  if (a.dispatchTarget === "existing_session") {
    const targetId = resolveSendTarget(a);
    if (targetId !== null) {
      const runId = store.startAutomationRun(a.id, targetId, opts.trigger);
      try {
        host.resumeSession(asSessionId(targetId));
        host.sendMessage(asSessionId(targetId), a.prompt);
        // 投递成功只回填 sessionId，status 留在 running —— 终态由 session.ended 回灌
        const ended = store.getSession(targetId);
        const endedFailed = ended !== undefined && ended.endedAt !== null && ended.status === "failed";
        if (ended !== undefined && ended.endedAt !== null) {
          store.finishAutomationRun(runId, endedFailed ? "failed" : "done", `ended: ${ended.status}`);
        } else {
          automationRunBySession.set(targetId, { runId, automationId: a.id });
        }
        if (endedFailed) store.setAutomationError(a.id, `ended: ${ended!.status}`, Date.now());
        else store.setAutomationError(a.id, null, null);
        log.info("automation message sent to existing session", { automationId: a.id, runId, sessionId: targetId, trigger: opts.trigger });
        return { runId, sessionId: targetId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        store.finishAutomationRun(runId, "failed", message);
        store.setAutomationError(a.id, message, Date.now());
        throw err;
      }
    }
    // 接不回任何老会话：记一笔再退回新开会话，别让这条续跑静默消失
    log.warn("existing-session automation found no resumable target, falling back to new session", { automationId: a.id });
    dispatchNote = "找不到可续接的对话，已改为新开会话";
  }

  // TUI 模式：到点在前端 PTY 里拉起执行器本尊的终端界面（yolo 免审批），
  // 人可看、可插手、可补充信息。不走 host —— 没有会话台账与事件流，
  // 运行记录的终态由终端 exit 帧回灌（autoExit：CLI 退 → shell 退 → exit 帧）。
  if (a.launchMode === "terminal") {
    const runId = store.startAutomationRun(a.id, null, opts.trigger);
    try {
      const terminalId = await launchExecutorTerminal({
        runtimeId: a.runtimeId,
        unitId: a.unitId,
        rootPath: a.rootPath,
        prompt: a.prompt,
      });
      store.setAutomationRunSession(runId, terminalId);
      automationRunByTerminal.set(terminalId, { runId, automationId: a.id });
      store.setAutomationError(a.id, dispatchNote, dispatchNote === null ? null : Date.now());
      log.info("automation terminal launched", { automationId: a.id, runId, terminalId, trigger: opts.trigger });
      return { runId, sessionId: terminalId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      store.finishAutomationRun(runId, "failed", message);
      store.setAutomationError(a.id, message, Date.now());
      throw err;
    }
  }

  const runId = store.startAutomationRun(a.id, null, opts.trigger);
  try {
    const session = await host.startSession({
      runtimeId: a.runtimeId,
      unitId: asUnitId(a.unitId),
      unitName: a.unitName,
      rootPath: a.rootPath,
      prompt: a.prompt,
      model: a.model === null ? null : asModelId(a.model),
      mode: (a.mode as "plan" | "build" | "edit" | "yolo" | undefined) ?? undefined,
      // 标明 headless 来源：权限闸据此【完全放行】，否则遇审批请求永远挂起
      source: "automation",
    });
    // 派发成功只回填 sessionId，status 留在 running —— 终态由 session.ended 回灌；
    // 旧写法 start 后立刻写 done，会话真失败前界面上一直显示「已完成」。
    store.setAutomationRunSession(runId, session.id);
    // mockperm 这类快执行器，会话可能在 startSession 的 promise 落定**之前**就已 ended
    // （几十毫秒答完是常态）：终态广播跑在登记前面，回灌永远等不到。已终态就当场收口。
    // 判据用 endedAt 而不是 status —— status="failed" 也可能是轮次失败而会话仍开着。
    const ended = store.getSession(session.id);
    const endedFailed = ended !== undefined && ended.endedAt !== null && ended.status === "failed";
    if (ended !== undefined && ended.endedAt !== null) {
      store.finishAutomationRun(runId, endedFailed ? "failed" : "done", `ended: ${ended.status}`);
    } else {
      automationRunBySession.set(session.id, { runId, automationId: a.id });
    }
    // 失败徽章：这次派发以失败告终就挂上；否则清掉（上一次的失败由这次成功翻篇）
    // —— 但 dispatchNote（回退说明）要留下，它不是失败徽章，别被当成旧账清掉
    if (endedFailed) store.setAutomationError(a.id, `ended: ${ended!.status}`, Date.now());
    else store.setAutomationError(a.id, dispatchNote, dispatchNote === null ? null : Date.now());
    log.info("automation session launched", { automationId: a.id, runId, sessionId: session.id, trigger: opts.trigger });
    return { runId, sessionId: session.id };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.finishAutomationRun(runId, "failed", message);
    store.setAutomationError(a.id, message, Date.now());
    throw err;
  }
}

const scheduler = new AutomationScheduler(store, runAutomation);

/**
 * 重启自愈 —— 「sessionId → 运行记录」的回灌映射在内存里，daemon 重启即丢。
 * 不做这一遍：上一次运行周期里 status=running 的运行记录永远停在 running
 * （卡片假「运行中」），还活着的会话结束时也等不到结算。
 * 按会话台账逐条收口：已结束 → 按其状态落终态；记录缺失 → failed；仍活着 → 重新挂回。
 */
function healAutomationRuns(): void {
  let settled = 0;
  let reattached = 0;
  for (const a of store.listAutomations()) {
    for (const r of store.listAutomationRuns(a.id, 200)) {
      if (r.status !== "running") continue;
      if (r.sessionId === null) {
        // 派发在 startSession 完成前中断：会话从未存在
        store.finishAutomationRun(r.id, "failed", "daemon 重启前未完成派发");
        settled++;
        continue;
      }
      // TUI 模式：sessionId 列存的是 autoterm_ 前缀的终端 id。PTY 随 daemon 进程
      // 一起死了（ConPTY 是子进程），重启后不可能还活着 —— 直接按中断收口。
      if (r.sessionId.startsWith("autoterm_")) {
        store.finishAutomationRun(r.id, "failed", "daemon 重启，终端已随进程关闭");
        settled++;
        continue;
      }
      const s = store.getSession(r.sessionId);
      if (s === undefined) {
        store.finishAutomationRun(r.id, "failed", "daemon 重启后会话记录缺失");
        settled++;
        continue;
      }
      if (s.endedAt !== null) {
        const failed = s.status === "failed";
        store.finishAutomationRun(r.id, failed ? "failed" : "done", `ended: ${s.status}`);
        if (failed) store.setAutomationError(a.id, `ended: ${s.status}`, s.endedAt);
        settled++;
        continue;
      }
      // 会话还活着（loadPersisted 已把它装回台账）：重新挂回终态回灌
      automationRunBySession.set(r.sessionId, { runId: r.id, automationId: a.id });
      reattached++;
    }
  }
  if (settled > 0 || reattached > 0) log.info("automation runs healed after restart", { settled, reattached });
}

healAutomationRuns();
// 手动派发终端的自愈：PTY 随 daemon 一起死，running 行全部按中断收口
{
  let n = 0;
  for (const r of store.listRunningTerminalRuns()) {
    store.finishTerminalRun(r.terminalId, "failed", "daemon 重启，终端已随进程关闭");
    n++;
  }
  if (n > 0) log.info("terminal runs healed after restart", { settled: n });
}
scheduler.start();

// 用量耗尽自动续跑：订阅执行器的窗口打满时自动排一条一次性自动化，
// 到点往撞墙的那个对话里发一句「继续」。排出来的东西就是普通 automation，
// 所以卡片、停用、手动触发全都是现成的。
// 探针自带 5 分钟 TTL 缓存，这里只消费缓存读数，不额外起子进程。
const quotaResumeWatcher = new QuotaResumeWatcher({
  store,
  probe: new QuotaProbe(config.homeDir),
  getConfig: () => getBacklogConfig(store),
});
quotaResumeWatcher.start();

// 渠道网关（docs/08 WP-8）：bot 的 IM 入站通道。
//
// ⚠ 2026-10-02：Telegram 从「启动时无条件 start 的全局单例」改成 reconciler。
// 旧写法的问题是渠道状态与 bot.json 无关——用户在设置页改完渠道保存，daemon 里的
// 连接纹丝不动，必须重启才生效。现在两家网关都定期比对盘上定义与在跑实例。
// apiBase 可指向 mock（冒烟）。
const telegramGateway = new TelegramGateway({
  apiBase: process.env["AGENT_WORKBENCH_TELEGRAM_API"] ?? "https://api.telegram.org",
  registry: botRegistry,
  host,
  pollMs: 1500,
});
telegramGateway.start();

// 飞书：每 bot 一个飞书机器人（一个飞书应用 = 一个账号 = 一个 bot 身份）。
// 入站拦截器：配置的确认会话里发「确认/拒绝 <待办id>」直接落到待办引擎（v1 关键词口径），
// 其余消息照常进 bot 轮次；引擎不在（启动早期）按未消费放行。
const feishuGateway = new FeishuGateway({
  registry: botRegistry,
  host,
  reconcileMs: 15_000,
  inboundHook: async (text, chatId) => {
    const cfg = getBacklogConfig(store);
    if (!cfg.feishu.enabled || cfg.feishu.receiveId === "" || chatId !== cfg.feishu.receiveId) return false;
    try {
      return await (backlogEngine?.handleInboundText(text) ?? false);
    } catch {
      return false;
    }
  },
});
feishuGateway.start();

// ---- 记忆编排（Phase 7）-----------------------------------------------------

const memory = new MemoryService(store, config.homeDir);

// ---- REST 管理面（权限闸的决策入口，docs/07 §六）----------------------------

const httpRoutes: HttpRoute[] = [
  // 回环自动取 token（WP-7）：本机前端免配置；非回环走不到路由层（authorize 401）
  {
    method: "GET",
    path: "/bootstrap",
    handle: ({ remoteAddress }) => {
      if (!isLoopbackAddr(remoteAddress)) {
        throw Object.assign(new Error("bootstrap only from loopback"), { code: "forbidden" });
      }
      return { token: config.token, home: config.homeDir };
    },
  },
  // per-bot 入站 webhook（WP-9）：鉴权走 bot 自己的 secret（全局 token 豁免此路径）
  {
    method: "POST",
    path: "/webhook/bot",
    handle: async ({ body }) => {
      const p = (body ?? {}) as { botId?: string; secret?: string; text?: string; waitMs?: number };
      if (typeof p.botId !== "string" || typeof p.text !== "string") {
        throw Object.assign(new Error("botId and text are required"), { code: "bad_params" });
      }
      const bot = await botRegistry.getBot(p.botId);
      if (bot === undefined) throw Object.assign(new Error(`no such bot: ${p.botId}`), { code: "unknown_bot" });
      const hook = (bot.channels as Array<{ kind?: string; enabled?: boolean; config?: Record<string, string> } | undefined>)
        ?.find((c) => c?.kind === "webhook");
      if (hook === undefined || hook.enabled !== true) {
        throw Object.assign(new Error(`bot ${p.botId} has no webhook channel`), { code: "no_channel" });
      }
      const secret = hook.config?.["secret"] ?? "";
      // 评审 P3：常量时间比较（hash 后等长比较），防 LAN 侧信道；secret 是唯一门槛
      // （通过即等同在 bot 工作目录 yolo 执行）
      const provided = createHash("sha256").update(p.secret ?? "").digest();
      const expected = createHash("sha256").update(secret).digest();
      if (secret === "" || !timingSafeEqual(provided, expected)) {
        throw Object.assign(new Error("bad secret"), { code: "forbidden" });
      }
      // 评审 P3：waitMs 默认 60s、上限 120s——慢轮次不该无限占住 HTTP 连接
      const rawWait = typeof p.waitMs === "number" ? p.waitMs : 60_000;
      const waitMs = Math.min(Math.max(rawWait, 1_000), 120_000);
      const { sessionId, reply } = await askBot(botRegistry, host, p.botId, p.text, { waitMs, source: "webhook" });
      return { sessionId, reply };
    },
  },
  {
    method: "GET",
    path: "/api/permissions/rules",
    handle: () => ({ rules: gate.listRules() }),
  },
  {
    method: "POST",
    path: "/api/permissions/rules",
    handle: ({ body }) => {
      const p = (body ?? {}) as { runtimeId?: string; kind?: string; pattern?: string; decision?: string };
      if (typeof p.pattern !== "string" || (p.decision !== "allow" && p.decision !== "deny")) {
        throw Object.assign(new Error("pattern and decision(allow|deny) are required"), { code: "bad_params" });
      }
      return { id: gate.addRule({ runtimeId: p.runtimeId ?? null, kind: p.kind ?? null, pattern: p.pattern, decision: p.decision }) };
    },
  },
  {
    method: "DELETE",
    path: "/api/permissions/rules",
    handle: ({ url }) => {
      const id = Number.parseInt(url.searchParams.get("id") ?? "", 10);
      if (!Number.isFinite(id)) throw Object.assign(new Error("id query param is required"), { code: "bad_params" });
      return { deleted: gate.deleteRule(id) };
    },
  },
  {
    method: "POST",
    path: "/api/permissions/resolve",
    handle: ({ body }) => {
      const p = (body ?? {}) as { sessionId?: string; requestId?: string; decision?: string };
      if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" ||
          (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "always")) {
        throw Object.assign(new Error("sessionId, requestId, decision(allow|deny|always) are required"), { code: "bad_params" });
      }
      return host.resolvePermission(asSessionId(p.sessionId), p.requestId, p.decision).then(() => ({ resolved: true }));
    },
  },
  {
    method: "POST",
    path: "/api/workspaces/open-folder",
    handle: async ({ body }) => {
      const p = (body ?? {}) as { path?: string; botId?: string };
      let targetPath = p.path;
      if (!targetPath && p.botId) {
        const b = await botRegistry.getBot(p.botId);
        if (b) targetPath = b.rootPath;
      }
      if (!targetPath || typeof targetPath !== "string") {
        throw Object.assign(new Error("path or botId is required"), { code: "bad_params" });
      }
      return launchFileManager(targetPath);
    },
  },
];

function launchFileManager(targetPath: string): { ok: boolean; path: string } {
  const cleanPath = path.resolve(targetPath);
  try {
    if (!existsSync(cleanPath)) {
      mkdirSync(cleanPath, { recursive: true });
    }
  } catch (err) {
    log.warn("mkdir before launch file manager failed", { err, path: cleanPath });
  }

  const platform = process.platform;
  const winPath = cleanPath.replace(/\//g, "\\");

  /**
   * 起一个脱离父进程的 GUI 启动器。
   * ⚠ 'error' 必须有人接：ChildProcess 上没有 error 监听时，EventEmitter 会把
   * spawn 失败（ENOENT / 权限）抛成**未捕获异常**，直接把 daemon 带下去 ——
   * 用户点一下「在资源管理器中打开」就可能弄死整个后台。
   */
  const launchDetached = (file: string, args: string[], label: string): void => {
    try {
      const p = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        ...(platform === "win32" ? { windowsHide: true } : {}),
      });
      p.on("error", (err) => log.warn(`${label} spawn failed`, { err: err.message, path: cleanPath }));
      p.unref();
    } catch (err) {
      log.warn(`${label} spawn threw`, { err, path: cleanPath });
    }
  };

  if (platform === "win32") {
    // 关键修复：Windows 下不能用 exec('explorer.exe ...')！
    // exec 会捕获并重定向 stdio，explorer.exe 检测到 stdio 被管道捕获时会被 Windows 拒绝创建 GUI 窗口并退出码为 1。
    // 必须用 spawn + detached: true + stdio: "ignore" 并 unref()，脱离父进程管道，
    // 才能让 Windows 桌面 Shell 正确创建并弹出资源管理器窗口。
    try {
      const p = spawn("explorer.exe", [winPath], {
        detached: true,
        stdio: "ignore",
      });
      p.unref();
      p.on("error", (err) => {
        log.warn("explorer.exe direct spawn failed, trying cmd start fallback", { err: err.message, path: winPath });
        launchDetached("cmd.exe", ["/c", "start", "", winPath], "cmd.exe start");
      });
    } catch (err) {
      log.warn("spawn explorer failed, fallback to cmd start", { err, path: winPath });
      launchDetached("cmd.exe", ["/c", "start", "", winPath], "cmd.exe start");
    }
  } else if (platform === "darwin") {
    launchDetached("open", [cleanPath], "open");
  } else {
    launchDetached("xdg-open", [cleanPath], "xdg-open");
  }
  return { ok: true, path: cleanPath };
}

/** 鉴权判定（docs/08 WP-7）：token 开启时全查，唯一豁免 = 回环取 /bootstrap 与 本机打开文件夹 */
const authorize = (req: IncomingMessage, url: URL): boolean => {
  if (config.token === null) return true;
  if (url.pathname === "/bootstrap") {
    // 评审 P0：跨源网页 fetch 自带 Origin 头且对端是回环——必须连 Origin 一起验
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    return isLoopbackAddr(req.socket.remoteAddress);
  }
  // 本地桌面打开工作区文件夹：仅限回环本地源
  if (url.pathname === "/api/workspaces/open-folder") {
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    if (isLoopbackAddr(req.socket.remoteAddress)) return true;
  }
  if (url.pathname === "/webhook/bot") return true; // per-bot secret 在路由内自验
  const provided = req.headers["x-awb-token"] ?? url.searchParams.get("token");
  return typeof provided === "string" && provided === config.token;
};

// 出图代理（docs 决策：密钥挪进 daemon）：浏览器把请求体交给 daemon，daemon 注入
// Authorization 后转发并透传响应流。这条路由是流式大载荷，走 httpd 的裸路由通道。
const imageProfiles = new ImageProfileStore(config.homeDir);

const { server, port } = await startHttp(config, startedAt, httpRoutes, authorize, [
  { method: "POST", path: "/api/image/call", handle: handleImageCall(imageProfiles) },
]);
const wss = attachWs(server, { config, startedAt, authorize });

// ---- 待办 / GTD（backlog）—— 引擎需要 wss 广播，必须在 attachWs 之后构造 ----------

backlogEngine = new BacklogEngine({
  store,
  host,
  homeDir: config.homeDir,
  getConfig: () => getBacklogConfig(store),
  broadcast: (signal: BacklogSignal) => broadcastBacklog(wss, signal),
  // 待办 launchMode=terminal 的 TUI 派发（与自动化共用 launchExecutorTerminal）
  launchTerminal: (o) => launchExecutorTerminal(o),
  notify: async (text) => {
    const cfg = getBacklogConfig(store);
    if (!cfg.feishu.enabled || cfg.feishu.receiveId === "") return;
    try {
      const r = await feishuGateway.sendTo(cfg.feishu.botId, cfg.feishu.accountId, cfg.feishu.receiveId, text);
      if (!r.ok) log.warn("backlog feishu notify failed", { detail: r.detail });
    } catch (err: unknown) {
      log.warn("backlog feishu notify failed", { error: err instanceof Error ? err.message : String(err) });
    }
  },
  rootsWithUnits: async () => {
    const bots = await botRegistry.listBots();
    return bots
      .filter((b) => typeof b.rootPath === "string" && b.rootPath !== "")
      .map((b) => ({ rootPath: String(b.rootPath), unitId: String(b.id ?? ""), unitName: String(b.name ?? "") }));
  },
  // 心跳 bot 的主绑定（bot 设置页改执行器/模型即生效；backlog 配置显式指定时优先）
  heartbeatBinding: async () => {
    const bot = await botRegistry.getBot(HEARTBEAT_BOT_ID);
    if (bot === undefined) return null;
    const bindings = Array.isArray(bot.bindings) ? (bot.bindings as Array<Record<string, unknown>>) : [];
    const primary = bindings.find((b) => b["primary"] === true) ?? bindings[0];
    if (primary === undefined) return null;
    const runtimeId = String(primary["runtimeId"] ?? "").replace(/^daemon:/, "");
    const modelHint = typeof primary["modelHint"] === "string" ? String(primary["modelHint"]) : null;
    return runtimeId === "" ? null : { runtimeId, model: modelHint };
  },
});
backlogEngine.start();
// dst 启动器已并入 dsh（tuiCommand）：dsh 的 TUI 用 dst shim 拉起
function tuiCommandFor(executorId: string | undefined): string | undefined {
  if (!executorId) return executorId;
  const isYolo = executorId.endsWith(":yolo");
  const baseId = isYolo ? executorId.slice(0, -5) : executorId;
  try {
    const tui = host.getAdapter(baseId).tuiCommand ?? baseId;
    return isYolo ? `${tui}:yolo` : tui;
  } catch {
    return executorId; // 未注册的 executorId 原样传，由 terminals 兜底
  }
}

registerMethod("terminal.create", (params) => {
  const p = (params ?? {}) as {
    terminalId?: string;
    cwd?: string;
    shell?: string;
    command?: string;
    args?: readonly string[];
    executorId?: string;
    unitId?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  };
  return terminals.create({
    terminalId: p.terminalId,
    cwd: p.cwd,
    shell: p.shell,
    command: p.command,
    args: p.args,
    executorId: tuiCommandFor(p.executorId),
    unitId: typeof p.unitId === "string" && p.unitId !== "" ? p.unitId : undefined,
    cols: p.cols,
    rows: p.rows,
    env: p.env,
  });
});
/**
 * 手动派发终端 —— 经派发系统打开前台 TUI（与终端面板手动开的区别：
 * 登记 terminal_runs 运行记录，进该 bot 的 unit.history 时间轴，
 * 标签带「派发」徽章）。不带 prompt，人在 TUI 里自己敲。
 */
registerMethod("terminal.dispatch", (params) => {
  const p = (params ?? {}) as { unitId?: string; unitName?: string; rootPath?: string; runtimeId?: string; args?: unknown };
  if (typeof p.unitId !== "string" || p.unitId === "" || typeof p.rootPath !== "string" || p.rootPath === "" ||
      typeof p.runtimeId !== "string" || p.runtimeId === "") {
    throw Object.assign(new Error("unitId, rootPath, runtimeId are required"), { code: "bad_params" });
  }
  if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== "string"))) {
    throw Object.assign(new Error("args must be string[]"), { code: "bad_params" });
  }
  // 属性收窄进不了异步闭包，先落局部常量
  const unitId = p.unitId;
  const unitName = p.unitName ?? unitId;
  const rootPath = p.rootPath;
  const runtimeId = p.runtimeId.replace(/^daemon:/, "");
  const args = Array.isArray(p.args) ? (p.args as string[]) : undefined;
  return (async () => {
    const terminalId = await launchExecutorTerminal({ runtimeId, unitId, rootPath, args });
    const runId = store.startTerminalRun({ terminalId, unitId, unitName, runtimeId });
    log.info("terminal dispatched manually", { terminalId, runId, unitId, runtimeId, args });
    return { terminalId, runId };
  })();
});
registerMethod("terminal.input", (params) => {
  const p = (params ?? {}) as { terminalId?: string; data?: string };
  if (typeof p.terminalId !== "string" || typeof p.data !== "string") {
    throw Object.assign(new Error("terminalId and data are required"), { code: "bad_params" });
  }
  terminals.write(p.terminalId, p.data);
  return { written: true };
});
registerMethod("terminal.resize", (params) => {
  const p = (params ?? {}) as { terminalId?: string; cols?: number; rows?: number };
  if (typeof p.terminalId !== "string" || typeof p.cols !== "number" || typeof p.rows !== "number") {
    throw Object.assign(new Error("terminalId, cols, rows are required"), { code: "bad_params" });
  }
  terminals.resize(p.terminalId, p.cols, p.rows);
  return { resized: true };
});
registerMethod("terminal.kill", (params) => {
  const p = (params ?? {}) as { terminalId?: string };
  if (typeof p.terminalId !== "string") throw Object.assign(new Error("terminalId is required"), { code: "bad_params" });
  terminals.kill(p.terminalId);
  return { killed: true };
});
registerMethod("terminal.list", () => terminals.list());
registerMethod("terminal.transcript", (params) => {
  const p = (params ?? {}) as { terminalId?: string };
  if (typeof p.terminalId !== "string" || p.terminalId === "") {
    throw Object.assign(new Error("terminalId is required"), { code: "bad_params" });
  }
  const text = store.getTerminalTranscript(p.terminalId);
  return { terminalId: p.terminalId, text };
});

// ---- 自动化方法（Phase 5 v2）-------------------------------------------------

const badAutomation = (message: string): Error => Object.assign(new Error(message), { code: "bad_params" });

/** scheduleRule 入参校验：共享引擎的规则对象落库前把范围钉死 */
function parseScheduleRule(raw: unknown): ScheduleRule {
  if (raw === null || typeof raw !== "object") throw badAutomation("scheduleRule must be an object");
  const r = raw as Record<string, unknown>;
  const frequency = r["frequency"];
  if (frequency !== "hourly" && frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly" && frequency !== "custom") {
    throw badAutomation(`bad scheduleRule.frequency: ${String(frequency)}`);
  }
  const int = (key: string, min: number, max: number, fallback?: number): number => {
    const v = r[key];
    if (v === undefined || v === null) {
      if (fallback !== undefined) return fallback;
      throw badAutomation(`scheduleRule.${key} is required`);
    }
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw badAutomation(`scheduleRule.${key} out of range (${min}..${max})`);
    return n;
  };
  const weekdays = (
    Array.isArray(r["weekdays"])
      ? (r["weekdays"] as unknown[]).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : []
  ) as ScheduleRule["weekdays"];
  const unit = r["unit"];
  const unitOk =
    frequency === "custom" &&
    (unit === "minutes" || unit === "hours" || unit === "days" || unit === "weeks" || unit === "months");
  const rule: ScheduleRule = {
    frequency,
    hour: int("hour", 0, 23, 0),
    minute: int("minute", 0, 59, 0),
    weekdays,
    dayOfMonth: int("dayOfMonth", 1, 31, 1),
    // 上限与 delayMinutes 对齐（525600 分钟 = 1 年）：delayMinutes 路径产出的规则
    // 会被原样回传校验，上限不一致时「编辑一个大间隔一次性任务」会莫名保存失败
    ...(frequency === "custom" ? { interval: int("interval", 1, 525_600, 1) } : {}),
    ...(unitOk ? { unit: unit as "minutes" | "hours" | "days" | "weeks" | "months" } : {}),
    ...(typeof r["anchorAt"] === "number" && Number.isFinite(r["anchorAt"]) ? { anchorAt: r["anchorAt"] as number } : {}),
    // 绝对时刻必须原样透传：编辑时表单会把整条规则回传，漏掉这个字段
    // 等于把「10-20 15:09 只跑一次」悄悄降级成「每天 15:09」
    ...(typeof r["runAt"] === "number" && Number.isFinite(r["runAt"]) ? { runAt: r["runAt"] as number } : {}),
  };
  return rule;
}

/**
 * 创建/更新共用的调度入参归一，**四选一**（对齐 ZCode 的 contract）：
 *   delayMinutes ——「N 分钟后」一次性（相对表达以 daemon 时钟为锚，不信客户端换算）
 *   runAt        ——「2026-10-20 15:09 只跑一次」绝对时刻（同样以 daemon 时钟判定过期）
 *   scheduleRule —— 权威规则（anchorAt 缺省 = 现在，即「改频率即重新锚定」）
 *   cron         —— 纯 cron 兼容（调度走 cronNextAt；cron 的整点语义只有它自己算得准）
 */
function resolveSchedule(p: {
  cron?: unknown;
  scheduleRule?: unknown;
  delayMinutes?: unknown;
  runAt?: unknown;
}): { cron: string; rule: ScheduleRule | null; nextRunAt: number | null } {
  if (typeof p.delayMinutes === "number") {
    if (!Number.isFinite(p.delayMinutes) || p.delayMinutes < 1 || p.delayMinutes > 525_600) {
      throw badAutomation("delayMinutes must be 1..525600");
    }
    const rule = buildRelativeDelaySchedule(p.delayMinutes);
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: computeScheduleNextRunAt(rule) };
  }
  // 绝对时刻：过期/不合法直接拒，不静默顺延 —— 「静默改成明天同一时刻」
  // 是最坏的失败形态（用户以为今天会跑，结果明天才跑）
  if (p.runAt !== undefined && p.runAt !== null) {
    if (typeof p.runAt !== "number" || !Number.isFinite(p.runAt)) {
      throw badAutomation("runAt must be a number (epoch ms)");
    }
    // 与 delayMinutes 的互斥同理：runAt 与 scheduleRule/cron 同给时谁优先都是猜，
    // 静默取 runAt 会把另一半参数丢得无声无息 —— 直接拒
    if ((p.scheduleRule !== undefined && p.scheduleRule !== null) || (typeof p.cron === "string" && p.cron.trim() !== "")) {
      throw badAutomation("runAt 与 scheduleRule/cron 只能给一个");
    }
    const now = Date.now();
    if (p.runAt <= now) throw badAutomation("runAt 已经是过去时间了");
    if (p.runAt > now + 365 * 86_400_000) throw badAutomation("runAt 超过一年后，自动化不支持");
    const rule = buildAbsoluteSchedule(p.runAt);
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: p.runAt };
  }
  if (p.scheduleRule !== undefined && p.scheduleRule !== null) {
    const parsed = parseScheduleRule(p.scheduleRule);
    // 带 runAt 的规则不再补 anchorAt：那会把「确切落点」和「从某刻起推」
    // 两套语义混在一条规则里，之后谁读谁懵
    const rule: ScheduleRule =
      parsed.runAt !== undefined ? parsed : parsed.anchorAt === undefined ? { ...parsed, anchorAt: Date.now() } : parsed;
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: computeScheduleNextRunAt(rule) };
  }
  if (typeof p.cron === "string" && p.cron.trim() !== "") {
    parseCron(p.cron); // 坏表达式在创建时就拒，不等 tick 才发现
    return { cron: p.cron, rule: null, nextRunAt: cronNextAt(p.cron) };
  }
  throw badAutomation("需要 cron / scheduleRule / delayMinutes 之一");
}

registerMethod("automation.create", (params) => {
  const p = (params ?? {}) as {
    unitId?: string; unitName?: string; name?: string; runtimeId?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: string;
    cron?: string; scheduleRule?: unknown; delayMinutes?: number; runAt?: number | null;
    recurring?: boolean; maxRuns?: number;
    launchMode?: string;
    dispatchTarget?: string;
    targetSessionId?: string | null;
  };
  if (typeof p.unitId !== "string" || typeof p.runtimeId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string") {
    throw badAutomation("unitId, runtimeId, rootPath, prompt are required");
  }
  if (p.dispatchTarget !== undefined && p.dispatchTarget !== "new_session" && p.dispatchTarget !== "existing_session") {
    throw badAutomation("dispatchTarget 只能是 new_session 或 existing_session");
  }
  // runAt 与 delayMinutes 同为一次性表达，不能同时给（谁优先都是猜）
  if (typeof p.runAt === "number" && typeof p.delayMinutes === "number") {
    throw badAutomation("runAt 与 delayMinutes 只能给一个");
  }
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "headless") {
    throw badAutomation("launchMode 只能是 terminal 或 headless");
  }
  // 绝对时刻与相对延迟同属「一次性」表达：调度/次数口径必须一致，
  // 否则 runAt 建出来的任务会被当成循环任务，一到点就永远跑下去
  const oneShot = typeof p.delayMinutes === "number" || typeof p.runAt === "number";
  if (oneShot && p.recurring === true) {
    throw badAutomation("一次性任务（delayMinutes / runAt）不能配 recurring=true");
  }
  if (typeof p.delayMinutes === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("delayMinutes 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (typeof p.runAt === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("runAt 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (typeof p.maxRuns === "number" && (!Number.isFinite(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 10_000)) {
    throw badAutomation("maxRuns 必须是 1..10000");
  }
  const { cron, rule, nextRunAt } = resolveSchedule(p);
  if (nextRunAt === null) throw badAutomation("当前规则推不出任何未来的触发时间");
  // recurring 缺省 = 循环；显式 false 且未给 maxRuns = 一次性（跑一次收口，ZCode 同口径）。
  // delayMinutes 本质是一次性的相对表达，强制 recurring=false —— 否则它会按间隔永远跑下去。
  const recurring = oneShot ? false : p.recurring !== false;
  const maxRuns = typeof p.maxRuns === "number" ? p.maxRuns : (recurring ? null : 1);
  const unitName = p.unitName ?? p.unitId;
  const id = store.createAutomation({
    unitId: p.unitId,
    unitName,
    name: p.name ?? unitName,
    runtimeId: p.runtimeId,
    rootPath: p.rootPath,
    prompt: p.prompt,
    model: typeof p.model === "string" ? p.model : null,
    mode: typeof p.mode === "string" ? p.mode : null,
    cron,
    scheduleRule: rule,
    recurring,
    maxRuns,
    nextRunAt,
    launchMode: p.launchMode === "headless" ? "headless" : "terminal",
    // 定时发送到已有对话：目标会话可以留空 —— 发火时按执行器最近一个可 resume 的会话回退
    dispatchTarget: p.dispatchTarget === "existing_session" ? "existing_session" : "new_session",
    targetSessionId: typeof p.targetSessionId === "string" && p.targetSessionId !== "" ? p.targetSessionId : null,
  });
  return { id, nextRunAt };
});

registerMethod("automation.update", (params) => {
  const p = (params ?? {}) as {
    id?: number; name?: string; prompt?: string; model?: string | null; mode?: string | null;
    unitId?: string; unitName?: string; runtimeId?: string; rootPath?: string;
    cron?: string; scheduleRule?: unknown; delayMinutes?: number;
    recurring?: boolean; maxRuns?: number | null;
    launchMode?: string;
    dispatchTarget?: string;
    targetSessionId?: string | null;
    runAt?: number | null;
  };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "headless") {
    throw badAutomation("launchMode 只能是 terminal 或 headless");
  }
  if (p.dispatchTarget !== undefined && p.dispatchTarget !== "new_session" && p.dispatchTarget !== "existing_session") {
    throw badAutomation("dispatchTarget 只能是 new_session 或 existing_session");
  }
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  const prev = hit.automation;

  const patch: Partial<Parameters<Store["updateAutomation"]>[1]> = {};
  if (typeof p.name === "string") patch.name = p.name;
  if (p.launchMode === "terminal" || p.launchMode === "headless") patch.launchMode = p.launchMode;
  if (typeof p.prompt === "string") patch.prompt = p.prompt;
  if (p.model !== undefined) patch.model = typeof p.model === "string" ? p.model : null;
  if (p.mode !== undefined) patch.mode = typeof p.mode === "string" ? p.mode : null;
  if (typeof p.unitId === "string") patch.unitId = p.unitId;
  if (typeof p.unitName === "string") patch.unitName = p.unitName;
  if (typeof p.runtimeId === "string") patch.runtimeId = p.runtimeId;
  if (typeof p.rootPath === "string") patch.rootPath = p.rootPath;
  if (p.dispatchTarget === "new_session" || p.dispatchTarget === "existing_session") patch.dispatchTarget = p.dispatchTarget;
  if (p.targetSessionId !== undefined) {
    patch.targetSessionId = typeof p.targetSessionId === "string" && p.targetSessionId !== "" ? p.targetSessionId : null;
  }

  if (typeof p.delayMinutes === "number" && p.recurring === true) {
    throw badAutomation("delayMinutes 是一次性任务，不能配 recurring=true");
  }
  if (typeof p.runAt === "number" && p.recurring === true) {
    throw badAutomation("runAt 是一次性任务，不能配 recurring=true");
  }
  if (typeof p.runAt === "number" && typeof p.delayMinutes === "number") {
    throw badAutomation("runAt 与 delayMinutes 只能给一个");
  }
  if (typeof p.runAt === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("runAt 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (p.maxRuns !== undefined && p.maxRuns !== null &&
      (!Number.isFinite(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 10_000)) {
    throw badAutomation("maxRuns 必须是 1..10000（null = 不限次数）");
  }
  // 次数口径：recurring=false 而 maxRuns 未给 → 补成 1（一次性）。
  // delayMinutes 本质是一次性的相对表达 —— 必须连 recurring 一起强制收口，
  // 否则「只改提示词」的一次性任务保存完就悄悄变成永久循环。
  const delay = typeof p.delayMinutes === "number";
  const absolute = typeof p.runAt === "number";
  const wantsRuns = p.recurring !== undefined || p.maxRuns !== undefined || delay || absolute;
  const recurring = delay || absolute ? false : (p.recurring ?? prev.recurring);
  // 切到一次性表达（delay/runAt）时 maxRuns 强制 1：留着 prev 的 >1 会让一次性
  // 任务跑完后既不到终态也推不出下一次，调度器只能亮「无法推算」的错误徽章
  const maxRuns = p.maxRuns !== undefined
    ? (p.maxRuns === null ? (recurring ? null : 1) : p.maxRuns)
    : delay || absolute
      ? 1
      : ((p.recurring !== undefined && !recurring) && prev.maxRuns === null ? 1 : prev.maxRuns);

  const scheduleChanged = p.cron !== undefined || p.scheduleRule !== undefined || delay || absolute;
  if (scheduleChanged) {
    const resolved = resolveSchedule(p);
    // create 拒「推不出未来」，update 大多数情况同拒 —— 例外：编辑一个已经
    // 发火过的一次性任务（runAt 已成过去）时表单会把原样规则回传，那不是在
    // 改调度，拒掉等于「改个名字都存不了」。识别之：盘上调度原样不动。
    const pastOneShotResubmit =
      resolved.nextRunAt === null && resolved.rule !== null && resolved.rule.runAt !== undefined &&
      resolved.rule.runAt <= Date.now() && p.runAt === undefined && p.delayMinutes === undefined && p.cron === undefined;
    if (resolved.nextRunAt === null && !pastOneShotResubmit) {
      // 否则写下去就是 enabled + next_run_at=null 的无声卡死行
      throw badAutomation("当前规则推不出任何未来的触发时间");
    }
    if (!pastOneShotResubmit) {
      patch.cron = resolved.cron;
      patch.scheduleRule = resolved.rule;
      patch.nextRunAt = resolved.nextRunAt;
      // 重排已发火的一次性任务：terminal 认领时被置 enabled=0，给了新的未来
      // 落点就是明确要再跑，保持停用会无声地永远不跑。只重挂一次性行 ——
      // 手动停用的循环任务改调度，不该被自作主张拉起。
      if (!prev.enabled && prev.recurring === false) patch.enabled = true;
    }
  } else if (wantsRuns) {
    // 只动次数口径：下一个触发点从现有规则重算。
    // 盘上的行可能被手改坏（weekly 缺 weekdays / 坏 cron）——这里抛不得，
    // 落 null 让调度器在下一 tick 把它停用 + 亮徽章。
    try {
      patch.nextRunAt = prev.scheduleRule !== null
        ? computeScheduleNextRunAt(prev.scheduleRule)
        : cronNextAt(prev.cron);
    } catch {
      patch.nextRunAt = null;
    }
  }
  if (wantsRuns) {
    patch.recurring = recurring;
    patch.maxRuns = maxRuns;
  }
  if (scheduleChanged || wantsRuns) scheduler.invalidate(p.id);

  store.updateAutomation(p.id, patch);
  const after = store.getAutomation(p.id);
  return { automation: after?.automation ?? null };
});

registerMethod("automation.list", () => {
  // 卡片需要运行记录（最近运行 / 状态徽章），每条带上最近 10 条
  return store.listAutomations().map((a) => ({ ...a, runs: store.listAutomationRuns(a.id, 10) }));
});
registerMethod("automation.setEnabled", (params) => {
  const p = (params ?? {}) as { id?: number; enabled?: boolean };
  if (typeof p.id !== "number" || typeof p.enabled !== "boolean") {
    throw badAutomation("id and enabled are required");
  }
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  scheduler.invalidate(p.id);
  const changed = store.setAutomationEnabled(p.id, p.enabled);
  // 重新启用一个 next_run_at 为空的行（终态任务被手动拉起）：从现在重算一次，
  // 否则永远没人认领。停用期间「错过」的旧时刻交给 misfire 宽限跳过。
  let nextRunAt = hit.automation.nextRunAt;
  if (p.enabled && nextRunAt === null) {
    const a = hit.automation;
    // 坏 cron / 半损坏的规则在这里会抛 —— 不能让 500 留下 enabled+null 的卡死行。
    // 落 null 交给调度器：下一 tick 会把它停用 + 亮徽章（可见的失败，不是无声的消失）。
    try {
      nextRunAt = a.scheduleRule !== null ? computeScheduleNextRunAt(a.scheduleRule) : cronNextAt(a.cron);
    } catch {
      nextRunAt = null;
    }
    store.updateAutomation(p.id, { nextRunAt });
  }
  return { changed, nextRunAt };
});
registerMethod("automation.delete", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  scheduler.invalidate(p.id);
  return { deleted: store.deleteAutomation(p.id) };
});
registerMethod("automation.runs", (params) => {
  const p = (params ?? {}) as { id?: number; limit?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const limit = typeof p.limit === "number" ? Math.min(Math.max(p.limit, 1), 200) : 20;
  return store.listAutomationRuns(p.id, limit);
});
registerMethod("automation.runNow", async (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  const out = await runAutomation(hit.automation, { trigger: "manual" });
  // 手动触发不消耗 run_count（那是 scheduled 跑的账，一次性任务的终态判断只看它）。
  // 例外：**待发火的一次性任务**手动跑 = 用户明确「现在就跑这次」，排定的那次
  // 必须一并收口 —— 否则到点还会再跑一次，违背「跑一次，跑完即停」的承诺。
  const a = hit.automation;
  if (!a.recurring && (a.maxRuns ?? 1) <= 1 && a.enabled && a.nextRunAt !== null) {
    scheduler.invalidate(a.id);
    // 与调度器认领同款原子收口：next_run_at=null + run_count+1 + enabled=0
    store.markAutomationFired(a.id, null, Date.now(), true);
  }
  return out;
});

// ---- 单元历史（unit.history）---------------------------------------------------
//
// 每个 bot 一条统一时间轴：自动化任务、待办任务、心跳会话、手动/IM 会话。
// 视角是「跑过什么任务」而不是裸会话表：已被运行记录引用的会话归入对应任务
// 条目（不再重复出现），没被引用的会话才按会话条目列出（headless 才有 sessionId，
// 可下钻 session.messages 看对话；TUI 条目只有运行结果摘要）。

interface UnitHistoryEntry {
  key: string;
  kind: "automation" | "backlog" | "session" | "manual";
  unitId?: string;
  unitName?: string;
  title: string;
  subtitle: string | null;
  runtimeId: string;
  launchMode: "terminal" | "headless";
  status: string;
  trigger: string | null;
  startedAt: number;
  endedAt: number | null;
  detail: string | null;
  /** headless 会话的 id（可查 session.messages 下钻）；TUI 运行为 null */
  sessionId: string | null;
  /**
   * 执行器原生会话引用（sessions.cli_ref：claude=cliSessionId、codex=threadId、
   * zcode=原生 id、ACP 系=ref）。TUI 恢复按各家 resume 口径用它，不用我们的内部 id。
   */
  resumeRef: string | null;
  /** 终端运行 id（用于检索终端纯文本日志/transcript） */
  terminalId?: string | null;
}

/**
 * 尝试从各 CLI 原生存储中回溯历史交互式会话的标题与恢复引用（mcode、zcode、claude 等）
 */
function resolveNativeTerminalSession(
  runtimeId: string,
  rootPath: string,
  startedAt: number,
  endedAt: number | null,
): { title: string; resumeRef: string | null } | null {
  const bareRuntime = runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");
  const home = os.homedir();
  const minTime = startedAt - 30_000;
  const maxTime = (endedAt ?? Date.now()) + 30_000;

  if (bareRuntime === "mcode") {
    try {
      const dbPath = path.join(home, ".minimax", "v2", "sqlite", "runtime-state.sqlite");
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        try {
          const base = rootPath ? path.basename(rootPath) : "";
          const pattern = base !== "" ? `%${base}%` : "%";
          const row = db
            .prepare(
              `SELECT session_id, title, created_at_ms FROM local_runtime_sessions
               WHERE workspace_dir LIKE ? AND created_at_ms >= ? AND created_at_ms <= ?
               ORDER BY created_at_ms ASC LIMIT 1`,
            )
            .get(pattern, minTime, maxTime) as Record<string, unknown> | undefined;
          if (row && typeof row["title"] === "string" && row["title"].trim() !== "") {
            return {
              title: String(row["title"]).trim(),
              resumeRef: row["session_id"] ? String(row["session_id"]) : null,
            };
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // 容错
    }
  }

  if (bareRuntime === "zcode") {
    try {
      const dbPath = path.join(home, ".zcode", "cli", "db", "db.sqlite");
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        try {
          const row = db
            .prepare(
              `SELECT id, title, time_created FROM session
               WHERE time_created >= ? AND time_created <= ?
               ORDER BY time_created ASC LIMIT 1`,
            )
            .get(minTime, maxTime) as Record<string, unknown> | undefined;
          if (row && typeof row["title"] === "string" && row["title"].trim() !== "") {
            return {
              title: String(row["title"]).trim(),
              resumeRef: row["id"] ? String(row["id"]) : null,
            };
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // 容错
    }
  }

  if (bareRuntime === "claude") {
    try {
      const histPath = path.join(home, ".claude", "history.jsonl");
      if (existsSync(histPath)) {
        const content = readFileSync(histPath, "utf8");
        const lines = content.split(/\r?\n/).filter(Boolean).slice(-100);
        for (const line of lines) {
          try {
            const data = JSON.parse(line) as Record<string, unknown>;
            const ts = Number(data["timestamp"]);
            if (ts >= minTime && ts <= maxTime && typeof data["display"] === "string" && data["display"].trim() !== "") {
              return {
                title: String(data["display"]).trim(),
                resumeRef: data["sessionId"] ? String(data["sessionId"]) : null,
              };
            }
          } catch {}
        }
      }
    } catch {
      // 容错
    }
  }

  return null;
}

registerMethod("unit.history", async (params) => {
  const p = (params ?? {}) as { unitId?: string; limit?: number };
  const targetUnitId = typeof p.unitId === "string" && p.unitId.trim() !== "" ? p.unitId.trim() : null;
  const limit = Math.min(Math.max(typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.round(p.limit) : 100, 1), 500);

  const entries: UnitHistoryEntry[] = [];
  /** 已被运行记录认领的会话 id（全量，不受单次 limit 影响）：会话条目去重用 */
  const claimedSessionIds = store.getClaimedSessionIds();

  // 预载全部 bot 映射，支持单 bot 历史或跨 bot 全局历史
  const allBots = await botRegistry.listBots().catch(() => []);
  const botMap = new Map(allBots.map((b) => [b.unitId, b]));
  const defaultBotRootPath = targetUnitId ? (botMap.get(targetUnitId)?.rootPath ? String(botMap.get(targetUnitId)?.rootPath) : "") : "";

  for (const a of store.listAutomations()) {
    if (targetUnitId !== null && a.unitId !== targetUnitId) continue;
    const uName = botMap.get(a.unitId)?.name ?? a.unitId;
    for (const r of store.listAutomationRuns(a.id, limit)) {
      const isTerminal = r.sessionId !== null && r.sessionId.startsWith("autoterm_");
      const launchMode: "terminal" | "headless" = isTerminal ? "terminal" : (r.sessionId !== null ? "headless" : a.launchMode);
      entries.push({
        key: `automation-${r.id}`,
        kind: "automation",
        unitId: a.unitId,
        unitName: uName,
        title: a.name,
        subtitle: a.prompt.length > 80 ? `${a.prompt.slice(0, 80)}…` : a.prompt,
        runtimeId: a.runtimeId,
        launchMode,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
        detail: r.detail,
        sessionId: !isTerminal ? r.sessionId : null,
        resumeRef: !isTerminal && r.sessionId !== null
          ? (store.getSession(r.sessionId)?.cliRef ?? null)
          : null,
        terminalId: isTerminal ? r.sessionId : null,
      });
    }
  }

  for (const item of store.listBacklogItems()) {
    if (targetUnitId !== null && item.unitId !== targetUnitId) continue;
    const uName = botMap.get(item.unitId)?.name ?? item.unitName ?? item.unitId;
    for (const r of store.listBacklogRuns(item.id, limit)) {
      const isTerminal = r.sessionId !== null && r.sessionId.startsWith("autoterm_");
      if (r.sessionId !== null && !isTerminal) claimedSessionIds.add(r.sessionId);
      entries.push({
        key: `backlog-${r.id}`,
        kind: "backlog",
        unitId: item.unitId,
        unitName: uName,
        title: item.title,
        subtitle: item.goal.length > 80 ? `${item.goal.slice(0, 80)}…` : item.goal,
        runtimeId: r.runtimeId,
        launchMode: isTerminal ? "terminal" : "headless",
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
        detail: r.detail,
        sessionId: r.sessionId !== null && !isTerminal ? r.sessionId : null,
        resumeRef: r.sessionId !== null && !isTerminal ? (store.getSession(r.sessionId)?.cliRef ?? null) : null,
        terminalId: isTerminal ? r.sessionId : null,
      });
    }
  }

  for (const r of store.listTerminalRuns(targetUnitId ?? undefined, limit)) {
    let title = r.title;
    let resumeRef = r.resumeRef;
    const botRootPath = (botMap.get(r.unitId)?.rootPath ? String(botMap.get(r.unitId)?.rootPath) : "") || defaultBotRootPath;
    if (!title || title === "" || title === "交互式会话") {
      const resolved = resolveNativeTerminalSession(r.runtimeId, botRootPath, r.startedAt, r.finishedAt);
      if (resolved) {
        title = resolved.title;
        resumeRef = resolved.resumeRef;
        store.updateTerminalRunResume(r.id, title, resumeRef);
      }
    }
    entries.push({
      key: `manual-${r.id}`,
      kind: "manual",
      unitId: r.unitId,
      unitName: botMap.get(r.unitId)?.name ?? r.unitName,
      title: title && title !== "" ? title : "交互式会话",
      subtitle: null,
      runtimeId: r.runtimeId,
      launchMode: "terminal",
      status: r.status,
      trigger: "manual",
      startedAt: r.startedAt,
      endedAt: r.finishedAt,
      detail: r.detail,
      sessionId: null,
      resumeRef: resumeRef ?? null,
      terminalId: r.terminalId,
    });
  }

  for (const s of store.listSessions()) {
    if ((targetUnitId !== null && s.unitId !== targetUnitId) || claimedSessionIds.has(s.id)) continue;
    let title = s.title.trim();
    if (title === "" || title === "（无标题会话）") {
      const firstMsg = store.listMessages(s.id, 1)[0];
      if (firstMsg?.text) {
        const line = firstMsg.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
        if (line !== "") {
          title = line.length > 60 ? `${line.slice(0, 60)}…` : line;
        }
      }
    }
    entries.push({
      key: `session-${s.id}`,
      kind: "session",
      unitId: s.unitId,
      unitName: botMap.get(s.unitId)?.name ?? s.unitId,
      title: title === "" ? "（无标题会话）" : title,
      subtitle: null,
      runtimeId: s.runtimeId,
      launchMode: "headless",
      status: s.status,
      trigger: null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      detail: null,
      sessionId: s.id,
      resumeRef: s.cliRef,
      terminalId: null,
    });
  }

  entries.sort((a, b) => b.startedAt - a.startedAt);
  return { entries: entries.slice(0, limit) };
});

// ---- 原生会话历史（history.native.*，docs/13 Phase 1）-------------------------
//
// 会话事实源层：直接读各 CLI 自己的会话存储（~/.pi / ~/.claude / ~/.codex / ~/.grok /
// ~/.minimax / ~/.kimi-code / $DSH_HOME / ~/.zcode / ~/.hermes），只读浏览零进程成本。
// TUI 里聊的、任何入口产生的会话都可见——这是「聊天视图不再形同虚设」的事实源。
// 协议型来源（opencode/openclaw）随 Phase 4 对应 tier 的适配器升级接入。

registerMethod("history.native.list", async (params) => {
  const p = (params ?? {}) as { unitId?: string; executorIds?: unknown; limit?: number };
  const limit = Math.min(Math.max(typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.round(p.limit) : 50, 1), 200);
  const executorIds = Array.isArray(p.executorIds) ? p.executorIds.filter((x): x is string => typeof x === "string") : [];
  // unitId → rootPath 过滤（不传 = 全量跨 bot）
  let rootPath: string | null = null;
  if (typeof p.unitId === "string" && p.unitId.trim() !== "") {
    const bots = await botRegistry.listBots().catch(() => [] as { unitId: string; rootPath?: unknown }[]);
    const bot = bots.find((b) => b.unitId === p.unitId);
    rootPath = bot !== undefined && typeof bot.rootPath === "string" && bot.rootPath !== "" ? bot.rootPath : null;
  }
  const sessions = await listNativeSessions(rootPath, executorIds, limit);
  return { sessions };
});

registerMethod("history.native.detail", async (params) => {
  const p = (params ?? {}) as { executorId?: string; sessionId?: string };
  if (typeof p.executorId !== "string" || typeof p.sessionId !== "string" || p.executorId === "" || p.sessionId === "") {
    throw Object.assign(new Error("executorId 与 sessionId 必填"), { code: "bad_params" });
  }
  const detail = await readNativeSession(p.executorId, p.sessionId);
  if (detail === null) throw Object.assign(new Error("会话不存在或读取失败"), { code: "not_found" });
  return { detail };
});


// ---- 待办 / GTD 方法（backlog.*）----------------------------------------------
//
// 确认门语义：backlog.proposal.confirm / backlog.runNow 都是**用户动作**（弹窗按钮、
// 清单按钮）——引擎自身的心跳只会产生提议，永远到不了 dispatch。权限面零新代码：
// 执行走 source:"automation" 的 headless 链路（权限闸完全放行，deny 规则仍优先）。

const badBacklog = (message: string): Error => Object.assign(new Error(message), { code: "bad_params" });

function requireEngine(): BacklogEngine {
  if (backlogEngine === undefined) throw Object.assign(new Error("backlog engine 未就绪"), { code: "engine_not_ready" });
  return backlogEngine;
}

registerMethod("backlog.list", async () => {
  const engine = requireEngine();
  const [quotas] = await Promise.all([engine.quotas(false)]);
  return {
    items: engine.listItems(),
    proposal: engine.proposal(),
    state: engine.snapshot(),
    config: getBacklogConfig(store),
    quotas,
  };
});

registerMethod("backlog.create", (params) => {
  const p = (params ?? {}) as {
    title?: string; goal?: string; prompt?: string;
    unitId?: string; unitName?: string; rootPath?: string;
    runtimeId?: string; model?: string | null; mode?: string | null; size?: string | null;
    launchMode?: string;
  };
  if (typeof p.goal !== "string" || p.goal.trim() === "") throw badBacklog("goal is required");
  if (typeof p.unitId !== "string" || typeof p.rootPath !== "string" || p.rootPath === "") {
    throw badBacklog("unitId and rootPath are required");
  }
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "headless") {
    throw badBacklog("launchMode 只能是 terminal 或 headless");
  }
  const goal = p.goal.trim();
  const title = typeof p.title === "string" && p.title.trim() !== "" ? p.title.trim() : goal.split(/\r?\n/)[0]!.slice(0, 40);
  const id = store.createBacklogItem({
    title,
    goal,
    prompt: typeof p.prompt === "string" && p.prompt.trim() !== "" ? p.prompt.trim() : draftPromptOf(goal),
    unitId: p.unitId,
    unitName: typeof p.unitName === "string" ? p.unitName : p.unitId,
    rootPath: p.rootPath,
    runtimeId: typeof p.runtimeId === "string" ? p.runtimeId : "",
    model: typeof p.model === "string" && p.model !== "" ? p.model : null,
    mode: typeof p.mode === "string" && p.mode !== "" ? p.mode : null,
    size: p.size === "big" || p.size === "small" ? p.size : null,
    launchMode: p.launchMode === "headless" ? "headless" : "terminal",
    source: "manual",
  });
  const item = store.getBacklogItem(id);
  return { id, item: item === undefined ? null : requireEngine().toItem(item) };
});

registerMethod("backlog.update", (params) => {
  const p = (params ?? {}) as {
    id?: number; title?: string; goal?: string; prompt?: string;
    unitId?: string; unitName?: string; rootPath?: string;
    runtimeId?: string; model?: string | null; mode?: string | null; size?: string | null;
    launchMode?: string;
  };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "headless") {
    throw badBacklog("launchMode 只能是 terminal 或 headless");
  }
  const hit = store.getBacklogItem(p.id);
  if (hit === undefined) throw Object.assign(new Error(`没有这个待办：${p.id}`), { code: "unknown_item" });
  if (hit.status === "executing") throw badBacklog("执行中的待办不能编辑 —— 等它跑完或打回后再改");
  store.updateBacklogItem(p.id, {
    ...(typeof p.title === "string" && p.title.trim() !== "" ? { title: p.title.trim() } : {}),
    ...(typeof p.goal === "string" && p.goal.trim() !== "" ? { goal: p.goal.trim() } : {}),
    ...(typeof p.prompt === "string" && p.prompt.trim() !== "" ? { prompt: p.prompt.trim() } : {}),
    ...(typeof p.unitId === "string" ? { unitId: p.unitId } : {}),
    ...(typeof p.unitName === "string" ? { unitName: p.unitName } : {}),
    ...(typeof p.rootPath === "string" && p.rootPath !== "" ? { rootPath: p.rootPath } : {}),
    ...(typeof p.runtimeId === "string" ? { runtimeId: p.runtimeId } : {}),
    ...(p.model !== undefined ? { model: typeof p.model === "string" && p.model !== "" ? p.model : null } : {}),
    ...(p.mode !== undefined ? { mode: typeof p.mode === "string" && p.mode !== "" ? p.mode : null } : {}),
    ...(p.size !== undefined ? { size: p.size === "big" || p.size === "small" ? p.size : null } : {}),
    ...(p.launchMode === "terminal" || p.launchMode === "headless" ? { launchMode: p.launchMode } : {}),
  });
  const item = store.getBacklogItem(p.id);
  return { item: item === undefined ? null : requireEngine().toItem(item) };
});

registerMethod("backlog.delete", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  const hit = store.getBacklogItem(p.id);
  if (hit !== undefined && hit.status === "executing") throw badBacklog("执行中的待办不能删除 —— 先等它跑完");
  return { deleted: store.deleteBacklogItem(p.id) };
});

/** 手动排序：传全量 id 顺序（顺序即优先级） */
registerMethod("backlog.reorder", (params) => {
  const p = (params ?? {}) as { ids?: unknown };
  if (!Array.isArray(p.ids)) throw badBacklog("ids (number[]) is required");
  const ids = p.ids.map(Number).filter((n) => Number.isInteger(n));
  ids.forEach((id, i) => store.updateBacklogItem(id, { sortPos: (i + 1) * 1000 }));
  return { reordered: ids.length };
});

registerMethod("backlog.wake", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  requireEngine().wake(p.id);
  return { ok: true };
});

registerMethod("backlog.sleep", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  requireEngine().sleep(p.id);
  return { ok: true };
});

/** 确认门 —— 确认当前提议（执行器可在此时改选，选择记忆回待办） */
registerMethod("backlog.proposal.confirm", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; model?: string | null };
  return requireEngine().confirm({
    ...(typeof p.runtimeId === "string" && p.runtimeId !== "" ? { runtimeId: p.runtimeId } : {}),
    ...(p.model !== undefined ? { model: typeof p.model === "string" && p.model !== "" ? p.model : null } : {}),
  });
});

registerMethod("backlog.proposal.reject", () => {
  requireEngine().reject();
  return { ok: true };
});

/** 验收：pass=true 关闭；打回 = 回就绪重新排队（可附一句话备注） */
registerMethod("backlog.review", (params) => {
  const p = (params ?? {}) as { id?: number; pass?: boolean; note?: string };
  if (typeof p.id !== "number" || typeof p.pass !== "boolean") throw badBacklog("id and pass are required");
  requireEngine().review(p.id, p.pass, typeof p.note === "string" && p.note.trim() !== "" ? p.note.trim() : null);
  return { ok: true };
});

/** 用户在清单上点「立即执行」——按钮本身即确认动作（与 automation.runNow 同口径） */
registerMethod("backlog.runNow", (params) => {
  const p = (params ?? {}) as { id?: number; runtimeId?: string; model?: string | null };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  const hit = store.getBacklogItem(p.id);
  if (hit === undefined) throw Object.assign(new Error(`没有这个待办：${p.id}`), { code: "unknown_item" });
  if (hit.status === "executing") throw badBacklog("这条待办已在执行中");
  const runtimeId = typeof p.runtimeId === "string" && p.runtimeId !== "" ? p.runtimeId : hit.runtimeId;
  if (runtimeId === undefined || runtimeId === "") throw badBacklog("没有配置执行器 —— 先编辑待办选一个，或在弹窗里选");
  const model = p.model !== undefined ? (typeof p.model === "string" && p.model !== "" ? p.model : null) : hit.model;
  return requireEngine().dispatch(hit, runtimeId, model, "manual");
});

registerMethod("backlog.config.get", () => getBacklogConfig(store));
registerMethod("backlog.config.set", (params) => {
  const p = (params ?? {}) as { patch?: unknown };
  const next = setBacklogConfig(store, p.patch);
  return { config: next };
});

registerMethod("backlog.quotas", async (params) => {
  const p = (params ?? {}) as { refresh?: boolean };
  return { quotas: await requireEngine().quotas(p.refresh === true) };
});

// 续跑判定快照：给前端解释「为什么现在有 / 没有那条续跑任务」。
// 只读，不触发探测 —— 想强制刷新走 backlog.quotas 的 refresh。
registerMethod("quotaResume.state", () => {
  const cfg = getBacklogConfig(store);
  return { enabled: cfg.quotaResume.enabled, config: cfg.quotaResume, states: quotaResumeWatcher.snapshot() };
});

registerMethod("backlog.state.forceBusy", (params) => {
  const p = (params ?? {}) as { on?: boolean };
  if (typeof p.on !== "boolean") throw badBacklog("on is required");
  requireEngine().setForceBusy(p.on);
  return { ok: true, snapshot: requireEngine().snapshot() };
});

/** 手动触发一跳（测试/演示）：跳过周期与空闲判定，其余护栏（单飞/强制忙碌）照旧。
 * 受理即返 —— 跳动本身要跑一个心跳会话（几十秒），结果从 state/items 信号帧观察。 */
registerMethod("backlog.heartbeat.force", () => {
  void requireEngine().forceBeat();
  return { started: true };
});

registerMethod("backlog.consolidate.run", (params) => {
  const p = (params ?? {}) as { force?: boolean };
  return requireEngine().consolidate(p.force !== false);
});



// ---- 记忆方法（docs/10）-----------------------------------------------------
//
// 旧的 memory.save/search/list（Phase 7 三柱 + sqlite 路由）保留在下面继续可用，
// 但**新记忆系统不走它**：项目记忆是文件（memory.project.*），跨会话检索是
// 现场扫源目录（memory.searchAll / steward.search）。保留旧方法是刻意的 ——
// 前端还在用，且 `memory.weknora` 配置 v2 要接着用。

registerMethod("memory.project.read", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  return readLongTerm(p.rootPath);
});
registerMethod("memory.project.write", (params) => {
  const p = (params ?? {}) as { rootPath?: string; content?: string };
  if (typeof p.rootPath !== "string" || typeof p.content !== "string") {
    throw Object.assign(new Error("rootPath and content are required"), { code: "bad_params" });
  }
  return writeLongTerm(p.rootPath, p.content, { homeDir: config.homeDir });
});
registerMethod("memory.project.daily", (params) => {
  const p = (params ?? {}) as { rootPath?: string; date?: string; limit?: number };
  if (typeof p.rootPath !== "string") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  if (typeof p.date === "string" && p.date !== "") return readDaily(p.rootPath, p.date);
  return listDaily(p.rootPath);
});

/** 后台守护引擎配置获取与更新 */
registerMethod("memory.guardian.get", () => {
  return getGuardianConfig(store);
});
registerMethod("memory.guardian.set", (params) => {
  const patch = (params ?? {}) as Partial<MemoryGuardianConfig>;
  return setGuardianConfig(store, patch);
});

/** 记忆超限自愈合并执行 */
registerMethod("memory.consolidate", async (params) => {
  const p = (params ?? {}) as { rootPath?: string; force?: boolean };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  const guardianCfg = getGuardianConfig(store);
  return maybeConsolidate(p.rootPath, guardianCfg, { homeDir: config.homeDir, force: p.force === true });
});

/** 分发日志：这一轮注入了什么（docs/10 §5 UI 要的那一屏） */
registerMethod("memory.dispatches", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string" || p.sessionId === "") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return store.listDispatches(p.sessionId);
});

/** 跨会话追溯搜索。权限在这一层钉死（docs/10 红线 6）。 */
registerMethod("steward.search", async (params) => {
  const p = (params ?? {}) as {
    botId?: string; query?: string; limit?: number; pathHint?: string; withContext?: boolean; halfLifeDays?: number;
    sinceDays?: number; maxBytesPerCli?: number;
  };
  if (typeof p.query !== "string" || p.query.trim() === "") throw Object.assign(new Error("query is required"), { code: "bad_params" });

  // 身份解析有三种情况，**不能混**：
  // - 不给 botId            → 这是工作台自身的调用（设置页试跑等），按管家算
  // - 给了 botId 且查得到   → 按该 bot 定义判权限
  // - 给了 botId 但查不到   → **拒绝**。曾在这里回落成管家，等于「报个不存在的
  //                           bot 名就能拿到跨项目检索权」——冒烟抓出来的真漏洞。
  let requester: Record<string, unknown>;
  if (typeof p.botId !== "string" || p.botId === "") {
    requester = { id: STEWARD_ID, role: STEWARD_ID, crossSearch: true };
  } else {
    const def = await botRegistry.getBot(p.botId);
    if (def === undefined) {
      throw Object.assign(new Error(`没有这个 bot：${p.botId}`), { code: "unknown_bot" });
    }
    requester = def;
  }

  // 交互式搜索**必须有时间窗和字节上限**。
  //
  // 实测代价（2026-10-04，本机 1.6 GB 语料）：无索引的全量扫描是真花钱的 ——
  // JSON.parse + 切块 + bigram，单次全量能吃掉几分钟 CPU。所以默认值取
  // 「够快」而不是「够全」：
  //   - since 默认 365 天前（mtime 预筛直接跳过老文件，比全量快两个数量级）
  //   - 每家 128 MB 上限（4 家合计 512 MB 是解析成本的红线）
  // 想要更多就把 sinceDays / maxBytesPerCli 显式调大 —— 那是用户的选择，
  // 不该由默认值替他承担。
  const sinceDays = p.sinceDays ?? 365;
  const maxBytesPerCli = p.maxBytesPerCli ?? 128 * 1024 * 1024;

  return stewardSearch(requester, {
    query: p.query,
    since: Date.now() - sinceDays * 86_400_000,
    limitBytesPerCli: maxBytesPerCli,
    ...(p.limit === undefined ? {} : { limit: p.limit }),
    ...(p.pathHint === undefined ? {} : { pathHint: p.pathHint }),
    withContext: p.withContext === true,
    ...(p.halfLifeDays === undefined ? {} : { halfLifeDays: p.halfLifeDays }),
  });
});
registerMethod("steward.recent", () => stewardRecent(config.homeDir));

// ---- curator（docs/10 §4.7）------------------------------------------------

/** 记忆条目的遥测视图（curator 的判断依据，也是 UI 要显示的「多久没用了」）。 */
registerMethod("memory.telemetry", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath === "string" && p.rootPath !== "") return store.listMemoryMeta(p.rootPath);
  return store.listMemoryMeta();
});

registerMethod("curator.run", async (params) => {
  const p = (params ?? {}) as {
    rootPath?: string; dryRun?: boolean; now?: number;
    intervalHours?: number; minIdleHours?: number; staleAfterDays?: number; archiveAfterDays?: number;
  };
  const rootPath = typeof p.rootPath === "string" && p.rootPath !== "" ? p.rootPath : stewardRoot(config.homeDir);
  const cfg: CuratorConfig = {
    ...DEFAULT_CURATOR,
    ...(p.dryRun === undefined ? {} : { dryRun: p.dryRun }),
    ...(p.intervalHours === undefined ? {} : { intervalHours: p.intervalHours }),
    ...(p.minIdleHours === undefined ? {} : { minIdleHours: p.minIdleHours }),
    ...(p.staleAfterDays === undefined ? {} : { staleAfterDays: p.staleAfterDays }),
    ...(p.archiveAfterDays === undefined ? {} : { archiveAfterDays: p.archiveAfterDays }),
  };
  const r = await runCurator(
    rootPath,
    { meta: new DbMetaStore(store), homeDir: config.homeDir },
    cfg,
    p.now === undefined ? {} : { now: p.now },
  );
  // 报告落盘（hermes 做法）：run.json 机器可读 + REPORT.md 人读
  try {
    const dir = path.join(config.homeDir, "logs", "curator", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "run.json"), JSON.stringify(r, null, 2), "utf8");
    await writeFile(path.join(dir, "REPORT.md"), renderReport(r, cfg), "utf8");
    return { ...r, reportDir: dir };
  } catch (err: unknown) {
    log.warn("curator report write failed", { error: err instanceof Error ? err.message : String(err) });
    return r;
  }
});

/** 每日总结任务（docs/10 §4.5）。dryRun=true 时只报不写。 */
registerMethod("memory.digest.run", async (params) => {
  const p = (params ?? {}) as { date?: string; dryRun?: boolean; force?: boolean };
  const digest = new DailyDigest(config.homeDir, { knownProjects: botRegistry.roots() });
  return digest.run({
    ...(p.date === undefined ? {} : { date: p.date }),
    ...(p.dryRun === undefined ? {} : { dryRun: p.dryRun }),
    ...(p.force === undefined ? {} : { force: p.force }),
  });
});

registerMethod("memory.save", (params) => {
  const p = (params ?? {}) as { pillar?: string; content?: string; source?: string; backends?: string[] };
  if (typeof p.pillar !== "string" || typeof p.content !== "string") {
    throw Object.assign(new Error("pillar and content are required"), { code: "bad_params" });
  }
  return memory.save({ pillar: p.pillar as never, content: p.content, source: p.source, backends: p.backends as never });
});
registerMethod("memory.search", (params) => {
  const p = (params ?? {}) as { query?: string; pillars?: string[]; backends?: string[]; topK?: number };
  if (typeof p.query !== "string") throw Object.assign(new Error("query is required"), { code: "bad_params" });
  return memory.search({ query: p.query, pillars: p.pillars as never, backends: p.backends as never, topK: p.topK });
});
registerMethod("memory.list", (params) => {
  const p = (params ?? {}) as { pillar?: string };
  if (typeof p.pillar !== "string") throw Object.assign(new Error("pillar is required"), { code: "bad_params" });
  return memory.list(p.pillar as never);
});
// ---- Bot 注册表（docs/08 WP-5）：bot 定义的落盘面 <rootPath>/.agent-workbench/bot.json ----
registerMethod("bot.put", (params) => {
  const p = (params ?? {}) as {
    unit?: Record<string, unknown>;
    ifRevision?: number;
    ifAgentsMdHash?: string;
  };
  if (p.unit === undefined || typeof p.unit !== "object") {
    throw Object.assign(new Error("unit is required"), { code: "bad_params" });
  }
  const opts: { ifRevision?: number; ifAgentsMdHash?: string } = {};
  if (typeof p.ifRevision === "number") opts.ifRevision = p.ifRevision;
  if (typeof p.ifAgentsMdHash === "string") opts.ifAgentsMdHash = p.ifAgentsMdHash;
  return botRegistry.putBot(p.unit, opts);
});
// 渠道连通性诊断（向导第三步 / docs/09 §五）。配错了以前只有一行 warn，
// 界面上表现为「绑了没反应」，两边对不上。
registerMethod("channel.diagnose", async (params) => {
  const p = (params ?? {}) as { botId?: string; accountId?: string };
  if (typeof p.botId !== "string" || p.botId === "") {
    throw Object.assign(new Error("botId is required"), { code: "bad_params" });
  }
  const specs = feishuGateway.specsOf(p.botId);
  const one = p.accountId === undefined ? (specs[0] ?? null) : feishuGateway.specOf(p.botId, p.accountId);
  if (one === null) {
    throw Object.assign(
      new Error(`bot ${p.botId} 没有可诊断的飞书账号（没配 profile / 已停用）`),
      { code: "no_channel" },
    );
  }
  return diagnoseLarkAccount(one);
});
// 主动出站：让 bot 主动开口（日报、告警、自动化结果）。之前只有回程。
registerMethod("channel.send", async (params) => {
  const p = (params ?? {}) as { botId?: string; accountId?: string; receiveId?: string; text?: string };
  if (typeof p.botId !== "string" || p.botId === "") throw Object.assign(new Error("botId is required"), { code: "bad_params" });
  if (typeof p.receiveId !== "string" || p.receiveId === "") throw Object.assign(new Error("receiveId (chat_id) is required"), { code: "bad_params" });
  if (typeof p.text !== "string" || p.text === "") throw Object.assign(new Error("text is required"), { code: "bad_params" });
  return feishuGateway.sendTo(p.botId, p.accountId ?? "main", p.receiveId, p.text);
});
registerMethod("bot.list", () => botRegistry.listBots());
// ---- 外观（appearance）—— <homeDir>/appearance.json，用户可让 agent 直接改这个文件 ----
registerMethod("appearance.read", async () => {
  const meta = await readAppearance(config.homeDir);
  // 壁纸单独带回来：图不进 JSON，否则那个文件会大到没法手改
  const wallpaperDataUrl = meta.exists
    ? await readWallpaperDataUrl(config.homeDir, meta.wallpaperRel)
    : null;
  return { ...meta, wallpaperDataUrl };
});
registerMethod("appearance.write", async (params) => {
  const p = (params ?? {}) as { content?: string; expectedHash?: string | null };
  if (typeof p.content !== "string") {
    throw Object.assign(new Error("content is required"), { code: "bad_params" });
  }
  return writeAppearance(config.homeDir, p.content, { expectedHash: p.expectedHash ?? null });
});
// 落一张壁纸到 <homeDir>/wallpapers/，返回该写进 appearance.json 的 wallpaper.path
registerMethod("appearance.wallpaper.save", async (params) => {
  const p = (params ?? {}) as { name?: string; base64?: string };
  if (typeof p.name !== "string" || typeof p.base64 !== "string") {
    throw Object.assign(new Error("name and base64 are required"), { code: "bad_params" });
  }
  return saveWallpaper(config.homeDir, p.name, Buffer.from(p.base64, "base64"));
});
registerMethod("appearance.wallpaper.delete", async (params) => {
  const p = (params ?? {}) as { path?: string };
  return { deleted: await deleteWallpaper(config.homeDir, p.path ?? null) };
});
// ---- 出图供应商 profile —— <homeDir>/image-profiles.json，密钥永不下发浏览器 ----
registerMethod("image.profiles.list", () => {
  return imageProfiles.listMasked();
});
registerMethod("image.profiles.put", (params) => {
  const p = (params ?? {}) as Partial<ImageProfileRow> & { id?: string };
  if (typeof p.id !== "string" || p.id === "") {
    throw Object.assign(new Error("id is required"), { code: "bad_params" });
  }
  return imageProfiles.put(p as Partial<ImageProfileRow> & { id: string });
});
registerMethod("image.profiles.delete", (params) => {
  const p = (params ?? {}) as { id?: string };
  if (typeof p.id !== "string" || p.id === "") {
    throw Object.assign(new Error("id is required"), { code: "bad_params" });
  }
  return { deleted: imageProfiles.delete(p.id) };
});
// 目录探测（docs/09 §七 P0-B）：纯读，导入对话框三分支全靠它决定
registerMethod("bot.inspect", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  return botRegistry.inspect(p.rootPath);
});
// bot.json 里有渠道密钥时，导入一个 git 仓库前必须能一键补 .gitignore
registerMethod("bot.gitignore.ensure", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  return botRegistry.ensureGitignore(p.rootPath);
});
// 渠道运行态：bot.json 声明了什么 vs 网关实际起没起。docs/09 §五的状态徽标要靠它
registerMethod("channel.status", async () => {
  const bots = await botRegistry.listBots();
  return {
    // 各网关当前真正持有的账号数
    gateways: { feishu: feishuGateway.activeAccounts, telegram: telegramGateway.activeAccountCount },
    bots: bots.map((b) => {
      const declared = Array.isArray(b.channels) ? (b.channels as Array<Record<string, unknown>>) : [];
      return {
        id: String(b.id ?? ""),
        channels: declared.map((c) => ({
          kind: String(c["kind"] ?? ""),
          enabled: c["enabled"] === true,
          accounts: Array.isArray(c["accounts"]) ? (c["accounts"] as unknown[]).length : 0,
        })),
      };
    }),
  };
});
// 「这个 bot 接的是哪个飞书机器人」——名字 + 头像，不是 profile 字符串。
// profile 形如 cli_a94d…，界面上没人认得出那是哪个机器人。
registerMethod("channel.identity", async (params) => {
  const p = (params ?? {}) as { profiles?: unknown };
  // 设置页正在配、还没保存的草稿 profile 也要能认：显式传 profiles 走这条
  if (Array.isArray(p.profiles)) {
    return larkIdentities(p.profiles.filter((x): x is string => typeof x === "string"));
  }
  // 不传参数 = 盘上所有启用的飞书账号。走网关的规格表而不是 raw bot.json：
  // 那张表已经滤掉了没 profile 的旧格式账号，认它们只会得到一片报错
  const bots = await botRegistry.listBots();
  const profiles: string[] = [];
  for (const b of bots) {
    for (const s of feishuGateway.specsOf(String(b.id ?? ""))) profiles.push(s.profile);
  }
  return larkIdentities(profiles);
});
// 绑定向导的「本机有哪些飞书机器人」。profile list 的字段用户没法用来指认，
// 所以逐个认过脸再回——界面上才是能点的「飞书 CLI」「日报助手」而不是一串 ID。
registerMethod("channel.profiles", () => larkProfileList());
// 建一个新机器人（= 加一个 lark-cli profile）。
// ⚠ appSecret 走 stdin 交给 lark-cli，不进 argv、不落盘到本仓库、不回传、
// 不写日志。lark-cli 自己把它存进系统钥匙串，config.json 里只留一个句柄。
// 一次调用就把「写盘结果 + 认脸结果」一起返回：CLI 写盘成功**不代表**机器人能用，
// 界面没有机会只显示「创建成功」就骗过去。
registerMethod("channel.profile.add", (params) => {
  const p = (params ?? {}) as { name?: unknown; appId?: unknown; appSecret?: unknown };
  if (typeof p.name !== "string" || typeof p.appId !== "string" || typeof p.appSecret !== "string") {
    throw Object.assign(new Error("name / appId / appSecret are required"), { code: "bad_params" });
  }
  return addLarkProfile({ name: p.name, appId: p.appId, appSecret: p.appSecret });
});
registerMethod("bot.roots.add", (params) => {
  const p = (params ?? {}) as { dir?: string };
  if (typeof p.dir !== "string" || p.dir === "") throw Object.assign(new Error("dir is required"), { code: "bad_params" });
  botRegistry.addRoot(p.dir);
  return { roots: botRegistry.roots() };
});
// 把一条文本交给 bot 并等轮落定拿回全文（WP-9：MCP ask_bot / webhook 的内核入口）
registerMethod("bot.ask", (params) => {
  const p = (params ?? {}) as {
    botId?: string;
    text?: string;
    waitMs?: number;
    memoryOptions?: {
      scopes?: readonly ("semantic" | "daily" | "procedural")[];
      dailyDate?: string;
      dailyLimit?: number;
    };
  };
  if (typeof p.botId !== "string" || typeof p.text !== "string") {
    throw Object.assign(new Error("botId and text are required"), { code: "bad_params" });
  }
  // 评审 P3：waitMs 设上限，防误设大值无限占住 WS RPC
  const waitMs = typeof p.waitMs === "number" ? Math.min(Math.max(p.waitMs, 1_000), 600_000) : undefined;
  return askBot(botRegistry, host, p.botId, p.text, { waitMs, source: "webhook", memoryOptions: p.memoryOptions });
});

registerMethod("memory.routing.get", () => memory.getRouting());
registerMethod("memory.routing.set", (params) => {
  const p = (params ?? {}) as { routing?: Record<string, string[]> };
  if (p.routing === undefined || typeof p.routing !== "object") {
    throw Object.assign(new Error("routing is required"), { code: "bad_params" });
  }
  return memory.setRouting(p.routing as never);
});
registerMethod("memory.weknora.config.get", () => memory.weknoraGetConfig());
registerMethod("memory.weknora.config.set", (params) => {
  const p = (params ?? {}) as { baseUrl?: string; apiKey?: string; kbIds?: string[] };
  if (typeof p.baseUrl !== "string") throw Object.assign(new Error("baseUrl is required"), { code: "bad_params" });
  memory.weknoraSetConfig({ baseUrl: p.baseUrl, apiKey: p.apiKey, kbIds: p.kbIds });
  return memory.weknoraGetConfig();
});
registerMethod("memory.mirror", () => memory.readMirror());

registerMethod("adapter.list", (params) => {
  const p = params as { sync?: boolean } | null;
  return host.listAdapters(p?.sync ?? false);
});
registerMethod("adapter.probe", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.probe(runtimeId);
});
/**
 * 模型清单刷新 —— 「重新探测模型」按钮的落点，与 adapter.probe **互不相干**。
 *
 * 返回值同时给两份：刷新报告（谁是真探到的、谁退回了兜底）+ 刷新后的完整适配器清单。
 * 一次往返就能把界面更新到位，不必让前端再补一次 adapter.list（那个接口的 models
 * 是注册时的快照，正是「后端刷了、界面不更新」这个老 bug 的根源）。
 *
 * 零用量：这条路径只跑各 CLI 的只读列清单命令或读本地目录文件，不发 prompt、不起 turn。
 */
registerMethod("adapter.models", async (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (runtimeId !== undefined && typeof runtimeId !== "string") {
    throw Object.assign(new Error("runtimeId must be a string when provided"), { code: "bad_params" });
  }
  const report = await host.syncModels(runtimeId);
  return { report, adapters: await host.listAdapters(false) };
});
registerMethod("adapter.commands", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; rootPath?: string };
  if (typeof p.runtimeId !== "string" || typeof p.rootPath !== "string") {
    throw Object.assign(new Error("runtimeId and rootPath are required"), { code: "bad_params" });
  }
  // 空清单 = 该执行器没有原生命令面（UI 菜单回落工作台本地命令），不是错误
  return host.listCommands(p.runtimeId, p.rootPath);
});

/**
 * 技能清单（设置页「技能」分区）—— 按技能源分组返回全部技能（含已停用），
 * 每组带「读取该源的执行器」作影响范围提示。rootPath 可选：给了才纳入项目级源。
 */
registerMethod("skills.inventory", async (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const adapters = await host.listAdapters(false);
  const names = new Map(adapters.map((a) => [a.id, a.displayName]));
  return buildSkillsInventory(rootPath, (id) => names.get(id) ?? id);
});

/**
 * 技能停用/恢复 —— 在已知技能源内把文件夹搬进/搬出 `.disabled/`。
 * 原生配置文件是唯一真相源：搬完即生效（发现层与 ZCode 原生都不扫点目录），
 * 这里只补一件事——立刻失效受影响执行器的命令缓存，别让斜杠菜单显示旧世界。
 */
registerMethod("skills.copy", (params) => {
  const p = (params ?? {}) as { fromSourceDir?: string; dirName?: string; toSourceDir?: string; rootPath?: string };
  if (typeof p.fromSourceDir !== "string" || typeof p.dirName !== "string" || typeof p.toSourceDir !== "string") {
    throw Object.assign(new Error("fromSourceDir, dirName and toSourceDir are required"), { code: "bad_params" });
  }
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const result = copySkill(p.fromSourceDir, p.dirName, p.toSourceDir, rootPath);
  host.invalidateCommandsFor(result.readers);
  return { ok: true, readers: result.readers };
});

registerMethod("skills.setDisabled", (params) => {
  const p = (params ?? {}) as { sourceDir?: string; dirName?: string; disabled?: boolean; rootPath?: string };
  if (typeof p.sourceDir !== "string" || typeof p.dirName !== "string" || typeof p.disabled !== "boolean") {
    throw Object.assign(new Error("sourceDir, dirName and disabled are required"), { code: "bad_params" });
  }
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const result = setSkillDisabled(p.sourceDir, p.dirName, p.disabled, rootPath);
  host.invalidateCommandsFor(result.readers);
  return { ok: true, readers: result.readers };
});

// ---- MCP 管理（ADR 0004：原生配置文件是唯一真相源，这里只做外科手术式读写） ----

const mcpDeps: McpServiceDeps = { configHome: os.homedir(), stateHome: config.homeDir };

registerMethod("mcp.inventory", () => mcpInventory(mcpDeps));

registerMethod("mcp.save", (params) => {
  const p = (params ?? {}) as { executorId?: string; entry?: unknown; expectedSha?: string };
  if (typeof p.executorId !== "string") throw Object.assign(new Error("executorId is required"), { code: "bad_params" });
  const entry = sanitizeEntry(p.entry);
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  return mcpSave(mcpDeps, p.executorId, entry, expectedSha);
});

registerMethod("mcp.remove", (params) => {
  const p = (params ?? {}) as { executorId?: string; name?: string; toVault?: boolean; expectedSha?: string };
  if (typeof p.executorId !== "string" || typeof p.name !== "string") {
    throw Object.assign(new Error("executorId and name are required"), { code: "bad_params" });
  }
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  // toVault 严格布尔：字符串 "false" 这类 truthy 会静默当 true（与 setEnabled 的口径对齐）
  return mcpRemove(mcpDeps, p.executorId, p.name, { toVault: typeof p.toVault === "boolean" ? p.toVault : true, expectedSha });
});

registerMethod("mcp.setEnabled", (params) => {
  const p = (params ?? {}) as { executorId?: string; name?: string; enabled?: boolean; expectedSha?: string };
  if (typeof p.executorId !== "string" || typeof p.name !== "string" || typeof p.enabled !== "boolean") {
    throw Object.assign(new Error("executorId, name and enabled are required"), { code: "bad_params" });
  }
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  return mcpSetEnabled(mcpDeps, p.executorId, p.name, p.enabled, expectedSha);
});

registerMethod("mcp.copy", (params) => {
  const p = (params ?? {}) as {
    fromExecutorId?: string; name?: string; toExecutorIds?: unknown; expectedShas?: Record<string, string>;
  };
  if (typeof p.fromExecutorId !== "string" || typeof p.name !== "string" || !Array.isArray(p.toExecutorIds)) {
    throw Object.assign(new Error("fromExecutorId, name and toExecutorIds are required"), { code: "bad_params" });
  }
  const targets = p.toExecutorIds.filter((x): x is string => typeof x === "string");
  // 指纹只收字符串值：非字符串（空串/数字）会被 assertSha 当成有效指纹比对而必判 conflict
  const expectedShas =
    p.expectedShas !== null && typeof p.expectedShas === "object"
      ? Object.fromEntries(Object.entries(p.expectedShas).filter((kv): kv is [string, string] => typeof kv[1] === "string" && kv[1] !== ""))
      : {};
  return mcpCopy(mcpDeps, p.fromExecutorId, p.name, targets, expectedShas);
});

registerMethod("mcp.read", (params) => {
  const p = (params ?? {}) as { executorId?: string };
  if (typeof p.executorId !== "string") throw Object.assign(new Error("executorId is required"), { code: "bad_params" });
  return mcpReadFile(mcpDeps, p.executorId);
});
registerMethod("session.start", (params) => {
  // params 在协议里是可选的（wsd 的信封声明 params?: unknown）——
  // 缺了要当 bad_params 报，不能 `params as {...}` 后直接读属性（TypeError → internal）
  const p = (params ?? {}) as {
    runtimeId?: string; unitId?: string; unitName?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: "plan" | "build" | "edit" | "yolo";
    reasoningLevel?: string;
    memoryOptions?: {
      scopes?: readonly ("semantic" | "daily" | "procedural")[];
      dailyDate?: string;
      dailyLimit?: number;
    };
  };
  if (typeof p.runtimeId !== "string" || typeof p.unitId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string") {
    throw Object.assign(new Error("runtimeId, unitId, rootPath, prompt are required"), { code: "bad_params" });
  }
  return host.startSession({
    runtimeId: p.runtimeId,
    unitId: asUnitId(p.unitId),
    unitName: p.unitName ?? p.unitId,
    rootPath: p.rootPath,
    prompt: p.prompt,
    model: typeof p.model === "string" ? asModelId(p.model) : null,
    mode: p.mode,
    reasoningLevel: p.reasoningLevel,
    memoryOptions: p.memoryOptions,
  });
});
registerMethod("session.send", (params) => {
  const p = (params ?? {}) as { sessionId?: string; text?: string; reasoningLevel?: string };
  if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
    throw Object.assign(new Error("sessionId and text are required"), { code: "bad_params" });
  }
  return host.sendMessage(asSessionId(p.sessionId), p.text, { reasoningLevel: p.reasoningLevel });
});
registerMethod("session.cancel", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return host.cancelSession(asSessionId(sessionId));
});
registerMethod("session.list", () => host.listSessions());

/**
 * 可续接的对话清单 —— 「定时发送到已有对话」的下拉数据源。
 *
 * 口径必须是 **cli_ref 非空**，不是「所有历史会话」：首轮都没跑完的会话拿不到
 * 执行器侧引用，resumeSession 会直接抛 no_cli_ref。把它们列进选择器，
 * 用户选了就是选了个必然失败的项 —— 「能选到的就一定能用」是这个列表唯一
 * 的承诺。runtimeId 可选，给了只列该执行器的。
 */
registerMethod("session.resumable", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; limit?: number };
  const limit = Math.min(50, Math.max(1, Math.round(Number(p.limit)) || 20));
  const only = typeof p.runtimeId === "string" && p.runtimeId !== "" ? p.runtimeId : null;
  const out = store
    .listSessions()
    .filter((s) => s.cliRef !== null && (only === null || s.runtimeId === only))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: s.title,
      runtimeId: s.runtimeId,
      unitId: s.unitId,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      lastActiveAt: s.endedAt ?? s.startedAt,
    }));
  return { sessions: out };
});
registerMethod("session.resume", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return host.resumeSession(asSessionId(sessionId));
});
registerMethod("session.messages", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  // host 只认活会话 —— 历史会话（daemon 重启后/已结束落盘）从 store 兜底读，
  // 否则单元历史里点开任何旧会话都是 unknown_session。
  try {
    return host.sessionMessages(asSessionId(p.sessionId));
  } catch {
    const rows = store.listMessages(p.sessionId);
    if (store.getSession(p.sessionId) === undefined && rows.length === 0) {
      throw Object.assign(new Error(`no such session: ${p.sessionId}`), { code: "unknown_session" });
    }
    return rows;
  }
});
// exportTrace 的线上形态（WP-3）：以落盘账本为准 —— 跨日期 TraceRecord NDJSON，
// 事件环（上限 500）只是热缓存。afterSeq 可选：断线补拉游标（WP-2 复用）。
registerMethod("session.trace", (params) => {
  const p = (params ?? {}) as { sessionId?: string; afterSeq?: number };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return traceSink.readSessionNdjson(asSessionId(p.sessionId), typeof p.afterSeq === "number" ? p.afterSeq : 0);
});
// 断线补拉（WP-2）：热路径读事件环；游标滑出环外（gap）时回落落盘账本。
registerMethod("session.events.since", async (params) => {
  const p = (params ?? {}) as { sessionId?: string; afterSeq?: number };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  const afterSeq = typeof p.afterSeq === "number" ? p.afterSeq : 0;
  const hot = host.hotEventsSince(asSessionId(p.sessionId), afterSeq);
  if (!hot.gap) return hot.items;
  const nd = await traceSink.readSessionNdjson(asSessionId(p.sessionId), afterSeq);
  return nd
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const r = JSON.parse(l) as { seq: number; event: unknown };
      return { seq: r.seq, event: r.event };
    });
});
// 孤儿治理面（WP-10）：列出可回收的死会话 / 回收指定会话（轨迹文件永不删）。
registerMethod("session.gc", (params) => {
  const p = (params ?? {}) as { maxAgeDays?: number };
  const maxAgeDays = typeof p.maxAgeDays === "number" ? p.maxAgeDays : 14;
  return host.gcCandidates(maxAgeDays * 86_400_000);
});
registerMethod("session.forget", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  host.forgetSession(asSessionId(sessionId));
  return { forgotten: sessionId };
});
registerMethod("permission.resolve", (params) => {
  const p = (params ?? {}) as { sessionId?: string; requestId?: string; decision?: "allow" | "deny" | "always" };
  if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" ||
      (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "always")) {
    throw Object.assign(new Error("sessionId, requestId, decision(allow|deny|always) are required"), { code: "bad_params" });
  }
  return host.resolvePermission(asSessionId(p.sessionId), p.requestId, p.decision);
});

registerMethod("workspace.openFolder", async (params) => {
  const p = (params ?? {}) as { path?: string; botId?: string };
  let targetPath = p.path;
  if (!targetPath && p.botId) {
    const b = await botRegistry.getBot(p.botId);
    if (b) targetPath = b.rootPath;
  }
  if (!targetPath || typeof targetPath !== "string") {
    throw Object.assign(new Error("path or botId is required"), { code: "bad_params" });
  }
  return launchFileManager(targetPath);
});

registerMethod("health", () => healthPayload(config, startedAt));

/**
 * 协议原生的关闭通道。Windows 上跨进程 SIGTERM 不可投递（冒烟脚本实证），
 * 程序化退出一律走这里；SIGINT/SIGTERM 处理器保留给终端 Ctrl+C 与 Unix。
 * 延迟退出是为了让响应帧先落 TCP。
 */
registerMethod("daemon.stop", () => {
  setTimeout(() => shutdown("rpc daemon.stop"), 30);
  return { stopping: true };
});

log.info("daemon listening", {
  http: `http://${config.host}:${port}`,
  ws: `ws://${config.host}:${port}/ws`,
  version: config.version,
  pid: process.pid,
  home: config.homeDir,
});

// 命令面板预热（后台，不挡 listen）：拉一遍「有命令面的执行器 × 已知 bot
// rootPath」，让用户第一次打开斜杠菜单就命中缓存 —— 对标 TUI 的秒开体验。
// 冷启动成本（opencode 起 server ~6s、zcode 问 app-server ~1s）全部藏进启动期。
void (async () => {
  try {
    const bots = await botRegistry.listBots();
    const roots = [...new Set(bots.map((b) => b.rootPath).filter((r): r is string => typeof r === "string" && r !== ""))];
    if (roots.length > 0) {
      await host.prewarmCommands(roots);
      log.info("命令面板预热完成", { roots: roots.length });
    }
  } catch {
    /* 预热是优化不是功能路径：失败留给菜单打开时的正常拉取 */
  }
})();

let shuttingDown = false;
// 评审 P1：host.shutdown 必须真等——undelivered 广播是异步 socket 写、adapter.disconnect
// 杀子进程、store.close 落盘，全部排在第一个 await 之后；此前同步 process.exit 抢跑全跳过
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  scheduler.stop();
  quotaResumeWatcher.stop();
  backlogEngine?.stop();
  memoryScheduler?.stop(); // 之前漏了：60s interval 会活到 process.exit，正在跑的日报/curator 被从中间砍断
  telegramGateway.stop();
  // 飞书也停：它有一个 15s reconcile interval 和每账号的长连接/子进程，
  // 漏掉它就会在 host.shutdown() 关掉 store 之后还能起新活（评审 P1 同类）
  feishuGateway.stop();
  // 杀光终端 → ConPTY 排空窗口 → terminate pty worker（顺序敏感，见 stop 注释）
  await terminals.stop();
  const force = setTimeout(() => process.exit(0), 2000).unref(); // 挂起写兜底：2s 强制退
  try {
    await host.shutdown();
  } catch (err: unknown) {
    log.warn("host shutdown failed", { error: err instanceof Error ? err.message : String(err) });
  }
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  server.close();
  clearTimeout(force);
  log.info("bye");
  process.exit(0);}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
