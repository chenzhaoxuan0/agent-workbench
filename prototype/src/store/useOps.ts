import { create } from "zustand";

/**
 * Ops store —— LLM-Ops 支柱（对齐 waku-agent 的 waku/ops + evals/ 目录）。
 *
 * waku 的铁律在这里逐一落地：
 * 1. **两类 eval 永不混合** —— 确定性 eval 是 0/1（“对的工具触发了吗？”，
 *    无模型裁判），judge 是 0–1 打分过阈值（“回复有帮助吗？”，每次都是
 *    真实的一次 LLM 调用）。混淆两者是最常见的 eval 错误。
 * 2. **发布门（make gate）** —— 确定性必须 100% 且 judge 全部过阈值；
 *    每跑一次追加一行历史（eval_runs.jsonl 语义）。
 * 3. **花费是永久的** —— 每次 LLM 调用向 usage 账本追加一行
 *    （usage.jsonl 语义），重置演示不会清掉；美元成本由 token 估算，
 *    token 才是 ground truth。
 * 4. **Arena** —— 同一 prompt 让 N 个模型赛同一条真实链路；Completion
 *    （确定性分）与 Quality（裁判分）刻意分开记。
 *
 * 原型阶段运行是**模拟**的（staged setTimeout），但数据形态、追加只写的
 * 持久化、阈值判定逻辑与真实实现一一对应；接真实运行时时只换执行端。
 */

/* --------------------------------------------------------------- 数据形态 */

/** 确定性 eval 用例 —— waku evals/dataset.jsonl 的行形态 */
export interface DeterministicCase {
  readonly id: string;
  readonly input: string;
  /** 期望触发的工具；null = 期望不调用任何工具 */
  readonly expectTool: string | null;
  /** 期望参数里包含的子串（大小写不敏感） */
  readonly expectInArgs: Readonly<Record<string, string>>;
  /** 最近一次 gate 的结果；undefined = 从未跑过 */
  lastResult?: "pass" | "fail";
}

/** judge 指标 —— DeepEval GEval 的形态：命名指标 + 评分步骤 + 阈值 */
export interface JudgeMetric {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly string[];
  /** 0–1，低于即 gate FAIL */
  readonly threshold: number;
  /** 最近一次得分（0–1）；undefined = 从未跑过 */
  lastScore?: number;
}

/** 一次 gate 的历史行 —— eval_runs.jsonl 语义：追加只写 */
export interface GateRun {
  readonly ts: number;
  readonly detPassed: number;
  readonly detTotal: number;
  readonly judgeAvg: number;
  readonly verdict: "pass" | "fail";
  readonly failReason?: string;
}

/** Arena 选手成绩 —— Completion / Quality 双分刻意分开 */
export interface ArenaContestant {
  readonly runtimeId: string;
  readonly runtimeLabel: string;
  readonly modelId: string;
  readonly modelLabel: string;
  /** 确定性：期望的工具行为发生了吗 */
  readonly completion: "pass" | "fail";
  /** 裁判分 0–1 */
  readonly quality: number;
  readonly latencyMs: number;
  readonly tokensOut: number;
}

export interface ArenaRun {
  readonly id: number;
  readonly ts: number;
  readonly prompt: string;
  readonly contestants: readonly ArenaContestant[];
}

