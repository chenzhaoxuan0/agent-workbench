/**
 * OpenCode 执行器适配器 —— **`opencode serve` 形态**（HTTP REST + SSE，
 * docs/13 Phase 4 Tier 1 升级；2026-10 曾从 serve 迁 ACP，本次按计划反向升级）。
 *
 * 当年迁走的两个代价这次都有解：
 * - 阻塞轮完成 → `POST /session/{id}/prompt_async`（204 立即受理），
 *   轮生命周期走 SSE 的 session.status busy/idle；
 * - 自管 SSE 重连 → 保留（SSE 断开自动重连 + 按 sessionID 续运），
 *   但多项目实例靠 `x-opencode-directory` header 隔离，不靠端口。
 *
 * 升级收益：162-path OpenAPI 全量面（diff/权限/question/fork/revert）、
 * GET /session 历史直读（Phase 1 协议型来源）、token 级流式 delta。
 *
 * 协议事实（opencode 1.18.35 本机实测，2026-10-14）：
 * - 启动：`opencode serve --hostname 127.0.0.1 --port <N>`，stdout 打
 *   "opencode server listening on http://…" 即就绪；OPENCODE_SERVER_PASSWORD
 *   未设时明文可用（本机回环，风险可受）
 * - 会话：`POST /session`（body {title?}；目录用 header x-opencode-directory，
 *   body 里的 directory 字段会 500）→ {id:"ses_…"}
 * - 发轮：`POST /session/{id}/prompt_async` body
 *   {parts:[{type:"text",text}], model?{providerID,modelID}} → 204
 * - 取消：`POST /session/{id}/abort`
 * - 权限：`POST /permission/{requestID}/reply` body {reply:"once"|"always"|"reject"}
 * - SSE：`GET /event`（同 directory header）。事件 properties.sessionID 归属：
 *   message.part.delta {messageID,partID,field:"text",delta}——真 token 流；
 *   message.part.updated {part:{type:text|reasoning|tool,…,messageID}}；
 *   message.updated {info:{id,role}}；session.status {status:{type:busy|idle}}；
 *   session.idle（轮落定）；session.diff {diff:[…]}；permission.*（审批）
 * - 模型：`GET /model`（同 header）→ [{id,providerID,name,limit,cost,capabilities}]
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- serve 进程管理（一个 adapter 一个常驻 serve，死了下次请求重启） --------------

class ServeProcess {
  private child: ChildProcess | null = null;
  private base: string | null = null;
  private starting: Promise<string> | null = null;

  baseUrl(): Promise<string> {
    if (this.base !== null && this.child !== null && this.child.exitCode === null) return Promise.resolve(this.base);
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawn(): Promise<string> {
    const cmd = await resolveCommand("opencode");
    const port = 33000 + Math.floor(Math.random() * 2000);
    const child = spawn(cmd.file, [...cmd.prefixArgs, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("opencode serve 15s 内未就绪")), 15_000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const m = line.match(/listening on (http:\/\/\S+)/);
        if (m !== null) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve 退出（code ${code}）`));
      });
    });
    this.base = base;
    child.once("exit", () => {
      log.info("opencode serve exited", { code: child.exitCode });
      this.base = null;
      this.child = null;
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s !== "" && !s.includes("OPENCODE_SERVER_PASSWORD")) log.debug("opencode serve stderr", { line: s.slice(0, 160) });
    });
    return base;
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.base = null;
    child?.kill();
  }
}

// ---- 会话台账 ------------------------------------------------------------------

interface OcSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** "providerID/modelID" 形态的模型 id（serve 的 model 对象正好拆这两段） */
  model: ModelId | null;
  ref: string | null;
  sink: AdapterSink | null;
  /** 轮内流式聚合：messageID → 已流出文本（idle 时发 message.completed） */
  readonly streamed: Map<string, string>;
  /** messageId → role（message.updated 缓存） */
  readonly roles: Map<string, string>;
  /** 已翻译过 tool.started 的 partID（part.updated 会重复带全量 part） */
  readonly seenToolParts: Set<string>;
  /** 上次会话累计 token/cost（session.updated 差值出 usage） */
  lastTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  lastCost: number;
  usageCount: number;
  /** 已应答回执的审批 requestID（permission.updated 会重复推送） */
  readonly answeredPermissions: Set<string>;
}

