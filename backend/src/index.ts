/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
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
import { TerminalManager } from "./terminal/terminals.ts";
import { Store } from "./store/db.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { parseCron } from "./automation/cron.ts";
import { OpsRunner } from "./ops/eval.ts";
import { ArenaRunner } from "./ops/arena.ts";
import { MemoryService } from "./memory/memory.ts";
import { BotRegistry } from "./bots/registry.ts";
import { TelegramGateway } from "./channels/telegram.ts";
import { FeishuGateway, diagnoseLarkAccount, larkIdentities, larkProfileList, addLarkProfile } from "./channels/feishu.ts";
import { askBot } from "./channels/askBot.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

const startedAt = Date.now();
const config = loadConfig();
setLogLevel(config.logLevel);

mkdirSync(config.homeDir, { recursive: true });



// ---- 服务与执行器（先建好，REST 路由要引用）---------------------------------

const store = new Store(config.homeDir);
const gate = new PermissionGate(store);
const traceSink = new TraceSink(config.homeDir);
const botRegistry = new BotRegistry(store);
const host = new RuntimeHost((event, seq) => {
  broadcastEvent(wss, event, seq);
  // 自动化运行记录的终态回灌（Phase 5）
  if (event.type === "session.ended") {
    const runId = automationRunBySession.get(event.sessionId);
    if (runId !== undefined) {
      automationRunBySession.delete(event.sessionId);
      const failed = event.reason === "error" || event.reason === "executor_exited";
      store.finishAutomationRun(runId, failed ? "failed" : "done", `ended: ${event.reason}`);
    }
  }
}, traceSink, config.homeDir, store, gate);
host.register(new ZcodeAdapter());
host.register(new CodexAdapter());
host.register(new ClaudeAdapter());
host.register(new PiAdapter());
host.register(new McodeAdapter());
host.register(new MockPermAdapter());
host.loadPersisted();

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
  { id: "mockperm", installed: true, registered: true, hint: "权限闸试金石" },
  {
    id: "opencode",
    installed: true,
    registered: false,
    hint: "已安装但未配置 provider 凭据（opencode auth login）—— 配置后即可接入",
  },
  { id: "cursor-agent", installed: false, registered: false, hint: "未安装（cursor-agent install）" },
  { id: "grok", installed: false, registered: false, hint: "未安装" },
  { id: "antigravity", installed: false, registered: false, hint: "未安装" },
]);

// ---- 终端（Phase 2）--------------------------------------------------------

const terminals = new TerminalManager((frame) =>
  broadcastTerminal(wss, { v: WIRE_VERSION, type: "terminal", ...frame }),
);

// ---- 自动化调度（Phase 5）---------------------------------------------------

/** sessionId → runId：会话结束态回灌运行记录 */
const automationRunBySession = new Map<string, number>();

async function runAutomation(a: {
  id: number;
  unitId: string;
  unitName: string;
  runtimeId: string;
  rootPath: string;
  prompt: string;
  model: string | null;
  mode: string | null;
}): Promise<{ runId: number; sessionId: string }> {
  const runId = store.startAutomationRun(a.id, null);
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
    store.finishAutomationRun(runId, "done", `session ${session.id} started`);
    store.setAutomationRunSession(runId, session.id);
    automationRunBySession.set(session.id, runId);
    log.info("automation session launched", { automationId: a.id, runId, sessionId: session.id });
    return { runId, sessionId: session.id };
  } catch (err: unknown) {
    store.finishAutomationRun(runId, "failed", err instanceof Error ? err.message : String(err));
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

// ---- Ops（Phase 6）----------------------------------------------------------

const ops = new OpsRunner(host, config.homeDir);
const arena = new ArenaRunner(host, config.homeDir);

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
];

/** 鉴权判定（docs/08 WP-7）：token 开启时全查，唯一豁免 = 回环取 /bootstrap */
const authorize = (req: IncomingMessage, url: URL): boolean => {
  if (config.token === null) return true;
  if (url.pathname === "/bootstrap") {
    // 评审 P0：跨源网页 fetch 自带 Origin 头且对端是回环——必须连 Origin 一起验
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    return isLoopbackAddr(req.socket.remoteAddress);
  }
  if (url.pathname === "/webhook/bot") return true; // per-bot secret 在路由内自验
  const provided = req.headers["x-awb-token"] ?? url.searchParams.get("token");
  return typeof provided === "string" && provided === config.token;
};

