/**
 * Mock 适配器 —— 原型期唯一的数据源。
 *
 * 它同时扮演两个角色：
 *  1. 让 UI/UX 迭代不依赖任何真实运行时（装没装 Claude Code 都能设计）
 *  2. 演示「能力降级」：六家工具的能力矩阵故意各不相同，
 *     UI 立刻就能看出"某个工具不支持 diff 时该长什么样"
 *
 * 接真实运行时时，替换的是本目录，core/ 与 ui/ 一行不改。
 */

import type {
  AdapterFactory,
  ConnectionState,
  PermissionDecision,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SendMessageRequest,
  StartSessionRequest,
} from "../../core/adapter.ts";
import type { RuntimeEvent } from "../../core/events.ts";
import { modelById, type ModelId } from "../../core/models.ts";
import { asModelId } from "../../core/models.ts";
import {
  asRuntimeId,
  asSessionId,
  asUnitId,
  type RuntimeId,
  type Session,
  type SessionId,
  type WorkUnit,
} from "../../core/units.ts";

// ---------------------------------------------------------------------------
// 六家工具的真实能力画像（按对话中已确认的事实填写）
// ---------------------------------------------------------------------------

interface RuntimeSpec {
  readonly id: string;
  readonly displayName: string;
  readonly vendor: string;
  readonly accent: string;
  readonly glyph: string;
  readonly tagline: string;
  readonly transport: "acp" | "jsonrpc" | "rpc" | "http" | "process" | "internal";
  readonly endpoint: string;
  readonly requiresCwd: boolean;
  readonly capabilities: RuntimeCapabilities;
  /**
   * 这个 CLI 能用哪些模型。
   * 厂商中立与否是**这个 CLI 的事实**，不是我们替它决定的：
   * Claude Code 只接 Anthropic，Codex 只接 OpenAI，OpenCode / pi / ZCode 自己接多家。
   */
  readonly models: readonly ModelId[];
  /** 故意留一个「未安装」样例，让 UI 的错误态也能被设计 */
  readonly installed: boolean;
}

const CAP_ALL: RuntimeCapabilities = {
  resumeSession: true,
  fileDiff: true,
  terminal: true,
  permissions: true,
  subagents: true,
  worktrees: true,
  sandbox: true,
  mcp: true,
  usage: true,
  multimodal: true,
};

const m = (v: string) => asModelId(v);

/** 厂商中立的那几家：三家都接 */
const NEUTRAL_MODELS: readonly ModelId[] = [
  m("claude-opus-5-5"),
  m("claude-sonnet-5"),
  m("claude-haiku-4-5"),
  m("gpt-6-astra"),
  m("gpt-5-1-codex"),
  m("gpt-5-6-luna"),
  m("deepseek-v4-pro"),
  m("deepseek-v4-flash"),
];

