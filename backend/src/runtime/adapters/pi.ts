/**
 * Pi 执行器适配器 —— 走 `pi --mode json -p`（JSONL 事件流）+ `--session-id` 多轮。
 *
 * 协议事实（pi 0.87.1 实测，stdout 逐行 JSON）：
 * - session{id,timestamp,cwd}（id 即 --session-id 传入值）/ agent_start / turn_start
 * - message_start|message_end{message:{role:"system"|"user"|"assistant"|"toolResult",content,...}}
 *   —— system/user 是本轮回显，assistant content 形如
 *   [{type:"thinking",thinking},{type:"text",text},{type:"toolCall",id,name,arguments}]
 * - message_update{usage, assistantMessageEvent}：assistantMessageEvent.type =
 *   thinking_start|thinking_delta|thinking_end|text_start|text_delta|text_end|
 *   toolcall_start{id,toolName}|toolcall_delta|toolcall_end{toolCall:{id,name,arguments}}
 *   —— text/thinking 带 delta 真流式；toolcall_delta 是 JSON 参数分片
 * - tool_execution_start{toolCallId,toolName,args} / tool_execution_update{partialResult}
 *   / tool_execution_end{toolCallId,result:{content:[{type:"text",text}]},isError}
 * - turn_end{message}：message.usage 是权威计量
 *   {input,output,cacheRead,cacheWrite,totalTokens,cost:{total}} —— cost.total 真实计费
 * - agent_end{messages} / agent_settled 后进程退出（-p 一次性语义）
 * - 多轮：`--session-id <uuid>`（不存在则创建，存在则续聊）——会话事实源在 pi 侧落盘，
 *   daemon 重启后 reattach 用同一 id 即可
 * - 思考档位：--thinking off|minimal|low|medium|high|xhigh|max（zcode 的 max 原生支持）
 * - 模型：--model <provider/id>（缺省用 pi 自己配置的默认模型）
 *
 * 与 codex -p 同为「每轮一个进程」，契约泛化性的又一块试金石
 * （新增执行器 = 本文件 + host 注册一行，core 不改）。
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
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
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand, spawnLines } from "../exec.ts";
import { log } from "../../log.ts";

// ---- CLI JSONL 事件（宽松类型） ---------------------------------------------

interface PiContent {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiMessage {
  role?: string;
  content?: PiContent[];
  usage?: PiUsage;
  provider?: string;
  model?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface PiAssistantEvent {
  type?: string;
  delta?: string;
  id?: string;
  toolName?: string;
  toolCall?: { id?: string; name?: string; arguments?: unknown };
}

interface PiEvent {
  type?: string;
  id?: string;
  message?: PiMessage;
  usage?: PiUsage;
  assistantMessageEvent?: PiAssistantEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: PiContent[] };
  isError?: boolean;
}

interface SessionState {
  /** daemon 发的稳定 id（对外唯一事实） */
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  /** pi 会话 id（SDK 创建后为 pi 的 uuidv7；CLI 路径由 --session-id 固定注入） */
  piSessionId: string;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  loop: { reasoningLevel?: string };
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
  /** SDK 进程内传输状态（失败一次后置 sdkFailed，永久回落 CLI） */
  sdk: { session: { prompt(t: string, o: unknown): Promise<unknown>; abort(): Promise<void> | void; dispose(): Promise<void> | void; sessionId?: string }; unsubscribe: () => void } | null;
  sdkFailed: boolean;
  /** 当前轮聚合器（SDK 事件回调与轮收尾共用） */
  acc: PiTurnAcc | null;
}

/** 一轮的聚合器：delta/工具事件行内即时 sink，文本/usage 由 turn_end 回填、exit 后收尾 */
interface PiTurnAcc {
  sawAny: boolean;
  /** message_update 流式正文累计（message.completed 用，turn_end 文本是权威全文） */
  turnText: string;
  messageId: string;
  /** callId → args（tool_execution_end 不带 args，file.changed 要用它） */
  readonly toolArgs: Map<string, unknown>;
  /** turn_end.message.usage（exit 后发 usage 事件用） */
  turnUsage?: PiUsage;
  turnModel?: string;
}

