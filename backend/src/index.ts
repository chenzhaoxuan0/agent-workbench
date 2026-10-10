/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { healthPayload, isLocalOrigin, isLoopbackAddr, startHttp, type HttpRoute } from "./httpd.ts";
import { log, setLogLevel } from "./log.ts";
import { attachWs, broadcastEvent, broadcastTerminal, registerMethod, WIRE_VERSION } from "./wsd.ts";
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
import { TerminalManager } from "./terminal/terminals.ts";
import { Store } from "./store/db.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { cronNextAt, parseCron } from "./automation/cron.ts";
import {
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
import { BotRegistry } from "./bots/registry.ts";
import { TelegramGateway } from "./channels/telegram.ts";
import { FeishuGateway, diagnoseLarkAccount, larkIdentities, larkProfileList, addLarkProfile } from "./channels/feishu.ts";
import { askBot } from "./channels/askBot.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

const startedAt = Date.now();
const config = loadConfig();
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
  }
}, traceSink, config.homeDir, store, gate, new FileMemoryInjector());
memoryScheduler = new MemoryScheduler({
  homeDir: config.homeDir,
  store,
  knownProjects: () => botRegistry.roots(),
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

// ---- 终端（Phase 2）--------------------------------------------------------

const terminals = new TerminalManager((frame) =>
  broadcastTerminal(wss, { v: WIRE_VERSION, type: "terminal", ...frame }),
);

// ---- 自动化调度（Phase 5 v2）-------------------------------------------------

/** sessionId → { runId, automationId }：会话结束态回灌运行记录与失败徽章 */
const automationRunBySession = new Map<string, { runId: number; automationId: number }>();

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
  },
  opts: { trigger: "schedule" | "manual" },
): Promise<{ runId: number; sessionId: string }> {
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
    if (endedFailed) store.setAutomationError(a.id, `ended: ${ended!.status}`, Date.now());
    else store.setAutomationError(a.id, null, null);
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
scheduler.start();

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

// 飞书：每 bot 一个飞书机器人（一个飞书应用 = 一个账号 = 一个 bot 身份）
const feishuGateway = new FeishuGateway({ registry: botRegistry, host, reconcileMs: 15_000 });
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

const { server, port } = await startHttp(config, startedAt, httpRoutes, authorize);
const wss = attachWs(server, { config, startedAt, authorize });
// dst 启动器已并入 dsh（tuiCommand）：dsh 的 TUI 用 dst shim 拉起
function tuiCommandFor(executorId: string | undefined): string | undefined {
  if (!executorId) return executorId;
  try {
    return host.getAdapter(executorId).tuiCommand ?? executorId;
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
    cols: p.cols,
    rows: p.rows,
    env: p.env,
  });
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
    ...(frequency === "custom" ? { interval: int("interval", 1, 10_000, 1) } : {}),
    ...(unitOk ? { unit: unit as "minutes" | "hours" | "days" | "weeks" | "months" } : {}),
    ...(typeof r["anchorAt"] === "number" && Number.isFinite(r["anchorAt"]) ? { anchorAt: r["anchorAt"] as number } : {}),
  };
  return rule;
}

/**
 * 创建/更新共用的调度入参归一，三选一（对齐 ZCode 的 contract）：
 *   delayMinutes ——「N 分钟后」一次性（相对表达以 daemon 时钟为锚，不信客户端换算）
 *   scheduleRule —— 权威规则（anchorAt 缺省 = 现在，即「改频率即重新锚定」）
 *   cron         —— 纯 cron 兼容（调度走 cronNextAt；cron 的整点语义只有它自己算得准）
 */
function resolveSchedule(p: {
  cron?: unknown;
  scheduleRule?: unknown;
  delayMinutes?: unknown;
}): { cron: string; rule: ScheduleRule | null; nextRunAt: number | null } {
  if (typeof p.delayMinutes === "number") {
    if (!Number.isFinite(p.delayMinutes) || p.delayMinutes < 1 || p.delayMinutes > 525_600) {
      throw badAutomation("delayMinutes must be 1..525600");
    }
    const rule = buildRelativeDelaySchedule(p.delayMinutes);
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: computeScheduleNextRunAt(rule) };
  }
  if (p.scheduleRule !== undefined && p.scheduleRule !== null) {
    const parsed = parseScheduleRule(p.scheduleRule);
    const rule: ScheduleRule = parsed.anchorAt === undefined ? { ...parsed, anchorAt: Date.now() } : parsed;
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
    cron?: string; scheduleRule?: unknown; delayMinutes?: number;
    recurring?: boolean; maxRuns?: number;
  };
  if (typeof p.unitId !== "string" || typeof p.runtimeId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string") {
    throw badAutomation("unitId, runtimeId, rootPath, prompt are required");
  }
  if (typeof p.delayMinutes === "number" && p.recurring === true) {
    throw badAutomation("delayMinutes 是一次性任务，不能配 recurring=true");
  }
  const { cron, rule, nextRunAt } = resolveSchedule(p);
  if (nextRunAt === null) throw badAutomation("当前规则推不出任何未来的触发时间");
  // recurring 缺省 = 循环；显式 false 且未给 maxRuns = 一次性（跑一次收口，ZCode 同口径）。
  // delayMinutes 本质是一次性的相对表达，强制 recurring=false —— 否则它会按间隔永远跑下去。
  const recurring = typeof p.delayMinutes === "number" ? false : p.recurring !== false;
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
  });
  return { id, nextRunAt };
});