/** usage 账本行 —— usage.jsonl 语义：每次 LLM 调用追加一行 */
export interface UsageEntry {
  readonly id: number;
  readonly ts: number;
  readonly provider: string;
  readonly model: string;
  readonly kind: "chat" | "deterministic" | "judge" | "arena";
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface ArenaCandidate {
  readonly runtimeId: string;
  readonly runtimeLabel: string;
  readonly modelId: string;
  readonly modelLabel: string;
}

/* ------------------------------------------------------- 种子数据（waku 同款） */

const SEED_CASES: readonly DeterministicCase[] = [
  {
    id: "schedule-basic",
    input: "下周二上午 9 点和 Alex 喝咖啡",
    expectTool: "create_event",
    expectInArgs: { title: "alex", start: "T09:00" },
  },
  {
    id: "schedule-applies-memory",
    input: "（已记忆：Alex 偏好早晨）周五和 Alex 约个跟进会",
    expectTool: "create_event",
    expectInArgs: { title: "alex" },
  },
  {
    id: "remember-preference",
    input: "记住 Alex 偏好早晨的会议",
    expectTool: "save_note",
    expectInArgs: { content: "早晨" },
  },
  {
    id: "draft-message",
    input: "给 Alex 发消息：演示改到周五了",
    expectTool: "send_message",
    expectInArgs: { body: "周五" },
  },
  {
    id: "no-tool-general-knowledge",
    input: "法国的首都是哪里？",
    expectTool: null,
    expectInArgs: {},
  },
];

/** 偶发失败用例：让 gate 的 FAIL 态在演示里可见（真实世界的 flaky eval） */
const FLAKY_CASE_ID = "draft-message";

const SEED_METRICS: readonly JudgeMetric[] = [
  {
    id: "helpfulness",
    name: "Helpfulness",
    threshold: 0.6,
    steps: ["回复是否直接回应用户的请求", "是否确认了已执行的动作：做了什么、何时、涉及谁", "是否简洁而友好"],
  },
  {
    id: "memory-use",
    name: "MemoryUse",
    threshold: 0.6,
    steps: ["从检索上下文中找出与输入相关的已记忆事实", "检查回复是否正确使用了这些事实而非忽略它们"],
  },
];

/** 美元成本估算表（$/MTok）。token 是 ground truth，成本只是它的投影 */
const PRICE_PER_MTOK: Readonly<Record<string, { in: number; out: number }>> = {
  Anthropic: { in: 3, out: 15 },
  OpenAI: { in: 2.5, out: 10 },
  Google: { in: 1.25, out: 5 },
  "Zhipu AI": { in: 0.6, out: 2.2 },
};

function estimateCost(provider: string, tokensIn: number, tokensOut: number): number {
  const p = PRICE_PER_MTOK[provider] ?? { in: 1, out: 3 };
  return Math.round(((tokensIn * p.in + tokensOut * p.out) / 1e6) * 1e4) / 1e4;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------- 追加只写持久化 */

const STORE_KEY = "agent-workbench:ops";
const MAX_GATE_RUNS = 50;
const MAX_ARENA_RUNS = 50;
const MAX_USAGE = 4000;

interface PersistedLogs {
  gateHistory?: readonly GateRun[];
  arenaHistory?: readonly ArenaRun[];
  usage?: readonly UsageEntry[];
}

function readLogs(): PersistedLogs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PersistedLogs) : {};
  } catch {
    return {};
  }
}

function writeLogs(logs: PersistedLogs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(logs));
  } catch {
    /* 配额满等场景忽略 —— 原型不计 */
  }
}

/* -------------------------------------------------------------- 种子账本数据 */

const DAY = 86_400_000;

function seedUsage(): readonly UsageEntry[] {
  const providers: readonly { provider: string; model: string }[] = [
    { provider: "Anthropic", model: "claude-sonnet-5" },
    { provider: "OpenAI", model: "gpt-5.2" },
    { provider: "Google", model: "gemini-3-pro" },
    { provider: "Zhipu AI", model: "glm-5" },
  ];
  const out: UsageEntry[] = [];
  let id = 1;
  const now = Date.now();
  // 近 14 天 × 每天 2–5 笔真实会话调用（eval/judge/arena 的调用由运行时真实追加）
  for (let d = 13; d >= 0; d -= 1) {
    const calls = 2 + Math.floor(Math.random() * 4);
    for (let c = 0; c < calls; c += 1) {
      const pick =
        providers[Math.floor(Math.random() * providers.length)] ?? { provider: "Anthropic", model: "claude-sonnet-5" };
      const tokensIn = 4_000 + Math.floor(Math.random() * 40_000);
      const tokensOut = 300 + Math.floor(Math.random() * 3_000);
      out.push({
        id: id++,
        ts: now - d * DAY - Math.floor(Math.random() * DAY * 0.8),
        provider: pick.provider,
        model: pick.model,
        kind: "chat",
        tokensIn,
        tokensOut,
        costUsd: estimateCost(pick.provider, tokensIn, tokensOut),
      });
    }
  }
  return out;
}

function seedGateHistory(): readonly GateRun[] {
  const now = Date.now();
  return [
    { ts: now - 5 * DAY, detPassed: 5, detTotal: 5, judgeAvg: 0.78, verdict: "pass" },
    { ts: now - 3 * DAY, detPassed: 4, detTotal: 5, judgeAvg: 0.71, verdict: "fail", failReason: "确定性 4/5 —— draft-message 未触发" },
    { ts: now - 1 * DAY, detPassed: 5, detTotal: 5, judgeAvg: 0.82, verdict: "pass" },
  ];
}

