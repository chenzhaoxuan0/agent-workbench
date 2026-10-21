/**
 * Kimi Code 执行器适配器 —— ACP 形态：`kimi acp` 常驻子进程，
 * JSON-RPC（newline-delimited）over stdio，与 mcode.ts / dsh.ts / hermes.ts 同构。
 *
 * 为什么走 ACP：kimi 官方把 `kimi acp` 定位成标准 Agent Client Protocol 入口，
 * 协议面完整 —— session/resume、request_permission 反向流、usage_update 全都有
 * （二进制方法表 + initialize 实测），裸 `kimi` 命令是全屏 TUI（终端 TUI 菜单
 * 一键直启，id 即命令名），headless 驱动走这里。
 *
 * 协议事实（kimi 2.1.1 实测 + kimi.exe 方法表/字符串走查）：
 * - initialize → {protocolVersion:1, agentInfo:{name:"Kimi Code CLI",version},
 *   agentCapabilities:{loadSession:true, promptCapabilities:{image:true,
 *   embeddedContext:true}, sessionCapabilities:{list,resume,close,delete,fork,
 *   additionalDirectories}, mcpCapabilities:{http:true,sse:true}}}
 * - ⚠ 认证是**前置闸**：凭据（~/.kimi-code/credentials/kimi-code.json，OAuth
 *   短命 token 靠 refresh 续期）过期/缺失时，initialize 之后的一切请求
 *   （包括 authenticate 自己）都报 -32000 "Authentication required"（实测）。
 *   恢复方式只有终端 `kimi login`（设备码流程，需人工浏览器操作），daemon
 *   无法代登 —— 认证失败在这里翻译成带指引的错误。凭据有效时无需 authenticate
 *   （与 dsh/opencode 同款：凭据走 CLI 自己的家目录）。
 * - session/new {cwd, mcpServers} → {sessionId, configOptions, availableModels,
 *   currentModelId, currentModeId}（二进制字符串证据；认证过期期间无法实测成功
 *   响应，解析全部防御性 —— 有就刷新模型清单，没有就保留 fallback）
 * - 模型/模式切换走 session/set_config_option（snake_case，同 opencode/hermes）
 *   + session/set_mode；⚠ 方法表里**没有** session/set_model（hermes 有、kimi
 *   没有，勿串）。configOption 的 value 形态未实测，原样回传 daemon 侧的模型 id，
 *   失败降级跟随默认
 * - StartRequest.mode 暂不映射：kimi 的 modeId 枚举随 session/new 下发
 *   （TUI 侧是 --yolo/--auto/--plan，ACP modeId 未实测），不猜枚举值
 * - session/prompt → session/update 通知 + 阻塞到轮末 {stopReason}：
 *   agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update /
 *   usage_update / current_mode_update / session_info_update /
 *   available_commands_update（后三类不翻译）
 * - 权限（session/request_permission 反向流）四档：allow_once / allow_always /
 *   reject_once / reject_always —— daemon 的 deny 落 reject_once
 * - reattach：session/resume（capabilities 声明 resume）；失败回落新会话
 * - 扩展方法 providers/list、providers/set、nes/* 等不使用
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ---- kimi web 传输（docs/13 Phase 4 Tier 3：本地 HTTP server + WS 事件流）--------
//
// 协议事实（kimi 2.1.1 本机实测 + docs/en/reference/server-api.md）：
// - 启动：`kimi web`，stdout 打 "Local: http://127.0.0.1:<port>/#token=<token>"
//   （端口顺延；token 每次启动随机）；实例注册 ~/.kimi-code/server/instances/
// - REST：POST /api/v1/sessions {title, metadata:{cwd}}（cwd 必填）→ {data:{id}}
//   POST /api/v1/sessions/{id}/prompts {content:[{type:"text",text}]} → accepted
//   GET /api/v1/sessions/{id}/messages?page_size=N（翻历史）
// - WS：ws://host/api/v1/ws，子协议 `kimi-code.bearer.<token>` 认证；
//   {type:"subscribe", payload:{session_ids:[…]}} 订阅后推
//   turn.started → assistant.delta → tool.call.started/tool.result → turn.ended
// - 双传输：web 拉不起来/请求失败回落既有 ACP 路径（kimi acp）

class KimiWebServer {
  private child: ChildProcess | null = null;
  private base: string | null = null;
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private starting: Promise<boolean> | null = null;
  eventHandler: ((msg: Record<string, unknown>) => void) | null = null;

  async ready(): Promise<boolean> {
    if (this.base !== null && this.child !== null && this.child.exitCode === null) return true;
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawn(): Promise<boolean> {
    try {
      const cmd = await resolveCommand("kimi");
      const child = spawn(cmd.file, [...cmd.prefixArgs, "web"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      const info = await new Promise<{ base: string; token: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("kimi web 30s 未就绪")), 30_000);
        createInterface({ input: child.stdout }).on("line", (line) => {
          const m = line.match(/Local:\s+(http:\/\/[\d.:]+)\/#token=(\S+)/);
          if (m !== null) {
            clearTimeout(timer);
            resolve({ base: m[1]!, token: m[2]! });
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`kimi web 退出（code ${code}）`));
        });
      });
      this.base = info.base;
      this.token = info.token;
      child.once("exit", () => {
        this.base = null;
        this.child = null;
        this.ws = null;
      });
      return true;
    } catch (err: unknown) {
      log.debug("kimi web 拉起失败（回落 ACP）", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  async rest(path: string, method: "GET" | "POST", body?: unknown, timeoutMs = 20000): Promise<{ code: number; json: unknown }> {
    const base = this.base;
    if (base === null || this.token === null) return { code: -1, json: { msg: "kimi web not ready" } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
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
      return { code: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** WS 订阅某会话（子协议认证；事件进 eventHandler） */
  async subscribe(sessionId: string): Promise<void> {
    const base = this.base;
    const token = this.token;
    if (base === null || token === null) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", payload: { session_ids: [sessionId] } }));
      return;
    }
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/v1/ws", [`kimi-code.bearer.${token}`]);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg["type"] === "subscribe" || msg["type"] === "hello") return;
        this.eventHandler?.(msg);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    };
    ws.onclose = () => {
      this.ws = null;
    };
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", payload: { session_ids: [sessionId] } }));
        resolve();
      };
      setTimeout(resolve, 3000); // 订阅失败不阻塞轮：REST 兜底
    });
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.base = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    child?.kill();
  }
}

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