interface OpencodeModelEntry {
  id?: string;
  providerID?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    input?: { image?: boolean; video?: boolean; pdf?: boolean };
  };
  variants?: Record<string, unknown>;
}

function parseOpencodeModelsVerbose(out: string): ExecutorModelInfo[] {
  const models: ExecutorModelInfo[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (out[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const jsonStr = out.slice(start, i + 1);
        try {
          const item = JSON.parse(jsonStr) as OpencodeModelEntry;
          if (item.id && item.providerID) {
            const fullId = `${item.providerID}/${item.id}` as ModelId;
            const reasoningLevels =
              item.variants && typeof item.variants === "object"
                ? Object.keys(item.variants).filter((k) => k !== "none")
                : undefined;
            models.push({
              id: fullId,
              displayName: item.name ?? item.id,
              contextWindow: item.limit?.context && item.limit.context > 0 ? item.limit.context : 200000,
              maxOutput: item.limit?.output && item.limit.output > 0 ? item.limit.output : undefined,
              reasoningLevels: reasoningLevels && reasoningLevels.length > 0 ? reasoningLevels : undefined,
              multimodal: item.capabilities?.input?.image ?? false,
              inputPerMTok: typeof item.cost?.input === "number" ? item.cost.input : undefined,
              outputPerMTok: typeof item.cost?.output === "number" ? item.cost.output : undefined,
            });
          }
        } catch {
          // ignore non-JSON blocks
        }
        start = -1;
      }
    }
  }
  return models;
}

const DEFAULT_OPENCODE_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "opencode/big-pickle" as ModelId,
    displayName: "Big Pickle（执行器默认）",
    contextWindow: 200000,
    maxOutput: 32000,
    multimodal: true,
  },
  {
    id: "minimax-cn-coding-plan/MiniMax-M3" as ModelId,
    displayName: "MiniMax M3",
    contextWindow: 1048576,
    maxOutput: 512000,
    reasoningLevels: ["low", "high", "max"],
    multimodal: true,
  },
  {
    id: "zhipuai-coding-plan/glm-5.3-flash" as ModelId,
    displayName: "GLM-5.3 Flash",
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoningLevels: ["low", "high", "max"],
    multimodal: true,
  },
];

