/**
 * Hermes Agent 执行器适配器 —— ACP 形态：`hermes acp` 常驻子进程，
 * JSON-RPC（newline-delimited）over stdio，与 mcode.ts / dsh.ts / opencode.ts 同构。
 *
 * 为什么走 ACP：hermes 官方把 `hermes acp` 定位成编辑器集成入口（VS Code / Zed /
 * JetBrains），用标准 Python acp SDK（agentclientprotocol，v0.11.2 schema）实现，
 * 协议面完整 —— session/resume、request_permission 反向流、usage_update 全都有。
 * 裸 `hermes` 命令是全屏 TUI（终端 TUI 菜单一键直启，id 即命令名），headless 驱动
 * 走这里，一套心智与仓库里其它 ACP 适配器对齐。
 *
 * 协议事实（hermes 0.20.0 实测 + acp_adapter 源码 + venv 里 acp/meta.py 走查）：
 * - initialize → {protocolVersion:1, agentInfo:{name:"hermes-agent",version},
 *   agentCapabilities:{loadSession:true, promptCapabilities:{image:true},
 *   sessionCapabilities:{fork,list,resume}}}
 *   —— authenticate 只认本机已配置的 provider 方法（实测 minimax-cn 运行时凭据），
 *   daemon 不主动 authenticate（凭据走 hermes 自己的 ~/.hermes 配置）
 * - session/new {cwd, mcpServers} → {sessionId:UUID, models:{availableModels,
 *   currentModelId}, modes:{availableModes, currentModeId}}
 *   ⚠ 模型 id 是 **冒号分隔**（`minimax-cn:MiniMax-M3`），与 opencode 的斜杠、
 *   dsh 的 JSON 串都不同；清单随会话下发，顺手刷新适配器的 models
 * - 模型/模式切换是独立方法（acp/meta.py 的 wire 命名，snake_case，同 opencode、
 *   异于 dsh 的 camelCase）：session/set_model {sessionId, modelId}、
 *   session/set_mode {sessionId, modeId}
 *   ⚠ hermes 的 session/set_config_option 是兼容性空壳（server.py 源码：除
 *   edit-approval-policy 外全进无人读的 config_options 字典）—— 模型千万别走它
 * - session/prompt → session/update 通知 + 阻塞到轮末 {stopReason}
 *   - agent_message_chunk / agent_thought_chunk（content:{type:"text"}）
 *   - tool_call / tool_call_update（content 可嵌套，与 dsh 同款，必须递归解包）
 *   - usage_update{used, size} —— 会话累计 token，无成本字段；按轮差值出 usage
 *   - available_commands_update / session_info_update / current_mode_update 等不翻译
 * - 权限（acp_adapter/permissions.py 源码走查）：session/request_permission 反向流，
 *   options 按 **optionId** 区分档位（不是 kind！）：allow_once / allow_session /
 *   allow_always / deny / deny_always —— 比其它家的三档多一个「会话级允许」，
 *   daemon 的 always 优先落 allow_always、不在清单时降级 allow_session
 * - reattach：session/resume {sessionId, cwd, mcpServers}，cwd 必须与原会话一致
 *   （server.py：找不到会话时静默开新会话，历史不丢但接不回原上下文）；
 *   失败回落新会话，与 dsh/opencode 同款行为
 * - 关停：kill 兜底（Python 进程对 stdin EOF 的行为未实测，不赌它）
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
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { discoverGenericToolSkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type { NativeCommandInfo } from "../../contract.ts";
import { pickAcpModelOptions, queryAcpSessionNew } from "./acp-models.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- ACP 线缆类型（宽松，同 dsh/opencode） ------------------------------------

interface AcpContent {
  type?: string;
  text?: string;
  /** ACP 的内容块是**可嵌套**的：工具结果形如 `{type:"content", content:{type:"text",…}}` */
  content?: AcpContent | AcpContent[];
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
}

interface AcpRequest {
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
    options?: { optionId?: string; kind?: string; name?: string }[];
  };
}

interface AcpResponse {
  id?: number;
  result?: {
    sessionId?: string;
    stopReason?: string;
    models?: {
      availableModels?: { modelId?: string; name?: string; description?: string }[];
      currentModelId?: string;
    };
  };
  error?: { code?: number; message?: string };
}

// ---- 会话台账 ------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  readonly acpId: number;
  readonly options: readonly { optionId?: string; kind?: string }[];
}

