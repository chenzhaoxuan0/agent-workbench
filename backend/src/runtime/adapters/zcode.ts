/**
 * ZCode 执行器适配器 —— 双传输：app-server（全能力，首选）+ `-p --json`（自动回退）。
 *
 * 【app-server 路径】`zcode app-server --stdio`（ZCode Protocol v1，NDJSON JSON-RPC 方言）：
 * - 真流式：session/subscribe 后 model.streaming(text_delta/reasoning_delta) 逐块推送；
 * - 工具事件：tool.updated(scheduled/result/error) → tool.started/completed；
 * - 权限反向流：interaction/requestPermission 挂起 → permission.requested →
 *   resolvePermission 应答 —— 与 Phase 4 权限闸/前端权限卡真实闭环（mode=build 时生效）；
 * - 多轮：同会话 session/send 原生续聊；usage 真 provider 计数（turn 级，缺时差值兜底）；
 * - 认证：standalone 引导读共享凭据库 + 内部认证头端口，daemon 无需任何 key。
 *
 * 【fork 前置补丁】（awb/standalone-app-server 分支，已并入本机安装的 CLI）：
 * app-server 入口原先不传 standalone 引导（-p/TUI 传了），registry 恒空 →
 * "Select a model before continuing"；且认证头端口不内接，turn 死在 prepare。
 * 两处都在 apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts。
 *
 * 【回退】app-server 起不动（未打补丁的安装 / registry 空 / spawn 失败）时，
 * 进程级降级到 -p 路径：真实回复/usage/多轮（--resume）仍在，但无流式、
 * 无工具事件、无权限流（yolo 单轮）。能力边界见 PrintTransport。
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
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
  UnitId,
} from "../../contract.ts";
import { isShellTool } from "../../contract.ts";
import { execLines, resolveCommand, spawnLines, type ResolvedCommand } from "../exec.ts";
import { log } from "../../log.ts";

const RPC_TIMEOUT_MS = 180_000;
/** 本机（bigmodel 个人套餐）的 registry providerId；写错会被 create 拒绝并回落默认模型 */
const CODING_PLAN_PROVIDER_ID = "account:bigmodel-individual-coding-plan";

// ---- 宽松协议类型 ----------------------------------------------------------

