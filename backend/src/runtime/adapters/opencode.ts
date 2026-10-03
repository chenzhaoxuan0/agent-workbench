/**
 * OpenCode 执行器适配器 —— 常驻 HTTP server 形态（第三种形态，t3code 同款）：
 * `opencode serve --port=0` 起无头服务，HTTP API 驱动 + SSE 事件流。
 *
 * 为什么不是 `opencode acp`（它也有内建 ACP）：用户点名参考 t3code，而 t3code
 * （apps/server/src/provider/OpenCodeServerOwner.ts）正是懒起本地 serve 进程、
 * `OPENCODE_SERVER_PASSWORD` 环境变量认证、走 HTTP API —— opencode 的一等公民
 * 接口是其 client-server 架构，ACP 反而是外围。于是有了第三种进程形态：
 * 一次性进程（claude/codex/pi）、常驻 stdio 协议（zcode/mcode/dsh）、常驻 HTTP（本家）。
 *
 * 协议事实（opencode 1.18.34 实测 + packages 源码走查）：
 * - serve 打印 "opencode server listening on http://127.0.0.1:<port>"（--port=0 随机端口）
 * - 认证是 HTTP Basic：用户名默认 "opencode"，密码来自 OPENCODE_SERVER_PASSWORD
 *   （server/auth.ts：header() 生成 `Basic base64(user:pass)`）
 * - POST /session → {id:"ses_…"}；POST /session/:id/prompt_async {parts,model} 异步发轮，
 *   不走阻塞 POST /message（undici 默认 5min 头超时扛不住长轮次）
 * - SSE GET /event（全局流，按 properties.sessionID 过滤），实测事件：
 *   message.part.updated（part 全量快照：text/reasoning/tool/step-start/step-finish）、
 *   message.part.delta{partID,field,delta}（field="text" 的真流式增量）、
 *   message.updated（info 带 tokens/cost，role=assistant 的末条即权威计量）、
 *   session.status{busy|idle} + session.idle（轮完成信号）、session.diff{diff:[FileDiff]}、
 *   permission.updated（反向审批）、session.error、file.edited
 * - tool part：{tool, callID, state:{status:"pending"|"running"|"completed"|"error",input,output}}
 * - FileDiff.Info：{file,patch,additions,deletions,status:"added"|"deleted"|"modified"}
 *   —— 真 patch 直通 file.diff 事件（fileDiff 能力的最强来源）
 * - 权限：permission.updated{properties:{id,type,title,callID}} → permission.requested；
 *   应答 POST /permission/:requestID/reply {reply:"once"|"always"|"reject"}
 * - 取消：POST /session/:id/abort → 轮以 session.idle 收尾
 * - reattach：opencode 会话按项目目录落盘、全局可寻址 —— 新 serve 进程直接 GET /session/:id
 *   验证后续用同一 sessionID 发 prompt_async，无需 load
 * - 模型：prompt_async payload 带 {model:{providerID,modelID}}；本机默认模型
 *   （zhipuai-coding-plan/...）已失效（"Model not found" 实测），minimax-cn-coding-plan
 *   凭据可用
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
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

// ---- OpenCode 线缆类型（宽松） -------------------------------------------------

interface OcPart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
  tokens?: Record<string, unknown>;
}

interface OcEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    messageID?: string;
    partID?: string;
    field?: string;
    delta?: string;
    part?: OcPart;
    info?: OcMessageRef;
    status?: { type?: string };
    diff?: OcFileDiff[];
    error?: { name?: string; data?: { message?: string } };
    // permission.updated 的 properties 直接是 Permission 对象
    id?: string;
    type?: string;
    title?: string;
    callID?: string;
  };
}

interface OcUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface OcFileDiff {
  file?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
}

interface OcMessageRef {
  id?: string;
  role?: string;
  tokens?: OcUsage;
  cost?: number;
  modelID?: string;
  providerID?: string;
}

// ---- 会话台账 ------------------------------------------------------------------

interface PendingPermission {
  readonly kind: "file_write" | "shell" | "network" | "tool";
  readonly detail: string;
  readonly risk: "low" | "medium" | "high";
}

interface TurnAcc {
  turnText: string;
  readonly messageId: string;
  /** 当前轮的 assistant messageID（message.updated role=assistant 首见时锁定） */
  assistantMessageId: string | null;
  /** 本轮 user messageID（finalize 后按它拉 /diff，得到「这一轮改了什么」） */
  userMessageId: string | null;
  sawError: string | null;
  usage: { tokens: OcUsage; cost: number; model: string } | null;
}