// ---- ACP 线缆类型（宽松，同 dsh/hermes） --------------------------------------

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
    models?: { availableModels?: { modelId?: string; name?: string }[]; currentModelId?: string };
    availableModels?: { modelId?: string; name?: string }[];
    currentModelId?: string;
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

interface KimiSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly model: ModelId | null;
  /** kimi 的 ACP sessionId，session/new 或 session/resume 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  initialized: boolean;
  sessionLoaded: boolean;
  /** 模型 configOption 只在本进程首轮流前设置一次（会话级选择，不是轮级参数） */
  modelApplied: boolean;
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
  /** web 传输的轮内状态（webText 增量 / webSeen 消息幂等 / webDone 轮末） */
  webText: string;
  webMessageId: string | null;
  webDone: boolean;
  readonly webSeen: Set<string>;
}

// kimi 的模型清单随 session/new 下发（configOptions/availableModels）。登录态过期
// 期间拿不到真实清单，这里只放执行器默认这一个占位过注册的非空校验 —— 首个会话
// 建立后立即被 availableModels 覆盖。不要凭记忆填 k2 系列型号，猜错比空更误导。
const DEFAULT_KIMI_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "kimi/default" as ModelId,
    displayName: "Kimi 默认模型（登录后随会话下发真实清单）",
    multimodal: true,
  },
];

/**
 * 认证失败的统一出口：kimi 的 -32000 没有结构化码，靠消息文本识别（协议侧）；
 * 适配器自己抛的 executor_auth_required（resumeSession 等路径）直接认 code ——
 * 它的 message 是中文指引，不含英文原文，只查文本会漏。
 */
function isAuthError(err: unknown): boolean {
  if (err instanceof Error && (err as { code?: string }).code === "executor_auth_required") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Authentication required");
}

