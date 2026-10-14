/**
 * Claude Code 执行器适配器 —— **官方 Agent SDK 常驻形态**（docs/13 Phase 4 Tier 2）。
 *
 * 升级要点（原 `claude -p --output-format stream-json` 每轮一进程形态退役）：
 * - `query({ prompt: AsyncIterable<SDKUserMessage>, options })` 流式输入：一个会话
 *   一个常驻 CLI 子进程，多轮同进程续聊（上下文不重放），`interrupt()` 真取消
 * - `canUseTool` 回调 → permission.requested（统一权限闸）：headless 也有真审批面了
 *   （原 -p default 档写工具直接被拒）；resolvePermission → allow/deny 回执
 * - resume：options.resume 按原生 sessionId 接续（reattach 用）
 * - result 消息带 total_cost_usd 真实成本（网关计费），usage 原样上报
 * - 认证走本机 ~/.claude（SDK spawn 的 CLI 自己处理，daemon 透明）
 *
 * SDK 版本面（@anthropic-ai/claude-agent-sdk 0.3.x）：
 * - SDKPartialAssistantMessage（stream_event，includePartialMessages 开）→ 真 token delta
 * - SDKAssistantMessage（完整块：text/thinking/tool_use）→ message/tool 事件
 * - SDKUserMessageReplay（工具结果回放）→ tool.completed
 * - SDKResultMessage（turn 终态：result/is_error/total_cost_usd/usage/session_id）
 */

import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- SDK 消息宽松视图（顶层判别用 SDK 类型，字段按宽容记录取） -------------------

interface SdkBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface SdkMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  replay?: boolean;
  parent_tool_use_id?: string | null;
  message?: { content?: SdkBlock[] | string };
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, number | undefined>;
  /** system/local_command_output 的输出正文 */
  content?: string;
  /** system/commands_changed 推送的最新命令清单 */
  commands?: readonly SdkSlashCommand[];
  /** system/informational 的渲染级别（info 只进 transcript，不上时间线） */
  level?: string;
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly mode: StartRequest["mode"];
  /** claude 原生会话 id（system init / result 给出；reattach 与 cli_ref 用） */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  /** 常驻 query（首个 send 时创建；进程与轮次共存亡） */
  q: Query | null;
  /** 流式输入队列：send() 推入，async iterator 消费 */
  queue: SDKUserMessage[];
  notify: (() => void) | null;
  /** canUseTool 挂起中的审批：requestId → resolve */
  approvals: Map<string, (allow: boolean) => void>;
  approvalSeq: number;
  loop: { reasoningLevel?: string; model?: string | null };
  usageCount: number;
  closed: boolean;
}

function modeToPermission(mode: StartRequest["mode"]): Options["permissionMode"] {
  if (mode === "yolo") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "plan") return "plan";
  return "default";
}

// ---- 原生斜杠命令（supportedCommands）----------------------------------------

/**
 * SDK 的 slash 命令清单里混着一类「UX 绑死在本地终端」的命令（SDK 文档原文：
 * terminal_slash_commands —— exit / statusline 这类）。Web 端执行它们没有意义
 * （/exit 甚至会杀掉常驻会话），菜单里直接隐藏。保守起见只藏确定终端绑定的这几个。
 */
const TERMINAL_BOUND_COMMANDS = new Set(["exit", "statusline", "terminal-setup", "vim", "ide"]);

/** SDK SlashCommand 的宽松视图（supportedCommands / commands_changed 共用） */
interface SdkSlashCommand {
  name?: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

function toNativeCommands(list: readonly SdkSlashCommand[]): readonly NativeCommandInfo[] {
  const out: NativeCommandInfo[] = [];
  for (const c of list) {
    if (typeof c.name !== "string" || c.name === "" || TERMINAL_BOUND_COMMANDS.has(c.name)) continue;
    out.push({
      name: c.name,
      description: c.description || undefined,
      argumentHint: c.argumentHint || undefined,
      aliases: Array.isArray(c.aliases) && c.aliases.length > 0 ? c.aliases.filter((a) => typeof a === "string") : undefined,
      builtin: c.builtin === true ? true : undefined,
      source: c.builtin === true ? "builtin" : undefined,
    });
  }
  return out;
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly glyph = "C";
  readonly models: readonly ExecutorModelInfo[] = [
    {
      id: "sonnet" as ModelId,
      displayName: "Sonnet（网关别名）",
      contextWindow: 200000,
      reasoningLevels: ["low", "medium", "high", "max"],
      multimodal: true,
    },
    { id: "opus" as ModelId, displayName: "Opus（网关别名）", contextWindow: 200000, multimodal: true },
    { id: "haiku" as ModelId, displayName: "Haiku（网关别名）", contextWindow: 200000, multimodal: false },
  ];

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    // canUseTool 回调：headless 也有真反向审批流（Tier 2 升级的核心收益）
    permissions: true,
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime", // SDKPartialAssistantMessage 真 token 流
    steering: "mid-turn", // 流式输入模式：turn 进行中可继续入队
  };

