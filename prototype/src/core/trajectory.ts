/**
 * 轨迹投影 —— 从归一化事件流折叠出 dsh 式的会话轨迹。
 *
 * 口径对齐 dsh 的三层结构：
 * - 记录（cell）：一条事件一行，带类型标签 / 单行摘要 / 可展开详情；
 * - 轮次（turn）：一次用户输入开启一轮（dsh: turn/start–turn/end），
 *   孤儿记录（用户消息之前的事件）折进 Turn 1；
 * - 会话统计（session-stats 投影）：turns / steps / LLM 耗时 / 工具耗时 /
 *   速度 / 四桶 token / 成本。
 *
 * 与 dsh 的差异：dsh 从 JSONL 会话日志投影，有精确的 step 生命周期与
 * 首 token 时间；本原型只有归一化事件流——steps 以 usage 事件数近似
 * （每轮 LLM 调用一条），LLM 耗时用 usage 自报的 decodeMs，工具耗时由
 * tool.started → tool.completed 按 callId 配对计算，TTFT 无数据不展示。
 */

import type { RuntimeEvent } from "./events.ts";
import { formatTokens, formatTokensPerSecond } from "./sessionStats.ts";

export type TrajKind =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "plan"
  | "permission"
  | "subagent"
  | "diff"
  | "deliverable";

export interface TrajTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TrajRecord {
  readonly id: string;
  readonly kind: TrajKind;
  readonly label: string;
  /** 单行摘要（CSS 省略号） */
  readonly text: string;
  /** 工具行内联结果（dsh：`name args → result`） */
  readonly result?: string;
  /** 展开详情（全文 / JSON） */
  readonly detail?: string;
  readonly isError?: boolean;
  readonly at: number;
  readonly clock: string;
  readonly durationMs?: number;
}

export interface TrajTurn {
  readonly turn: number;
  readonly records: readonly TrajRecord[];
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: TrajTokens;
  readonly costUsd: number;
}

export interface TrajStats {
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly llmMs: number;
  readonly toolMs: number;
  readonly tokens: TrajTokens;
  readonly costUsd: number;
  readonly tokensPerSecond: number | null;
  readonly eventCount: number;
}

export interface Trajectory {
  readonly turns: readonly TrajTurn[];
  readonly stats: TrajStats;
}

const ZERO: TrajTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const addTokens = (a: TrajTokens, b: Partial<TrajTokens>): TrajTokens => ({
  input: a.input + (b.input ?? 0),
  output: a.output + (b.output ?? 0),
  cacheRead: a.cacheRead + (b.cacheRead ?? 0),
  cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
});