const RUNTIME_SPECS: readonly RuntimeSpec[] = [
  {
    id: "zcode",
    displayName: "ZCode",
    vendor: "zocdeusually",
    accent: "#7C6CF5",
    glyph: "Z",
    tagline: "主力执行器 · bot 三件套内置最全",
    transport: "http",
    endpoint: "http://127.0.0.1:7801",
    requiresCwd: true,
    capabilities: CAP_ALL,
    models: NEUTRAL_MODELS,
    installed: true,
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    vendor: "Anthropic",
    accent: "#D97757",
    glyph: "C",
    tagline: "长上下文强 · 子代理成熟",
    transport: "jsonrpc",
    endpoint: "claude",
    requiresCwd: true,
    capabilities: { ...CAP_ALL, multimodal: false, worktrees: false },
    models: [m("claude-opus-5-5"), m("claude-sonnet-5"), m("claude-haiku-4-5")],
    installed: true,
  },
  {
    id: "codex",
    displayName: "Codex",
    vendor: "OpenAI",
    accent: "#10A37F",
    glyph: "O",
    tagline: "沙箱执行 · app-server 协议",
    transport: "jsonrpc",
    endpoint: "codex app-server",
    requiresCwd: true,
    capabilities: { ...CAP_ALL, multimodal: false, subagents: false },
    models: [m("gpt-6-astra"), m("gpt-5-1-codex"), m("gpt-5-6-luna")],
    installed: true,
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    vendor: "sst",
    accent: "#3B82F6",
    glyph: "S",
    tagline: "轻量 · 启动最快",
    transport: "process",
    endpoint: "opencode serve",
    requiresCwd: true,
    capabilities: {
      ...CAP_ALL,
      fileDiff: false,
      permissions: false,
      multimodal: false,
      worktrees: false,
      sandbox: false,
    },
    models: NEUTRAL_MODELS,
    installed: true,
  },
  {
    id: "pi",
    displayName: "pi",
    vendor: "Earendil Works",
    accent: "#A855F7",
    glyph: "P",
    tagline: "RPC 模式 · eval 框架可复用",
    transport: "rpc",
    endpoint: "pi --mode rpc",
    requiresCwd: true,
    capabilities: {
      ...CAP_ALL,
      terminal: false,
      permissions: false,
      multimodal: false,
      worktrees: false,
      sandbox: false,
    },
    models: NEUTRAL_MODELS,
    installed: true,
  },
  {
    id: "dsh",
    displayName: "DeepSeek Harness",
    vendor: "DeepSeek",
    accent: "#4D6BFE",
    glyph: "D",
    tagline: "ACP 原生 · 团队编排原生支持",
    transport: "acp",
    endpoint: "dsh --profile acp",
    requiresCwd: true,
    capabilities: CAP_ALL,
    // ACP 是协议层，与厂商无关：dsh 原生跑 DeepSeek，但挂别的 provider 也行。
    // 这条比 Claude Code / Codex 的单厂商清单宽，体现的正是「同一个 CLI 能选多家」。
    models: [m("deepseek-v4-pro"), m("deepseek-v4-flash"), m("claude-sonnet-5"), m("gpt-5-6-luna")],
    // 故意设为未安装：验证 UI 的「未安装 / 安装引导」态
    installed: false,
  },
];

// ---------------------------------------------------------------------------
// Mock 适配器实现
// ---------------------------------------------------------------------------

class MockAdapter implements RuntimeAdapter {
  readonly id: RuntimeId;
  readonly presentation;
  readonly transport;
  readonly capabilities;
  readonly #installed: boolean;
  readonly #queue: RuntimeEvent[] = [];
  /**
   * 未被取走的事件缓冲 + 正在等下一条的那个消费者。
   *
   * ⚠ 这里必须是「缓冲 + 单槽」，不能是「一排等待者」。
   * 旧写法是 `waiters[]` + emit 时 shift 一个：只要 emit 时消费者还没重新
   * 挂上等待（resolve 只把续体排进微任务，不会同步跑），这一条就没了。
   * 后果是**同步连发的事件只有第一条能活下来** —— 一次跑 6 条 file.diff
   * 就只剩 1 条，所有靠事件驱动的页签看起来都像「没数据」。
   *
   * 这也是真实适配器必须守的契约：运行时不能因为 UI 还没调 next() 就丢事件。
   */
  readonly #pending: RuntimeEvent[] = [];
  #waiting: ((e: RuntimeEvent) => void) | null = null;

  constructor(spec: RuntimeSpec) {
    this.id = asRuntimeId(spec.id);
    this.presentation = {
      displayName: spec.displayName,
      vendor: spec.vendor,
      accent: spec.accent,
      glyph: spec.glyph,
      tagline: spec.tagline,
    };
    this.transport = {
      kind: spec.transport,
      endpoint: spec.endpoint,
      requiresCwd: spec.requiresCwd,
    };
    this.capabilities = spec.capabilities;
    this.#installed = spec.installed;
  }

