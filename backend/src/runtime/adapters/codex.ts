/**
 * Codex 执行器适配器 —— 走 `codex exec --json`（JSONL 事件流）+ `exec resume` 多轮。
 *
 * 协议事实（codex-cli 0.156.1 实测）：
 * - stdout 逐行 JSON 事件：thread.started{thread_id} / turn.started /
 *   item.started{item} / item.completed{item} / turn.completed{usage} / turn.failed
 * - item.type：agent_message{text} / command_execution{command,aggregated_output,exit_code,status}
 *   / reasoning{text} / error{message} / file_change{changes[{path,kind}]}
 * - usage：{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
 *   reasoning_output_tokens} —— 计费口径按契约（对齐 dsh）：
 *   billedInput = uncached + cacheRead + cacheWrite = input_tokens + cache_write_input_tokens
 * - 多轮：`codex exec resume <thread_id> --json …`（会话事实源在 CLI 侧落盘）
 * - 审批在 exec 模式恒为 never；沙箱用 -s 控制（映射 StartRequest.mode）
 * - 认证走 ~/.codex（本机 provider=custom，模型 gpt-6-astra 实测可用）
 *
 * 与 zcode -p 路径同为「每轮一个进程」，但这家有真工具事件与多 item 流——
 * 契约泛化性的第二块试金石（新增执行器 = 本文件 + host 注册一行，core 不改）。
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

interface CliItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: readonly { path?: string; kind?: string }[];
}

interface CliEvent {
  type?: string;
  thread_id?: string;
  item?: CliItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
}

interface SessionState {
  /** daemon 发的稳定 id（对外唯一事实） */
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** CLI thread id（exec resume 用），首轮才有 */
  threadId: string | null;
  sink: AdapterSink | null;
  running: boolean;
  cancelled: boolean;
  child: ChildProcess | null;
  /** 本轮已收到的 message 数（turn.completed 时补 message.completed 用） */
  turnTexts: string[];
  /** 本轮 loop 参数（reasoning / 采样），send 时可覆盖 */
  loop: { reasoningLevel?: string; sampling?: { temperature?: number; topP?: number } };
}