const clockOf = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function deriveTrajectory(items: readonly { readonly event: RuntimeEvent; readonly at: number }[]): Trajectory {
  const turns: { turn: number; records: TrajRecord[]; steps: number; toolCalls: number; tokens: TrajTokens; costUsd: number }[] = [];
  let current = { turn: 1, records: [] as TrajRecord[], steps: 0, toolCalls: 0, tokens: ZERO, costUsd: 0 };
  let started = false;

  // 工具配对计时（dsh：pendingCalls 按 callId 配对 tool/call → tool/result）
  const pendingTools = new Map<string, { at: number; record: TrajRecord }>();
  let toolMs = 0;

  const push = (record: TrajRecord) => current.records.push(record);

  items.forEach(({ event, at }, i) => {
    const clock = clockOf(at);
    const rid = `r${i}`;

    switch (event.type) {
      case "message.delta":
        if (event.role !== "user") break;
        // 用户输入开启新一轮；第一轮之前堆积的孤儿记录折进当前轮
        if (started) {
          turns.push(current);
          current = { turn: current.turn + 1, records: [], steps: 0, toolCalls: 0, tokens: ZERO, costUsd: 0 };
        }
        started = true;
        push({
          id: rid, kind: "user", label: "用户", text: event.text, at, clock,
        });
        break;

      case "reasoning.delta":
        push({ id: rid, kind: "assistant", label: "思考", text: event.text, at, clock });
        break;

      case "message.completed":
        push({
          id: rid, kind: "assistant", label: "助手", text: event.text,
          detail: event.text, at, clock,
        });
        break;

      case "tool.started":
        push({
          id: rid, kind: "tool", label: event.toolName, text: event.title,
          detail: event.input === null || event.input === undefined ? undefined : JSON.stringify(event.input, null, 1),
          at, clock,
        });
        pendingTools.set(event.callId, {
          at,
          record: current.records[current.records.length - 1]!,
        });
        current.toolCalls += 1;
        break;

      case "tool.completed": {
        const pending = pendingTools.get(event.callId);
        pendingTools.delete(event.callId);
        if (pending) {
          const durationMs = Math.max(at - pending.at, 0);
          toolMs += durationMs;
          // 就地补结果与耗时（记录对象由本函数构造，可安全扩展）
          const idx = current.records.indexOf(pending.record);
          if (idx >= 0) {
            const rec = current.records[idx]!;
            current.records[idx] = {
              ...rec,
              result: event.output ?? (event.ok ? "完成" : "失败"),
              detail: [rec.detail, event.output && `结果：${event.output}`].filter(Boolean).join("\n\n"),
              durationMs,
              isError: !event.ok,
            };
          }
        }
        break;
      }

      case "permission.requested":
        push({ id: rid, kind: "permission", label: "权限", text: event.detail, at, clock });
        break;
      case "permission.resolved":
        push({ id: rid, kind: "permission", label: "权限", text: `裁决：${event.decision}`, at, clock });
        break;

      case "plan.proposed":
        push({
          id: rid, kind: "plan", label: "计划", text: event.title,
          detail: event.steps.map((s, idx) => `${idx + 1}. [${s.status}] ${s.title}`).join("\n"),
          at, clock,
        });
        break;
      case "plan.resolved":
        push({ id: rid, kind: "plan", label: "计划", text: `决策：${event.decision}`, at, clock });
        break;

      case "subagent.spawned":
        push({ id: rid, kind: "subagent", label: "子代理", text: `${event.role} · 经由 ${event.runtimeId}`, at, clock });
        break;
      case "subagent.finished":
        push({
          id: rid, kind: "subagent", label: "子代理",
          text: event.summary ? `完成 · ${event.summary}` : "完成",
          isError: !event.ok, at, clock,
        });
        break;

      case "file.diff":
        push({
          id: rid, kind: "diff", label: "diff",
          text: `${event.path} +${event.additions} −${event.deletions}`,
          detail: event.patch, at, clock,
        });
        break;

      case "usage": {
        current.steps += 1;
        current.tokens = addTokens(current.tokens, {
          input: event.inputTokens,
          output: event.outputTokens,
          cacheRead: event.cacheReadTokens ?? 0,
          cacheWrite: event.cacheWriteTokens ?? 0,
        });
        current.costUsd += event.costUsd;
        push({
          id: rid, kind: "system", label: event.model,
          text: `${formatTokens(event.inputTokens)}↑ ${formatTokens(event.outputTokens)}↓ · $${event.costUsd.toFixed(3)}`,
          at, clock,
        });
        break;
      }

      case "deliverable":
        push({ id: rid, kind: "deliverable", label: "产出", text: event.title, at, clock });
        break;

      case "session.started":
        push({ id: rid, kind: "system", label: "会话", text: "会话开始", at, clock });
        break;
      case "session.ended":
        push({ id: rid, kind: "system", label: "会话", text: `会话结束 · ${event.reason}`, at, clock });
        break;
    }
  });
  turns.push(current);

  const stats: TrajStats = turns.reduce<TrajStats>(
    (acc, t) => ({
      ...acc,
      turns: acc.turns + (t.records.some((r) => r.kind === "user") ? 1 : 0),
      steps: acc.steps + t.steps,
      toolCalls: acc.toolCalls + t.toolCalls,
      tokens: addTokens(acc.tokens, t.tokens),
      costUsd: acc.costUsd + t.costUsd,
    }),
    {
      turns: 0, steps: 0, toolCalls: 0, llmMs: 0, toolMs,
      tokens: ZERO, costUsd: 0,
      tokensPerSecond: null, eventCount: items.length,
    },
  );
  // LLM 耗时与速度：usage 自报 decodeMs 的口径（在 reduce 外补算，需要事件流）
  let decodeMs = 0;
  let decodeTokens = 0;
  for (const { event } of items) {
    if (event.type === "usage" && event.decodeMs) {
      decodeMs += event.decodeMs;
      decodeTokens += event.outputTokens;
    }
  }
  const withLlm: TrajStats = {
    ...stats,
    llmMs: decodeMs,
    tokensPerSecond: decodeMs > 0 ? stats.tokens.output / (decodeMs / 1000) : null,
  };
  void decodeTokens;

  return { turns, stats: withLlm };
}

/** 摘要文本（轮头/详情复用） */
export const trajTokenText = (t: TrajTokens): string =>
  `${formatTokens(t.input + t.cacheRead + t.cacheWrite)}↑ ${formatTokens(t.output)}↓`;

export const trajSpeedText = (stats: TrajStats): string | null =>
  stats.tokensPerSecond === null ? null : `${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`;
