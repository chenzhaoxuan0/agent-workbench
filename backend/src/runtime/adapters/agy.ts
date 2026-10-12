/**
 * Google Antigravity（agy）执行器适配器 —— `agy --output-format stream-json --print` + `--conversation` 多轮。
 *
 * 协议事实（agy 1.2.5 实测）：
 * - init：首个事件，带 conversation_id / tools 清单 / permission_mode
 * - step_update：
 *   - step_type: "agent_response" + text_delta（增量文字流）
 *   - step_type: "tool" + state: "ACTIVE"（工具启动，tool_info.name / parameters）
 *   - step_type: "tool" + state: "DONE"（工具完成，tool_info.output）
 *   - state: "DONE" + usage（input_tokens / output_tokens / thinking_tokens / total_tokens）
 * - result：turn 终态 {status, response, duration_seconds, usage, conversation_id}
 * - 多轮：--conversation <conversation_id> 维系上下文
 * - 权限模式：--mode (accept-edits | plan)，默认传入 --dangerously-skip-permissions 免除无头死锁
 * - 模型：--model <model>，推理档位：--effort (low | medium | high)
 * - 动态模型：`agy models` 探测可用模型清单
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

interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: "ACTIVE" | "DONE";
  step_type?: "user_input" | "system_message" | "agent_response" | "tool";
  text_delta?: string;
  thinking_delta?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: unknown;
    output?: unknown;
  };
}

interface AgyResult {
  conversation_id?: string;
  status?: "SUCCESS" | "ERROR";
  response?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyEvent {
  event?: "init" | "step_update" | "result";
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: AgyStepUpdate;
  result?: AgyResult;
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly mode: StartRequest["mode"];
  model: ModelId | null;
  reasoningLevel: string | undefined;
  /** CLI 原生会话 ID（--conversation 用），首轮 init 事件给出 */
  cliConversationId: string | null;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  usageCount: number;
}

interface TurnAcc {
  readonly messageId: string;
  initSeen: boolean;
  sawAnyEvent: boolean;
  resultText: string | null;
  isError: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  durationMs?: number;
}

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "gemini-3.8-flash-high" as ModelId,
    displayName: "Gemini 3.8 Flash (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.8-flash-medium" as ModelId,
    displayName: "Gemini 3.8 Flash (Medium)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
  },
  {
    id: "gemini-3.8-flash-low" as ModelId,
    displayName: "Gemini 3.8 Flash (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "gemini-3.7-flash-high" as ModelId,
    displayName: "Gemini 3.7 Flash (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.7-flash-medium" as ModelId,
    displayName: "Gemini 3.7 Flash (Medium)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
  },
  {
    id: "gemini-3.7-flash-low" as ModelId,
    displayName: "Gemini 3.7 Flash (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "gemini-3.1-pro-high" as ModelId,
    displayName: "Gemini 3.1 Pro (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.1-pro-low" as ModelId,
    displayName: "Gemini 3.1 Pro (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "claude-sonnet-4-6" as ModelId,
    displayName: "Claude Sonnet 4.6 (Thinking)",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "claude-opus-4-6-thinking" as ModelId,
    displayName: "Claude Opus 4.6 (Thinking)",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "gpt-oss-120b-medium" as ModelId,
    displayName: "GPT-OSS 120B (Medium)",
    contextWindow: 128_000,
    multimodal: false,
  },
  {
    id: "antigravity-default" as ModelId,
    displayName: "Antigravity Default",
    contextWindow: 1_000_000,
    multimodal: true,
  },
];

export class AgyAdapter implements ExecutorAdapter {
  readonly id = "agy";
  readonly displayName = "Antigravity";
  readonly glyph = "A";

  private dynamicModels: readonly ExecutorModelInfo[] | null = null;
  private readonly sessions = new Map<SessionId, SessionState>();