export class CodexAdapter implements ExecutorAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly glyph = "C";
  readonly models: readonly ExecutorModelInfo[] = [
    { id: "gpt-6-astra" as ModelId, displayName: "GPT-6 Astra" },
    { id: "gpt-5-1-codex" as ModelId, displayName: "GPT-5.1 Codex" },
  ];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false, // file_change 有 path+kind 无 patch，先不给 diff 能力
    terminal: false,
    permissions: false, // exec 模式审批恒为 never
    subagents: false,
    worktrees: true, // 原生 --worktree
    sandbox: true, // 原生 -s read-only / workspace-write / danger-full-access
    mcp: true,
    usage: true,
    multimodal: true,
  };

  private readonly sessions = new Map<string, SessionState>();

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("codex");
      const out = await execLines(cmd, ["--version"], 15000);
      return {
        state: { status: "ready", version: out.trim() || "unknown" },
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
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      threadId: null,
      sink,
      running: false,
      cancelled: false,
      child: null,
      turnTexts: [],
      loop: {
        reasoningLevel: req.reasoningLevel,
        sampling: req.sampling,
      },
    };
    this.sessions.set(state.sessionId, state);

    const impl: AdapterSession = {
      id: state.sessionId,
      send: async (text: string, loop?) => {
        if (loop !== undefined) {
          if (loop.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
          if (loop.sampling !== undefined) state.loop.sampling = loop.sampling;
        }
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on codex exec session (approvals are never)");
      },
      externalRef: () => state.threadId,
    };
    return impl;
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      threadId: ref,
      sink,
      running: false,
      cancelled: false,
      child: null,
      turnTexts: [],
      loop: {},
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string) => {
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on codex exec session (approvals are never)");
      },
      externalRef: () => state.threadId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  // ---- turn 执行 ----

  /** mode → codex 沙箱档。yolo 给 workspace-write（agent 要能动工作区），plan 只读。 */
  private sandboxFor(mode: StartRequest["mode"]): "read-only" | "workspace-write" {
    return mode === "plan" ? "read-only" : "workspace-write";
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    const cmd = await resolveCommand("codex");
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", this.sandboxFor("yolo"), "--cd", state.rootPath];
    const loop = state.loop;
    if (loop.reasoningLevel !== undefined) {
      // zcode 的 max 档映射到 codex 的 high；未知值原样透传（codex 会警告并忽略）
      const effort = loop.reasoningLevel === "max" ? "high" : loop.reasoningLevel;
      args.push("-c", `model_reasoning_effort="${effort}"`);
    }
    if (loop.sampling?.temperature !== undefined) args.push("-c", `model_temperature=${loop.sampling.temperature}`);
    if (loop.sampling?.topP !== undefined) args.push("-c", `model_top_p=${loop.sampling.topP}`);
    if (state.threadId !== null) args.push("resume", state.threadId);
    args.push(prompt);

    const lines: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => lines.push(line),
      onStderrLine: (line) => log.debug("codex exec stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;
    state.running = true;
    state.turnTexts = [];

    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    state.child = null;
    state.running = false;

    if (lines.length === 0) {
      if (!state.cancelled) {
        state.sink?.({ type: "error", sessionId: state.sessionId, message: `codex exec produced no events (exit ${exitCode})`, recoverable: false });
      }
      // agent loop 语义：会话线程仍在（exec resume 可续），不发 ended
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: state.cancelled ? "idle" : "failed" });
      return;
    }
    this.emitEvents(state, lines);
  }

  // ---- JSONL → RuntimeEvent ----

  private emitEvents(state: SessionState, lines: readonly string[]): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    let turnUsage: CliEvent["usage"] | undefined;
    let failed: string | null = null;

    for (const line of lines) {
      let ev: CliEvent;
      try {
        ev = JSON.parse(line) as CliEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case "thread.started": {
          if (ev.thread_id !== undefined) state.threadId = ev.thread_id;
          break;
        }
        case "item.started": {
          const item = ev.item ?? {};
          if (item.type === "command_execution") {
            sink({
              type: "tool.started",
              sessionId,
              callId: item.id ?? `call_${Date.now()}`,
              toolName: "shell",
              title: item.command ?? "shell",
              input: { command: item.command },
            });
          }
          break;
        }
        case "item.completed": {
          const item = ev.item ?? {};
          if (item.type === "agent_message") {
            const text = item.text ?? "";
            if (text !== "") {
              sink({ type: "message.delta", sessionId, messageId: item.id ?? `msg_${Date.now()}`, role: "assistant", text });
              sink({ type: "message.completed", sessionId, messageId: item.id ?? `msg_${Date.now()}`, text });
              state.turnTexts.push(text);
            }
          } else if (item.type === "command_execution") {
            sink({
              type: "tool.completed",
              sessionId,
              callId: item.id ?? `call_${Date.now()}`,
              ok: item.exit_code === 0 || item.status === "completed",
              output: item.aggregated_output ?? item.status ?? "",
            });
          } else if (item.type === "reasoning") {
            const text = item.text ?? "";
            if (text !== "") {
              sink({ type: "reasoning.delta", sessionId, messageId: item.id ?? `r_${Date.now()}`, text });
            }
          } else if (item.type === "file_change") {
            for (const ch of item.changes ?? []) {
              if (ch.path === undefined) continue;
              const change = ch.kind === "add" ? "created" : ch.kind === "delete" ? "deleted" : "modified";
              sink({ type: "file.changed", sessionId, path: ch.path, change });
            }
          } else if (item.type === "error") {
            // 配置告警之类也走 error item；recoverable 由 turn 结局决定，先给 true
            sink({ type: "error", sessionId, message: item.message ?? "item error", recoverable: true });
          }
          break;
        }
        case "turn.completed": {
          turnUsage = ev.usage;
          break;
        }
        case "turn.failed": {
          failed = ev.error?.message ?? "turn failed";
          break;
        }
        default:
          break;
      }
    }

    if (turnUsage !== undefined) {
      const billedInput = (turnUsage.input_tokens ?? 0) + (turnUsage.cache_write_input_tokens ?? 0);
      sink({
        type: "usage",
        sessionId,
        inputTokens: billedInput,
        outputTokens: turnUsage.output_tokens ?? 0,
        cacheReadTokens: turnUsage.cached_input_tokens,
        cacheWriteTokens: turnUsage.cache_write_input_tokens,
        costUsd: 0, // 美元由 Phase 6 价目表统一估算
        model: "codex-default",
        decodeMs: undefined,
      });
    }

    if (failed !== null) {
      sink({ type: "error", sessionId, message: failed, recoverable: false });
      // agent loop 语义：turn 失败 ≠ 会话结束（exec resume 可续聊）
      sink({ type: "session.status", sessionId, status: "failed" });
    } else {
      sink({ type: "session.status", sessionId, status: "idle" });
    }
  }
}
