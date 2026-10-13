/**
 * OpenClaw 执行器适配器 —— 统一调用 `openclaw agent -m <text> --json` 与 `openclaw agent exec`。
 *
 * 协议事实（openclaw 2026.10 实测与源码走查）：
 * - 源码库：C:\Users\chenziyu\project\Agent\openclaw
 * - 本机安装：npm 全局包（openclaw.cmd / openclaw.ps1）
 * - 执行指令：
 *   - Gateway 模式：`openclaw agent -m <prompt> --json [--session-id <id>] [--model <model>]`
 *   - 本地独立模式：`openclaw agent exec <prompt> --json --cwd <rootPath> [--model <model>]`
 * - 输出信封：
 *   - payloads: [{text: string, mediaUrl}]
 *   - meta.agentMeta: {sessionId, provider, model, usage:{input, output, cacheRead, cost:{total}}}
 *   - terminalReply: {disposition, text}
 * - 模型发现：`openclaw models list` 输出已配置的模型列表
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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

interface OpenClawResponse {
  runId?: string;
  status?: string;
  ok?: boolean;
  final?: string;
  sessionId?: string;
  error?: { type?: string; message?: string };
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
    finalAssistantVisibleText?: string;
    meta?: {
      durationMs?: number;
      agentMeta?: {
        sessionId?: string;
        provider?: string;
        model?: string;
        contextTokens?: number;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
          cost?: { total?: number };
        };
      };
    };
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

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "minimax-portal/MiniMax-M3" as ModelId,
    displayName: "MiniMax M3",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "minimax-portal/MiniMax-M2.7" as ModelId,
    displayName: "MiniMax M2.7",
    contextWindow: 205_000,
    multimodal: false,
  },
  {
    id: "minimax-portal/MiniMax-M2.5" as ModelId,
    displayName: "MiniMax M2.5",
    contextWindow: 205_000,
    multimodal: false,
  },
  {
    id: "openclaw-default" as ModelId,
    displayName: "OpenClaw Default",
    contextWindow: 200_000,
    multimodal: true,
  },
];

const LOCAL_OPENCLAW_ENTRY = "C:\\Users\\chenziyu\\project\\Agent\\openclaw\\openclaw.mjs";

async function resolveOpenclawCommand(): Promise<ResolvedCommand> {
  try {
    return await resolveCommand("openclaw");
  } catch {
    if (existsSync(LOCAL_OPENCLAW_ENTRY)) {
      return { file: process.execPath, prefixArgs: [LOCAL_OPENCLAW_ENTRY], via: "npm-shim" };
    }
    throw Object.assign(new Error("openclaw executable not found on PATH or local source"), {
      code: "not_installed",
    });
  }
}

export class OpenclawAdapter implements ExecutorAdapter {
  readonly id = "openclaw";
  readonly displayName = "OpenClaw";
  readonly glyph = "O";
  readonly tuiCommand = "openclaw";

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
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  /** 动态对齐/刷新模型清单：实时调用 `openclaw models list` */
  async syncModels(): Promise<readonly ExecutorModelInfo[]> {
    try {
      const cmd = await resolveOpenclawCommand();
      const stdout = await execLines(cmd, ["models", "list"], 30000);
      if (!stdout || stdout.trim() === "") return this.models;

      const list: ExecutorModelInfo[] = [];
      const lines = stdout.split(/\r?\n/);
      let started = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("Model") && trimmed.includes("Input")) {
          started = true;
          continue;
        }
        if (!started) continue;

        const parts = trimmed.split(/\s{2,}/);
        if (parts.length >= 2) {
          const modelId = parts[0]?.trim();
          const inputType = parts[1]?.trim() ?? "";
          const ctxStr = parts[2]?.trim() ?? "";

          if (modelId && !modelId.includes(" ")) {
            let contextWindow = 200_000;
            if (ctxStr.endsWith("k") || ctxStr.endsWith("K")) {
              contextWindow = parseInt(ctxStr, 10) * 1000;
            } else if (ctxStr.endsWith("m") || ctxStr.endsWith("M")) {
              contextWindow = parseInt(ctxStr, 10) * 1_000_000;
            }

            const name = modelId.split("/").pop() ?? modelId;
            list.push({
              id: modelId as ModelId,
              displayName: name,
              contextWindow,
              multimodal: inputType.includes("image"),
            });
          }
        }
      }

      if (list.length > 0) {
        this.dynamicModels = list;
        log.info("openclaw models synced dynamically", { count: list.length });
        return list;
      }
    } catch (err: unknown) {
      log.debug("openclaw models list failed, using fallback models", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.models;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveOpenclawCommand();
      const versionOut = await execLines(cmd, ["--version"], 10000).catch(() =>
        execLines(cmd, ["-V"], 10000),
      );
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
                hint: "未在 PATH 中找到 openclaw CLI（可在终端运行 npm i -g openclaw 或检查 C:\\Users\\chenziyu\\project\\Agent\\openclaw）",
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
      log.error("openclaw initial turn failed", {
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
        log.warn("resolvePermission called on openclaw");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveOpenclawCommand();

    // 优先走 `openclaw agent -m ... --json`
    const args = ["agent", "-m", prompt, "--json"];
    if (state.cliSessionId !== null) {
      args.push("--session-id", state.cliSessionId);
    }
    if (state.model !== null) {
      args.push("--model", state.model);
    }
    if (state.reasoningLevel !== undefined && state.reasoningLevel !== "") {
      args.push("--thinking", state.reasoningLevel);
    }

    const collectedStdout: string[] = [];
    const messageId = `msg_${Date.now()}`;

    state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "running" });

    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => {
        collectedStdout.push(line);
      },
      onStderrLine: (line) => log.debug("openclaw stderr", { line: line.slice(0, 200) }),
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

    const fullText = collectedStdout.join("\n").trim();

    // 检查是否因为网关未运行而失败，若是则降级为 `agent exec`
    if (exitCode !== 0 && (fullText.includes("A Gateway is running") || fullText.includes("failed to connect") || fullText.includes("ECONNREFUSED"))) {
      log.info("openclaw agent returned gateway error, attempting local agent exec fallback");
      await this.spawnTurnExecFallback(state, prompt, messageId);
      return;
    }

    this.processResponse(state, messageId, fullText, exitCode);
  }

  /** 本地独立执行降级：`openclaw agent exec <prompt> --json --cwd <rootPath>` */
  private async spawnTurnExecFallback(
    state: SessionState,
    prompt: string,
    messageId: string,
  ): Promise<void> {
    const cmd = await resolveOpenclawCommand();
    const args = ["agent", "exec", prompt, "--json", "--cwd", state.rootPath];
    if (state.model !== null) {
      args.push("--model", state.model);
    }
    if (state.reasoningLevel !== undefined && state.reasoningLevel !== "") {
      args.push("--thinking", state.reasoningLevel);
    }

    const collectedStdout: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => {
        collectedStdout.push(line);
      },
      onStderrLine: (line) => log.debug("openclaw agent exec stderr", { line: line.slice(0, 200) }),
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

    this.processResponse(state, messageId, collectedStdout.join("\n").trim(), exitCode);
  }

  private processResponse(
    state: SessionState,
    messageId: string,
    rawOutput: string,
    exitCode: number | null,
  ): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    // 提取可能的 JSON 块
    let parsed: OpenClawResponse | null = null;
    const jsonStart = rawOutput.indexOf("{");
    const jsonEnd = rawOutput.lastIndexOf("}");

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(rawOutput.slice(jsonStart, jsonEnd + 1)) as OpenClawResponse;
      } catch {
        // 解析失败走下文兜底
      }
    }

    if (parsed) {
      const isOk = parsed.ok !== false && parsed.status !== "error";
      const replyPayload = parsed.result?.payloads?.[0]?.text ??
        parsed.result?.finalAssistantVisibleText ??
        parsed.final ??
        "";

      const agentMeta = parsed.result?.meta?.agentMeta;
      const returnedSessionId = agentMeta?.sessionId ?? parsed.sessionId;
      if (returnedSessionId) {
        state.cliSessionId = returnedSessionId;
      }

      if (isOk) {
        if (replyPayload && replyPayload !== "") {
          sink({
            type: "message.delta",
            sessionId,
            messageId,
            role: "assistant",
            text: replyPayload,
          });
        }

        sink({
          type: "message.completed",
          sessionId,
          messageId,
          text: replyPayload,
        });

        const usage = agentMeta?.usage;
        if (usage) {
          state.usageCount += 1;
          sink({
            type: "usage",
            sessionId,
            model: (agentMeta?.model ?? state.model ?? "openclaw-default") as ModelId,
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead,
            costUsd: usage.cost?.total ?? 0,
          });
        }

        sink({ type: "session.status", sessionId, status: "idle" });
        return;
      }

      const errMsg = parsed.error?.message ?? "OpenClaw agent reported an error";
      sink({ type: "error", sessionId, message: errMsg, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed_executor" });
      return;
    }

    // 非 JSON 输出或直接文本
    if (exitCode === 0 && rawOutput !== "") {
      sink({
        type: "message.delta",
        sessionId,
        messageId,
        role: "assistant",
        text: rawOutput,
      });
      sink({
        type: "message.completed",
        sessionId,
        messageId,
        text: rawOutput,
      });
      sink({ type: "session.status", sessionId, status: "idle" });
      return;
    }

    sink({
      type: "error",
      sessionId,
      message: rawOutput !== "" ? rawOutput : `openclaw process exited with code ${exitCode}`,
      recoverable: false,
    });
    sink({ type: "session.status", sessionId, status: "failed_executor" });
  }
}