  get models(): readonly ExecutorModelInfo[] {
    return this.dynamicModels ?? STATIC_MODELS;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: false, // 走 --dangerously-skip-permissions，由 daemon 权限闸统一治理
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  /** 动态对齐/刷新模型清单：实时调用 `agy models` */
  async syncModels(): Promise<readonly ExecutorModelInfo[]> {
    try {
      const cmd = await resolveCommand("agy");
      const stdout = await execLines(cmd, ["models"], 35000);
      if (!stdout || stdout.trim() === "") {
        return this.models;
      }

      const list: ExecutorModelInfo[] = [];
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Fetching")) continue;
        const parts = trimmed.split(/\t+|\s{2,}/);
        if (parts.length < 2) continue;
        const slug = parts[0]?.trim();
        const name = parts[1]?.trim();
        if (!slug || !name) continue;

        const isGemini = slug.startsWith("gemini");
        const isClaude = slug.startsWith("claude");
        const isLow = slug.includes("low");
        const isMed = slug.includes("medium");
        const isHigh = slug.includes("high");

        list.push({
          id: slug as ModelId,
          displayName: name,
          contextWindow: isGemini ? 1_000_000 : isClaude ? 200_000 : 128_000,
          multimodal: !slug.includes("gpt-oss"),
          reasoningLevels: isGemini ? ["low", "medium", "high"] : isLow ? ["low"] : isMed ? ["medium"] : isHigh ? ["high"] : undefined,
          defaultReasoningLevel: isHigh ? "high" : isMed ? "medium" : isLow ? "low" : undefined,
        });
      }

      if (list.length > 0) {
        // 保留 antigravity-default 占位
        if (!list.some((m) => m.id === "antigravity-default")) {
          list.push({
            id: "antigravity-default" as ModelId,
            displayName: "Antigravity Default",
            contextWindow: 1_000_000,
            multimodal: true,
          });
        }
        this.dynamicModels = list;
        return list;
      }
    } catch (err: unknown) {
      log.warn("agy syncModels failed", { error: err instanceof Error ? err.message : String(err) });
    }
    return this.models;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("agy");
      const out = await execLines(cmd, ["--version"], 15000);
      return {
        state: {
          status: "ready",
          version: out.trim() || "unknown",
        },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 agy CLI（请确保 agy 在 PATH 中）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const sessionId = `ses_${randomUUID()}` as SessionId;
    const state: SessionState = {
      sessionId,
      rootPath: req.rootPath,
      mode: req.mode,
      model: req.model,
      reasoningLevel: req.reasoningLevel,
      cliConversationId: null,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);

    void this.spawnTurn(state, req.prompt);

    return {
      id: sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel) state.reasoningLevel = loop.reasoningLevel;
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on agy session (auto-approved via --dangerously-skip-permissions)");
      },
      externalRef: () => state.cliConversationId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      model: null,
      reasoningLevel: undefined,
      cliConversationId: ref,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel) state.reasoningLevel = loop.reasoningLevel;
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on agy session (auto-approved via --dangerously-skip-permissions)");
      },
      externalRef: () => state.cliConversationId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  // ---- turn 执行 ----

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveCommand("agy");
    const args = ["--output-format", "stream-json"];

    if (state.cliConversationId !== null) {
      args.push("--conversation", state.cliConversationId);
    }

    if (state.model && state.model !== "antigravity-default") {
      args.push("--model", state.model);
    }

    if (state.reasoningLevel) {
      const effort = state.reasoningLevel.toLowerCase();
      if (["low", "medium", "high"].includes(effort)) {
        args.push("--effort", effort);
      }
    }

    if (state.mode === "plan") {
      args.push("--mode", "plan");
    } else if (state.mode === "edit") {
      args.push("--mode", "accept-edits");
    } else {
      args.push("--dangerously-skip-permissions");
    }

    // --print 必须紧跟 prompt
    args.push("--print", prompt);

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
      onStderrLine: (line) => log.debug("agy stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;

    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
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
    let ev: AgyEvent;
    try {
      ev = JSON.parse(line) as AgyEvent;
    } catch {
      return;
    }
    acc.sawAnyEvent = true;
    const sessionId = state.sessionId;

    if (ev.event === "init") {
      acc.initSeen = true;
      if (ev.conversation_id) {
        state.cliConversationId = ev.conversation_id;
        sink({ type: "session.ref", sessionId, ref: ev.conversation_id });
      }
      return;
    }

    if (ev.event === "step_update" && ev.step_update) {
      const update = ev.step_update;
      if (update.conversation_id && !state.cliConversationId) {
        state.cliConversationId = update.conversation_id;
        sink({ type: "session.ref", sessionId, ref: update.conversation_id });
      }

      // agent 回复的文字流 / 思考流
      if (update.step_type === "agent_response") {
        if (update.text_delta) {
          sink({
            type: "message.delta",
            sessionId,
            messageId: acc.messageId,
            role: "assistant",
            text: update.text_delta,
          });
        }
        if (update.thinking_delta) {
          sink({
            type: "reasoning.delta",
            sessionId,
            messageId: acc.messageId,
            text: update.thinking_delta,
          });
        }
        if (update.state === "DONE" && update.usage) {
          acc.usage = update.usage;
        }
        return;
      }

      // 工具执行流
      if (update.step_type === "tool") {
        const callId = `call_${update.step_index ?? Date.now()}`;
        const toolName = update.tool_name ?? update.tool_info?.name ?? "tool";

        if (update.state === "ACTIVE") {
          sink({
            type: "tool.started",
            sessionId,
            callId,
            toolName,
            title: toolName,
            input: update.tool_info?.parameters ?? null,
          });
        } else if (update.state === "DONE") {
          const outRaw = update.tool_info?.output;
          const output = typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw ?? "");
          sink({
            type: "tool.completed",
            sessionId,
            callId,
            ok: true,
            output: output.slice(0, 8000),
          });
        }
        return;
      }

      return;
    }

    if (ev.event === "result" && ev.result) {
      acc.resultText = ev.result.response ?? "";
      acc.isError = ev.result.status === "ERROR";
      acc.usage = ev.result.usage ?? acc.usage;
      acc.durationMs = (ev.result.duration_seconds ?? 0) * 1000;
      if (ev.result.conversation_id) {
        state.cliConversationId = ev.result.conversation_id;
      }
    }
  }

  private finalizeTurn(state: SessionState, acc: TurnAcc, exitCode: number | null): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (!acc.sawAnyEvent) {
      sink({
        type: "error",
        sessionId,
        message: `Antigravity 未输出任何事件（进程退出码：${exitCode}）`,
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    if (acc.isError) {
      sink({
        type: "error",
        sessionId,
        message: acc.resultText || "Antigravity 执行出错",
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    sink({
      type: "message.completed",
      sessionId,
      messageId: acc.messageId,
      text: acc.resultText ?? "",
    });

    state.usageCount += 1;
    const inTok = acc.usage?.input_tokens ?? 0;
    const outTok = acc.usage?.output_tokens ?? 0;
    const readTok = acc.usage?.cache_read_tokens ?? 0;
    sink({
      type: "usage",
      sessionId,
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: readTok,
      costUsd: 0,
      model: state.model ?? "gemini-3.8-flash-high",
      decodeMs: acc.durationMs,
      requestId: `agy:${state.cliConversationId ?? state.sessionId}:p${process.pid}:${state.usageCount}`,
    });

    sink({ type: "session.status", sessionId, status: "idle" });
  }
}
