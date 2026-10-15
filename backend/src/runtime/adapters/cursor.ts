/**
 * Cursor Agent 执行器适配器 —— `cursor-agent -p --output-format stream-json --stream-partial-output` + `--resume` 多轮。
 *
 * 协议事实（cursor-agent 2026 实测）：
 * - system:init：首个事件，带 session_id / model / cwd / permissionMode
 * - thinking: delta 与 completed，带 text 与 timestamp_ms
 * - assistant：消息块与增量文字流 content[{type:"text",text}]
 * - tool_call / tool_result：工具调用与完成
 * - result：turn 终态 {subtype:"success"|"error", result, is_error, session_id, duration_ms, usage:{inputTokens,outputTokens,cacheReadTokens}}
 * - 多轮：--resume <session_id> 维系上下文
 * - 权限模式：--trust 避免工作区信任弹窗；--yolo / -f 免除审批
 * - 动态模型：`cursor-agent --list-models` 探测可用模型清单
 *
 * docs/13 Phase 4 Tier 2 的 SDK 升级路径（@cursor/sdk 1.0.x 已上 npm）**待语义对齐
 * POC**：SDK 走 CURSOR_API_KEY + 云/本地 workspace 的 agent 语义，与本地
 * cursor-agent CLI 的工作目录语义有差异（计划原文已标注「升级前先做语义对齐」）。
 * 本文件保留 CLI 主路径；POC 环境就绪后在 send() 前挂 SDK 传输（参照
 * openclaw.ts 的双传输模式：SDK 失败回落 CLI）。
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
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
import { discoverCursorSkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type { NativeCommandInfo } from "../../contract.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand, spawnLines } from "../exec.ts";
import { log } from "../../log.ts";

interface CursorContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  call_id?: string;
  tool_call_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  text?: string;
  message?: { role?: string; content?: CursorContentBlock[] };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  tool_call?: { id?: string; name?: string; input?: unknown };
  tool_result?: { id?: string; output?: unknown; is_error?: boolean };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  model: ModelId | null;
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
  usage?: CursorEvent["usage"];
  durationMs?: number;
}

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "gpt-5.6-sol-medium" as ModelId,
    displayName: "GPT-5.6 Sol 1M",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "gpt-5.5-medium" as ModelId,
    displayName: "GPT-5.5 1M",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "claude-sonnet-5-5-high" as ModelId,
    displayName: "Claude Sonnet 5.5 High",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "claude-opus-4-7-high" as ModelId,
    displayName: "Claude Opus 4.7 1M High",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "cursor-grok-4.5-medium" as ModelId,
    displayName: "Grok 4.5 Medium",
    contextWindow: 500_000,
    multimodal: true,
  },
  {
    id: "gemini-3.8-flash-high" as ModelId,
    displayName: "Gemini 3.8 Flash High",
    contextWindow: 1_000_000,
    multimodal: true,
  },
];

export class CursorAdapter implements ExecutorAdapter {
  readonly id = "cursor";
  readonly displayName = "Cursor Agent";
  readonly glyph = "C";
  readonly tuiCommand = "cursor-agent";

  private dynamicModels: readonly ExecutorModelInfo[] | null = null;
  private readonly sessions = new Map<SessionId, SessionState>();

  get models(): readonly ExecutorModelInfo[] {
    return this.dynamicModels ?? STATIC_MODELS;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: true,
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  /** 动态对齐/刷新模型清单：实时调用 `cursor-agent --list-models` */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("cursor-agent");
      const stdout = await execLines(cmd, ["--list-models"], 30000);
      if (!stdout || stdout.trim() === "") {
        return { models: this.models, source: "static", reason: "--list-models 无输出", elapsedMs: Date.now() - t0 };
      }

      const list: ExecutorModelInfo[] = [];
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Tip:")) continue;
        const dashIdx = trimmed.indexOf(" - ");
        if (dashIdx === -1) continue;

        const slug = trimmed.slice(0, dashIdx).trim();
        const name = trimmed.slice(dashIdx + 3).trim();
        if (!slug || !name) continue;

        const is1M = name.includes("1M") || slug.includes("1m");
        const isClaude = slug.startsWith("claude");
        const isGpt = slug.startsWith("gpt");
        const isGemini = slug.startsWith("gemini");
        const isGrok = slug.includes("grok");

        const hasLow = slug.includes("low");
        const hasMed = slug.includes("medium");
        const hasHigh = slug.includes("high") || slug.includes("max");

        list.push({
          id: slug as ModelId,
          displayName: name,
          contextWindow: is1M ? 1_000_000 : isGrok ? 500_000 : 200_000,
          multimodal: isClaude || isGpt || isGemini || isGrok,
          reasoningLevels: hasLow || hasMed || hasHigh ? ["low", "medium", "high"] : undefined,
          defaultReasoningLevel: hasHigh ? "high" : hasMed ? "medium" : hasLow ? "low" : undefined,
        });
      }

      if (list.length > 0) {
        this.dynamicModels = list;
        log.info("cursor-agent models synced dynamically", { count: list.length });
        return { models: list, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("cursor-agent --list-models failed, using fallback models", { error: reason });
      return { models: this.models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this.models, source: "static", reason: "--list-models 输出未匹配到条目", elapsedMs: Date.now() - t0 };
  }


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * Cursor 原生命令、技能与子智能体面：
   * 内置目录（官方文档/包内注册表为事实源，见 builtin-catalogs.ts）+
   * 原生技能（.cursor/skills、.codex/skills、.claude/skills 及标准 .agents/skills）+
   * 子智能体（.cursor/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 Cursor，由 Cursor 原生分发。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < CursorAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverCursorSkillsAndAgents(rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("cursor-agent");
      const versionOut = await execLines(cmd, ["-v"], 10000).catch(() =>
        execLines(cmd, ["--version"], 10000),
      );
      const version = versionOut.split(/\r?\n/)[0]?.trim() || "ready";

      // 尝试探测登录状态
      let statusHint = "";
      try {
        const statusOut = await execLines(cmd, ["status"], 10000);
        const statusLine = statusOut.split(/\r?\n/).find((l) => l.includes("Logged in"))?.trim();
        if (statusLine) statusHint = statusLine;
      } catch {
        // status 失败不阻断
      }

      return {
        state: { status: "ready", version: statusHint ? `${version} (${statusHint})` : version },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未在 PATH 中找到 cursor-agent CLI" }
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
      cliSessionId: null,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);

    // 首轮执行
    void this.spawnTurn(state, req.prompt).catch((err: unknown) => {
      log.error("cursor-agent initial turn failed", {
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
      send: async (text: string) => {
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on cursor-agent (runs in --trust / --yolo mode)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveCommand("cursor-agent");
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--workspace",
      state.rootPath,
    ];

    if (state.mode === "yolo") {
      args.push("--yolo");
    }
    if (state.cliSessionId !== null) {
      args.push("--resume", state.cliSessionId);
    }
    if (state.model !== null) {
      args.push("--model", state.model);
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
      onStderrLine: (line) => log.debug("cursor-agent stderr", { line: line.slice(0, 200) }),
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

    let ev: CursorEvent;
    try {
      ev = JSON.parse(line) as CursorEvent;
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

    if (ev.type === "thinking" && ev.subtype === "delta") {
      if (ev.text !== undefined && ev.text !== "") {
        sink({
          type: "reasoning.delta",
          sessionId,
          messageId: acc.messageId,
          text: ev.text,
        });
      }
      return;
    }

    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text !== undefined && block.text !== "") {
          sink({
            type: "message.delta",
            sessionId,
            messageId: acc.messageId,
            role: "assistant",
            text: block.text,
          });
        }
      }
      return;
    }

    if (ev.type === "tool_call" || ev.tool_call !== undefined) {
      const tool = ev.tool_call;
      const callId = tool?.id ?? `call_${Date.now()}`;
      sink({
        type: "tool.started",
        sessionId,
        callId,
        toolName: tool?.name ?? "tool",
        title: tool?.name ?? "tool",
        input: tool?.input ?? null,
      });
      return;
    }

    if (ev.type === "tool_result" || ev.tool_result !== undefined) {
      const res = ev.tool_result;
      const callId = res?.id ?? `call_${Date.now()}`;
      const out = typeof res?.output === "string" ? res.output : JSON.stringify(res?.output ?? null);
      sink({
        type: "tool.completed",
        sessionId,
        callId,
        ok: res?.is_error !== true,
        output: out.slice(0, 8000),
      });
      return;
    }

    if (ev.type === "result") {
      acc.resultText = ev.result ?? "";
      acc.isError = ev.is_error === true;
      acc.usage = ev.usage;
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
        message: `cursor-agent exited without output (exit code ${exitCode})`,
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed_executor" });
      return;
    }

    if (acc.isError) {
      sink({
        type: "error",
        sessionId,
        message: acc.resultText && acc.resultText.trim() !== "" ? acc.resultText : "cursor-agent reported error",
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
        model: state.model ?? ("Auto" as ModelId),
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: 0,
      });
    }

    sink({ type: "session.status", sessionId, status: "idle" });
  }
}