interface OcSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly model: ModelId | null;
  /** opencode 的会话 id（"ses_…"），POST /session 后才有；reattach 时外部传入 */
  ref: string | null;
  /** reattach 的目标 ref：ensureSession 首轮消费（验证可用则转入 ref） */
  reattachRef: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  /** http://127.0.0.1:<port>（serve stdout 解析） */
  baseUrl: string | null;
  password: string;
  sseAbort: AbortController | null;
  closed: boolean;
  cancelled: boolean;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
  /** partID → part 类型（delta 流式增量需要知道 text 还是 reasoning） */
  readonly partTypes: Map<string, string>;
  /** 已发过 tool.started 的 callID（part 快照 pending→running 会重复推送） */
  readonly toolStarted: Set<string>;
  /** requestID → 权限元数据 */
  readonly permissionPending: Map<string, PendingPermission>;
  turn: TurnAcc | null;
  /** 轮完成信号（session.idle）触发器 */
  idleResolve: (() => void) | null;
}

export class OpencodeAdapter implements ExecutorAdapter {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly glyph = "O";
  readonly models: readonly ExecutorModelInfo[] = [
    // 本机凭据实测可用（opencode models）：minimax-cn-coding-plan 全系；
    // 用户的默认模型 zhipuai-coding-plan/* 已失效，model=null 会撞上 —— hint 见 catalog
    { id: "minimax-cn-coding-plan/MiniMax-M2.7" as ModelId, displayName: "MiniMax M2.7" },
    { id: "minimax-cn-coding-plan/MiniMax-M2.5" as ModelId, displayName: "MiniMax M2.5" },
    { id: "minimax-cn-coding-plan/MiniMax-M2.5-highspeed" as ModelId, displayName: "MiniMax M2.5 Highspeed" },
  ];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // 会话按项目落盘全局可寻址，新 serve 进程直连同一 sessionID
    fileDiff: true, // session.diff 带 {file,patch,additions,deletions,status} 真 patch
    terminal: false,
    permissions: true, // permission.updated 反向流 + /permission/:id/reply
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true, // message.updated info.tokens/cost
    multimodal: true, // parts 支持文件/图片
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, OcSession>();

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("opencode");
      const out = await execLines(cmd, ["--version"], 15000);
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
    const state: OcSession = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      model: req.model ?? null,
      ref: null,
      reattachRef: null,
      sink,
      child: null,
      baseUrl: null,
      password: `ocd_${randomUUID()}`,
      sseAbort: null,
      closed: false,
      cancelled: false,
      usageCount: 0,
      partTypes: new Map(),
      toolStarted: new Set(),
      permissionPending: new Map(),
      turn: null,
      idleResolve: null,
    };
    this.sessions.set(state.sessionId, state);
    return this.sessionHandle(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: OcSession = {
      sessionId,
      rootPath,
      model: null,
      ref: null,
      reattachRef: ref, // GET /session/:id 验证通过则续用；失效回落新会话
      sink,
      child: null,
      baseUrl: null,
      password: `ocd_${randomUUID()}`,
      sseAbort: null,
      closed: false,
      cancelled: false,
      usageCount: 0,
      partTypes: new Map(),
      toolStarted: new Set(),
      permissionPending: new Map(),
      turn: null,
      idleResolve: null,
    };
    this.sessions.set(sessionId, state);
    return this.sessionHandle(state);
  }

  private sessionHandle(state: OcSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        if (state.ref !== null && state.baseUrl !== null) {
          await this.post(state, `/session/${state.ref}/abort`, {}).catch(() => {});
        }
      },
      resolvePermission: async (requestId, decision) => {
        await this.resolvePermission(state, requestId, decision);
      },
      externalRef: () => state.ref,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.closed = true;
      st.sseAbort?.abort();
      const child = st.child;
      if (child !== null && child.exitCode === null) child.kill();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      st.child = null;
      st.idleResolve?.(); // 防 send 卡死
    }
    this.sessions.clear();
  }

  // ---- server 生命周期 ---------------------------------------------------------

  private async ensureServer(state: OcSession): Promise<string> {
    if (state.baseUrl !== null) return state.baseUrl;
    const cmd = await resolveCommand("opencode");
    const child = spawn(cmd.file, [...cmd.prefixArgs, "serve", "--port=0", "--print-logs"], {
      cwd: state.rootPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: state.password },
    });
    state.child = child;
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(adapterListenTimeout()), 60000);
      child.stdout!.setEncoding("utf8");
      let acc = "";
      const onData = (chunk: string) => {
        acc += chunk;
        const m = acc.match(/https?:\/\/[0-9.]+:\d+/);
        if (m) {
          clearTimeout(timer);
          child.stdout!.off("data", onData);
          resolve(m[0]);
        }
      };
      child.stdout!.on("data", onData);
      child.once("close", () => {
        clearTimeout(timer);
        reject(adapterError("executor_exited", "opencode serve exited before listening"));
      });
    });
    state.baseUrl = baseUrl;
    child.once("close", () => {
      if (!state.closed) log.warn("opencode serve exited unexpectedly", { sessionId: state.sessionId });
      state.baseUrl = null;
      state.child = null;
      state.sseAbort?.abort();
    });
    child.stderr!.setEncoding("utf8");
    const { createInterface } = await import("node:readline");
    createInterface({ input: child.stderr }).on("line", (line) =>
      log.debug("opencode serve", { line: line.slice(0, 200) }),
    );
    this.startSse(state);
    return baseUrl;
  }

  /** SSE 订阅：断线重连（会话存续期间），按 sessionID 过滤在 onEvent 里做 */
  private startSse(state: OcSession): void {
    if (state.closed || state.baseUrl === null) return;
    const controller = new AbortController();
    state.sseAbort = controller;
    const basic = `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`;
    void (async () => {
      while (!state.closed && !controller.signal.aborted && state.baseUrl !== null) {
        try {
          const resp = await fetch(`${state.baseUrl}/event`, {
            headers: { Authorization: basic },
            signal: controller.signal,
          });
          if (!resp.ok || resp.body === null) throw new Error(`sse status ${resp.status}`);
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              try {
                this.onEvent(state, JSON.parse(line.slice(5).trim()) as OcEvent);
              } catch {
                // 非 JSON 行忽略
              }
            }
          }
        } catch (err: unknown) {
          if (controller.signal.aborted || state.closed) return;
          log.debug("opencode sse dropped, reconnecting", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (!state.closed && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  }

  private authHeaders(state: OcSession): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`,
      "Content-Type": "application/json",
    };
  }

  private async get(state: OcSession, path: string, timeoutMs?: number): Promise<unknown> {
    if (state.baseUrl === null) throw adapterError("executor_exited", "opencode serve not running");
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const resp = await fetch(`${state.baseUrl}${path}`, { headers: this.authHeaders(state), signal });
    if (!resp.ok) throw adapterError("oc_request_failed", `opencode GET ${path} failed with ${resp.status}`);
    return (await resp.json()) as unknown;
  }

  private async post(state: OcSession, path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.baseUrl === null) throw adapterError("executor_exited", "opencode serve not running");
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const resp = await fetch(`${state.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders(state),
      body: JSON.stringify(body ?? {}),
      signal,
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = text;
    }
    if (!resp.ok) {
      const message =
        parsed !== null && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>)
          ? String((parsed as { data?: { message?: string } }).data?.message ?? resp.status)
          : `opencode ${path} failed with ${resp.status}`;
      throw adapterError("oc_request_failed", message);
    }
    return parsed;
  }

  // ---- turn 执行 ----

  private async ensureSession(state: OcSession): Promise<void> {
    await this.ensureServer(state);
    if (state.ref !== null) return;
    if (state.reattachRef !== null) {
      // reattach：先验证旧会话仍可寻址（项目落盘全局可见），失效回落新会话
      try {
        const resp = await fetch(`${state.baseUrl}/session/${state.reattachRef}`, {
          headers: this.authHeaders(state),
        });
        if (resp.ok) {
          state.ref = state.reattachRef;
          return;
        }
        log.warn("opencode reattach target not found, starting fresh", { ref: state.reattachRef, status: resp.status });
      } catch (err: unknown) {
        log.warn("opencode reattach probe failed, starting fresh", {
          ref: state.reattachRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const created = (await this.post(state, "/session", {}, 30000)) as { id?: string };
    if (typeof created?.id !== "string" || created.id === "") {
      throw adapterError("oc_no_session", "opencode POST /session returned no id");
    }
    state.ref = created.id;
  }

  private async runTurn(state: OcSession, prompt: string): Promise<void> {
    state.cancelled = false;
    await this.ensureSession(state);

    const acc: TurnAcc = {
      turnText: "",
      messageId: `msg_${Date.now()}`,
      assistantMessageId: null,
      userMessageId: null,
      sawError: null,
      usage: null,
    };
    state.turn = acc;
    try {
      const body: Record<string, unknown> = { parts: [{ type: "text", text: prompt }] };
      if (state.model !== null) {
        const slash = state.model.indexOf("/");
        if (slash > 0) {
          body["model"] = { providerID: state.model.slice(0, slash), modelID: state.model.slice(slash + 1) };
        }
      }
      await this.post(state, `/session/${state.ref}/prompt_async`, body, 30000);
      // 轮完成信号：session.idle（实测成功/失败/取消路径都会发）
      await new Promise<void>((resolve) => {
        state.idleResolve = resolve;
        const timer = setTimeout(resolve, 30 * 60 * 1000); // 30min 兜底，防 idle 丢失卡死
        timer.unref?.();
      });
      state.idleResolve = null;
      await this.finalizeTurn(state, acc);
    } catch (err: unknown) {
      state.idleResolve = null;
      const sink = state.sink;
      if (sink !== null) {
        sink({
          type: "error",
          sessionId: state.sessionId,
          message: `opencode turn failed: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        });
        sink({ type: "session.status", sessionId: state.sessionId, status: "failed" });
      }
    } finally {
      state.turn = null;
    }
  }

  private async finalizeTurn(state: OcSession, acc: TurnAcc): Promise<void> {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    // 本轮文件变更：GET /session/:id/diff（SnapshotFileDiff 带真 patch）。
    // SSE 的 session.diff 事件是 revert 快照（实测恒空），真 diff 在这里按 user message 拉。
    if (state.ref !== null && state.baseUrl !== null) {
      try {
        const query = acc.userMessageId !== null ? `?messageID=${encodeURIComponent(acc.userMessageId)}` : "";
        const diffs = (await this.get(state, `/session/${state.ref}/diff${query}`, 20000)) as OcFileDiff[] | null;
        for (const d of Array.isArray(diffs) ? diffs : []) {
          if (d.file === undefined) continue;
          sink({
            type: "file.diff",
            sessionId,
            path: d.file,
            additions: d.additions ?? 0,
            deletions: d.deletions ?? 0,
            patch: d.patch,
          });
          sink({
            type: "file.changed",
            sessionId,
            path: d.file,
            change: d.status === "added" ? "created" : d.status === "deleted" ? "deleted" : "modified",
          });
        }
      } catch (err: unknown) {
        log.debug("opencode diff fetch failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }
    if (acc.usage !== null) {
      const { tokens, cost, model } = acc.usage;
      const cacheW = tokens.cache?.write ?? 0;
      sink({
        type: "usage",
        sessionId,
        // 计费口径对齐契约（dsh）：billedInput = uncached + cacheWrite
        inputTokens: (tokens.input ?? 0) + cacheW,
        outputTokens: tokens.output ?? 0,
        cacheReadTokens: tokens.cache?.read,
        cacheWriteTokens: cacheW,
        costUsd: cost ?? 0, // opencode 侧计算的 provider 成本；订阅制套餐常为 0
        model,
        decodeMs: undefined,
        requestId: `opencode:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    if (acc.sawError !== null) {
      sink({ type: "error", sessionId, message: acc.sawError, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionID 继续 prompt_async）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- SSE 事件 → RuntimeEvent --------------------------------------------------

  private onEvent(state: OcSession, ev: OcEvent): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    const props = ev.properties ?? {};
    // 全局 SSE 流：只处理本适配器会话的事件（permission 事件按 sessionID 带在 properties）
    if (props.sessionID !== undefined && props.sessionID !== state.ref) return;

    switch (ev.type) {
      case "message.updated": {
        const info = props.info ?? {};
        const acc = state.turn;
        if (info.role === "user" && acc !== null && acc.userMessageId === null && info.id !== undefined) {
          acc.userMessageId = info.id;
        }
        if (info.role !== "assistant" || acc === null) break;
        if (acc.assistantMessageId === null && info.id !== undefined) {
          acc.assistantMessageId = info.id; // 本轮首个 assistant message
        }
        // 末条 assistant message.updated 带权威计量
        if (info.tokens !== undefined) {
          acc.usage = {
            tokens: info.tokens ?? {},
            cost: info.cost ?? 0,
            model: info.modelID ?? "opencode-default",
          };
        }
        break;
      }
      case "message.part.updated": {
        const part = props.part ?? {};
        if (part.id !== undefined && part.type !== undefined) state.partTypes.set(part.id, part.type);
        if (part.type === "tool" && part.callID !== undefined) {
          const status = part.state?.status;
          if (status === "pending" || status === "running") {
            if (!state.toolStarted.has(part.callID)) {
              state.toolStarted.add(part.callID);
              sink({
                type: "tool.started",
                sessionId,
                callId: part.callID,
                toolName: part.tool ?? "tool",
                title: part.tool ?? "tool",
                input: part.state?.input ?? null,
              });
            }
          } else if (status === "completed" || status === "error") {
            sink({
              type: "tool.completed",
              sessionId,
              callId: part.callID,
              ok: status === "completed",
              output: stringifyOutput(part.state?.output).slice(0, 8000),
            });
          }
        }
        break;
      }
      case "message.part.delta": {
        const acc = state.turn;
        if (acc === null || props.field !== "text" || props.delta === undefined || props.delta === "") break;
        // 只认本轮 assistant message 的增量（user 消息回显不走 delta）
        if (acc.assistantMessageId !== null && props.messageID !== acc.assistantMessageId) break;
        const partType = props.partID !== undefined ? state.partTypes.get(props.partID) : undefined;
        if (partType === "reasoning") {
          sink({ type: "reasoning.delta", sessionId, messageId: acc.messageId, text: props.delta });
        } else {
          acc.turnText += props.delta;
          sink({ type: "message.delta", sessionId, messageId: acc.messageId, role: "assistant", text: props.delta });
        }
        break;
      }
      case "session.diff": {
        for (const d of props.diff ?? []) {
          if (d.file === undefined) continue;
          sink({
            type: "file.diff",
            sessionId,
            path: d.file,
            additions: d.additions ?? 0,
            deletions: d.deletions ?? 0,
            patch: d.patch,
          });
          sink({
            type: "file.changed",
            sessionId,
            path: d.file,
            change: d.status === "added" ? "created" : d.status === "deleted" ? "deleted" : "modified",
          });
        }
        break;
      }
      case "permission.updated": {
        const requestId = props.id;
        if (requestId === undefined) break;
        const kind = permissionKind(props.type);
        state.permissionPending.set(requestId, {
          kind,
          detail: props.title ?? props.type ?? "tool",
          risk: props.type === "bash" ? "medium" : "low",
        });
        sink({
          type: "permission.requested",
          sessionId,
          requestId,
          kind,
          detail: props.title ?? props.type ?? "tool",
          risk: props.type === "bash" ? "medium" : "low",
        });
        break;
      }
      case "session.error": {
        const acc = state.turn;
        const message = props.error?.data?.message ?? props.error?.name ?? "session error";
        if (acc !== null) acc.sawError = message;
        break; // 细节留给 finalizeTurn（session.idle 随后到）
      }
      case "file.edited": {
        const file = props.id ?? (ev.properties as { file?: string } | undefined)?.file;
        if (file === undefined || file === "") break;
        sink({
          type: "file.changed",
          sessionId,
          path: file,
          change: existsSync(file) ? "modified" : "deleted",
        });
        break;
      }
      case "session.idle": {
        state.idleResolve?.();
        break;
      }
      default:
        break; // server.connected / plugin.added / file.watcher.updated 等不翻译
    }
  }

  private async resolvePermission(state: OcSession, requestId: string, decision: "allow" | "deny" | "always"): Promise<void> {
    const pending = state.permissionPending.get(requestId);
    state.permissionPending.delete(requestId);
    try {
      await this.post(state, `/permission/${requestId}/reply`, {
        // opencode 的 Reply 枚举：once | always | reject
        reply: decision === "deny" ? "reject" : decision === "always" ? "always" : "once",
      }, 15000);
    } catch (err: unknown) {
      log.warn("opencode permission reply failed", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    state.sink?.({
      type: "permission.resolved",
      sessionId: state.sessionId,
      requestId,
      decision,
    });
  }
}

// ---- 小工具 -------------------------------------------------------------------

function adapterListenTimeout(): Error {
  return adapterError("oc_listen_timeout", "opencode serve did not report a listening URL within 60s");
}

function permissionKind(type: string | undefined): "file_write" | "shell" | "network" | "tool" {
  switch (type) {
    case "bash":
      return "shell";
    case "edit":
    case "write":
      return "file_write";
    case "webfetch":
      return "network";
    default:
      return "tool";
  }
}

function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  return typeof output === "string" ? output : JSON.stringify(output);
}
