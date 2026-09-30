/**
 * Claude Code 执行器适配器 —— `claude -p --output-format stream-json` + `--resume` 多轮。
 *
 * 协议事实（claude 2.1.280 实测，stream-json 每行一事件）：
 * - system:init：首个事件，带 session_id / model / tools 清单
 * - stream_event（--include-partial-messages）：Anthropic 流事件
 *   {content_block_delta, delta:{text_delta|thinking_delta}} —— 真流式 delta
 * - assistant：完整消息块 content[{text}|{tool_use,id,name,input}] + usage
 * - user：工具结果 content[{tool_result,tool_use_id,is_error,content}]
 * - result：turn 终态 {result,is_error,total_cost_usd,duration_ms,usage,session_id}
 *   —— total_cost_usd 是真实成本（网关计费），非估算
 * - 多轮：--resume <session_id>；权限模式 --permission-mode（headless 无交互审批面，
 *   default 档写工具自动拒绝）；认证走本机 settings.json 的网关（对 daemon 透明）
 *
 * 本机网关（settings.json → mdataplus 端点）偶发过载（"活动火爆"），届时 turn
 * 以 is_error 收尾 —— 适配器如实翻译为 error + status failed，网关恢复即用。
 * probe 只验 CLI 存在与版本，网关状态留给 turn 暴露。
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

// ---- CLI 事件宽松类型 -------------------------------------------------------

interface CliContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface CliEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { id?: string; content?: CliContentBlock[]; usage?: Record<string, number | undefined> };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: Record<string, number | undefined>;
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly mode: StartRequest["mode"];
  /** CLI 的原生会话 id（--resume 用），首轮 init 事件给出 */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  loop: { reasoningLevel?: string };
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
}

/** 一轮的终态聚合器：行内事件即时 sink，聚合字段由 result 行回填、exit 后收尾用 */
interface TurnAcc {
  readonly messageId: string;
  initSeen: boolean;
  sawAnyEvent: boolean;
  resultText: string | null;
  isError: boolean;
  usage?: Record<string, number | undefined>;
  costUsd?: number;
  durationMs?: number;
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly glyph = "C";
  readonly models: readonly ExecutorModelInfo[] = [
    { id: "sonnet" as ModelId, displayName: "Sonnet（网关别名）" },
    { id: "opus" as ModelId, displayName: "Opus（网关别名）" },
    { id: "haiku" as ModelId, displayName: "Haiku（网关别名）" },
  ];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: false, // -p 无交互审批面：default 档自动拒写，无反向权限流
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    // WP-1：stream-json 逐行内联翻译，行到即 sink（工具/结果事件随轮次实时到达）。
    // 注意：token 级 delta 还需网关支持 partial（本机网关实测整段返回，粒度=completed 级）。
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, SessionState>();

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("claude");
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
            ? { status: "not_installed", hint: "未安装 claude CLI（npm i -g @anthropic-ai/claude-code）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      mode: req.mode ?? "build",
      cliSessionId: null,
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
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        // capabilities.permissions=false：-p 无反向权限流
        log.warn("resolvePermission called on claude -p session (no permission stream)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      cliSessionId: ref,
      sink,
      cancelled: false,
      child: null,
      loop: {},
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on claude -p session (no permission stream)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  // ---- turn 执行 ----

  /** 权限档映射：daemon 四档 → claude --permission-mode */
  private permissionModeFor(mode: StartRequest["mode"]): string {
    switch (mode) {
      case "plan":
        return "plan";
      case "edit":
        return "acceptEdits";
      case "yolo":
        return "bypassPermissions";
      default:
        return "default";
    }
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    // 评审 P1：cancelled 只描述"cancel 杀掉的那一轮"；不复位会让后续每轮的结果被静默丢弃
    state.cancelled = false;
    const cmd = await resolveCommand("claude");
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (state.cliSessionId !== null) args.push("--resume", state.cliSessionId);
    args.push("--permission-mode", this.permissionModeFor(state.mode));

    // WP-1 真流式：逐行内联翻译——delta/工具事件在行到达时即 sink，不等进程退出；
    // 只有终态聚合（completed/usage/status）留在 exit 后收尾（避免双重 ended）。
    const acc: TurnAcc = {
      messageId: `msg_${Date.now()}`,
      initSeen: false,
      sawAnyEvent: false,
      resultText: null,
      isError: false,
    };
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => this.handleLine(state, acc, line),
      onStderrLine: (line) => log.debug("claude -p stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;
    // 评审 P2：'exit' 可先于 stdio 排空——尾部 result 行（usage/终态聚合源）可能未读；
    // 'close' 在流全部结束之后触发
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    state.child = null;

    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }
    this.finalizeTurn(state, acc, exitCode);
  }

  // ---- JSONL → RuntimeEvent（逐行）----

  private handleLine(state: SessionState, acc: TurnAcc, line: string): void {
    const sink = state.sink;
    if (sink === null || line.trim() === "") return;
    let ev: CliEvent;
    try {
      ev = JSON.parse(line) as CliEvent;
    } catch {
      return;
    }
    acc.sawAnyEvent = true;
    const sessionId = state.sessionId;

    if (ev.type === "system" && ev.subtype === "init") {
      acc.initSeen = true;
      if (ev.session_id !== undefined) state.cliSessionId = ev.session_id;
      return;
    }

    if (ev.type === "stream_event") {
      const delta = ev.event?.delta;
      if (delta?.type === "text_delta" && delta.text !== undefined && delta.text !== "") {
        sink({ type: "message.delta", sessionId, messageId: acc.messageId, role: "assistant", text: delta.text });
      } else if (delta?.type === "thinking_delta" && delta.thinking !== undefined && delta.thinking !== "") {
        sink({ type: "reasoning.delta", sessionId, messageId: acc.messageId, text: delta.thinking });
      }
      return;
    }

    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use" && block.id !== undefined) {
          sink({
            type: "tool.started",
            sessionId,
            callId: block.id,
            toolName: block.name ?? "tool",
            title: block.name ?? "tool",
            input: block.input ?? null,
          });
        }
      }
      return;
    }