interface TurnAcc {
  turnText: string;
  readonly messageId: string;
  /** 轮起点前的累计用量（usage_update 差值口径用） */
  readonly usedBefore: number;
}

interface HermesSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly model: ModelId | null;
  readonly mode: StartRequest["mode"];
  /** hermes 的 ACP sessionId（UUID），session/new 或 session/resume 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  initialized: boolean;
  sessionLoaded: boolean;
  /** 模型/模式只在本进程首轮流前设置一次（会话级选择，不是轮级参数） */
  optionsApplied: boolean;
  closed: boolean;
  cancelled: boolean;
  lastUsed: number;
  usageCount: number;
  nextId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly permissionPending: Map<string, PendingPermission>;
  /** toolCallId → 标题（权限请求的 detail 兜底） */
  readonly toolTitles: Map<string, string>;
  turn: TurnAcc | null;
}

// 本机实测清单（hermes model 交互选择器没有非交互列表输出，ACP 清单随首个会话刷新）。
// 模型 id 保持 hermes 原生冒号形态，set_model 原样回传。
const DEFAULT_HERMES_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "minimax-cn:MiniMax-M3" as ModelId,
    displayName: "MiniMax M3（当前默认）",
    contextWindow: 1000000,
    multimodal: true,
  },
  {
    id: "minimax-cn:MiniMax-M2.7" as ModelId,
    displayName: "MiniMax M2.7",
    contextWindow: 1000000,
    multimodal: true,
  },
  {
    id: "minimax-cn:MiniMax-M2.5" as ModelId,
    displayName: "MiniMax M2.5",
    contextWindow: 1000000,
    multimodal: true,
  },
  {
    id: "minimax-cn:MiniMax-M2" as ModelId,
    displayName: "MiniMax M2",
    contextWindow: 1000000,
    multimodal: true,
  },
];