export class KimiAdapter implements ExecutorAdapter {
  readonly id = "kimi";
  readonly displayName = "Kimi Code";
  readonly glyph = "K";
  // 原生读取 cwd 下的 AGENTS.md（官方文档 What's New：AGENTS.md 为配置面，改后 /reload 生效）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [...DEFAULT_KIMI_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // session/resume（agentCapabilities 实测声明 resume）
    fileDiff: false, // ACP 事件翻译无 diff 流
    terminal: false,
    permissions: true, // request_permission 反向流，allow/reject × once/always 四档
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // mcpCapabilities http/sse 实测 true；session/new 可挂 mcpServers（daemon 暂不透传）
    usage: true, // usage_update 在二进制事件面里
    multimodal: true, // promptCapabilities.image 实测 true
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, KimiSession>();


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * Kimi 原生命令、技能与子智能体面：
   * 内置目录（见 builtin-catalogs.ts）+ 原生技能（.kimi/skills 与 .agents/skills）+
   * 子智能体（.kimi/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 Kimi。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < KimiAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverGenericToolSkillsAndAgents(this.id, rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("kimi");
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
            ? { status: "not_installed", hint: "未安装 kimi CLI（Kimi Code 安装器）" }
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
    const state = this.newState(sessionId, rootPath, { model: null }, sink);
    state.ref = ref; // session/resume 时用；cwd 不匹配时回落新会话
    return this.sessionHandle(state);
  }

