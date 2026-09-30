/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { healthPayload, startHttp, type HttpRoute } from "./httpd.ts";
import { log, setLogLevel } from "./log.ts";
import { attachWs, broadcastEvent, broadcastTerminal, registerMethod, WIRE_VERSION } from "./wsd.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { MockPermAdapter } from "./runtime/adapters/mockperm.ts";
import { ClaudeAdapter } from "./runtime/adapters/claude.ts";
import { RuntimeHost } from "./runtime/host.ts";
import { TraceSink } from "./runtime/trace.ts";
import { ZcodeAdapter } from "./runtime/adapters/zcode.ts";
import { CodexAdapter } from "./runtime/adapters/codex.ts";
import { TerminalManager } from "./terminal/terminals.ts";
import { Store } from "./store/db.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { parseCron } from "./automation/cron.ts";
import { OpsRunner } from "./ops/eval.ts";
import { ArenaRunner } from "./ops/arena.ts";
import { MemoryService } from "./memory/memory.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

const startedAt = Date.now();
const config = loadConfig();
setLogLevel(config.logLevel);

mkdirSync(config.homeDir, { recursive: true });

// ---- 服务与执行器（先建好，REST 路由要引用）---------------------------------

const store = new Store(config.homeDir);
const gate = new PermissionGate(store);
const traceSink = new TraceSink(config.homeDir);
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
  { id: "mockperm", installed: true, registered: true, hint: "权限闸试金石" },
  {
    id: "opencode",
    installed: true,
    registered: false,
    hint: "已安装但未配置 provider 凭据（opencode auth login）—— 配置后即可接入",
  },
  {
    id: "pi",
    installed: true,
    registered: false,
    hint: "已安装但无任何 provider 凭据（pi auth login / --api-key）—— 配置后即可接入",
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

// ---- Ops（Phase 6）----------------------------------------------------------

const ops = new OpsRunner(host, config.homeDir);
const arena = new ArenaRunner(host, config.homeDir);

// ---- 记忆编排（Phase 7）-----------------------------------------------------

const memory = new MemoryService(store, config.homeDir);

// ---- REST 管理面（权限闸的决策入口，docs/07 §六）----------------------------

const httpRoutes: HttpRoute[] = [
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

const { server, port } = await startHttp(config, startedAt, httpRoutes);
const wss = attachWs(server, { config, startedAt });
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
  const { runtimeId } = params as { runtimeId?: string };
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
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  scheduler.stop();
  void host.shutdown().catch(() => {});
  terminals.shutdown();
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  server.close();
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
