/**
 * ZCode 执行器适配器 —— 走 `zcode -p <prompt> --json`（headless 单轮）+ `--resume` 多轮。
 *
 * 为什么不是 `zcode app-server`（ZCode Protocol NDJSON）：协议本身已探明可用
 * （握手免费、事件流完整、权限反向请求齐备，第一版适配器已跑通到 turn 层），
 * 但 standalone 模式的 Provider Registry 需要 `zcode login` 写入的
 * `account-provider:*` 凭据体系（读 ZCode Built-in 配置 + credential store 私有键）；
 * 本机的桌面端 oauth 登录（`oauth:bigmodel:access_token`）喂不饱它 ——
 * `session/create` 永远得到空模型目录（settings.model.available=[]），
 * turn 无法开始（"Select a model before continuing"）。
 * 实证：空 registry 等 60s 不自行装填；glm/zai/bigmodel 三个 providerId 全部
 * "Provider Registry 中不存在 Model"。桌面端是进程内推送 updateAccountConfig 的，
 * daemon 拿不到等价凭据快照。若未来 CLI 支持独立凭据（或用户跑 zcode login），
 * 恢复 app-server 客户端即可拿到真流式 delta 与权限反向流。
 *
 * -p 路径的能力边界（诚实声明）：
 * - 无流式 delta：整段回复在终态 JSON 里，翻译为单个 message.delta + completed；
 * - 无工具事件：response 只有最终文本（yolo 模式下工具确实在跑，但过程不可见）；
 * - 无权限反向流：-p 默认 yolo，权限闸对 zcode 执行器 capability 声明为 false；
 * - usage 是真的：终态 JSON 带 provider 侧 token 计数。
 * - 会话 id 是 daemon 发的稳定 id（sess_ 前缀）；CLI 的原生 id 存 cliSessionId，
 *   仅用于 --resume 续聊，不对外。
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

// ---- CLI 终态 JSON（宽松类型） ----------------------------------------------

interface CliTurnResult {
  sessionId?: string;
  traceId?: string;
  turnId?: string;
  response?: string;
  is_error?: boolean;
  result?: string;
  terminal_reason?: string;
  duration_ms?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}

// ---- 每会话状态 ------------------------------------------------------------

interface SessionState {
  /** daemon 发的稳定 id，所有对外事件只用它 */
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** CLI 的原生会话 id（--resume 用），首轮结束才有 */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  running: boolean;
  /** cancel() 置位：进程死且无终态 JSON 时 ended 用 cancelled 而不是 error */
  cancelled: boolean;
  child: ChildProcess | null;
}

export class ZcodeAdapter implements ExecutorAdapter {
  readonly id = "zcode";
  readonly displayName = "ZCode";
  readonly glyph = "Z";
  readonly models: readonly ExecutorModelInfo[] = [
    { id: "glm-5.3" as ModelId, displayName: "GLM-5.3" },
    { id: "glm-5-turbo" as ModelId, displayName: "GLM-5 Turbo" },
  ];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: false, // -p 路径 yolo 单轮，无反向权限流（见头部说明）
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
  };

  private readonly sessions = new Map<string, SessionState>();

  // ---- SPI ----

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("zcode");
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
      cliSessionId: null,
      sink,
      running: false,
      cancelled: false,
      child: null,
    };
    this.sessions.set(state.sessionId, state);
    if (req.model !== null) {
      log.warn("zcode -p path cannot select a model; using CLI default", { model: req.model });
    }

    const impl: AdapterSession = {
      id: state.sessionId,
      send: async (text: string) => {
        // 首轮（cliSessionId 还是 null）自然不带 --resume，多轮由 CLI 侧持久化续接
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        // capabilities.permissions=false，永远不该被调到
        log.warn("resolvePermission called on zcode -p session (no permission stream)");
      },
    };
    return impl;
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  // ---- turn 执行 ----

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    const resumeId = state.cliSessionId;
    const cmd = await resolveCommand("zcode");
    const args = ["-p", prompt, "--json", "--cwd", state.rootPath];
    if (resumeId !== null) args.push("--resume", resumeId);

    const stdout: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => stdout.push(line),
      onStderrLine: (line) => log.debug("zcode -p stderr", { line: line.slice(0, 200) }),
      // 不在 exit 回调里收尾：正常路径在 await exit 之后统一处理，
      // 否则两条路径都会发 session.ended（双重 ended，冒烟已抓到过）
    });
    state.child = child;
    state.running = true;

    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    state.child = null;
    state.running = false;

    const parsed = this.parseTurnOutput(stdout.join("\n"));
    if (parsed === null) {
      const reason = state.cancelled ? "cancelled" : "error";
      if (!state.cancelled) {
        state.sink?.({ type: "error", sessionId: state.sessionId, message: `zcode -p produced no JSON (exit ${exitCode})`, recoverable: false });
      }
      state.sink?.({ type: "session.ended", sessionId: state.sessionId, reason });
      return;
    }
    if (parsed.sessionId !== undefined) state.cliSessionId = parsed.sessionId;
    this.emitTurn(state, parsed);
  }

  // ---- 终态 JSON → RuntimeEvent ----

  private parseTurnOutput(raw: string): CliTurnResult | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    // CLI 输出可能带非 JSON 前后缀，取第一个 { 起的整段尝试解析
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as CliTurnResult;
    } catch {
      return null;
    }
  }

  private emitTurn(state: SessionState, r: CliTurnResult): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    const messageId = r.turnId ?? r.traceId ?? `msg_${Date.now()}`;

    const text = r.response ?? (r.is_error === true ? r.result ?? "" : "");
    // -p 无流式：整段回复作为一个 delta 块（见头部能力边界声明）
    if (text !== "") {
      sink({ type: "message.delta", sessionId, messageId, role: "assistant", text });
      sink({ type: "message.completed", sessionId, messageId, text });
    }

    const u = r.usage;
    if (u !== undefined && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
      sink({
        type: "usage",
        sessionId,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheCreationTokens,
        // Z.AI/bigmodel 套餐按订阅计价；token 是 ground truth，美元由 Phase 6 价目表估
        costUsd: 0,
        model: "zcode-default",
        decodeMs: r.duration_ms,
      });
    }

    if (r.is_error === true) {
      sink({ type: "error", sessionId, message: r.result ?? "turn failed", recoverable: false });
      sink({ type: "session.ended", sessionId, reason: "error" });
    } else {
      sink({ type: "session.ended", sessionId, reason: "completed" });
    }
  }
}
