/**
 * Grok Build（SpaceXAI grok）执行器适配器 —— `grok -p --output-format streaming-messages-json --include-partial-messages` + `--resume` 多轮。
 *
 * 协议事实（grok 1.x 实测与 xai-grok-pager 源码走查）：
 * - 源码库：crates/codegen/xai-grok-pager-bin 与 xai-grok-pager
 * - system:init：首个事件，带 session_id / model / tools 清单
 * - stream_event（--include-partial-messages）：Messages API wire format 流事件
 *   {content_block_delta, delta:{text_delta|thinking_delta}} —— 真流式 delta
 * - assistant：完整消息块 content[{text}|{tool_use,id,name,input}]
 * - user：工具结果 content[{tool_result,tool_use_id,is_error,content}]
 * - result：turn 终态 {result,is_error,duration_ms,usage:{input_tokens,output_tokens,cache_read_tokens},session_id}
 * - 多轮：--resume <session_id> 维系上下文
 * - 权限模式：--always-approve（别名 --yolo / --dangerously-skip-permissions）免除交互挂起
 * - 模型：--model <model>（默认 grok-4.6 / grok-4.5）；推理档位：--effort <low|medium|high|xhigh>
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
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
import { execLines, resolveCommand, spawnLines, type ResolvedCommand } from "../exec.ts";
import { log } from "../../log.ts";

interface GrokContentBlock {
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

interface GrokEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  message?: {
    id?: string;
    content?: GrokContentBlock[];
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  model: ModelId | null;
  reasoningLevel: string | undefined;
  cliSessionId: string | null;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  usageCount: number;
}

interface TurnAcc {
  messageId: string;
  initSeen: boolean;
  sawAnyEvent: boolean;
  resultText: string | null;
  isError: boolean;
  usage?: GrokEvent["usage"];
  costUsd?: number;
  durationMs?: number;
}

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "grok-4.6" as ModelId,
    displayName: "Grok 4.6",
    contextWindow: 500_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningLevel: "high",
  },
  {
    id: "grok-4.5" as ModelId,
    displayName: "Grok 4.5",
    contextWindow: 500_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  },
];

function getLocalGrokCandidates(): string[] {
  const home = homedir();
  return [
    // 官方发布版安装目标（irm https://x.ai/cli/install.ps1 | iex）
    path.join(home, ".grok", "bin", "grok.exe"),
    path.join(home, ".grok", "bin", "grok"),
    path.join(home, ".grok", "bin", "agent.exe"),
    path.join(home, ".grok", "bin", "xai-grok-pager.exe"),
    path.join(home, "AppData", "Local", "grok", "bin", "grok.exe"),
    path.join(home, ".local", "bin", "grok.exe"),
    path.join(home, ".local", "bin", "grok"),
    path.join(home, ".cargo", "bin", "grok.exe"),
    // 本地 grok-build 源码编译产物目录
    "C:\\Users\\chenziyu\\project\\Agent\\grok-build\\target\\release\\xai-grok-pager.exe",
    "C:\\Users\\chenziyu\\project\\Agent\\grok-build\\target\\release\\grok.exe",
    "C:\\Users\\chenziyu\\project\\Agent\\grok-build\\target\\debug\\xai-grok-pager.exe",
    "C:\\Users\\chenziyu\\project\\Agent\\grok-build\\target\\debug\\grok.exe",
  ];
}

async function resolveGrokCommand(): Promise<ResolvedCommand> {
  // 1. 优先查已知物理路径（直接绕过长驻进程未能继承 Windows 注册表新 PATH 的问题）
  for (const p of getLocalGrokCandidates()) {
    if (existsSync(p)) {
      return { file: p, prefixArgs: [], via: "exe" };
    }
  }

  // 2. PATH 解析
  try {
    return await resolveCommand("grok");
  } catch {
    // 尝试 xai-grok-pager 别名
    try {
      return await resolveCommand("xai-grok-pager");
    } catch {
      throw Object.assign(new Error("grok executable not found on PATH or target"), {
        code: "not_installed",
      });
    }
  }
}

export class GrokAdapter implements ExecutorAdapter {
  readonly id = "grok";
  readonly displayName = "Grok Build";
  readonly glyph = "G";
  readonly tuiCommand = "grok";

  private readonly sessions = new Map<SessionId, SessionState>();

  get models(): readonly ExecutorModelInfo[] {
    return STATIC_MODELS;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: true,
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveGrokCommand();
      const versionOut = await execLines(cmd, ["--version"], 10000);
      const version = versionOut.split(/\r?\n/)[0]?.trim() || "ready";
      return {
        state: { status: "ready", version },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? {
                status: "not_installed",
                hint: "未找到 grok CLI。运行 irm https://x.ai/cli/install.ps1 | iex 安装，或在 grok-build 目录执行 cargo build -p xai-grok-pager-bin --release",
              }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const sessionId = `sess_${randomUUID()}` as SessionId;
    const state: SessionState = {
      sessionId,
      rootPath: req.rootPath,
      mode: req.mode,
      model: req.model,
      reasoningLevel: req.reasoningLevel,
      cliSessionId: null,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);

    void this.spawnTurn(state, req.prompt).catch((err: unknown) => {
      log.error("grok initial turn failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return this.sessionHandle(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      model: null,
      reasoningLevel: undefined,
      cliSessionId: ref,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    return this.sessionHandle(state);
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  private sessionHandle(state: SessionState): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.reasoningLevel = loop.reasoningLevel;
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on grok (runs with --always-approve / --yolo)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveGrokCommand();
    const args = [
      "-p",
      prompt,
      "--output-format",
      "streaming-messages-json",
      "--include-partial-messages",
      "--always-approve",
    ];

    if (state.cliSessionId !== null) {
      args.push("--resume", state.cliSessionId);
    }
    if (state.model !== null) {
      args.push("--model", state.model);
    }
    if (state.reasoningLevel !== undefined && state.reasoningLevel !== "") {
      args.push("--effort", state.reasoningLevel);
    }

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
      onStderrLine: (line) => log.debug("grok stderr", { line: line.slice(0, 200) }),
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

  private handleLine(state: SessionState, acc: TurnAcc, line: string): void {
    const sink = state.sink;
    if (sink === null || line.trim() === "") return;

    let ev: GrokEvent;
    try {
      ev = JSON.parse(line) as GrokEvent;
    } catch {
      return;
    }
    acc.sawAnyEvent = true;
    const sessionId = state.sessionId;

    if (ev.type === "system" && ev.subtype === "init") {
      acc.initSeen = true;
      if (ev.session_id !== undefined) state.cliSessionId = ev.session_id;
      sink({ type: "session.status", sessionId, status: "running" });
      return;
    }

    if (ev.type === "stream_event") {
      const delta = ev.event?.delta;
      if (delta?.type === "text_delta" && delta.text !== undefined && delta.text !== "") {
        sink({
          type: "message.delta",
          sessionId,
          messageId: acc.messageId,
          role: "assistant",
          text: delta.text,
        });
      } else if (delta?.type === "thinking_delta" && delta.thinking !== undefined && delta.thinking !== "") {
        sink({
          type: "reasoning.delta",
          sessionId,
          messageId: acc.messageId,
          text: delta.thinking,
        });
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
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
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
      sink({
        type: "error",
        sessionId,
        message: `grok exited without output (exit code ${exitCode})`,
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed_executor" });
      return;
    }

    if (acc.isError) {
      sink({
        type: "error",
        sessionId,
        message: acc.resultText && acc.resultText.trim() !== "" ? acc.resultText : "grok reported error",
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed_executor" });
      return;
    }

    sink({
      type: "message.completed",
      sessionId,
      messageId: acc.messageId,
      text: acc.resultText ?? "",
    });

    if (acc.usage) {
      state.usageCount += 1;
      const u = acc.usage;
      sink({
        type: "usage",
        sessionId,
        model: state.model ?? ("grok-4.6" as ModelId),
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
        costUsd: acc.costUsd ?? 0,
      });
    }

    sink({ type: "session.status", sessionId, status: "idle" });
  }
}