const { server, port } = await startHttp(config, startedAt, httpRoutes, authorize);
const wss = attachWs(server, { config, startedAt, authorize });
registerMethod("terminal.create", (params) => {
  const p = (params ?? {}) as { cwd?: string; shell?: string; cols?: number; rows?: number };
  return terminals.create({ cwd: p.cwd, shell: p.shell, cols: p.cols, rows: p.rows });
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

// ---- 自动化方法（Phase 5）---------------------------------------------------

registerMethod("automation.create", (params) => {
  const p = (params ?? {}) as {
    unitId?: string; unitName?: string; runtimeId?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: string; cron?: string;
  };
  if (typeof p.unitId !== "string" || typeof p.runtimeId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string" || typeof p.cron !== "string") {
    throw Object.assign(new Error("unitId, runtimeId, rootPath, prompt, cron are required"), { code: "bad_params" });
  }
  parseCron(p.cron); // 坏表达式在创建时就拒，不等 tick 才发现
  const id = store.createAutomation({
    unitId: p.unitId,
    unitName: p.unitName ?? p.unitId,
    runtimeId: p.runtimeId,
    rootPath: p.rootPath,
    prompt: p.prompt,
    model: typeof p.model === "string" ? p.model : null,
    mode: typeof p.mode === "string" ? p.mode : null,
    cron: p.cron,
  });
  return { id };
});
registerMethod("automation.list", (params) => {
  const p = (params ?? {}) as { runsFor?: number };
  const list = store.listAutomations();
  const wantRuns = typeof p.runsFor === "number";
  return list.map((a) => ({
    ...a,
    runs: wantRuns && a.id === p.runsFor ? store.listAutomationRuns(a.id) : undefined,
  }));
});
registerMethod("automation.setEnabled", (params) => {
  const p = (params ?? {}) as { id?: number; enabled?: boolean };
  if (typeof p.id !== "number" || typeof p.enabled !== "boolean") {
    throw Object.assign(new Error("id and enabled are required"), { code: "bad_params" });
  }
  const changed = store.setAutomationEnabled(p.id, p.enabled);
  scheduler.invalidate(p.id);
  return { changed };
});
registerMethod("automation.delete", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw Object.assign(new Error("id is required"), { code: "bad_params" });
  scheduler.invalidate(p.id);
  return { deleted: store.deleteAutomation(p.id) };
});
registerMethod("automation.runs", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw Object.assign(new Error("id is required"), { code: "bad_params" });
  return store.listAutomationRuns(p.id);
});
registerMethod("automation.runNow", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw Object.assign(new Error("id is required"), { code: "bad_params" });
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  return runAutomation(hit.automation);
});

// ---- Ops 方法（Phase 6）-----------------------------------------------------

registerMethod("ops.evalRun", (params) => {
  const p = (params ?? {}) as {
    datasetName?: string; rows?: Array<{ id?: string; input?: string; expect_tool?: string; expect_in_args?: string }>;
    runtimeId?: string; model?: string;
    judgeMetrics?: Array<{ name?: string; steps?: string[]; threshold?: number }>;
    turnTimeoutMs?: number;
  };
  if (typeof p.datasetName !== "string" || !Array.isArray(p.rows) || p.rows.length === 0 || typeof p.runtimeId !== "string") {
    throw Object.assign(new Error("datasetName, rows(non-empty), runtimeId are required"), { code: "bad_params" });
  }
  return ops.runGate({
    datasetName: p.datasetName,
    runtimeId: p.runtimeId,
    rows: p.rows.map((r, i) => ({ id: r.id ?? `row_${i}`, input: r.input ?? "", expect_tool: r.expect_tool, expect_in_args: r.expect_in_args })),
    model: typeof p.model === "string" ? p.model : null,
    judgeMetrics: p.judgeMetrics?.map((m) => ({ name: m.name ?? "metric", steps: m.steps ?? [], threshold: m.threshold ?? 0.6 })),
    turnTimeoutMs: p.turnTimeoutMs,
  });
});
registerMethod("ops.arenaRun", (params) => {
  const p = (params ?? {}) as {
    prompt?: string; runtimeIds?: string[];
    judgeMetric?: { name?: string; steps?: string[]; threshold?: number };
    turnTimeoutMs?: number;
  };
  if (typeof p.prompt !== "string" || !Array.isArray(p.runtimeIds) || p.runtimeIds.length === 0) {
    throw Object.assign(new Error("prompt and runtimeIds(non-empty) are required"), { code: "bad_params" });
  }
  return arena.runMatch({
    prompt: p.prompt,
    runtimeIds: p.runtimeIds,
    judgeMetric: p.judgeMetric === undefined
      ? undefined
      : { name: p.judgeMetric.name ?? "metric", steps: p.judgeMetric.steps ?? [], threshold: p.judgeMetric.threshold ?? 0.6 },
    turnTimeoutMs: p.turnTimeoutMs,
  });
});

// ---- 记忆方法（Phase 7）-----------------------------------------------------

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
  const p = (params ?? {}) as { botId?: string; text?: string; waitMs?: number };
  if (typeof p.botId !== "string" || typeof p.text !== "string") {
    throw Object.assign(new Error("botId and text are required"), { code: "bad_params" });
  }
  // 评审 P3：waitMs 设上限，防误设大值无限占住 WS RPC
  const waitMs = typeof p.waitMs === "number" ? Math.min(Math.max(p.waitMs, 1_000), 600_000) : undefined;
  return askBot(botRegistry, host, p.botId, p.text, { waitMs, source: "webhook" });
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

registerMethod("adapter.list", () => host.listAdapters());
registerMethod("adapter.probe", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.probe(runtimeId);
});
registerMethod("session.start", (params) => {
  const p = params as {
    runtimeId?: string; unitId?: string; unitName?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: "plan" | "build" | "edit" | "yolo";
    reasoningLevel?: string;
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
  });
});
registerMethod("session.send", (params) => {
  const p = params as { sessionId?: string; text?: string; reasoningLevel?: string };
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
  const p = params as { sessionId?: string; requestId?: string; decision?: "allow" | "deny" | "always" };
  if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" ||
      (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "always")) {
    throw Object.assign(new Error("sessionId, requestId, decision(allow|deny|always) are required"), { code: "bad_params" });
  }
  return host.resolvePermission(asSessionId(p.sessionId), p.requestId, p.decision);
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
  telegramGateway.stop();
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