  private readonly sessions = new Map<string, SessionState>();

  /** 原生命令缓存：rootPath → { 命令清单, 拉取时间 }。TTL 内菜单直接命中。 */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();
  /** listCommands 在途去重（菜单抖动/多视图并发打开时只拉一次） */
  private readonly commandFetches = new Map<string, Promise<readonly NativeCommandInfo[]>>();
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * 原生斜杠命令清单 —— 起一个**临时 query**（输入迭代器永远不给消息，
   * CLI 只完成 initialize 握手后干等输入），调 `supportedCommands()` 拿全量
   * （内置 + ~/.claude/commands + <root>/.claude/commands + 插件），拿完即收。
   *
   * 这是 SDK 官方的命令发现面（IDE 客户端同款用法）：清单是 CLI 自己算的，
   * 工作台不维护静态表 —— 新装插件/新加项目命令自动出现（commands_changed
   * 事件还会热刷新缓存，见 onMessage）。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < ClaudeAdapter.COMMAND_TTL_MS) return hit.commands;

    const inflight = this.commandFetches.get(rootPath);
    if (inflight !== undefined) return inflight;

    const fetch = this.fetchCommandsUncached(rootPath)
      .then((commands) => {
        this.commandCache.set(rootPath, { commands, at: Date.now() });
        return commands;
      })
      .finally(() => {
        this.commandFetches.delete(rootPath);
      });
    this.commandFetches.set(rootPath, fetch);
    return fetch;
  }

  /** 临时 query 实现：阻塞输入 → supportedCommands → 关输入收尾。失败返回 []（UI 回落本地命令）。 */
  private async fetchCommandsUncached(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    // 闭包里赋值、外部读 —— 用持有对象，别跟 TS 的控制流收窄较劲
    const gate: { release: (() => void) | null } = { release: null };
    const input: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              gate.release = () => {
                gate.release = null;
                resolve({ value: undefined, done: true });
              };
            }),
        };
      },
    };

    /**
     * 硬超时兜底：supportedCommands 没有自己的超时，CLI 卡在握手/更新/信任
     * 流程时这个 await 会永远悬着 —— RPC 跟着超时，前端菜单转圈到天荒地老。
     * 超时即收尾返回空清单（菜单如实显示「拉取失败」，下次打开重试）。
     */
    const HARD_TIMEOUT_MS = 20_000;

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const q = query({ prompt: input, options: { cwd: rootPath } });
      // 后台排空消息流（不迭代的话 CLI 侧输出堆着；这里只在乎 control 请求）
      const drain = (async () => {
        try {
          for await (const _ of q) void _;
        } catch {
          /* 收尾阶段的中断/退出噪声不算错 */
        }
      })();
      void drain;

      const list = await Promise.race([
        q.supportedCommands(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), HARD_TIMEOUT_MS).unref?.()),
      ]);
      if (list === null) {
        log.warn("claude supportedCommands 超时，返回空清单", { rootPath, ms: HARD_TIMEOUT_MS });
        // interrupt 让还活着的 CLI 子进程尽快退出，别泄漏 260MB 的进程
        void q.interrupt().catch(() => undefined);
        return [];
      }
      return toNativeCommands(Array.isArray(list) ? (list as readonly SdkSlashCommand[]) : []);
    } catch (err: unknown) {
      log.warn("claude supportedCommands failed", { rootPath, error: err instanceof Error ? err.message : String(err) });
      return [];
    } finally {
      gate.release?.();
    }
  }

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
      q: null,
      queue: [],
      notify: null,
      approvals: new Map(),
      approvalSeq: 0,
      loop: { reasoningLevel: req.reasoningLevel, model: req.model ?? null },
      usageCount: 0,
      closed: false,
    };
    this.sessions.set(state.sessionId, state);
    return this.sessionImpl(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      cliSessionId: ref,
      sink,
      q: null,
      queue: [],
      notify: null,
      approvals: new Map(),
      approvalSeq: 0,
      loop: {},
      usageCount: 0,
      closed: false,
    };
    this.sessions.set(sessionId, state);
    return this.sessionImpl(state);
  }

  private sessionImpl(state: SessionState): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
        state.queue.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        });
        state.notify?.();
        // 首条消息启动常驻 query（同进程多轮，此后 send 只入队）
        if (state.q === null && !state.closed) void this.runQuery(state);
      },
      cancel: async () => {
        try {
          await state.q?.interrupt();
        } catch (err: unknown) {
          log.debug("claude interrupt 被拒", { error: err instanceof Error ? err.message : String(err) });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
        }
      },
      resolvePermission: async (requestId: string, decision: "allow" | "deny" | "always") => {
        const resolve = state.approvals.get(requestId);
        if (resolve !== undefined) {
          state.approvals.delete(requestId);
          resolve(decision !== "deny");
          state.sink?.({
            type: "permission.resolved",
            sessionId: state.sessionId,
            requestId,
            decision: decision === "always" ? "allow" : decision,
          });
        }
      },
      externalRef: () => state.cliSessionId,
    };
  }

  async disconnect(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.closed = true;
      s.notify?.(); // 唤醒输入迭代器让它自然结束
    }
    this.sessions.clear();
  }

  // ---- 常驻 query：输入迭代器 + 消息翻译 ---------------------------------------

  private async runQuery(state: SessionState): Promise<void> {
    const input: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<SDKUserMessage>> =>
            new Promise((resolve) => {
              const first = state.queue.shift();
              if (first !== undefined) return resolve({ value: first, done: false });
              if (state.closed) return resolve({ value: undefined, done: true });
              state.notify = () => {
                const msg = state.queue.shift();
                if (msg !== undefined) resolve({ value: msg, done: false });
                else if (state.closed) resolve({ value: undefined, done: true });
              };
            }),
        };
      },
    };

    const options: Options = {
      cwd: state.rootPath,
      permissionMode: modeToPermission(state.mode),
      includePartialMessages: true,
      canUseTool: (toolName, input_, { signal }) =>
        new Promise((resolve) => {
          const requestId = `claude:${++state.approvalSeq}`;
          const kind = /write|edit/i.test(toolName) ? "file_write" : /bash|exec/i.test(toolName) ? "shell" : "tool";
          state.approvals.set(requestId, (allow) => {
            resolve(
              allow
                ? { behavior: "allow", updatedInput: input_ as Record<string, unknown> }
                : { behavior: "deny", message: "用户在 workbench 权限闸拒绝了这次调用" },
            );
          });
          state.sink?.({
            type: "permission.requested",
            sessionId: state.sessionId,
            requestId,
            kind,
            detail: `${toolName} ${JSON.stringify(input_).slice(0, 260)}`,
            risk: kind === "file_write" ? "medium" : "high",
          });
          // SDK 中止（interrupt/断连）时清挂起审批
          signal.addEventListener("abort", () => {
            if (state.approvals.delete(requestId)) resolve({ behavior: "deny", message: "aborted" });
          });
        }),
      ...(state.loop.model ? { model: state.loop.model } : {}),
      ...(state.cliSessionId !== null ? { resume: state.cliSessionId } : {}),
    };

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const q = query({ prompt: input, options });
      state.q = q;
      for await (const raw of q) {
        if (state.closed) break;
        this.onMessage(state, raw as unknown as SdkMsg);
      }
    } catch (err: unknown) {
      if (!state.closed) {
        state.sink?.({
          type: "error",
          sessionId: state.sessionId,
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        });
        state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
      }
    } finally {
      state.q = null;
      // 拒掉所有挂起审批（query 结束后 canUseTool 的 Promise 不该再悬着）
      for (const [, resolve] of state.approvals) resolve(false);
      state.approvals.clear();
    }
  }

  private onMessage(state: SessionState, m: SdkMsg): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    switch (m.type) {
      case "system": {
        if (typeof m.session_id === "string") state.cliSessionId = m.session_id;
        // 原生命令面的两类 system 子消息：
        // - local_command_output：/usage /memory /doctor 这类**本地命令**的输出
        //   （不经过模型循环，TUI 里直接打印）→ 翻成 assistant 消息进时间线。
        //   不翻的话 Web 端发 /usage 就像石沉大海 —— 这正是「TUI 与 Web 天差地别」的主因之一。
        // - commands_changed：CLI 主动推送最新命令清单（新装插件/技能动态发现）→ 热刷新缓存。
        if (m.subtype === "local_command_output" && typeof m.content === "string" && m.content !== "") {
          sink({
            type: "message.completed",
            sessionId,
            messageId: `local_${Date.now()}`,
            text: m.content,
          });
        } else if (m.subtype === "informational" && typeof m.content === "string" && m.content !== "" && m.level !== "info") {
          // 横幅（Hook 拦截理由 / slash 命令状态行）：notice 起步才值得占时间线
          sink({
            type: "message.completed",
            sessionId,
            messageId: `banner_${Date.now()}`,
            text: m.content,
          });
        } else if (m.subtype === "commands_changed" && Array.isArray(m.commands)) {
          this.commandCache.set(state.rootPath, {
            commands: toNativeCommands(m.commands as readonly SdkSlashCommand[]),
            at: Date.now(),
          });
        }
        break;
      }
      case "stream_event": {
        // includePartialMessages：text_delta / thinking_delta 真流式
        const delta = m.event?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          const messageId = `msg_${state.sessionId.slice(5, 13)}`;
          sink({ type: "message.delta", sessionId, messageId, role: "assistant", text: delta.text });
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
          sink({ type: "reasoning.delta", sessionId, messageId: `think_${Date.now()}`, text: delta.thinking });
        }
        break;
      }
      case "assistant": {
        if (typeof m.session_id === "string" && state.cliSessionId === null) state.cliSessionId = m.session_id;
        const blocks = Array.isArray(m.message?.content) ? (m.message?.content as SdkBlock[]) : [];
        let finalText = "";
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") {
            finalText += b.text;
          } else if (b.type === "tool_use") {
            sink({
              type: "tool.started",
              sessionId,
              callId: b.id ?? `call_${Date.now()}`,
              toolName: b.name ?? "tool",
              title: `${b.name ?? "tool"} ${JSON.stringify(b.input ?? {}).slice(0, 80)}`,
              input: (b.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        if (finalText !== "") {
          // delta 已流式发过（SDK 不给流与块的稳定 id 对齐），completed 用完整文本收口
          const messageId = `msg_${state.sessionId.slice(5, 13)}`;
          sink({ type: "message.completed", sessionId, messageId, text: finalText });
        }
        break;
      }
      case "user": {
        // 工具结果回放（replay）→ tool.completed
        if (m.replay !== true) break;
        const blocks = Array.isArray(m.message?.content) ? (m.message?.content as SdkBlock[]) : [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            const text =
              typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .map((x) => (typeof x === "object" && x !== null && "text" in x ? String((x as SdkBlock).text ?? "") : ""))
                      .join("")
                  : "";
            sink({
              type: "tool.completed",
              sessionId,
              callId: b.id ?? `call_${Date.now()}`,
              ok: b.is_error !== true,
              output: text.slice(0, 4000),
            });
          }
        }
        break;
      }
      case "result": {
        if (typeof m.session_id === "string") state.cliSessionId = m.session_id;
        const usage = m.usage ?? {};
        const billedInput = (usage["input_tokens"] ?? 0) + (usage["cache_creation_input_tokens"] ?? 0);
        if (billedInput > 0 || (usage["output_tokens"] ?? 0) > 0) {
          sink({
            type: "usage",
            sessionId,
            // 计费口径对齐契约（dsh）：billedInput = uncached + cacheWrite
            inputTokens: billedInput,
            outputTokens: usage["output_tokens"] ?? 0,
            cacheReadTokens: usage["cache_read_input_tokens"],
            cacheWriteTokens: usage["cache_creation_input_tokens"],
            // total_cost_usd 是网关真实计费，非估算
            costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0,
            model: String(state.loop.model ?? "claude"),
            requestId: `claude:${state.cliSessionId ?? sessionId}:p${process.pid}:${++state.usageCount}`,
          });
        }
        if (m.is_error === true) {
          sink({ type: "error", sessionId, message: m.result ?? "turn failed", recoverable: true });
          sink({ type: "session.status", sessionId, status: "failed" });
        } else {
          // agent loop 语义：turn 完成 ≠ 会话结束（常驻 query 继续可聊）
          sink({ type: "session.status", sessionId, status: "idle" });
        }
        break;
      }
      default:
        break; // status/notification 等辅助消息不进事件流
    }
  }
}
