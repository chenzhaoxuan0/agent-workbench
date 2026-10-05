/**
 * OpenCode 执行器适配器 —— ACP 形态：`opencode acp` 常驻子进程，
 * JSON-RPC（newline-delimited）over stdio，与 mcode.ts / dsh.ts 同构。
 *
 * 为什么从 HTTP server 形态（opencode serve + REST/SSE）换成 ACP：上一版按 t3code
 * 的 OpenCodeServerOwner 走 HTTP，是 opencode 的一等公民接口，但代价是自管 SSE
 * 重连、轮完成靠 session.idle 事件 + 30min 兜底定时器这类启发式。产品决定不需要
 * 单 serve 多会话复用（切执行器就开新会话），fileDiff 能力也用不上 —— 那就统一到
 * 仓库已有的 ACP 形态：轮末是协议级（session/prompt 阻塞返回 stopReason），
 * 进程生死即连接生死，与 dsh/mcode 一套心智。
 *
 * 协议事实（opencode 1.18.34 实测 + packages/opencode/src/acp 源码走查）：
 * - initialize → {protocolVersion:1, agentCapabilities:{loadSession:true,
 *   sessionCapabilities:{close,fork,list,resume}, promptCapabilities:{image:true}},
 *   authMethods:[opencode-login]}
 * - session/new {cwd, mcpServers} → {sessionId:"ses_…", configOptions:[
 *   {id:"model", type:"select", value 是 "providerID/modelID" 纯字符串},
 *   {id:"mode", options:[build, plan]}]} —— 完整模型清单随会话下发，
 *   本机默认（currentValue）实测为 opencode/big-pickle
 * - 模型/模式选择走 session/set_config_option —— 注意是 snake_case：
 *   camelCase 的 session/setConfigOption 实测 method not found（dsh 相反，勿串）
 * - session/prompt → session/update 通知 + 阻塞到轮末 {stopReason}
 *   - agent_message_chunk / agent_thought_chunk（content:{type:"text"}）
 *   - tool_call{toolCallId,title,kind:execute/edit/search/read/think/other,rawInput}
 *   - tool_call_update{status:"completed"|"failed",content:[…]}
 *   - usage_update{used, size, cost:{amount,currency}} —— used 是上下文累计 token
 *     （input+cache 读写），cost.amount 是会话累计成本；按轮差值出 usage
 *   - available_commands_update / config_option_update / user_message_chunk 等不翻译
 * - 权限三档全（源码 permission.ts）：options = [{optionId:"once",kind:"allow_once"},
 *   {optionId:"always",kind:"allow_always"},{optionId:"reject",kind:"reject_once"}]
 *   —— daemon 的 allow/always/deny 恰好一一对应，无需降级
 * - reattach：session/resume {sessionId, cwd, mcpServers}（会话按项目落盘全局可寻址），
 *   失效回落新会话；恢复的历史更新会以 session/update 重放（轮外 chunk 丢弃，
 *   tool_call 保留 —— 时间线上可见历史，与 dsh/mcode 同款行为）
 * - fileDiff 如实报 false：ACP 事件翻译无 diff 流；edit 工具 rawInput 里的
 *   oldText/newText 是模型输入对，不是落盘结果（HTTP 形态的 GET /session/:id/diff
 *   才是权威 patch —— 那是旧形态唯一的能力优势，产品已确认用不上）
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  adapterError,
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- ACP 线缆类型（宽松，同 dsh/mcode） ---------------------------------------

interface AcpContent {
  type?: string;
  text?: string;
}

interface AcpUpdate {
  sessionUpdate?: string;
  content?: AcpContent | AcpContent[];
  messageId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  used?: number;
  size?: number;
  cost?: { amount?: number };
}

interface AcpRequest {
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string };
    options?: { optionId?: string; name?: string; kind?: string }[];
  };
}

interface AcpResponse {
  id?: number;
  result?: { sessionId?: string; stopReason?: string };
  error?: { code?: number; message?: string };
}

// ---- 会话台账 ------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  readonly acpId: number;
  readonly options: readonly { optionId?: string; name?: string; kind?: string }[];
}

interface TurnAcc {
  turnText: string;
  readonly messageId: string;
  /** 轮起点前的累计用量（usage_update 差值口径用） */
  readonly usedBefore: number;
  readonly costBefore: number;
}