export class OpencodeAdapter implements ExecutorAdapter {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly glyph = "O";
  private _models: ExecutorModelInfo[] = [...DEFAULT_OPENCODE_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  private readonly serve = new ServeProcess();
  private readonly sessions = new Map<string, OcSession>();
  /** 已开 SSE 的 rootPath（opencode 按目录隔离实例：每个项目一条流，空 header 会路由到错误实例） */
  private readonly sseDirs = new Set<string>();

  async syncModels(): Promise<ModelSyncOutcome> {
    // 首选 serve 的 GET /model（结构化）；serve 起不来回落 CLI 解析（沿用旧实现）
    const t0 = Date.now();
    let serveReason: string | undefined;
    try {
      const base = await this.serve.baseUrl();
      const list = (await this.rest(base, "/model", "GET")).json as OpencodeModelEntry[];
      const synced = list
        .filter((m) => typeof m.id === "string" && typeof m.providerID === "string")
        .map((m) => ({
          id: `${m.providerID}/${m.id}` as ModelId,
          displayName: m.name ?? m.id ?? "",
          contextWindow: m.limit?.context && m.limit.context > 0 ? m.limit.context : 200000,
          maxOutput: m.limit?.output && m.limit.output > 0 ? m.limit.output : undefined,
          reasoningLevels:
            m.variants && typeof m.variants === "object"
              ? Object.keys(m.variants).filter((k) => k !== "none")
              : undefined,
          multimodal: m.capabilities?.input?.image ?? false,
          inputPerMTok: typeof m.cost?.input === "number" ? m.cost.input : undefined,
          outputPerMTok: typeof m.cost?.output === "number" ? m.cost.output : undefined,
        }));
      if (synced.length > 0) {
        this._models = synced;
        log.info("opencode models synced via serve /model", { count: synced.length });
        return { models: synced, source: "live", elapsedMs: Date.now() - t0 };
      }
      serveReason = "serve /model 返回空清单";
    } catch (err: unknown) {
      serveReason = err instanceof Error ? err.message : String(err);
      log.debug("opencode /model 同步失败，回落 CLI 解析", { error: serveReason });
    }
    try {
      const cmd = await resolveCommand("opencode");
      const out = await execLines(cmd, ["models", "--verbose"], 10000);
      const parsed = parseOpencodeModelsVerbose(out);
      if (parsed.length > 0) {
        this._models = parsed;
        log.info("opencode models synced dynamically", { count: parsed.length });
        return { models: parsed, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("opencode models --verbose failed, using fallback models", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this._models, source: "static", reason: serveReason ?? "models --verbose 输出未匹配到条目", elapsedMs: Date.now() - t0 };
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // 会话按项目落盘全局可寻址：GET /session 找回 + prompt_async 续聊
    fileDiff: true, // session.diff 事件（turn 级 diff 列表）
    terminal: false,
    permissions: true, // permission.* 事件 + /permission/{id}/reply（once/always/reject 三档）
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true, // session.updated 的 tokens/cost 差值出账
    multimodal: true,
    streaming: "realtime", // message.part.delta 真 token 流
    steering: "turn-end", // busy 期间入队、idle 后发（host 侧 pendingSends 语义）
  };

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("opencode");
      const out = await execLines(cmd, ["--version"], 15000);
      void this.syncModels().catch(() => {});
      return {
        state: { status: "ready", version: out.trim() || "unknown" },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 opencode CLI" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  // ---- REST 基础设施 -----------------------------------------------------------

  /** 原生命令缓存（GET /command）；老版本没有该路由时静默回落空清单 */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * opencode 的自定义命令面：`GET /command` 列出 `.opencode/command/*.md`
   * （项目级 + 全局）发现的命令，`POST /session/{id}/command` 原生执行 ——
   * 与 TUI 的斜杠命令同一条服务端路径，不是工作台模拟。
   */
  private async fetchCommandsUncached(base: string, rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const r = await this.rest(base, "/command", "GET", undefined, rootPath);
    if (r.status >= 300 || !Array.isArray(r.json)) return [];
    const out: NativeCommandInfo[] = [];
    for (const entry of r.json as unknown[]) {
      const c = (entry as { command?: { name?: string; description?: string } }).command;
      if (typeof c?.name !== "string" || c.name === "") continue;
      out.push({ name: c.name, description: c.description || undefined });
    }
    return out;
  }

  /**
   * opencode 的子智能体面：`GET /agent` 列出 agent 定义（过滤 mode=subagent
   * 只留子智能体段，primary 是默认交互面不进菜单）。老版本没有该路由时
   * 静默回落空清单。选中插入 "/name "，能否分发由 opencode 自己决定。
   */
  private async fetchAgentsUncached(base: string, rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const r = await this.rest(base, "/agent", "GET", undefined, rootPath);
    if (r.status >= 300) return [];
    // 响应是 { name: {name, description, mode, ...} } 的映射表
    const json = r.json as Record<string, { name?: string; description?: string; mode?: string }> | null;
    if (typeof json !== "object" || json === null) return [];
    const out: NativeCommandInfo[] = [];
    for (const def of Object.values(json)) {
      if (typeof def?.name !== "string" || def.name === "") continue;
      if (def.mode !== undefined && def.mode !== "subagent") continue;
      out.push({ name: def.name, description: def.description || undefined, kind: "agent" });
    }
    return out;
  }

  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < OpencodeAdapter.COMMAND_TTL_MS) return hit.commands;
    const base = await this.serve.baseUrl();
    const commands = await this.fetchCommandsUncached(base, rootPath).catch(() => [] as readonly NativeCommandInfo[]);
    const agents = await this.fetchAgentsUncached(base, rootPath).catch(() => [] as readonly NativeCommandInfo[]);
    const merged = [...commands, ...agents];
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  /**
   * "/name args" 且 name 在 /command 清单里 → 走原生 command 路由。
   * 不匹配（或路由失败）返回 false，调用方回落 prompt_async 原样透传。
   */
  private async runNativeCommand(base: string, state: OcSession, text: string): Promise<boolean> {
    if (!text.startsWith("/")) return false;
    const sp = text.search(/\s/);
    const name = text.slice(1, sp === -1 ? undefined : sp);
    if (name === "") return false;
    const known = await this.listCommands(state.rootPath);
    if (!known.some((c) => c.name === name)) return false;
    const args = sp === -1 ? "" : text.slice(sp + 1).trim();
    const r = await this.rest(
      base,
      `/session/${state.ref}/command`,
      "POST",
      { command: name, arguments: args },
      state.rootPath,
    );
    if (r.status >= 300) {
      log.debug("opencode command 路由失败，回落透传", { name, status: r.status });
      return false;
    }
    return true;
  }

  private async rest(
    base: string,
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    rootPath?: string,
    timeoutMs = 20000,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (rootPath !== undefined) headers["x-opencode-directory"] = rootPath;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 会话生命周期 -------------------------------------------------------------

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const base = await this.serve.baseUrl();
    void this.startSse(base, req.rootPath);
    const state: OcSession = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      model: req.model,
      ref: null,
      sink,
      streamed: new Map(),
      roles: new Map(),
      seenToolParts: new Set(),
      lastTokens: null,
      lastCost: 0,
      usageCount: 0,
      answeredPermissions: new Set(),
    };
    const r = await this.rest(base, "/session", "POST", { title: req.unitName }, req.rootPath);
    const id = (r.json as { id?: string } | undefined)?.id;
    if (id === undefined) {
      throw Object.assign(new Error(`opencode 会话创建失败（HTTP ${r.status}）`), { code: "start_failed" });
    }
    state.ref = id;
    this.sessions.set(state.sessionId, state);
    return this.sessionImpl(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: OcSession = {
      sessionId,
      rootPath,
      model: null,
      ref,
      sink,
      streamed: new Map(),
      roles: new Map(),
      seenToolParts: new Set(),
      lastTokens: null,
      lastCost: 0,
      usageCount: 0,
      answeredPermissions: new Set(),
    };
    this.sessions.set(sessionId, state);
    return this.sessionImpl(state);
  }

  private sessionImpl(state: OcSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        const base = await this.serve.baseUrl();
        void this.startSse(base, state.rootPath);
        if (state.ref === null) throw new Error("opencode 会话未建立");
        // 原生斜杠命令优先（.opencode/command 的服务端路由），其余原样 prompt
        if (await this.runNativeCommand(base, state, text)) return;
        const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
        if (state.model !== null && state.model.includes("/")) {
          const [providerID, modelID] = state.model.split("/");
          body["model"] = { providerID: providerID!, modelID: modelID! };
        }
        const r = await this.rest(base, `/session/${state.ref}/prompt_async`, "POST", body, state.rootPath);
        if (r.status >= 300) {
          state.sink?.({
            type: "error",
            sessionId: state.sessionId,
            message: `opencode prompt_async 失败（HTTP ${r.status}）${JSON.stringify(r.json ?? "").slice(0, 160)}`,
            recoverable: false,
          });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
        }
      },
      cancel: async () => {
        if (state.ref === null) return;
        const base = await this.serve.baseUrl();
        await this.rest(base, `/session/${state.ref}/abort`, "POST", undefined, state.rootPath).catch(() => undefined);
      },
      resolvePermission: async (requestId: string, decision: "allow" | "deny" | "always") => {
        if (state.ref === null) return;
        const base = await this.serve.baseUrl();
        state.answeredPermissions.add(requestId);
        await this
          .rest(
            base,
            `/permission/${requestId}/reply`,
            "POST",
            { reply: decision === "deny" ? "reject" : decision === "always" ? "always" : "once" },
            state.rootPath,
          )
          .catch(() => undefined);
        state.sink?.({
          type: "permission.resolved",
          sessionId: state.sessionId,
          requestId,
          decision: decision === "always" ? "allow" : decision,
        });
      },
      externalRef: () => state.ref,
    };
  }

  async disconnect(): Promise<void> {
    await this.serve.kill();
    this.sessions.clear();
  }

  // ---- SSE 事件流 ---------------------------------------------------------------

  private async startSse(base: string, rootPath: string): Promise<void> {
    if (this.sseDirs.has(rootPath)) return;
    this.sseDirs.add(rootPath);
    const loop = async (): Promise<void> => {
      while (this.sseDirs.has(rootPath)) {
        try {
          const ctrl = new AbortController();
          const res = await fetch(base + "/event", {
            headers: { "x-opencode-directory": rootPath },
            signal: ctrl.signal,
          });
          if (res.body === null) throw new Error("SSE 无 body");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLines = frame
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
              if (dataLines === "") continue;
              try {
                this.onEvent(JSON.parse(dataLines) as { type?: string; properties?: Record<string, unknown> });
              } catch {
                /* 坏帧跳过 */
              }
            }
          }
        } catch {
          // 断流重连（1s 退避）
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void loop();
  }

  private sessionOfRef(ref: unknown): OcSession | undefined {
    if (typeof ref !== "string") return undefined;
    for (const s of this.sessions.values()) if (s.ref === ref) return s;
    return undefined;
  }

  private onEvent(ev: { type?: string; properties?: Record<string, unknown> }): void {
    const type = ev.type ?? "";
    const p = ev.properties ?? {};
    const state = this.sessionOfRef(p["sessionID"]);
    if (state === undefined) return;
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    switch (type) {
      case "message.part.delta": {
        const delta = typeof p["delta"] === "string" ? p["delta"] : "";
        const messageID = typeof p["messageID"] === "string" ? p["messageID"] : `msg_${Date.now()}`;
        if (delta !== "" && p["field"] === "text") {
          sink({ type: "message.delta", sessionId, messageId: messageID, role: "assistant", text: delta });
          state.streamed.set(messageID, (state.streamed.get(messageID) ?? "") + delta);
        }
        break;
      }
      case "message.part.updated": {
        const part = (p["part"] ?? {}) as Record<string, unknown>;
        const pt = typeof part["type"] === "string" ? part["type"] : "";
        const messageID = typeof part["messageID"] === "string" ? part["messageID"] : "";
        const partID = typeof part["id"] === "string" ? part["id"] : messageID;
        if (pt === "reasoning") {
          const text = typeof part["text"] === "string" ? part["text"] : "";
          if (text !== "") sink({ type: "reasoning.delta", sessionId, messageId: partID, text });
        } else if (pt === "tool" || pt === "tool-state") {
          const tool = (part["tool"] ?? part["state"] ?? {}) as Record<string, unknown>;
          if (!state.seenToolParts.has(partID) && typeof tool["name"] === "string") {
            state.seenToolParts.add(partID);
            sink({
              type: "tool.started",
              sessionId,
              callId: partID,
              toolName: String(tool["name"]),
              title: String(tool["title"] ?? tool["name"]),
              input: {},
            });
          }
          if (part["status"] === "completed" || part["status"] === "failed" || tool["status"] === "completed" || tool["status"] === "failed") {
            const output = typeof part["output"] === "string" ? part["output"] : JSON.stringify(part["metadata"] ?? "").slice(0, 800);
            sink({
              type: "tool.completed",
              sessionId,
              callId: partID,
              ok: !String(part["status"] ?? tool["status"] ?? "").includes("fail"),
              output,
            });
          }
        }
        break;
      }
      case "message.updated": {
        const info = (p["info"] ?? {}) as Record<string, unknown>;
        if (typeof info["id"] === "string" && typeof info["role"] === "string") {
          state.roles.set(info["id"], info["role"]);
        }
        break;
      }
      case "session.updated": {
        // 会话累计 tokens/cost —— 差值出账（idle 时结算）
        const s = (p["info"] ?? p["session"] ?? {}) as Record<string, unknown>;
        const tokens = (s["tokens"] ?? {}) as Record<string, unknown>;
        if (tokens !== undefined && typeof tokens["input"] === "number") {
          state.lastTokens = {
            input: Number(tokens["input"] ?? 0),
            output: Number(tokens["output"] ?? 0),
            cacheRead: Number((tokens["cache"] as Record<string, unknown> | undefined)?.["read"] ?? 0),
            cacheWrite: Number((tokens["cache"] as Record<string, unknown> | undefined)?.["write"] ?? 0),
          };
        }
        if (typeof s["cost"] === "number") state.lastCost = s["cost"];
        break;
      }
      case "session.idle": {
        // 轮落定：结算流式消息 + usage
        for (const [messageID, text] of state.streamed) {
          sink({ type: "message.completed", sessionId, messageId: messageID, text });
        }
        state.streamed.clear();
        const t = state.lastTokens;
        if (t !== null) {
          sink({
            type: "usage",
            sessionId,
            inputTokens: t.input + t.cacheWrite,
            outputTokens: t.output,
            cacheReadTokens: t.cacheRead,
            cacheWriteTokens: t.cacheWrite,
            costUsd: state.lastCost,
            model: String(state.model ?? "opencode"),
            requestId: `opencode:${state.ref ?? sessionId}:p${process.pid}:${++state.usageCount}`,
          });
        }
        sink({ type: "session.status", sessionId, status: "idle" });
        break;
      }
      case "session.diff": {
        const diff = p["diff"];
        if (Array.isArray(diff)) {
          for (const d of diff as Record<string, unknown>[]) {
            const path = typeof d["path"] === "string" ? d["path"] : typeof d["file"] === "string" ? d["file"] : null;
            if (path === null) continue;
            sink({
              type: "file.diff",
              sessionId,
              path,
              additions: Number(d["added"] ?? d["additions"] ?? 0),
              deletions: Number(d["removed"] ?? d["deletions"] ?? 0),
            });
          }
        }
        break;
      }
      default: {
        if (type.startsWith("permission.")) {
          const perm = (p["permission"] ?? p["info"] ?? p) as Record<string, unknown>;
          const requestID = typeof perm["id"] === "string" ? perm["id"] : typeof p["requestID"] === "string" ? p["requestID"] : null;
          if (requestID === null || state.answeredPermissions.has(requestID)) break;
          if (type.includes("updated") && perm["status"] !== undefined && perm["status"] !== "pending") break;
          const tool = (perm["tool"] ?? perm["metadata"] ?? {}) as Record<string, unknown>;
          const title = typeof tool["title"] === "string" ? tool["title"] : "opencode 审批";
          sink({
            type: "permission.requested",
            sessionId,
            requestId: requestID,
            kind: typeof tool["name"] === "string" && /edit|write/i.test(String(tool["name"])) ? "file_write" : "tool",
            detail: `${title} ${JSON.stringify(perm["input"] ?? tool["input"] ?? {}).slice(0, 200)}`,
            risk: "medium",
          });
        }
        break;
      }
    }
  }
}