interface ProtoMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ProtoEvent {
  sessionId?: string;
  seq?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

// ---- 翻译辅助 --------------------------------------------------------------

function classifyPermission(toolName: string): "file_write" | "shell" | "network" | "tool" {
  const n = toolName.toLowerCase();
  if (/edit|write|patch|apply|replace/.test(n)) return "file_write";
  if (isShellTool(toolName)) return "shell";
  if (/fetch|web|http|curl|browser|search/.test(n)) return "network";
  return "tool";
}

function mapRisk(riskLevel: unknown): "low" | "medium" | "high" {
  if (riskLevel === "low") return "low";
  if (riskLevel === "high" || riskLevel === "critical") return "high";
  return "medium";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ==== 传输一：app-server（全能力）==========================================

interface AppServerSessionState {
  readonly sessionId: SessionId;
  readonly unitId: UnitId;
  readonly model: ModelId | null;
  readonly rootPath: string;
  sink: AdapterSink | null;
  currentMessageId: string | null;
  ended: boolean;
  /** resume/订阅完成门：send 必须等它（否则竞态打在不活跃会话上——冒烟实证） */
  ready: Promise<void>;
  /** turn 级 usage 缺失时用 session/usage 总量差值兜底 */
  cumulative: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** toolCallId → server 反向请求 id（权限应答按原 id 回；"" = 反向请求未到） */
  readonly pendingPermissions: Map<string, string>;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
}

export class ZcodeAppServerTransport {
  private child: ChildProcess | null = null;
  private connecting: Promise<void> | null = null;
  private rpcSeq = 0;
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly sessions = new Map<string, AppServerSessionState>();

  async ensureConnected(): Promise<void> {
    if (this.child !== null && this.child.exitCode === null) return;
    if (this.connecting !== null) return this.connecting;

    this.connecting = (async () => {
      const cmd = await resolveCommand("zcode");
      const child = spawnLines(cmd, ["app-server", "--stdio"], {
        closeStdin: false, // stdin 就是协议通道，EOF = 服务端优雅退出（冒烟实证）
        onLine: (line) => this.handleLine(line),
        onStderrLine: (line) => log.debug("zcode app-server stderr", { line: line.slice(0, 200) }),
        onExit: (code) => {
          log.warn("zcode app-server exited", { code });
          this.child = null;
          this.connecting = null;
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(Object.assign(new Error("zcode app-server process exited"), { code: "adapter_died" }));
          }
          this.pending.clear();
          for (const st of this.sessions.values()) this.failSession(st, "executor process exited", "executor_exited");
        },
      });
      this.child = child;
      log.info("zcode app-server spawned", { pid: child.pid, via: cmd.via });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let msg: ProtoMessage;
    try {
      msg = JSON.parse(line) as ProtoMessage;
    } catch {
      log.warn("zcode app-server sent non-JSON line", { line: line.slice(0, 120) });
      return;
    }

    // 对 client 请求的响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        p.reject(Object.assign(new Error(msg.error.message ?? "protocol error"), { code: `proto_${msg.error.code ?? "unknown"}` }));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // 通知：事件流
    if (msg.method === "session/event") {
      void this.dispatchProtocolEvent((msg.params ?? {}) as ProtoEvent);
      return;
    }

    // 反向请求：每类响应都有严格 schema，必须按各自形状回
    if (msg.id !== undefined && msg.method !== undefined) {
      this.handleReverseRequest(String(msg.id), msg.method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
  }

  private writeLine(frame: unknown): void {
    this.child?.stdin?.write(JSON.stringify(frame) + "\n");
  }

  rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    return this.ensureConnected().then(() => new Promise<T>((resolve, reject) => {
      const id = String(++this.rpcSeq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: "rpc_timeout" }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.writeLine({ id, method, params });
    }));
  }

  /** fork 补丁未安装（registry 空）时的特征错误 —— 触发进程级降级到 -p */
  static isRegistryEmptyError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Select a model|Provider Registry/i.test(msg);
  }

  private emitFor(st: AppServerSessionState, event: RuntimeEvent): void {
    if (st.ended && event.type !== "session.ended" && event.type !== "error") return;
    st.sink?.(event);
  }

  private failSession(st: AppServerSessionState, message: string, reason: string): void {
    if (st.ended) return;
    st.ended = true;
    this.denyPendingPermissions(st, reason);
    st.sink?.({ type: "error", sessionId: st.sessionId, message, recoverable: false });
    st.sink?.({ type: "session.ended", sessionId: st.sessionId, reason });
  }

  private async dispatchProtocolEvent(p: ProtoEvent): Promise<void> {
    const sessionId = str(p.sessionId);
    if (sessionId === undefined) return;
    const st = this.sessions.get(sessionId);
    if (st === undefined) return;

    const payload = p.payload ?? {};
    switch (p.type) {
      case "turn.started": {
        st.currentMessageId = str(payload["messageId"]) ?? null;
        break;
      }
      // 真流式：model.streaming 是协议暴露的增量通道（part.delta 在该 deliveryKind 下不到）
      case "model.streaming": {
        const kind = str(payload["kind"]);
        const delta = str(payload["delta"]);
        if (delta === undefined || delta === "") break;
        const messageId = str(payload["assistantMessageId"]) ?? st.currentMessageId ?? `msg_${String(p.seq ?? 0)}`;
        if (kind === "text_delta") {
          this.emitFor(st, { type: "message.delta", sessionId: st.sessionId, messageId, role: "assistant", text: delta });
        } else if (kind !== undefined && kind.startsWith("reasoning")) {
          this.emitFor(st, { type: "reasoning.delta", sessionId: st.sessionId, messageId, text: delta });
        }
        break;
      }
      case "tool.updated": {
        const kind = str(payload["kind"]);
        const callId = str(payload["toolCallId"]);
        if (callId === undefined) break;
        if (kind === "scheduled") {
          st.pendingPermissions.set(callId, "");
          const toolName = str(payload["toolName"]) ?? "tool";
          this.emitFor(st, {
            type: "tool.started",
            sessionId: st.sessionId,
            callId,
            toolName,
            title: str(payload["description"]) ?? toolName,
            input: payload["input"] ?? null,
          });
        } else if (kind === "result") {
          st.pendingPermissions.delete(callId);
          this.emitFor(st, {
            type: "tool.completed",
            sessionId: st.sessionId,
            callId,
            ok: true,
            output: JSON.stringify(payload["result"] ?? null),
          });
        } else if (kind === "error") {
          st.pendingPermissions.delete(callId);
          this.emitFor(st, {
            type: "tool.completed",
            sessionId: st.sessionId,
            callId,
            ok: false,
            output: JSON.stringify(payload["error"] ?? "tool error"),
          });
        }
        // started/progress/batch 是协议内部的精细态，契约里没有对应事件
        break;
      }
      case "turn.completed": {
        const response = str(payload["response"]) ?? "";
        const messageId = st.currentMessageId ?? `msg_${String(p.seq ?? 0)}`;
        this.emitFor(st, { type: "message.completed", sessionId: st.sessionId, messageId, text: response });
        await this.emitUsage(st, payload);
        this.denyPendingPermissions(st, "turn finished");
        // agent loop 语义：一轮完成 ≠ 会话结束。会话保持开启，session/send 续聊；
        // session.ended 只在 session.closed / 执行器退出时发。
        const resultType = str(payload["resultType"]) ?? "completed";
        this.emitFor(st, {
          type: "session.status",
          sessionId: st.sessionId,
          status: resultType === "success" ? "idle" : `failed:${resultType}`,
        });
        break;
      }
      case "turn.failed": {
        const err = payload["error"] as { message?: string } | undefined;
        this.denyPendingPermissions(st, "turn failed");
        this.emitFor(st, { type: "error", sessionId: st.sessionId, message: err?.message ?? "turn failed", recoverable: false });
        // turn 失败通常可重试（模型/网络/配置），会话保持开启
        this.emitFor(st, { type: "session.status", sessionId: st.sessionId, status: "failed" });
        break;
      }
      case "session.closed": {
        if (!st.ended) {
          st.ended = true;
          this.denyPendingPermissions(st, "session closed");
          this.emitFor(st, { type: "session.ended", sessionId: st.sessionId, reason: str(payload["reason"]) ?? "closed" });
        }
        break;
      }
      default:
        break;
    }
  }

  private async emitUsage(st: AppServerSessionState, turnPayload: Record<string, unknown>): Promise<void> {
    let input = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["inputTokens"]);
    let output = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["outputTokens"]);
    let cacheRead = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["cacheReadTokens"]);
    let cacheWrite = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["cacheCreationTokens"]);
    if (input === undefined || output === undefined) {
      try {
        const snap = await this.rpc<Record<string, unknown>>("session/usage", { sessionId: st.sessionId });
        const tIn = (num(snap["inputTokens"]) ?? 0) + (num(snap["cacheReadTokens"]) ?? 0) + (num(snap["cacheCreationTokens"]) ?? 0);
        const tOut = num(snap["outputTokens"]) ?? 0;
        const tCr = num(snap["cacheReadTokens"]) ?? 0;
        const tCw = num(snap["cacheCreationTokens"]) ?? 0;
        input = Math.max(0, tIn - st.cumulative.input);
        output = Math.max(0, tOut - st.cumulative.output);
        cacheRead = Math.max(0, tCr - st.cumulative.cacheRead);
        cacheWrite = Math.max(0, tCw - st.cumulative.cacheWrite);
        st.cumulative = { input: tIn, output: tOut, cacheRead: tCr, cacheWrite: tCw };
      } catch {
        input = input ?? 0;
        output = output ?? 0;
      }
    }
    this.emitFor(st, {
      type: "usage",
      sessionId: st.sessionId,
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // 套餐按订阅计价，token 是 ground truth；美元由 Phase 6 价目表统一估算
      costUsd: 0,
      model: st.model ?? "zcode-default",
      decodeMs: num(turnPayload["duration"]),
      requestId: `zcode:${st.sessionId}:p${process.pid}:${++st.usageCount}`,
    });
  }

  private denyPendingPermissions(st: AppServerSessionState, why: string): void {
    for (const [callId, serverMsgId] of st.pendingPermissions) {
      if (serverMsgId !== "") {
        this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: why } });
      }
      st.pendingPermissions.delete(callId);
    }
  }

  /**
   * 反向请求分派。schema 事实源：ZCode 克隆 packages/shared/src/zcode-protocol/index.ts。
   * 原则：daemon 是无人值守的 host —— 能自动答的自动答，权限留给前端，绝不悬挂。
   */
  private handleReverseRequest(serverMsgId: string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "interaction/requestPermission":
        this.handlePermissionRequest(serverMsgId, params);
        return;
      case "session/requestRuntimePreferences":
        this.writeLine({ id: serverMsgId, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } });
        return;
      case "interaction/requestUserInput":
        log.warn("declining requestUserInput (no interactive user)", { prompt: params["prompt"] });
        this.writeLine({ id: serverMsgId, result: { action: "decline", reason: "daemon runs unattended" } });
        return;
      case "interaction/requestProviderRuntimeHeaders":
        // fork 补丁接了内部认证头端口后不该到这；到了也如实说没有
        this.writeLine({ id: serverMsgId, result: { headersApplied: false, errorMessage: "daemon holds no provider credentials" } });
        return;
      case "interaction/requestOfficialMcpAuthHeaders":
        this.writeLine({ id: serverMsgId, result: { ok: false, reason: "official_auth_unavailable" } });
        return;
      default:
        log.error("unknown reverse interaction, replying deny", { method, keys: Object.keys(params) });
        this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: `unsupported interaction: ${method}` } });
    }
  }

  private handlePermissionRequest(serverMsgId: string, params: Record<string, unknown>): void {
    const toolCallId = str(params["toolCallId"]) ?? `perm_${serverMsgId}`;
    const toolName = str(params["toolName"]) ?? "tool";
    let st: AppServerSessionState | undefined;
    const sid = str(params["sessionId"]);
    if (sid !== undefined) st = this.sessions.get(sid);
    if (st === undefined) {
      for (const s of this.sessions.values()) {
        if (s.pendingPermissions.has(toolCallId)) { st = s; break; }
      }
    }
    if (st === undefined) {
      this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: "no owning session" } });
      return;
    }
    st.pendingPermissions.set(toolCallId, serverMsgId);
    this.emitFor(st, {
      type: "permission.requested",
      sessionId: st.sessionId,
      requestId: toolCallId,
      kind: classifyPermission(toolName),
      risk: mapRisk(params["riskLevel"]),
      detail: str(params["reason"]) ?? toolName,
    });
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    await this.ensureConnected();

    const createParams: Record<string, unknown> = {
      workspace: { workspacePath: req.rootPath, workspaceKey: req.rootPath },
      mode: req.mode ?? "yolo",
      persistence: "immediate",
    };
    if (req.model !== null) {
      // registry 的 providerId 因登录渠道而异；写错会被 setModel 拒绝 → 回落默认模型
      createParams["model"] = { providerId: CODING_PLAN_PROVIDER_ID, modelId: req.model };
    }

    let created: Record<string, unknown>;
    try {
      created = await this.rpc<Record<string, unknown>>("session/create", createParams);
    } catch (err: unknown) {
      if (req.model === null) throw err;
      log.warn("session/create with model failed, using executor default", {
        model: req.model,
        error: err instanceof Error ? err.message : String(err),
      });
      delete createParams["model"];
      created = await this.rpc<Record<string, unknown>>("session/create", createParams);
    }

    const session = created["session"] as Record<string, unknown> | undefined;
    const nativeId = str(session?.["sessionId"]);
    if (nativeId === undefined) {
      throw Object.assign(new Error(`session/create returned no sessionId`), { code: "protocol_error" });
    }

    const st: AppServerSessionState = {
      sessionId: nativeId as SessionId,
      unitId: req.unitId,
      model: req.model,
      rootPath: req.rootPath,
      sink,
      currentMessageId: null,
      ended: false,
      ready: Promise.resolve(),
      cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pendingPermissions: new Map(),
      usageCount: 0,
    };
    this.sessions.set(nativeId, st);
    return this.makeAppServerSession(st);
  }

  /** resume：跨 daemon 重启后，新 app-server 进程经 session/resume 载入持久化会话。
   *  workspace 必带 —— 冷恢复按 workspace 定位会话，缺了会报 "Session is not active"（探针实证）。 */
  reattach(state: AppServerSessionState, _ref: string): AdapterSession {
    this.sessions.set(state.sessionId, state);
    const bootstrap = async (): Promise<void> => {
      await this.ensureConnected();
      await this.rpc("session/resume", {
        sessionId: state.sessionId,
        workspace: { workspacePath: state.rootPath, workspaceKey: state.rootPath },
      });
      await this.rpc("session/subscribe", { sessionId: state.sessionId, deliveryKind: "desktop-continuous" });
    };
    state.ready = bootstrap().catch((err: unknown) => {
      log.warn("zcode session resume failed", {
        sessionId: state.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return this.makeAppServerSession(state);
  }

  private makeAppServerSession(st: AppServerSessionState): AdapterSession {
    // 先订阅再发 prompt，事件一条不漏
    const ensureSubscribed = async (): Promise<void> => {
      await this.rpc("session/subscribe", { sessionId: st.sessionId, deliveryKind: "desktop-continuous" });
    };

    return {
      id: st.sessionId,
      send: async (text: string) => {
        st.ended = false;
        await st.ready;
        await ensureSubscribed();
        await this.rpc("session/send", { sessionId: st.sessionId, content: text });
      },
      cancel: async () => {
        // session/stop 可插队；turn 会以 resultType:"cancelled" 收尾
        await this.rpc("session/stop", { sessionId: st.sessionId });
      },
      resolvePermission: async (requestId, decision) => {
        const serverMsgId = st.pendingPermissions.get(requestId);
        // always 暂按 allow 放行；规则表落盘是 host 侧 Phase 4 的事
        const wire = decision === "deny" ? "deny" : "allow";
        if (serverMsgId !== undefined && serverMsgId !== "") {
          this.writeLine({ id: serverMsgId, result: { decision: wire, reason: decision } });
        }
        st.pendingPermissions.delete(requestId);
        this.emitFor(st, { type: "permission.resolved", sessionId: st.sessionId, requestId, decision });
      },
      externalRef: () => st.sessionId,
    };
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("adapter is shutting down"), { code: "adapter_disposed" }));
    }
    this.pending.clear();
    this.sessions.clear();
    if (child !== null && child.exitCode === null) child.kill();
  }
}