export class HermesAdapter implements ExecutorAdapter {
  readonly id = "hermes";
  readonly displayName = "Hermes Agent";
  readonly glyph = "H";
  private _models: ExecutorModelInfo[] = [...DEFAULT_HERMES_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // session/resume（要求 cwd 与原会话一致）
    fileDiff: false, // ACP 事件翻译无 diff 流
    terminal: false,
    permissions: true, // request_permission 反向流，五档 optionId（allow/deny/会话级）
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // session/new / session/resume 可挂 mcpServers（daemon 暂不透传）
    usage: true, // usage_update 只有 token 数，无成本
    multimodal: true, // promptCapabilities.image 实测 true
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, HermesSession>();


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * Hermes 原生命令、技能与子智能体面：
   * 内置目录（见 builtin-catalogs.ts）+ 原生技能（.hermes/skills 与 .agents/skills）+
   * 子智能体（.hermes/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 Hermes。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < HermesAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverGenericToolSkillsAndAgents(this.id, rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("hermes");
      const out = await execLines(cmd, ["--version"], 30000);
      return {
        state: { status: "ready", version: out.split(/\r?\n/)[0]?.trim() || "unknown" },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 hermes CLI（hermes-agent 安装器 / pipx）" }
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
    state.ref = ref; // session/resume 时用；cwd 不匹配时回落新会话
    return this.sessionHandle(state);
  }

  private newState(
    sessionId: SessionId,
    rootPath: string,
    opts: { model: StartRequest["model"]; mode?: StartRequest["mode"] },
    sink: AdapterSink,
  ): HermesSession {
    const state: HermesSession = {
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

  private sessionHandle(state: HermesSession): AdapterSession {
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
      // stdin EOF 请求自退，kill 兜底（hermes Python 侧的 EOF 行为未实测，不赌它）
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

  private async ensureSession(state: HermesSession): Promise<void> {
    if (state.child === null) {
      const cmd = await resolveCommand("hermes");
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
        log.debug("hermes acp stderr", { line: line.slice(0, 200) }),
      );
      child.once("close", () => {
        state.child = null;
        state.initialized = false;
        const err = adapterError("executor_exited", "hermes acp process exited");
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
        models?: { availableModels?: { modelId?: string; name?: string }[]; currentModelId?: string };
      };
      if (typeof res.sessionId !== "string" || res.sessionId === "") {
        throw adapterError("acp_no_session", "hermes acp session/new returned no sessionId");
      }
      state.ref = res.sessionId;
      state.sessionLoaded = true;
      this.syncModelsFromSession(res.models);
    } else if (!state.sessionLoaded) {
      await this.resumeSession(state);
    }
  }

  /** session/new 下发的 availableModels → 刷新适配器模型清单（fallback 永不被清空） */
  private syncModelsFromSession(models: {
    availableModels?: { modelId?: string; name?: string }[];
    currentModelId?: string;
  } | undefined): void {
    const list = models?.availableModels;
    if (!Array.isArray(list) || list.length === 0) return;
    const parsed: ExecutorModelInfo[] = [];
    for (const m of list) {
      if (typeof m.modelId !== "string" || m.modelId === "") continue;
      parsed.push({
        id: m.modelId as ModelId,
        displayName: typeof m.name === "string" && m.name !== "" ? m.name : m.modelId,
        contextWindow: 1000000, // ACP 面不带 contextWindow；hermes 默认 1M 档
        multimodal: true,
      });
    }
    if (parsed.length > 0) {
      this._models = parsed;
      log.info("hermes models synced from session/new", { count: parsed.length });
    }
  }

  /**
   * 主动刷新模型清单：起临时 ACP 进程问一次 session/new 拿 availableModels。
   *
   * 原来这条路径只能**被动**触发 —— 必须先有用户真的开一轮会话，模型清单才会更新。
   * 于是「订阅里新出了个模型」在界面上永远看不见，直到你恰好用了一次。
   * 改成可主动调用后，模型按钮就能独立于会话刷新。
   *
   * 零用量：session/new 是建会话不是发消息，不烧 token。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("hermes");
      const result = await queryAcpSessionNew(cmd.file, cmd.prefixArgs, ["acp"], { timeoutMs: 30000 });
      const { options } = pickAcpModelOptions(result);
      if (options.length === 0) {
        return { models: this._models, source: "static", reason: "session/new 未返回模型清单", elapsedMs: Date.now() - t0 };
      }
      const parsed: ExecutorModelInfo[] = options.map((o) => ({
        id: o.value as ModelId,
        displayName: o.name,
        contextWindow: o.contextWindow ?? 1000000, // ACP 面不带 contextWindow；hermes 默认 1M 档
        reasoningLevels: o.reasoningLevels,
        multimodal: true,
      }));
      this._models = parsed;
      log.info("hermes models synced via ACP session/new", { count: parsed.length });
      return { models: parsed, source: "live", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("hermes 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }

  private async resumeSession(state: HermesSession): Promise<void> {
    try {
      const res = (await this.request(state, "session/resume", {
        sessionId: state.ref,
        cwd: state.rootPath,
        mcpServers: [],
      }, 60000)) as { models?: { availableModels?: { modelId?: string; name?: string }[] } };
      state.sessionLoaded = true;
      this.syncModelsFromSession(res?.models);
    } catch (err: unknown) {
      // cwd 变了 / 会话不可恢复：回落新会话，宁可丢历史也不能永久不可用
      log.warn("hermes session/resume failed, falling back to a fresh session", {
        ref: state.ref,
        error: err instanceof Error ? err.message : String(err),
      });
      state.ref = null;
      state.sessionLoaded = false;
      await this.ensureSession(state);
    }
  }

  private request(state: HermesSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.child === null) return Promise.reject(adapterError("executor_exited", "hermes acp not running"));
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

  private notify(state: HermesSession, method: string, params: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleWireLine(state: HermesSession, line: string): void {
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

  private respond(state: HermesSession, id: number, body: Record<string, unknown>): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // ---- turn 执行 ----

  private async runTurn(state: HermesSession, prompt: string): Promise<void> {
    state.cancelled = false;
    await this.ensureSession(state);
    await this.applySessionOptions(state);

    const acc: TurnAcc = { turnText: "", messageId: `msg_${Date.now()}`, usedBefore: state.lastUsed };
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
        message: `hermes session/prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
    } finally {
      state.turn = null;
    }
  }

  /**
   * StartRequest → hermes 会话级选项。只在本进程首轮流前应用一次。
   * - 模型走 session/set_model（set_config_option 是空壳，见文件头）
   * - 档位映射：yolo→dont_ask（全自动）、edit→accept_edits（自动改工作区文件）、
   *   其余不设（跟随 hermes 当前模式 default=每改必问）
   */
  private async applySessionOptions(state: HermesSession): Promise<void> {
    if (state.optionsApplied || state.ref === null) return;
    state.optionsApplied = true;
    if (state.model !== null) {
      try {
        await this.request(state, "session/set_model", { sessionId: state.ref, modelId: state.model });
      } catch (err: unknown) {
        log.debug("hermes set_model failed (continuing with session default)", {
          model: state.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const modeId = state.mode === "yolo" ? "dont_ask" : state.mode === "edit" ? "accept_edits" : null;
    if (modeId !== null) {
      try {
        await this.request(state, "session/set_mode", { sessionId: state.ref, modeId });
      } catch (err: unknown) {
        log.debug("hermes set_mode failed (continuing with default mode)", {
          modeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private finalizeTurn(state: HermesSession, acc: TurnAcc, stopReason: string, cancelled: boolean): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }
    if (state.lastUsed > acc.usedBefore) {
      sink({
        type: "usage",
        sessionId,
        // usage_update 只有会话累计 token（used），无成本字段 —— 差值出账，costUsd 恒 0
        inputTokens: Math.max(0, state.lastUsed - acc.usedBefore),
        outputTokens: 0,
        costUsd: 0,
        model: state.model ?? "hermes-default",
        decodeMs: undefined,
        requestId: `hermes:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    if (!cancelled && stopReason !== "end_turn" && stopReason !== "cancelled") {
      sink({ type: "error", sessionId, message: `hermes turn ended with stopReason=${stopReason}`, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionId 可继续 session/prompt）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- session/update → RuntimeEvent ------------------------------------------

  private onSessionUpdate(state: HermesSession, params: { update?: AcpUpdate }): void {
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
        break;
      }
      default:
        break; // available_commands_update / session_info_update / current_mode_update 等不翻译
    }
  }

  // ---- 权限审批（agent → client 反向请求） --------------------------------------

  private onPermissionRequest(state: HermesSession, acpId: number, params: NonNullable<AcpRequest["params"]>): void {
    const sink = state.sink;
    if (sink === null) {
      this.respond(state, acpId, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const requestId = params.toolCall?.toolCallId ?? `perm_${acpId}`;
    state.permissionPending.set(requestId, { acpId, options: params.options ?? [] });
    // hermes 权限请求挂在 toolCallUpdate 上：rawInput.command 是要执行的命令，title 兜底
    const raw = params.toolCall?.rawInput as { command?: string } | undefined;
    const title = params.toolCall?.title ?? (typeof raw?.command === "string" ? raw.command : undefined) ??
      state.toolTitles.get(requestId);
    const risk = params.toolCall?.kind === "execute" ? "medium" : "low";
    sink({
      type: "permission.requested",
      sessionId: state.sessionId,
      requestId,
      kind: risk === "medium" ? "shell" : "tool",
      detail: title !== undefined ? `hermes 请求执行：${title}` : "hermes 请求执行工具",
      risk,
    });
  }

  private resolvePermission(state: HermesSession, requestId: string, decision: "allow" | "deny" | "always"): void {
    const pending = state.permissionPending.get(requestId);
    if (pending === undefined) {
      log.warn("resolvePermission on unknown hermes request", { requestId });
      return;
    }
    state.permissionPending.delete(requestId);
    // hermes 按 optionId 分档（源码 _OPTION_ID_TO_HERMES），不是 kind：
    // allow→allow_once；always 首选 allow_always，不在请求里就落「会话级允许」；
    // deny→deny，兜底 deny_always（smart_denied 场景下 deny_always 也在）
    const wantIds: readonly string[] =
      decision === "deny" ? ["deny", "deny_always"]
      : decision === "always" ? ["allow_always", "allow_session", "allow_once"]
      : ["allow_once"];
    const option =
      pending.options.find((o) => o.optionId !== undefined && wantIds.includes(o.optionId)) ??
      pending.options[0];
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

function asBlockArray(content: AcpContent | AcpContent[] | undefined): AcpContent[] {
  if (content === undefined) return [];
  return Array.isArray(content) ? content : [content];
}

function chunkText(content: AcpContent | AcpContent[] | undefined): string {
  let out = "";
  for (const b of asBlockArray(content)) {
    if (b.type === "text" || b.type === undefined) {
      out += b.text ?? "";
      continue;
    }
    // ⚠ 嵌套形态必须解开：ACP 的 tool_call_update 内容是
    // `content:[{type:"content", content:{type:"text", text:"…"}}]`，
    // 只认 type==="text" 会让每个 tool.completed 的 output 都是空串。
    if (b.type === "content") out += chunkText(b.content);
  }
  return out;
}