interface OcSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly model: ModelId | null;
  readonly mode: StartRequest["mode"];
  /** opencode 的 ACP sessionId（"ses_…"），session/new 或 session/resume 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  initialized: boolean;
  sessionLoaded: boolean;
  /** configOption 只在本进程首轮流前设置一次（会话级选择，不是轮级参数） */
  optionsApplied: boolean;
  closed: boolean;
  cancelled: boolean;
  lastUsed: number;
  lastCost: number;
  usageCount: number;
  nextId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly permissionPending: Map<string, PendingPermission>;
  /** toolCallId → 标题（权限请求只带 toolCallId 时的 detail 兜底） */
  readonly toolTitles: Map<string, string>;
  turn: TurnAcc | null;
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

  async syncModels(): Promise<readonly ExecutorModelInfo[]> {
    try {
      const cmd = await resolveCommand("opencode");
      const out = await execLines(cmd, ["models", "--verbose"], 10000);
      const parsed = parseOpencodeModelsVerbose(out);
      if (parsed.length > 0) {
        this._models = parsed;
        log.info("opencode models synced dynamically", { count: parsed.length });
      }
    } catch (err: unknown) {
      log.debug("opencode models --verbose failed, using fallback models", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this._models;
  }
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // session/resume（会话按项目落盘全局可寻址）
    fileDiff: false, // ACP 事件翻译无 diff 流（见文件头）
    terminal: false,
    permissions: true, // request_permission 反向流，allow_once/allow_always/reject_once 三档全
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // initialize 报 mcpCapabilities http/sse；session/new 可挂 mcpServers（daemon 暂不透传）
    usage: true, // usage_update 带上下文累计 token 与会话累计成本，差值出账
    multimodal: true, // promptCapabilities.image 实测 true
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, OcSession>();

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
            ? { status: "not_installed", hint: "未安装 opencode CLI（npm i -g opencode-ai）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state = this.newState(`sess_${randomUUID()}` as SessionId, req.rootPath, req, sink);
    return this.sessionHandle(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state = this.newState(sessionId, rootPath, { model: null, mode: undefined }, sink);
    state.ref = ref; // session/resume 时用；cwd 不匹配或不可恢复时回落新会话
    return this.sessionHandle(state);
  }

  private newState(
    sessionId: SessionId,
    rootPath: string,
    opts: { model: StartRequest["model"]; mode?: StartRequest["mode"] },
    sink: AdapterSink,
  ): OcSession {
    const state: OcSession = {
      sessionId,
      rootPath,
      model: opts.model ?? null,
      mode: opts.mode,
      ref: null,
      sink,
      child: null,
      initialized: false,
      sessionLoaded: false,
      optionsApplied: false,
      closed: false,
      cancelled: false,
      lastUsed: 0,
      lastCost: 0,
      usageCount: 0,
      nextId: 1,
      pending: new Map(),
      permissionPending: new Map(),
      toolTitles: new Map(),
      turn: null,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private sessionHandle(state: OcSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        if (state.ref !== null && state.child !== null && state.initialized) {
          this.notify(state, "session/cancel", { sessionId: state.ref });
        }
      },
      resolvePermission: async (requestId, decision) => {
        this.resolvePermission(state, requestId, decision);
      },
      externalRef: () => state.ref,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.closed = true;
      for (const p of st.pending.values()) p.reject(adapterError("adapter_disposed", "adapter is shutting down"));
      st.pending.clear();
      const child = st.child;
      // stdin EOF 请求自退，kill 兜底（opencode 侧的 EOF 行为未实测，不赌它）
      child?.stdin?.end();
      const killTimer = setTimeout(() => {
        if (child !== null && child.exitCode === null) child.kill();
      }, 3000);
      killTimer.unref?.();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      st.child = null;
    }
    this.sessions.clear();
  }

  // ---- 进程与协议通道 ---------------------------------------------------------

  private async ensureSession(state: OcSession): Promise<void> {
    if (state.child === null) {
      const cmd = await resolveCommand("opencode");
      // 常驻协议进程：stdin 是协议通道，绝不能关（exec.ts closeStdin 语义）
      const child = spawn(cmd.file, [...cmd.prefixArgs, "acp"], {
        cwd: state.rootPath,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      });
      state.child = child;
      child.stdout?.setEncoding("utf8");
      let buf = "";
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line !== "") this.handleWireLine(state, line);
        }
      });
      child.stderr?.setEncoding("utf8");
      createInterface({ input: child.stderr }).on("line", (line) =>
        log.debug("opencode acp stderr", { line: line.slice(0, 200) }),
      );
      child.once("close", () => {
        state.child = null;
        state.initialized = false;
        const err = adapterError("executor_exited", "opencode acp process exited");
        for (const p of state.pending.values()) p.reject(err);
        state.pending.clear();
      });
    }
    if (!state.initialized) {
      await this.request(state, "initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, 60000);
      state.initialized = true;
    }
    if (state.ref === null) {
      const res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: [] }, 60000)) as {
        sessionId?: string;
      };
      if (typeof res.sessionId !== "string" || res.sessionId === "") {
        throw adapterError("acp_no_session", "opencode acp session/new returned no sessionId");
      }
      state.ref = res.sessionId;
      state.sessionLoaded = true;
    } else if (!state.sessionLoaded) {
      await this.resumeSession(state);
    }
  }

  private async resumeSession(state: OcSession): Promise<void> {
    try {
      await this.request(state, "session/resume", { sessionId: state.ref, cwd: state.rootPath, mcpServers: [] }, 60000);
      state.sessionLoaded = true;
    } catch (err: unknown) {
      // cwd 变了 / 会话不可恢复：回落新会话，宁可丢历史也不能永久不可用
      log.warn("opencode session/resume failed, falling back to a fresh session", {
        ref: state.ref,
        error: err instanceof Error ? err.message : String(err),
      });
      state.ref = null;
      state.sessionLoaded = false;
      await this.ensureSession(state);
    }
  }

  private request(state: OcSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.child === null) return Promise.reject(adapterError("executor_exited", "opencode acp not running"));
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? null
        : setTimeout(() => {
            state.pending.delete(id);
            reject(adapterError("acp_timeout", `${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
      state.pending.set(id, {
        resolve: (v) => {
          if (timer !== null) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer !== null) clearTimeout(timer);
          reject(e);
        },
      });
      state.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(state: OcSession, method: string, params: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleWireLine(state: OcSession, line: string): void {
    let msg: (AcpRequest & AcpResponse) | null = null;
    try {
      msg = JSON.parse(line) as AcpRequest & AcpResponse;
    } catch {
      return;
    }
    if (msg === null) return;

    // ① agent → client 的请求（权限审批）；未知请求按协议礼貌回 method not found
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        this.onPermissionRequest(state, msg.id, msg.params ?? {});
      } else {
        this.respond(state, msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
      return;
    }
    // ② 响应
    if (msg.id !== undefined) {
      const p = state.pending.get(msg.id);
      if (p === undefined) return;
      state.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error.message ?? "acp request failed"));
      else p.resolve(msg.result ?? {});
      return;
    }
    // ③ 通知
    if (msg.method === "session/update") {
      this.onSessionUpdate(state, msg.params as { update?: AcpUpdate });
    }
  }

  private respond(state: OcSession, id: number, body: Record<string, unknown>): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // ---- turn 执行 ----

  private async runTurn(state: OcSession, prompt: string): Promise<void> {
    state.cancelled = false;
    await this.ensureSession(state);
    await this.applyConfigOptions(state);

    const acc: TurnAcc = {
      turnText: "",
      messageId: `msg_${Date.now()}`,
      usedBefore: state.lastUsed,
      costBefore: state.lastCost,
    };
    state.turn = acc;
    try {
      const res = (await this.request(state, "session/prompt", {
        sessionId: state.ref,
        prompt: [{ type: "text", text: prompt }],
      })) as { stopReason?: string };
      this.finalizeTurn(state, acc, res.stopReason ?? "end_turn", state.cancelled);
    } catch (err: unknown) {
      if (state.cancelled) {
        this.finalizeTurn(state, acc, "cancelled", true);
        return;
      }
      state.sink?.({
        type: "error",
        sessionId: state.sessionId,
        message: `opencode session/prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
    } finally {
      state.turn = null;
    }
  }

  /** StartRequest 的模型与档位 → ACP configOption。注意方法名是 snake_case（实测，dsh 相反） */
  private async applyConfigOptions(state: OcSession): Promise<void> {
    if (state.optionsApplied || state.ref === null) return;
    state.optionsApplied = true;
    // 模型：value 是 "providerID/modelID" 纯字符串（实测）；null = 不设，跟随 opencode 默认
    if (state.model !== null && state.model.includes("/")) {
      try {
        await this.request(state, "session/set_config_option", {
          sessionId: state.ref,
          configId: "model",
          value: state.model,
        });
      } catch (err: unknown) {
        log.debug("opencode applyModel failed (continuing with default model)", {
          model: state.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 档位：configOptions 只有 build/plan 两档，plan 之外都不设（build 是默认）
    if (state.mode === "plan") {
      try {
        await this.request(state, "session/set_config_option", {
          sessionId: state.ref,
          configId: "mode",
          value: "plan",
        });
      } catch (err: unknown) {
        log.debug("opencode applyMode failed (continuing with build)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private finalizeTurn(state: OcSession, acc: TurnAcc, stopReason: string, cancelled: boolean): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }
    if (state.lastUsed > acc.usedBefore || state.lastCost > acc.costBefore) {
      sink({
        type: "usage",
        sessionId,
        // usage_update 的 used 是上下文累计 token（input+cache 读写）、cost.amount 是
        // 会话累计成本 —— 都按轮差值出账；outputTokens 拆不出来，如实记 0
        inputTokens: Math.max(0, state.lastUsed - acc.usedBefore),
        outputTokens: 0,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        costUsd: Math.max(0, state.lastCost - acc.costBefore),
        model: state.model ?? "opencode-default",
        decodeMs: undefined,
        requestId: `opencode:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    if (!cancelled && stopReason !== "end_turn" && stopReason !== "cancelled") {
      sink({ type: "error", sessionId, message: `opencode turn ended with stopReason=${stopReason}`, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionId 可继续 session/prompt）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- session/update → RuntimeEvent ------------------------------------------

  private onSessionUpdate(state: OcSession, params: { update?: AcpUpdate }): void {
    const sink = state.sink;
    const update = params.update;
    if (sink === null || update === undefined) return;
    const sessionId = state.sessionId;
    const acc = state.turn;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = chunkText(update.content);
        if (text !== "" && acc !== null) {
          acc.turnText += text;
          sink({ type: "message.delta", sessionId, messageId: acc.messageId, role: "assistant", text });
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = chunkText(update.content);
        if (text !== "" && acc !== null) {
          sink({ type: "reasoning.delta", sessionId, messageId: acc.messageId, text });
        }
        break;
      }
      case "tool_call": {
        if (update.toolCallId === undefined) break;
        if (update.title !== undefined) state.toolTitles.set(update.toolCallId, update.title);
        sink({
          type: "tool.started",
          sessionId,
          callId: update.toolCallId,
          toolName: update.title ?? "tool",
          title: update.title ?? "tool",
          input: update.rawInput ?? null,
        });
        break;
      }
      case "tool_call_update": {
        if (update.toolCallId === undefined) break;
        if (update.status === "completed" || update.status === "failed") {
          const output = chunkText(update.content);
          sink({
            type: "tool.completed",
            sessionId,
            callId: update.toolCallId,
            ok: update.status === "completed",
            output: output.slice(0, 8000),
          });
          state.toolTitles.delete(update.toolCallId);
        }
        break;
      }
      case "usage_update": {
        if (typeof update.used === "number") state.lastUsed = update.used;
        if (typeof update.cost?.amount === "number") state.lastCost = update.cost.amount;
        break;
      }
      default:
        break; // available_commands_update / config_option_update / user_message_chunk 等不翻译
    }
  }

  // ---- 权限审批（agent → client 反向请求） --------------------------------------

  private onPermissionRequest(state: OcSession, acpId: number, params: NonNullable<AcpRequest["params"]>): void {
    const sink = state.sink;
    if (sink === null) {
      this.respond(state, acpId, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const requestId = params.toolCall?.toolCallId ?? `perm_${acpId}`;
    state.permissionPending.set(requestId, { acpId, options: params.options ?? [] });
    const kind = permissionKind(params.toolCall?.kind);
    const title = params.toolCall?.title ?? state.toolTitles.get(requestId);
    sink({
      type: "permission.requested",
      sessionId: state.sessionId,
      requestId,
      kind,
      detail: title !== undefined ? `opencode 请求执行：${title}` : "opencode 请求执行工具",
      risk: kind === "shell" ? "medium" : "low",
    });
  }

  private resolvePermission(state: OcSession, requestId: string, decision: "allow" | "deny" | "always"): void {
    const pending = state.permissionPending.get(requestId);
    if (pending === undefined) {
      log.warn("resolvePermission on unknown opencode request", { requestId });
      return;
    }
    state.permissionPending.delete(requestId);
    // 三档一一对应（源码 permission.ts）：allow→once / always→always / deny→reject
    const want = decision === "deny" ? "reject_once" : decision === "always" ? "allow_always" : "allow_once";
    const option = pending.options.find((o) => o.kind === want) ?? pending.options[0];
    this.respond(state, pending.acpId, {
      result: { outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId } },
    });
    state.sink?.({
      type: "permission.resolved",
      sessionId: state.sessionId,
      requestId,
      decision,
    });
  }
}

// ---- 小工具 -------------------------------------------------------------------

function permissionKind(acpKind: string | undefined): "file_write" | "shell" | "network" | "tool" {
  switch (acpKind) {
    case "execute":
      return "shell";
    case "edit":
      return "file_write";
    case "fetch":
      return "network";
    default:
      return "tool";
  }
}

function asBlockArray(content: AcpContent | AcpContent[] | undefined): AcpContent[] {
  if (content === undefined) return [];
  return Array.isArray(content) ? content : [content];
}

function chunkText(content: AcpContent | AcpContent[] | undefined): string {
  return asBlockArray(content)
    .filter((b) => b.type === "text" || b.type === undefined)
    .map((b) => b.text ?? "")
    .join("");
}