// ==== 传输二：-p --json（回退，能力受限但真实）==============================

interface PrintSessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** CLI 的原生会话 id（--resume 用），首轮结束才有 */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  running: boolean;
  cancelled: boolean;
  child: ChildProcess | null;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
}

interface CliTurnResult {
  sessionId?: string;
  traceId?: string;
  turnId?: string;
  response?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

class PrintTransport {
  private readonly sessions = new Map<string, PrintSessionState>();

  async probeVersion(cmd: ResolvedCommand): Promise<string> {
    return (await execLines(cmd, ["--version"], 15000)).trim();
  }

  start(state: PrintSessionState, _req: StartRequest): AdapterSession {
    this.sessions.set(state.sessionId, state);
    return {
      id: state.sessionId,
      send: async (text: string) => {
        // 首轮（cliSessionId 还是 null）自然不带 --resume，多轮由 CLI 侧持久化续接
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        // -p 默认 yolo，没有权限反向流
        log.warn("resolvePermission called on zcode -p session (no permission stream)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: PrintSessionState = {
      sessionId,
      rootPath,
      cliSessionId: ref,
      sink,
      running: false,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    return this.start(state, { unitId: "unknown" as never, unitName: "", rootPath: state.rootPath, prompt: "", model: null });
  }

  disconnect(): void {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  private async spawnTurn(state: PrintSessionState, prompt: string): Promise<void> {
    // 评审 P1：cancelled 只描述"cancel 杀掉的那一轮"；不复位会把后续轮的失败误判为 idle
    state.cancelled = false;
    const resumeId = state.cliSessionId;
    const cmd = await resolveCommand("zcode");
    const args = ["-p", prompt, "--json", "--cwd", state.rootPath];
    if (resumeId !== null) args.push("--resume", resumeId);

    const stdout: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => stdout.push(line),
      onStderrLine: (line) => log.debug("zcode -p stderr", { line: line.slice(0, 200) }),
      // 不在 exit 回调里收尾：正常路径在 await exit 之后统一处理（避免双重 ended）
    });
    state.child = child;
    state.running = true;

    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    state.child = null;
    state.running = false;

    const parsed = this.parseTurnOutput(stdout.join("\n"));
    if (parsed === null) {
      // 会话线程仍在（--resume 可续），不发 ended
      if (!state.cancelled) {
        state.sink?.({ type: "error", sessionId: state.sessionId, message: `zcode -p produced no JSON (exit ${exitCode})`, recoverable: false });
      }
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: state.cancelled ? "idle" : "failed" });
      return;
    }
    if (parsed.sessionId !== undefined) state.cliSessionId = parsed.sessionId;
    this.emitTurn(state, parsed);
  }