    if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_result" && block.tool_use_id !== undefined) {
          const out =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? null);
          sink({
            type: "tool.completed",
            sessionId,
            callId: block.tool_use_id,
            ok: block.is_error !== true,
            output: out.slice(0, 8000),
          });
        }
      }
      return;
    }

    if (ev.type === "result") {
      acc.resultText = ev.result ?? "";
      acc.isError = ev.is_error === true;
      acc.usage = ev.usage;
      acc.costUsd = ev.total_cost_usd;
      acc.durationMs = ev.duration_ms;
      if (ev.session_id !== undefined) state.cliSessionId = ev.session_id;
    }
  }

  private finalizeTurn(state: SessionState, acc: TurnAcc, exitCode: number | null): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (!acc.sawAnyEvent) {
      state.sink?.({
        type: "error",
        sessionId,
        message: `claude -p produced no events (exit ${exitCode})`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    if (!acc.initSeen && acc.resultText === null) {
      // 非 JSON 噪声或异常输出：有行但没有协议事件
      state.sink?.({
        type: "error",
        sessionId,
        message: `claude -p output had no protocol events (exit ${exitCode})`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    // 完整回复（result.result 是权威全文；流式 delta 已实时推过）
    const finalText = acc.resultText ?? "";
    if (finalText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: finalText });
    }

    if (acc.usage !== undefined) {
      const input = Number(acc.usage["input_tokens"] ?? 0);
      const output = Number(acc.usage["output_tokens"] ?? 0);
      const cacheR = Number(acc.usage["cache_read_input_tokens"] ?? 0);
      const cacheW = Number(acc.usage["cache_creation_input_tokens"] ?? 0);
      sink({
        type: "usage",
        sessionId,
        // 计费口径对齐契约（dsh）：billedInput = uncached + cacheWrite
        inputTokens: input + cacheW,
        outputTokens: output,
        cacheReadTokens: cacheR,
        cacheWriteTokens: cacheW,
        // total_cost_usd 是网关真实计费，非估算
        costUsd: acc.costUsd ?? 0,
        model: state.loop.reasoningLevel ? `claude:${state.loop.reasoningLevel}` : "claude-default",
        decodeMs: acc.durationMs,
        requestId: `claude:${state.cliSessionId ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }

    if (acc.isError) {
      sink({ type: "error", sessionId, message: finalText || "turn failed", recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
    } else {
      // agent loop 语义：turn 完成 ≠ 会话结束（--resume 可续聊）
      sink({ type: "session.status", sessionId, status: "idle" });
    }
  }
}