  async probe(): Promise<ProbeResult> {
    const started = performance.now();
    if (PACE_MS > 0) await sleep(PACE_MS);
    const state: ConnectionState = this.#installed
      ? { status: "ready", version: "0.0.0-mock" }
      : { status: "not_installed", hint: `未检测到 ${this.presentation.displayName}，可在此安装或改用其他工具` };
    return {
      state,
      capabilities: this.capabilities,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async listSessions(unit: WorkUnit): Promise<readonly Session[]> {
    await sleep(PACE_MS);
    return [];
  }

  async startSession(req: StartSessionRequest): Promise<Session> {
    await sleep(PACE_MS);
    const session: Session = {
      id: asSessionId(`${this.id}-s${Date.now().toString(36)}`),
      unitId: req.unit.id,
      runtimeId: this.id,
      title: req.prompt.slice(0, 40) || "新会话",
      status: "running",
      startedAt: Date.now(),
      ephemeral: req.unit.kind === "project",
      worktree: req.worktree,
      stats: { messages: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    };
    this.#emit({ type: "session.started", sessionId: session.id, unitId: req.unit.id });
    this.#simulate(session, req);
    return session;
  }

  async resumeSession(sessionId: SessionId): Promise<Session> {
    await sleep(PACE_MS);
    return {
      id: sessionId,
      unitId: asUnitId("unknown"),
      runtimeId: this.id,
      title: "恢复的会话",
      status: "idle",
      startedAt: Date.now(),
      ephemeral: false,
      stats: { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    };
  }

  async sendMessage(_req: SendMessageRequest): Promise<void> {}
  async cancel(_sessionId: SessionId): Promise<void> {}

  async resolvePermission(_s: SessionId, _r: string, _d: PermissionDecision): Promise<void> {}

  async *events(): AsyncIterable<RuntimeEvent> {
    // 挂起等下一条被 #emit 推送的事件；真实适配器在这里做原生协议 → 归一化事件 的翻译。
    // 先看缓冲再挂等待，顺序反了会在「刚好有残留 + 刚好有人等」时卡住。
    while (true) {
      const next =
        this.#pending.length > 0
          ? this.#pending.shift()!
          : await new Promise<RuntimeEvent>((resolve) => {
              this.#waiting = resolve;
            });
      yield next;
    }
  }

  async exportTrace(): Promise<string> {
    return JSON.stringify(this.#queue, null, 2);
  }

  // ---- 内部：造一段可信的假轨迹 ----

  #emit(e: RuntimeEvent): void {
    this.#queue.push(e);
    // 有人在等就直接交给他；没人等就进缓冲，绝不丢
    const w = this.#waiting;
    if (w) {
      this.#waiting = null;
      w(e);
    } else {
      this.#pending.push(e);
    }
  }

  #simulate(session: Session, req: StartSessionRequest): void {
    const id = session.id;
    const unitId = req.unit.id;
    const messageId = `m${Date.now().toString(36)}`;
    const canDiff = this.capabilities.fileDiff;
    // 用户选的模型。回传它，右栏的「模型轨迹」页才看得出换模型的实际差别。
    const model = req.model;

    void (async () => {
      await sleep(PACE_MS);
      this.#emit({ type: "reasoning.delta", sessionId: id, messageId, text: "读取 AGENTS.md…" });
      await sleep(PACE_MS);
      this.#emit({
        type: "message.completed",
        sessionId: id,
        messageId,
        text: `已用 ${this.presentation.displayName} 接手，识别到工作单元「${req.unit.name}」。`,
      });

      // ---- 计划：ZCode 的 plan-detail 页签数据源 ----
      await sleep(PACE_MS);
      this.#emit({
        type: "plan.proposed",
        sessionId: id,
        planId: "plan-1",
        title: "补齐右栏页签与契约自检",
        rationale: "先立契约再渲染，避免边写 UI 边改口径。",
        steps: [
          { id: "s1", title: "core/sidepane.ts 扩到全量页签类型", status: "done" },
          { id: "s2", title: "events.ts 补 plan.* 事件", status: "done" },
          { id: "s3", title: "SidePane 渲染全部页签", status: "in_progress" },
          { id: "s4", title: "自检覆盖全量类型与作用域", status: "pending" },
          { id: "s5", title: "实跑验证 + 零 console 报错", status: "pending" },
        ],
      });
      await sleep(PACE_MS);
      this.#emit({ type: "plan.resolved", sessionId: id, planId: "plan-1", decision: "approved" });
      await sleep(PACE_MS);
      this.#emit({
        type: "plan.step.updated",
        sessionId: id,
        planId: "plan-1",
        stepId: "s4",
        status: "blocked",
      });