function seedArenaHistory(): readonly ArenaRun[] {
  const now = Date.now();
  return [
    {
      id: 1,
      ts: now - 2 * DAY,
      prompt: "帮我整理这周的记忆并安排下周一的回顾会",
      contestants: [
        { runtimeId: "claude", runtimeLabel: "Claude Code", modelId: "claude-sonnet-5", modelLabel: "claude-sonnet-5", completion: "pass", quality: 0.86, latencyMs: 4_120, tokensOut: 720 },
        { runtimeId: "codex", runtimeLabel: "Codex", modelId: "gpt-5.2", modelLabel: "gpt-5.2", completion: "pass", quality: 0.79, latencyMs: 5_460, tokensOut: 980 },
        { runtimeId: "gemini", runtimeLabel: "Gemini CLI", modelId: "gemini-3-pro", modelLabel: "gemini-3-pro", completion: "fail", quality: 0.58, latencyMs: 7_890, tokensOut: 1_240 },
      ],
    },
  ];
}

/* ------------------------------------------------------------------- Store */

interface OpsState {
  readonly cases: readonly DeterministicCase[];
  readonly metrics: readonly JudgeMetric[];
  /** 追加只写：一行一次 make gate */
  readonly gateHistory: readonly GateRun[];
  /** 追加只写：一行一次 Arena 比赛 */
  readonly arenaHistory: readonly ArenaRun[];
  /** 追加只写：一行一次 LLM 调用 */
  readonly usage: readonly UsageEntry[];
  readonly gateRunning: boolean;
  readonly arenaRunning: boolean;

  /** make gate：确定性用例逐个跑（0/1），然后 judge 逐指标打分（真实 = LLM 调用） */
  runGate: () => void;
  /** Arena：同一 prompt 逐个选手赛完，记分板一次性落一行 */
  runArena: (prompt: string, contestants: readonly ArenaCandidate[]) => void;
}

export const useOps = create<OpsState>((set, get) => {
  const logs = readLogs();
  let usageSeq = 1 + (logs.usage?.length ?? 0);
  let arenaSeq = 1 + (logs.arenaHistory?.length ?? 0);

  const appendUsage = (entry: Omit<UsageEntry, "id">) => {
    set((st) => {
      const usage = [...st.usage, { ...entry, id: usageSeq++ }].slice(-MAX_USAGE);
      writeLogs({ gateHistory: st.gateHistory, arenaHistory: st.arenaHistory, usage });
      return { usage };
    });
  };

  return {
    cases: SEED_CASES,
    metrics: SEED_METRICS,
    gateHistory: logs.gateHistory ?? seedGateHistory(),
    arenaHistory: logs.arenaHistory ?? seedArenaHistory(),
    usage: logs.usage ?? seedUsage(),
    gateRunning: false,
    arenaRunning: false,

    runGate: () => {
      const { cases, metrics, gateRunning } = get();
      if (gateRunning) return;

      // 预先裁定本轮结果：确定性基本全过（一条 flaky），judge 分数在阈值上方抖动
      const caseSteps = cases.map((c) => ({
        kind: "case" as const,
        c,
        pass: c.id === FLAKY_CASE_ID ? Math.random() > 0.18 : true,
      }));
      const metricSteps = metrics.map((m) => ({
        kind: "metric" as const,
        m,
        score: round2(Math.min(0.95, 0.58 + Math.random() * 0.36)),
      }));
      const steps = [...caseSteps, ...metricSteps];

      set({ gateRunning: true });
      let detPassed = 0;
      let judgeSum = 0;
      let delay = 0;
      steps.forEach((step, i) => {
        delay += step.kind === "case" ? 320 : 620;
        window.setTimeout(() => {
          if (step.kind === "case") {
            if (step.pass) detPassed += 1;
            set((st) => ({
              cases: st.cases.map((x) => (x.id === step.c.id ? { ...x, lastResult: step.pass ? "pass" : "fail" } : x)),
            }));
          } else {
            judgeSum += step.score;
            set((st) => ({
              metrics: st.metrics.map((x) => (x.id === step.m.id ? { ...x, lastScore: step.score } : x)),
            }));
            // judge 是真实的一次 LLM 调用 —— 花费入账
            const tokensIn = 540 + Math.floor(Math.random() * 600);
            const tokensOut = 90 + Math.floor(Math.random() * 160);
            appendUsage({
              ts: Date.now(),
              provider: "Anthropic",
              model: "claude-sonnet-5",
              kind: "judge",
              tokensIn,
              tokensOut,
              costUsd: estimateCost("Anthropic", tokensIn, tokensOut),
            });
          }
          if (i === steps.length - 1) {
            const judgeAvg = round2(judgeSum / Math.max(1, metricSteps.length));
            const detAll = detPassed === caseSteps.length;
            const judgeOk = metricSteps.every((s) => s.score >= s.m.threshold);
            const verdict: GateRun["verdict"] = detAll && judgeOk ? "pass" : "fail";
            const failReason = !detAll
              ? `确定性 ${detPassed}/${caseSteps.length} 未全过`
              : !judgeOk
                ? "judge 指标低于阈值"
                : undefined;
            set((st) => {
              const gateHistory = [
                ...st.gateHistory,
                { ts: Date.now(), detPassed, detTotal: caseSteps.length, judgeAvg, verdict, failReason },
              ].slice(-MAX_GATE_RUNS);
              writeLogs({ gateHistory, arenaHistory: st.arenaHistory, usage: st.usage });
              return { gateHistory, gateRunning: false };
            });
          } else {
            writeLogs({ gateHistory: get().gateHistory, arenaHistory: get().arenaHistory, usage: get().usage });
          }
        }, delay);
      });
    },

    runArena: (prompt, contestants) => {
      const { arenaRunning } = get();
      if (arenaRunning || contestants.length === 0) return;
      set({ arenaRunning: true });

      const arenaId = arenaSeq++;
      const finished: ArenaContestant[] = [];
      contestants.forEach((cst, i) => {
        const delay = 600 + i * 700 + Math.random() * 400;
        window.setTimeout(() => {
          const row: ArenaContestant = {
            ...cst,
            completion: Math.random() > 0.15 ? "pass" : "fail",
            quality: round2(Math.min(0.97, 0.5 + Math.random() * 0.45)),
            latencyMs: 1_200 + Math.round(Math.random() * 5_200),
            tokensOut: 180 + Math.round(Math.random() * 900),
          };
          finished.push(row);
          const tokensIn = 900 + Math.floor(Math.random() * 2_400);
          appendUsage({
            ts: Date.now(),
            provider: cst.runtimeLabel,
            model: cst.modelLabel,
            kind: "arena",
            tokensIn,
            tokensOut: row.tokensOut,
            costUsd: estimateCost(cst.runtimeLabel, tokensIn, row.tokensOut),
          });
          if (finished.length === contestants.length) {
            set((st) => {
              const arenaHistory = [
                ...st.arenaHistory,
                { id: arenaId, ts: Date.now(), prompt, contestants: [...finished] },
              ].slice(-MAX_ARENA_RUNS);
              writeLogs({ gateHistory: st.gateHistory, arenaHistory, usage: st.usage });
              return { arenaHistory, arenaRunning: false };
            });
          } else {
            writeLogs({ gateHistory: get().gateHistory, arenaHistory: get().arenaHistory, usage: get().usage });
          }
        }, delay);
      });
    },
  };
});