registerMethod("automation.update", (params) => {
  const p = (params ?? {}) as {
    id?: number; name?: string; prompt?: string; model?: string | null; mode?: string | null;
    unitId?: string; unitName?: string; runtimeId?: string; rootPath?: string;
    cron?: string; scheduleRule?: unknown; delayMinutes?: number;
    recurring?: boolean; maxRuns?: number | null;
  };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  const prev = hit.automation;

  const patch: Partial<Parameters<Store["updateAutomation"]>[1]> = {};
  if (typeof p.name === "string") patch.name = p.name;
  if (typeof p.prompt === "string") patch.prompt = p.prompt;
  if (p.model !== undefined) patch.model = typeof p.model === "string" ? p.model : null;
  if (p.mode !== undefined) patch.mode = typeof p.mode === "string" ? p.mode : null;
  if (typeof p.unitId === "string") patch.unitId = p.unitId;
  if (typeof p.unitName === "string") patch.unitName = p.unitName;
  if (typeof p.runtimeId === "string") patch.runtimeId = p.runtimeId;
  if (typeof p.rootPath === "string") patch.rootPath = p.rootPath;

  if (typeof p.delayMinutes === "number" && p.recurring === true) {
    throw badAutomation("delayMinutes 是一次性任务，不能配 recurring=true");
  }
  // 次数口径：recurring=false 而 maxRuns 未给 → 补成 1（一次性）
  const wantsRuns = p.recurring !== undefined || p.maxRuns !== undefined;
  const recurring = p.recurring ?? prev.recurring;
  const maxRuns = p.maxRuns !== undefined
    ? (p.maxRuns === null ? (recurring ? null : 1) : p.maxRuns)
    : (p.recurring !== undefined && !recurring && prev.maxRuns === null ? 1 : prev.maxRuns);

  const scheduleChanged = p.cron !== undefined || p.scheduleRule !== undefined || p.delayMinutes !== undefined;
  if (scheduleChanged) {
    const resolved = resolveSchedule(p);
    patch.cron = resolved.cron;
    patch.scheduleRule = resolved.rule;
    patch.nextRunAt = resolved.nextRunAt;
  } else if (wantsRuns) {
    // 只动次数口径：下一个触发点从现有规则重算
    patch.nextRunAt = prev.scheduleRule !== null
      ? computeScheduleNextRunAt(prev.scheduleRule)
      : cronNextAt(prev.cron);
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
    nextRunAt = a.scheduleRule !== null ? computeScheduleNextRunAt(a.scheduleRule) : cronNextAt(a.cron);
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
registerMethod("automation.runNow", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  // 手动触发不消耗 run_count（那是 scheduled 跑的账，一次性任务的终态判断只看它）
  return runAutomation(hit.automation, { trigger: "manual" });
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
registerMethod("session.resume", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return host.resumeSession(asSessionId(sessionId));
});
registerMethod("session.messages", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return host.sessionMessages(asSessionId(p.sessionId));
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

let shuttingDown = false;
// 评审 P1：host.shutdown 必须真等——undelivered 广播是异步 socket 写、adapter.disconnect
// 杀子进程、store.close 落盘，全部排在第一个 await 之后；此前同步 process.exit 抢跑全跳过
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  scheduler.stop();
  memoryScheduler?.stop(); // 之前漏了：60s interval 会活到 process.exit，正在跑的日报/curator 被从中间砍断
  telegramGateway.stop();
  // 飞书也停：它有一个 15s reconcile interval 和每账号的长连接/子进程，
  // 漏掉它就会在 host.shutdown() 关掉 store 之后还能起新活（评审 P1 同类）
  feishuGateway.stop();
  terminals.shutdown();
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
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