      if (this.capabilities.subagents) {
        // ⚠ childId 必须在 await 之前定下来。原先两处各算一次 Date.now()，
        // 中间隔着 await —— 开 pace 时两次必然不同，spawned 与 finished 对不上，
        // 子代理页会永远停在「进行中」。
        const childId = `c1-${Date.now().toString(36)}`;
        await sleep(PACE_MS);
        this.#emit({
          type: "subagent.spawned",
          sessionId: id,
          childId,
          role: "侦察",
          runtimeId: "opencode",
        });
        await sleep(PACE_MS);
        this.#emit({
          type: "subagent.finished",
          sessionId: id,
          childId,
          ok: true,
          summary: "已扫描目录结构，产出 3 条建议",
        });
      }

      if (this.capabilities.permissions) {
        await sleep(PACE_MS);
        this.#emit({
          type: "permission.requested",
          sessionId: id,
          requestId: "p1",
          kind: "file_write",
          detail: "写入 drafts/2026-09-27.md",
          risk: "low",
        });
      }

      await sleep(PACE_MS);
      this.#emit({ type: "tool.started", sessionId: id, callId: "t1", toolName: "Write", title: "写产出文件", input: null });
      await sleep(PACE_MS);
      this.#emit({ type: "tool.completed", sessionId: id, callId: "t1", ok: true, output: "ok" });

      // ---- 后台命令：bash-output 页签的数据源（只认 shell 类工具）----
      await sleep(PACE_MS);
      this.#emit({
        type: "tool.started",
        sessionId: id,
        callId: "t2",
        toolName: "Bash",
        title: "pnpm check:sidepane",
        input: null,
      });
      await sleep(PACE_MS);
      this.#emit({
        type: "tool.completed",
        sessionId: id,
        callId: "t2",
        ok: true,
        output: "通过 32 / 失败 0",
      });

      if (canDiff) {
        await sleep(PACE_MS);
        this.#emit({ type: "file.changed", sessionId: id, path: "src/app.tsx", change: "modified" });
        this.#emit({
          type: "file.diff",
          sessionId: id,
          path: "src/app.tsx",
          additions: 3,
          deletions: 1,
          patch: [
            "@@ -12,7 +12,9 @@ export function App() {",
            "   const [view, setView] = useState<ViewMode>('bot')",
            "+  // bot/项目双视图：ZCode 没有这层，必须保留",
            "+  const owner = useWorkbench((s) => s.activeSessionId)",
            "-  const owner = null",
            "   return (",
            "     <WorkspaceShell view={view} ownerId={owner} />",
          ].join("\n"),
        });

        this.#emit({ type: "file.changed", sessionId: id, path: "src/core/sidepane.ts", change: "created" });
        this.#emit({
          type: "file.diff",
          sessionId: id,
          path: "src/core/sidepane.ts",
          additions: 6,
          deletions: 0,
          patch: [
            "+++ b/src/core/sidepane.ts",
            "@@ -25,9 +25,15 @@",
            "-export type SidePaneTabType = 'files' | 'trace' | 'subagent'",
            "+export type SidePaneTabType =",
            "+  | 'capabilities' | 'deliverables' | 'tools' | 'terminal'",
            "+  | 'git' | 'code-viewer' | 'whiteboard' | 'browser'",
            "+  | 'files' | 'plan' | 'trace' | 'subagent'",
            "+  | 'workflow-run' | 'workflow-directory' | 'workflow-actor'",
          ].join("\n"),
        });

        this.#emit({ type: "file.changed", sessionId: id, path: "docs/00-north-star.md", change: "modified" });
        this.#emit({
          type: "file.diff",
          sessionId: id,
          path: "docs/00-north-star.md",
          additions: 1,
          deletions: 1,
          patch: ["@@ -1,4 +1,4 @@", "-让 agent 更好用", "+让一个人同时带好多个 agent"].join("\n"),
        });
      }

      if (this.capabilities.usage) {
        // 成本按**所选模型**的真实单价折算，不是写死的常数。
        // 否则「换个模型成本纹丝不动」，这个功能就等于没做 ——
        // 用户要的正是「换模型」能看出代价差别。
        const spec = modelById(model);
        // inputTokens 是**本轮重发的上下文表面**（dsh 的 pressureTokens 口径），
        // 所以第二轮比第一轮大 —— 底栏的上下文占用环靠它才会涨。
        const rounds = [
          { inTok: 48_200, outTok: 1_180, cacheRead: 38_400, cacheWrite: 1_200, decodeMs: 4_200 },
          { inTok: 61_400, outTok: 640, cacheRead: 52_000, cacheWrite: 2_400, decodeMs: 1_650 },
        ];
        for (const r of rounds) {
          const cost =
            spec === undefined
              ? 0.031
              : (r.inTok / 1e6) * spec.inputPerMTok + (r.outTok / 1e6) * spec.outputPerMTok;
          await sleep(PACE_MS);
          this.#emit({
            type: "usage",
            sessionId: id,
            inputTokens: r.inTok,
            outputTokens: r.outTok,
            cacheReadTokens: r.cacheRead,
            cacheWriteTokens: r.cacheWrite,
            decodeMs: r.decodeMs,
            costUsd: cost,
            model,
          });
        }
      }

      await sleep(PACE_MS);
      this.#emit({
        type: "deliverable",
        sessionId: id,
        unitId,
        title: "今日产出草稿",
        kind: "file",
        path: "drafts/2026-09-27.md",
      });

      await sleep(PACE_MS);
      this.#emit({ type: "session.ended", sessionId: id, reason: "completed" });
    })();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 事件节奏（毫秒）。
 *
 * 默认 0：原型迭代要的是立刻看到完整时间线，而不是等它慢慢演。
 * 需要做「真实节奏」演示时用 URL 参数打开：?pace=350
 *
 * 注意不要把默认值调大：Electron 的 FilePanel 浏览器标签未聚焦时，
 * Chromium 会对后台标签的嵌套 setTimeout 做节流（>5 层后钳到 1 次/秒），
 * 人为延迟会被无限拉长，看起来像"事件流卡住了"，其实是被浏览器节流。
 */
const PACE_MS = (() => {
  if (typeof location === "undefined") return 0;
  const raw = new URLSearchParams(location.search).get("pace");
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

// ---------------------------------------------------------------------------
// 导出工厂
// ---------------------------------------------------------------------------

export const mockFactories: readonly AdapterFactory[] = RUNTIME_SPECS.map((spec) => ({
  id: asRuntimeId(spec.id),
  presentation: {
    displayName: spec.displayName,
    vendor: spec.vendor,
    accent: spec.accent,
    glyph: spec.glyph,
    tagline: spec.tagline,
  },
  transport: {
    kind: spec.transport,
    endpoint: spec.endpoint,
    requiresCwd: spec.requiresCwd,
  },
  capabilities: spec.capabilities,
  models: spec.models,
  create: async () => new MockAdapter(spec),
}));