/* ----------------------------------------------------------- 派生聚合（纯函数） */

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls: number;
}

export function totalUsage(usage: readonly UsageEntry[]): UsageTotals {
  return usage.reduce<UsageTotals>(
    (acc, u) => ({
      tokensIn: acc.tokensIn + u.tokensIn,
      tokensOut: acc.tokensOut + u.tokensOut,
      costUsd: Math.round((acc.costUsd + u.costUsd) * 1e4) / 1e4,
      calls: acc.calls + 1,
    }),
    { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 },
  );
}

export interface UsageByDay {
  day: string;
  costUsd: number;
  tokens: number;
}

/** 最近 14 天按日聚合（升序），空天补零 —— 柱状图直接可用 */
export function usageByDay(usage: readonly UsageEntry[], days = 14): readonly UsageByDay[] {
  const buckets = new Map<string, { costUsd: number; tokens: number }>();
  const key = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  for (const u of usage) {
    const k = key(u.ts);
    const hit = buckets.get(k) ?? { costUsd: 0, tokens: 0 };
    hit.costUsd += u.costUsd;
    hit.tokens += u.tokensIn + u.tokensOut;
    buckets.set(k, hit);
  }
  const out: UsageByDay[] = [];
  const now = new Date();
  for (let d = days - 1; d >= 0; d -= 1) {
    const day = new Date(now.getTime() - d * DAY).toISOString().slice(0, 10);
    const hit = buckets.get(day);
    out.push({ day, costUsd: hit ? Math.round(hit.costUsd * 1e4) / 1e4 : 0, tokens: hit?.tokens ?? 0 });
  }
  return out;
}

export interface UsageByProvider extends UsageTotals {
  provider: string;
}

export function usageByProvider(usage: readonly UsageEntry[]): readonly UsageByProvider[] {
  const map = new Map<string, UsageTotals & { provider: string }>();
  for (const u of usage) {
    const hit = map.get(u.provider) ?? { provider: u.provider, tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
    hit.tokensIn += u.tokensIn;
    hit.tokensOut += u.tokensOut;
    hit.costUsd = Math.round((hit.costUsd + u.costUsd) * 1e4) / 1e4;
    hit.calls += 1;
    map.set(u.provider, hit);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/** 用量账本键名（设置页/文档引用 —— 透明化原则） */
export const OPS_STORAGE_KEY = STORE_KEY;