  private newState(
    sessionId: SessionId,
    rootPath: string,
    opts: { model: StartRequest["model"] },
    sink: AdapterSink,
  ): KimiSession {
    const state: KimiSession = {
      sessionId,
      rootPath,
      model: opts.model ?? null,
      ref: null,
      sink,
      child: null,
      initialized: false,
      sessionLoaded: false,
      modelApplied: false,
      closed: false,
      cancelled: false,
      lastUsed: 0,
      usageCount: 0,
      nextId: 1,
      pending: new Map(),
      permissionPending: new Map(),
      toolTitles: new Map(),
      turn: null,
      webText: "",
      webMessageId: null,
      webDone: false,
      webSeen: new Set<string>(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private sessionHandle(state: KimiSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        // kimi web 传输优先（docs/13 Tier 3）；失败回落 ACP
        if (await this.web.ready()) {
          try {
            await this.webTurn(state, text);
            return;
          } catch (err: unknown) {
            log.info("kimi web 传输失败（回落 ACP）", {
              sessionId: state.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
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
      // stdin EOF 请求自退，kill 兜底（kimi 侧的 EOF 行为未实测，不赌它）
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
    await this.web.kill();
  }

  // ---- kimi web 传输 -------------------------------------------------------------

  private readonly web = new KimiWebServer();

  /** web 传输发一轮：建会话（懒）→ WS 订阅 → 提交 prompt → 事件翻译到轮末 */
  private async webTurn(state: KimiSession, prompt: string): Promise<void> {
    const sink = state.sink;
    const sessionId = state.sessionId;
    sink?.({ type: "session.status", sessionId, status: "running" });

    // 会话：懒建（ref 为空时）；kimi web 与 ACP 同一 session_ 命名空间，ref 互通
    if (state.ref === null) {
      const r = await this.web.rest("/api/v1/sessions", "POST", { title: "agent-workbench", metadata: { cwd: state.rootPath } });
      const id = (r.json as { data?: { id?: string } } | undefined)?.data?.id;
      if (id === undefined) throw new Error(`kimi web 建会话失败（HTTP ${r.code}）`);
      state.ref = id;
    }
    this.web.eventHandler = (msg) => this.onWebEvent(state, msg);
    await this.web.subscribe(state.ref);

    // 轮内状态
    state.webText = "";
    state.webMessageId = null;

    const r = await this.web.rest(`/api/v1/sessions/${state.ref}/prompts`, "POST", {
      content: [{ type: "text", text: prompt }],
    });
    const status = (r.json as { data?: { status?: string } } | undefined)?.data?.status;
    if (status === undefined) throw new Error(`kimi web prompt 提交失败（HTTP ${r.code}）${JSON.stringify(r.json ?? "").slice(0, 120)}`);

    // 等轮末：WS 事件置 webDone；15s 无 WS 就用 REST 轮询兜底（busy + 消息差量）
    const deadline = Date.now() + 300_000;
    let lastBusy: boolean | null = null;
    while (Date.now() < deadline) {
      if (state.webDone) break;
      await new Promise((res) => setTimeout(res, 1500));
      if (state.webDone) break;
      const s = await this.web.rest(`/api/v1/sessions/${state.ref}`, "GET");
      const busy = (s.json as { data?: { busy?: boolean } } | undefined)?.data?.busy;
      if (busy === false && lastBusy === true) break;
      if (busy === false && lastBusy === null) {
        // 从未 busy：可能瞬完，翻一次消息确认
        await this.pollWebMessages(state);
        break;
      }
      lastBusy = busy ?? lastBusy;
      await this.pollWebMessages(state);
    }
    // 收口：再翻一次消息（WS 没接上/丢事件时兜底）+ idle
    await this.pollWebMessages(state);
    state.webDone = false;
    sink?.({ type: "session.status", sessionId, status: "idle" });
  }

  /** REST 翻消息：把新增 assistant 消息翻成 message.delta/completed（幂等：按 seen id 跳过） */
  private async pollWebMessages(state: KimiSession): Promise<void> {
    const sink = state.sink;
    if (sink === null || state.ref === null) return;
    const r = await this.web.rest(`/api/v1/sessions/${state.ref}/messages?page_size=30`, "GET");
    const items = (r.json as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items ?? [];
    for (const m of items) {
      const id = typeof m["id"] === "string" ? m["id"] : null;
      if (id === null) continue;
      if (state.webSeen.has(id)) continue;
      state.webSeen.add(id);
      if (m["role"] !== "assistant") continue;
      const text = (Array.isArray(m["content"]) ? (m["content"] as Array<{ type?: string; text?: string }>).map((c) => c.text ?? "").join("") : String(m["content"] ?? "")).trim();
      if (text === "") continue;
      const messageId = id;
      sink({ type: "message.delta", sessionId: state.sessionId, messageId, role: "assistant", text });
      sink({ type: "message.completed", sessionId: state.sessionId, messageId, text });
    }
  }

  /** kimi web WS 事件（turn.started / assistant.delta / tool 类 / turn.ended）→ RuntimeEvent */
  private onWebEvent(state: KimiSession, msg: Record<string, unknown>): void {
    const sink = state.sink;
    if (sink === null) return;
    const type = String(msg["type"] ?? "");
    const sid = typeof msg["session_id"] === "string" ? msg["session_id"] : (msg["payload"] as Record<string, unknown> | undefined)?.["session_id"];
    if (typeof sid === "string" && state.ref !== null && sid !== state.ref) return;
    switch (type) {
      case "assistant.delta": {
        const text = String(msg["text"] ?? msg["delta"] ?? (msg["payload"] as Record<string, unknown> | undefined)?.["text"] ?? "");
        if (text !== "") {
          const messageId = state.webMessageId ?? `msg_${Date.now()}`;
          state.webMessageId = messageId;
          state.webText += text;
          sink({ type: "message.delta", sessionId: state.sessionId, messageId, role: "assistant", text });
        }
        break;
      }
      case "tool.call.started": {
        const p = (msg["payload"] ?? msg) as Record<string, unknown>;
        sink({
          type: "tool.started",
          sessionId: state.sessionId,
          callId: String(p["id"] ?? p["call_id"] ?? `call_${Date.now()}`),
          toolName: String(p["name"] ?? p["tool"] ?? "tool"),
          title: String(p["title"] ?? p["name"] ?? ""),
          // 原生参数透传：清单类工具（TodoWrite 等）的步骤全在这里
          input: ((p["input"] ?? p["arguments"] ?? p["args"]) as unknown) ?? {},
        });
        break;
      }
      case "tool.result": {
        const p = (msg["payload"] ?? msg) as Record<string, unknown>;
        sink({
          type: "tool.completed",
          sessionId: state.sessionId,
          callId: String(p["id"] ?? p["call_id"] ?? `call_${Date.now()}`),
          ok: p["error"] === undefined || p["error"] === null,
          output: String(p["output"] ?? p["text"] ?? "").slice(0, 4000),
        });
        break;
      }
      case "turn.ended": {
        state.webDone = true;
        // delta 已流过：completed 由 pollWebMessages 兜底（消息 id 才是权威）
        break;
      }
      case "turn.started":
      default:
        break;
    }
  }

  // ---- 进程与协议通道 ---------------------------------------------------------

  private async ensureSession(state: KimiSession): Promise<void> {
    if (state.child === null) {
      const cmd = await resolveCommand("kimi");
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
        log.debug("kimi acp stderr", { line: line.slice(0, 200) }),
      );
      child.once("close", () => {
        state.child = null;
        state.initialized = false;
        const err = adapterError("executor_exited", "kimi acp process exited");
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
      let res: {
        sessionId?: string;
        availableModels?: { modelId?: string; name?: string }[];
        currentModelId?: string;
        models?: { availableModels?: { modelId?: string; name?: string }[] };
      };
      try {
        res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: [] }, 60000)) as typeof res;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 认证闸：kimi 未登录/凭据过期时 session/new 必然失败，翻译成可操作的指引
        if (isAuthError(err)) {
          throw adapterError(
            "executor_auth_required",
            "kimi 未登录或凭据已过期 —— 在终端运行 `kimi login` 重新登录后重试（终端 TUI 菜单启动 kimi 也可在界面内登录）",
          );
        }
        throw err;
      }
      if (typeof res.sessionId !== "string" || res.sessionId === "") {
        throw adapterError("acp_no_session", "kimi acp session/new returned no sessionId");
      }
      state.ref = res.sessionId;
      state.sessionLoaded = true;
      this.syncModelsFromSession(res);
    } else if (!state.sessionLoaded) {
      await this.resumeSession(state);
    }
  }

  /** session/new 下发的模型清单 → 刷新适配器清单（fallback 只在拿不到时保留） */
  private syncModelsFromSession(res: {
    availableModels?: { modelId?: string; name?: string }[];
    currentModelId?: string;
    models?: { availableModels?: { modelId?: string; name?: string }[] };
  }): void {
    const list = res.availableModels ?? res.models?.availableModels;
    if (!Array.isArray(list) || list.length === 0) return;
    const parsed: ExecutorModelInfo[] = [];
    for (const m of list) {
      if (typeof m.modelId !== "string" || m.modelId === "") continue;
      parsed.push({
        id: m.modelId as ModelId,
        displayName: typeof m.name === "string" && m.name !== "" ? m.name : m.modelId,
        multimodal: true,
      });
    }
    if (parsed.length > 0) {
      this._models = parsed;
      log.info("kimi models synced from session/new", { count: parsed.length });
    }
  }

  /**
   * 主动刷新模型清单：起临时 ACP 进程问一次 session/new 拿 availableModels。
   *
   * 与 hermes 同理：原来只能被动等会话启动才更新，「订阅里新出了模型」在界面上
   * 看不见。零用量 —— session/new 是建会话不是发消息。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("kimi");
      const result = await queryAcpSessionNew(cmd.file, cmd.prefixArgs, ["acp"], { timeoutMs: 30000 });
      const { options } = pickAcpModelOptions(result);
      if (options.length === 0) {
        return { models: this._models, source: "static", reason: "session/new 未返回模型清单", elapsedMs: Date.now() - t0 };
      }
      const parsed: ExecutorModelInfo[] = options.map((o) => ({
        id: o.value as ModelId,
        displayName: o.name,
        contextWindow: o.contextWindow,
        reasoningLevels: o.reasoningLevels,
        multimodal: true,
      }));
      this._models = parsed;
      log.info("kimi models synced via ACP session/new", { count: parsed.length });
      return { models: parsed, source: "live", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("kimi 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }

  private async resumeSession(state: KimiSession): Promise<void> {
    try {
      const res = (await this.request(state, "session/resume", {
        sessionId: state.ref,
        cwd: state.rootPath,
        mcpServers: [],
      }, 60000)) as { availableModels?: { modelId?: string; name?: string }[]; models?: { availableModels?: { modelId?: string; name?: string }[] } };
      state.sessionLoaded = true;
      this.syncModelsFromSession(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(err)) {
        throw adapterError(
          "executor_auth_required",
          "kimi 未登录或凭据已过期 —— 在终端运行 `kimi login` 重新登录后重试",
        );
      }
      // cwd 变了 / 会话不可恢复：回落新会话，宁可丢历史也不能永久不可用
      log.warn("kimi session/resume failed, falling back to a fresh session", {
        ref: state.ref,
        error: msg,
      });
      state.ref = null;
      state.sessionLoaded = false;
      await this.ensureSession(state);
    }
  }

  private request(state: KimiSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.child === null) return Promise.reject(adapterError("executor_exited", "kimi acp not running"));
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

  private notify(state: KimiSession, method: string, params: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleWireLine(state: KimiSession, line: string): void {
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

  private respond(state: KimiSession, id: number, body: Record<string, unknown>): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // ---- turn 执行 ----

  private async runTurn(state: KimiSession, prompt: string): Promise<void> {
    state.cancelled = false;
    const acc: TurnAcc = { turnText: "", messageId: `msg_${Date.now()}`, usedBefore: state.lastUsed };
    // ensureSession 也必须在 try 里：kimi 把认证做成前置闸（凭据过期时 session/new
    // 直接失败），这个错误必须走 sink 到达 UI，而不是只变成 send 的 reject
    try {
      await this.ensureSession(state);
      await this.applyModel(state);

      state.turn = acc;
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
      const msg = err instanceof Error ? err.message : String(err);
      state.sink?.({
        type: "error",
        sessionId: state.sessionId,
        message: isAuthError(err)
          ? "kimi 未登录或凭据已过期 —— 在终端运行 `kimi login` 重新登录后重试"
          : `kimi turn failed: ${msg}`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
    } finally {
      state.turn = null;
    }
  }

  /** StartRequest.model → ACP configOption "model"（⚠ kimi 没有 session/set_model，见文件头） */
  private async applyModel(state: KimiSession): Promise<void> {
    if (state.model === null || state.modelApplied || state.ref === null) return;
    state.modelApplied = true;
    if (state.model === "kimi/default") return; // fallback 占位 id = 跟随 kimi 默认
    try {
      await this.request(state, "session/set_config_option", {
        sessionId: state.ref,
        configId: "model",
        value: state.model,
      });
    } catch (err: unknown) {
      log.debug("kimi applyModel failed (continuing with default model)", {
        model: state.model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private finalizeTurn(state: KimiSession, acc: TurnAcc, stopReason: string, cancelled: boolean): void {
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
        // usage_update 只有会话累计 token，无成本字段 —— 差值出账，costUsd 恒 0
        inputTokens: Math.max(0, state.lastUsed - acc.usedBefore),
        outputTokens: 0,
        costUsd: 0,
        model: state.model ?? "kimi-default",
        decodeMs: undefined,
        requestId: `kimi:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    if (!cancelled && stopReason !== "end_turn" && stopReason !== "cancelled") {
      sink({ type: "error", sessionId, message: `kimi turn ended with stopReason=${stopReason}`, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionId 可继续 session/prompt）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- session/update → RuntimeEvent ------------------------------------------

  private onSessionUpdate(state: KimiSession, params: { update?: AcpUpdate }): void {
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
        break; // current_mode_update / session_info_update / available_commands_update 等不翻译
    }
  }

  // ---- 权限审批（agent → client 反向请求） --------------------------------------

  private onPermissionRequest(state: KimiSession, acpId: number, params: NonNullable<AcpRequest["params"]>): void {
    const sink = state.sink;
    if (sink === null) {
      this.respond(state, acpId, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const requestId = params.toolCall?.toolCallId ?? `perm_${acpId}`;
    state.permissionPending.set(requestId, { acpId, options: params.options ?? [] });
    const raw = params.toolCall?.rawInput as { command?: string } | undefined;
    const title = params.toolCall?.title ?? (typeof raw?.command === "string" ? raw.command : undefined) ??
      state.toolTitles.get(requestId);
    const risk = params.toolCall?.kind === "execute" ? "medium" : "low";
    sink({
      type: "permission.requested",
      sessionId: state.sessionId,
      requestId,
      kind: risk === "medium" ? "shell" : "tool",
      detail: title !== undefined ? `kimi 请求执行：${title}` : "kimi 请求执行工具",
      risk,
    });
  }

  private resolvePermission(state: KimiSession, requestId: string, decision: "allow" | "deny" | "always"): void {
    const pending = state.permissionPending.get(requestId);
    if (pending === undefined) {
      log.warn("resolvePermission on unknown kimi request", { requestId });
      return;
    }
    state.permissionPending.delete(requestId);
    // kimi 四档（二进制字符串证据）：allow_once / allow_always / reject_once / reject_always
    // 优先按 optionId 匹配（hermes 的教训：optionId 才是语义载体），kind 兜底
    const wantIds: readonly string[] =
      decision === "deny" ? ["reject_once", "reject_always"]
      : decision === "always" ? ["allow_always", "allow_once"]
      : ["allow_once"];
    const wantKinds: readonly string[] =
      decision === "deny" ? ["reject_once", "reject_always"]
      : decision === "always" ? ["allow_always", "allow_once"]
      : ["allow_once"];
    const option =
      pending.options.find((o) => o.optionId !== undefined && wantIds.includes(o.optionId)) ??
      pending.options.find((o) => o.kind !== undefined && wantKinds.includes(o.kind)) ??
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