function parsePiTokenCount(str: string): number | undefined {
  if (!str) return undefined;
  const s = str.trim().toUpperCase();
  if (s.endsWith("M")) {
    const num = parseFloat(s.slice(0, -1));
    return isNaN(num) ? undefined : Math.round(num * 1_000_000);
  }
  if (s.endsWith("K")) {
    const num = parseFloat(s.slice(0, -1));
    return isNaN(num) ? undefined : Math.round(num * 1_000);
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? undefined : n;
}

const DEFAULT_PI_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "minimax-cn/MiniMax-M2.7" as ModelId,
    displayName: "MiniMax M2.7",
    contextWindow: 204800,
    maxOutput: 131100,
    reasoningLevels: ["low", "medium", "high", "max"],
    multimodal: false,
  },
  {
    id: "minimax-cn/MiniMax-M2.7-highspeed" as ModelId,
    displayName: "MiniMax M2.7 Highspeed",
    contextWindow: 204800,
    maxOutput: 131100,
    reasoningLevels: ["low", "medium", "high", "max"],
    multimodal: false,
  },
  {
    id: "minimax-cn/MiniMax-M3" as ModelId,
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutput: 512000,
    reasoningLevels: ["low", "medium", "high", "max"],
    multimodal: true,
  },
];

export class PiAdapter implements ExecutorAdapter {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly glyph = "π";
  private _models: ExecutorModelInfo[] = [...DEFAULT_PI_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("pi");
      const out = await execLines(cmd, ["--list-models"], 8000);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const dataLines = lines.filter((l) => !/^provider\s+model/i.test(l));
      const parsed: ExecutorModelInfo[] = [];
      for (const line of dataLines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const provider = parts[0]!;
          const model = parts[1]!;
          const contextStr = parts[2] ?? "";
          const maxOutStr = parts[3] ?? "";
          const thinkingStr = parts[4]?.toLowerCase() ?? "";
          const imagesStr = parts[5]?.toLowerCase() ?? "";
          parsed.push({
            id: `${provider}/${model}` as ModelId,
            displayName: model,
            contextWindow: parsePiTokenCount(contextStr) ?? 204800,
            maxOutput: parsePiTokenCount(maxOutStr),
            reasoningLevels: thinkingStr === "yes" ? ["low", "medium", "high", "max"] : undefined,
            multimodal: imagesStr === "yes",
          });
        }
      }
      if (parsed.length > 0) {
        this._models = parsed;
        log.info("pi models synced dynamically", { count: parsed.length });
        return { models: parsed, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("pi --list-models failed, using fallback models", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this._models, source: "static", reason: "--list-models 输出未匹配到条目", elapsedMs: Date.now() - t0 };
  }
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false, // 协议无结构化 diff；write/edit 工具只发 file.changed
    terminal: false,
    permissions: false, // -p 无交互审批面
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: false, // pi 的 MCP 走它自己的扩展机制，未从 JSON 流暴露
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, SessionState>();

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("pi");
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
            ? { status: "not_installed", hint: "未安装 pi CLI（npm i -g @earendil-works/pi-coding-agent）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    // SDK 路径：piSessionId 由 pi 的 SessionManager 创建后回填（pi 的 uuidv7）；
    // CLI 兜底路径在 spawnTurn 里按需生成。daemon 重启后 reattach 用同一 ref 续命。
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      mode: req.mode ?? "build",
      piSessionId: "",
      sink,
      cancelled: false,
      child: null,
      loop: { reasoningLevel: req.reasoningLevel },
      usageCount: 0,
      sdk: null,
      sdkFailed: false,
      acc: null,
    };
    this.sessions.set(state.sessionId, state);

    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
        await this.spawnTurn(state, text, req.model ?? null);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
        try {
          await state.sdk?.session.abort();
        } catch {
          /* abort 幂等 */
        }
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on pi session (no permission stream)");
      },
      externalRef: () => state.piSessionId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      piSessionId: ref,
      sink,
      cancelled: false,
      child: null,
      loop: {},
      usageCount: 0,
      sdk: null,
      sdkFailed: false,
      acc: null,
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string) => {
        await this.spawnTurn(state, text, null);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
        try {
          await state.sdk?.session.abort();
        } catch {
          /* abort 幂等 */
        }
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on pi session (no permission stream)");
      },
      externalRef: () => state.piSessionId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.child?.kill();
      st.sdk?.unsubscribe();
      try {
        await st.sdk?.session.dispose();
      } catch {
        /* dispose 尽力 */
      }
    }
    this.sessions.clear();
    this.sdkServices.clear();
  }

  // ---- turn 执行 ----

  /** zcode 语义思考档 → pi --thinking；已知档原样透传（含 max），未知档丢弃走 pi 默认 */
  private static readonly THINKING_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  private async spawnTurn(state: SessionState, prompt: string, model: ModelId | null): Promise<void> {
    // SDK 进程内传输优先（docs/13 Tier 3：pi-web 同款）；失败标记后本轮及后续全走 CLI
    if (!state.sdkFailed) {
      try {
        await this.sdkTurn(state, prompt, model);
        return;
      } catch (err: unknown) {
        state.sdkFailed = true;
        state.sdk = null;
        log.info("pi SDK 传输失败，回落 CLI --mode json", {
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 评审 P1 同款：cancelled 只描述"cancel 杀掉的那一轮"
    state.cancelled = false;
    const cmd = await resolveCommand("pi");
    if (state.piSessionId === "") state.piSessionId = `pi_${randomUUID()}`;
    const args = ["--mode", "json", "--session-id", state.piSessionId];
    const effort = state.loop.reasoningLevel;
    if (effort !== undefined && PiAdapter.THINKING_LEVELS.has(effort)) {
      args.push("--thinking", effort);
    }
    if (model !== null) args.push("--model", model);
    args.push("-p", "--", prompt);

    const acc: PiTurnAcc = {
      sawAny: false,
      turnText: "",
      messageId: `msg_${Date.now()}`,
      toolArgs: new Map(),
    };
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => this.handleLine(state, acc, line),
      onStderrLine: (line) => log.debug("pi -p stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;

    // 与 claude/codex 同款：'close' 在流全部排空后触发，尾部 turn_end 不丢
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    state.child = null;

    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }
    this.finalizeTurn(state, acc, exitCode);
  }

  // ---- SDK 进程内传输（pi-web 同款：同一引擎，同一 ~/.pi 会话文件）----------------

  /** 每个 rootPath 一份 services（扩展加载贵，复用）；SessionManager 每会话一个 */
  private readonly sdkServices = new Map<string, unknown>();
  private sdkServicesLoading: Promise<unknown> | null = null;

  private async servicesOf(rootPath: string): Promise<unknown> {
    const hit = this.sdkServices.get(rootPath);
    if (hit !== undefined) return hit;
    this.sdkServicesLoading ??= (async () => {
      const mod = await import("@earendil-works/pi-coding-agent");
      const services = await mod.createAgentSessionServices({ cwd: rootPath });
      this.sdkServices.set(rootPath, services);
      return services;
    })();
    try {
      return await this.sdkServicesLoading;
    } finally {
      this.sdkServicesLoading = null;
    }
  }

  private async ensureSdkSession(state: SessionState, model: ModelId | null): Promise<void> {
    if (state.sdk !== null) return;
    const mod = await import("@earendil-works/pi-coding-agent");
    const services = (await this.servicesOf(state.rootPath)) as Record<string, unknown>;

    // 恢复（reattach 有 ref）优先按 id 找会话文件；找不到/出错回落新会话
    let sessionManager: Awaited<ReturnType<typeof mod.SessionManager.create>> | undefined;
    if (state.piSessionId !== "") {
      try {
        const file = await mod.SessionManager.findById(state.rootPath, state.piSessionId);
        if (typeof file === "string") sessionManager = await mod.SessionManager.open(file);
      } catch {
        /* 回落新会话 */
      }
    }
    if (sessionManager === undefined) {
      sessionManager = await mod.SessionManager.create(state.rootPath);
    }

    const effort = state.loop.reasoningLevel;
    const opts: Record<string, unknown> = { services, sessionManager };
    if (model !== null) opts["model"] = model;
    if (effort !== undefined && PiAdapter.THINKING_LEVELS.has(effort)) opts["thinkingLevel"] = effort;
    const result = await mod.createAgentSessionFromServices(
      opts as unknown as Parameters<typeof mod.createAgentSessionFromServices>[0],
    );
    const session = result.session;
    // pi 生成的 uuidv7 即 externalRef（daemon 重启 reattach / Phase 1 reader 直读）
    if (typeof session.sessionId === "string" && session.sessionId !== "") state.piSessionId = session.sessionId;
    const acc: PiTurnAcc = { sawAny: false, turnText: "", messageId: `msg_${Date.now()}`, toolArgs: new Map() };
    state.acc = acc;
    const unsubscribe = session.subscribe((event: unknown) => {
      // SDK 事件与 CLI --mode json 的 JSONL 同构（同一 AgentSessionEvent）——翻译层复用
      this.handleLine(state, state.acc ?? acc, JSON.stringify(event));
    });
    state.sdk = { session, unsubscribe };
  }

  private async sdkTurn(state: SessionState, prompt: string, model: ModelId | null): Promise<void> {
    await this.ensureSdkSession(state, model);
    const { session } = state.sdk!;
    state.acc = { sawAny: false, turnText: "", messageId: `msg_${Date.now()}`, toolArgs: new Map() };
    state.cancelled = false;
    state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "running" });
    await session.prompt(prompt, {});
    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }
    this.finalizeTurn(state, state.acc, 0);
  }

  // ---- JSONL → RuntimeEvent（逐行）----

  private handleLine(state: SessionState, acc: PiTurnAcc, line: string): void {
    const sink = state.sink;
    if (sink === null || line.trim() === "") return;
    let ev: PiEvent;
    try {
      ev = JSON.parse(line) as PiEvent;
    } catch {
      return; // 非 JSON 横幅不算有效轮（与 claude/codex 对齐）
    }
    acc.sawAny = true;
    const sessionId = state.sessionId;

    switch (ev.type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent ?? {};
        switch (ame.type) {
          case "thinking_delta":
            if (ame.delta) sink({ type: "reasoning.delta", sessionId, messageId: acc.messageId, text: ame.delta });
            break;
          case "text_delta":
            if (ame.delta) {
              acc.turnText += ame.delta;
              sink({ type: "message.delta", sessionId, messageId: acc.messageId, role: "assistant", text: ame.delta });
            }
            break;
          case "toolcall_start":
            // 只记名字；带参数的 tool.started 等 tool_execution_start（args 在那儿）再发
            break;
          default:
            break;
        }
        break;
      }
      case "tool_execution_start": {
        if (ev.toolCallId === undefined) break;
        if (ev.args !== undefined) acc.toolArgs.set(ev.toolCallId, ev.args);
        sink({
          type: "tool.started",
          sessionId,
          callId: ev.toolCallId,
          toolName: ev.toolName ?? "tool",
          title: ev.toolName ?? "tool",
          input: ev.args ?? null,
        });
        break;
      }
      case "tool_execution_end": {
        if (ev.toolCallId === undefined) break;
        const output = (ev.result?.content ?? [])
          .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("")
          .slice(0, 8000);
        sink({ type: "tool.completed", sessionId, callId: ev.toolCallId, ok: ev.isError !== true, output });
        // write/edit 是 pi 内建文件工具，凭 args.path 补 file.changed（bash 改文件协议看不见）
        if (ev.isError !== true && (ev.toolName === "write" || ev.toolName === "edit")) {
          const path = readArgPath(acc.toolArgs.get(ev.toolCallId));
          if (path !== null) {
            sink({ type: "file.changed", sessionId, path, change: ev.toolName === "write" ? "created" : "modified" });
          }
        }
        acc.toolArgs.delete(ev.toolCallId);
        break;
      }
      case "turn_end": {
        acc.turnUsage = ev.message?.usage;
        acc.turnModel = ev.message?.model;
        break;
      }
      default:
        break; // session/agent_start/agent_end/message_start|end（回显与 toolResult）不翻译
    }
  }

  private finalizeTurn(state: SessionState, acc: PiTurnAcc, exitCode: number | null): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (!acc.sawAny) {
      sink({
        type: "error",
        sessionId,
        message: `pi -p produced no events (exit ${exitCode})`,
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }

    if (acc.turnUsage !== undefined) {
      const u = acc.turnUsage;
      const cacheW = u.cacheWrite ?? 0;
      sink({
        type: "usage",
        sessionId,
        // 计费口径对齐契约（dsh）：billedInput = uncached + cacheWrite
        inputTokens: (u.input ?? 0) + cacheW,
        outputTokens: u.output ?? 0,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: cacheW,
        // cost.total 是 pi 侧真实计费，非估算
        costUsd: u.cost?.total ?? 0,
        model: acc.turnModel ?? "pi-default",
        decodeMs: undefined,
        requestId: `pi:${state.piSessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }

    // agent loop 语义：turn 完成 ≠ 会话结束（--session-id 可续聊）
    sink({ type: "session.status", sessionId, status: "idle" });
  }
}

/** 从工具参数里挖主路径（write/edit 的 path / filePath / file_path） */
function readArgPath(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path"]) {
    const v = rec[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}