  private parseTurnOutput(raw: string): CliTurnResult | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as CliTurnResult;
    } catch {
      return null;
    }
  }

  private emitTurn(state: PrintSessionState, r: CliTurnResult): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    const messageId = r.turnId ?? r.traceId ?? `msg_${Date.now()}`;

    const text = r.response ?? (r.is_error === true ? r.result ?? "" : "");
    if (text !== "") {
      sink({ type: "message.delta", sessionId, messageId, role: "assistant", text });
      sink({ type: "message.completed", sessionId, messageId, text });
    }

    const u = r.usage;
    if (u !== undefined && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
      sink({
        type: "usage",
        sessionId,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheCreationTokens,
        costUsd: 0,
        model: "zcode-default",
        requestId: `zcode:${sessionId}:p${process.pid}:${++state.usageCount}`,
        decodeMs: r.duration_ms,
      });
    }

    if (r.is_error === true) {
      sink({ type: "error", sessionId, message: r.result ?? "turn failed", recoverable: false });
      // agent loop 语义：turn 失败 ≠ 会话结束（--resume 可续聊）
      sink({ type: "session.status", sessionId, status: "failed" });
    } else {
      sink({ type: "session.status", sessionId, status: "idle" });
    }
  }
}

// ==== 适配器门面 ============================================================

