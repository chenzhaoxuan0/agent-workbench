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
  readonly mode: StartRequest["mode"];
  /** pi 会话 id（--session-id 固定注入，首轮即知，因此 externalRef 恒非空） */
  readonly piSessionId: string;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  loop: { reasoningLevel?: string };
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
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

export class PiAdapter implements ExecutorAdapter {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly glyph = "π";
  readonly models: readonly ExecutorModelInfo[] = [
    // pi 的模型由它自己的 provider 配置决定（本机默认 minimax-cn/MiniMax-M2.7 实测可用）；
    // model=null 走 pi 默认，非空时透传 --model（pi 侧未配置的 id 会在 turn 内报错）
    { id: "minimax-cn/MiniMax-M2.7" as ModelId, displayName: "MiniMax M2.7" },
  ];
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
    // 会话 id 由 daemon 侧生成并固定注入（--session-id），首轮即有稳定 externalRef，
    // daemon 重启后 reattach 直接续命 —— 不依赖 pi 首轮事件回传
    const ref = `pi_${randomUUID()}`;
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      mode: req.mode ?? "build",
      piSessionId: ref,
      sink,
      cancelled: false,
      child: null,
      loop: { reasoningLevel: req.reasoningLevel },
      usageCount: 0,
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
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on pi -p session (no permission stream)");
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
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on pi -p session (no permission stream)");
      },
      externalRef: () => state.piSessionId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
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
    // 评审 P1 同款：cancelled 只描述"cancel 杀掉的那一轮"
    state.cancelled = false;
    const cmd = await resolveCommand("pi");
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