export class ZcodeAdapter implements ExecutorAdapter {
  readonly id = "zcode";
  readonly displayName = "ZCode";
  readonly glyph = "Z";
  readonly models: readonly ExecutorModelInfo[] = [
    { id: "GLM-5.3-Flash" as ModelId, displayName: "GLM-5.3 Flash（默认）" },
    { id: "GLM-5.3" as ModelId, displayName: "GLM-5.3" },
    { id: "GLM-5-Turbo" as ModelId, displayName: "GLM-5 Turbo" },
  ];
  // 能力声明跟传输状态走（docs/08 WP-4）：app-server = 真流式；print 回退 = 批量。
  // 注册表在 probe 前读到的快照是 app-server 档——probe 返回值才是权威。
  get capabilities(): RuntimeCapabilities {
    return {
      resumeSession: true,
      fileDiff: false,
      terminal: false,
      permissions: true, // app-server 反向权限流（fork 补丁后）；降级到 -p 时实际不触发
      subagents: false,
      worktrees: false,
      sandbox: true,
      mcp: true,
      usage: true,
      multimodal: true,
      streaming: this.transport === "app-server" ? "realtime" : "batch",
      steering: "turn-end", // mid-turn 的物理条件具备（常驻进程），实现前如实报 turn-end
    };
  }

  /** 进程级传输状态：app-server 起不动时降级到 print，本次 daemon 生命周期内不再回头 */
  private transport: "app-server" | "print" = "app-server";
  private readonly appServer = new ZcodeAppServerTransport();
  private readonly print = new PrintTransport();

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("zcode");
      const version = (await execLines(cmd, ["--version"], 15000)).trim() || "unknown";
      return {
        state: {
          status: "ready",
          version: `${version} (${this.transport === "app-server" ? "app-server" : "print 回退"})`,
        },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      return {
        state: { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    if (this.transport === "app-server") {
      try {
        return await this.startViaAppServer(req, sink);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof Error && "code" in err ? String(err.code) : "";
        const registryEmpty = ZcodeAppServerTransport.isRegistryEmptyError(err);
        // 评审 P2：rpc_timeout 不再触发降级——单次 RPC 慢（180s）不代表进程死了，
        // disconnect 会打死其它健康会话在途的全部 RPC；只对"进程真死/无模型"降级
        if (registryEmpty || code === "adapter_died") {
          log.warn("zcode app-server unavailable, degrading to -p transport (this process)", {
            error: msg,
            hint: "安装带 awb/standalone-app-server 补丁的 zcode CLI 可恢复全能力（真流式/工具事件/权限流）",
          });
          this.transport = "print";
          await this.appServer.disconnect().catch(() => {});
        } else {
          throw err;
        }
      }
    }
    return this.startViaPrint(req, sink);
  }

  private async startViaAppServer(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    return this.appServer.start(req, sink);
  }

  private startViaPrint(req: StartRequest, sink: AdapterSink): AdapterSession {
    const state: PrintSessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      cliSessionId: null,
      sink,
      running: false,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    if (req.model !== null) {
      log.warn("zcode -p path cannot select a model; using CLI default", { model: req.model });
    }
    return this.print.start(state, req);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    if (this.transport === "print") return this.print.reattach(sessionId, ref, rootPath, sink);
    // app-server 会话的重挂：ref 即原生 sessionId
    const state: AppServerSessionState = {
      sessionId,
      unitId: "unknown" as never,
      model: null,
      rootPath,
      sink,
      currentMessageId: null,
      ended: false,
      ready: Promise.resolve(),
      cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pendingPermissions: new Map(),
      usageCount: 0,
    };
    const attached = this.appServer.reattach(state, ref);
    return attached;
  }

  async disconnect(): Promise<void> {
    await this.appServer.disconnect();
    this.print.disconnect();
  }
}
