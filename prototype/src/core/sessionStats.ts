/**
 * 会话统计派生 —— 底部状态栏的数据源。
 *
 * 口径对齐 dsh（deepseek-harness）的两层结构：
 * - 优先用运行时**声明**的数据：usage 事件自带 cacheRead / cacheWrite / decodeMs
 *   （对应 dsh 的 TokenUsageProjection + SessionStatsProjection）；
 * - 运行时没报的字段归零处理，UI 侧整段隐藏，不猜数。
 *
 * 这里是纯函数：输入事件流，输出快照。放在 core 而不是 ui，
 * 是因为设置页「用量」分区将来要复用同一套口径。
 */

import type { RuntimeEvent } from "./events.ts";

export interface DerivedStats {
  /** 未命中缓存的输入（dsh: uncachedInputTokens） */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** 计费输入 = uncached + cacheRead + cacheWrite */
  readonly billedInputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** LLM 轮数 ≈ usage 事件数 */
  readonly turns: number;
  /** 工具调用步数 */
  readonly steps: number;
  readonly decodeMs: number;
  /** 解码速度。运行时没报 decodeMs 时为 null，UI 整段隐藏 */
  readonly tokensPerSecond: number | null;
  /**
   * 当前上下文占用 ≈ 最后一轮 usage 的 input + output。
   * input 是「本轮重发的上下文表面」（dsh: pressureTokens 口径），
   * 取最后一轮而不是累加 —— 累加会把同一份上下文算多遍。
   */
  readonly contextTokens: number;
  /** 工具调用总耗时（tool.started → tool.completed 按 callId 配对） */
  readonly toolMs: number;
  /** 首 token 平均时延（TTFT）。以 usage 事件为一轮边界、轮内首个
   * delta 事件为首个 token 的近似 —— pace=0 时为 0，UI 隐藏该行 */
  readonly ttftMs: number | null;
}

interface StatSource {
  readonly event: RuntimeEvent;
  readonly at: number;
}

/** 没有任何 usage 事件时返回 null —— UI 据此切到「暂无数据」态 */
export function deriveSessionStats(items: readonly StatSource[]): DerivedStats | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let turns = 0;
  let steps = 0;
  let decodeMs = 0;
  let last: { readonly inTok: number; readonly outTok: number } | null = null;

  // 工具配对计时（dsh：pendingCalls 按 callId 配对 tool/call → tool/result）
  const pendingTools = new Map<string, number>();
  let toolMs = 0;

  // TTFT 近似：usage 事件视为一轮的结束边界，轮内首个 delta 视为首 token
  let roundStart: number | null = null;
  let firstDeltaAt: number | null = null;
  let ttftSum = 0;
  let ttftRounds = 0;

  for (const { event, at } of items) {
    if (roundStart === null) roundStart = at;
    if (
      (event.type === "reasoning.delta" || event.type === "message.delta") &&
      firstDeltaAt === null
    ) {
      firstDeltaAt = at;
    }

    switch (event.type) {
      case "tool.started":
        steps += 1;
        pendingTools.set(event.callId, at);
        break;
      case "tool.completed": {
        const start = pendingTools.get(event.callId);
        pendingTools.delete(event.callId);
        if (start !== undefined) toolMs += Math.max(at - start, 0);
        break;
      }
      case "usage":
        input += event.inputTokens;
        output += event.outputTokens;
        cacheRead += event.cacheReadTokens ?? 0;
        cacheWrite += event.cacheWriteTokens ?? 0;
        decodeMs += event.decodeMs ?? 0;
        costUsd += event.costUsd;
        turns += 1;
        if (firstDeltaAt !== null && roundStart !== null) {
          ttftSum += Math.max(firstDeltaAt - roundStart, 0);
          ttftRounds += 1;
        }
        roundStart = at;
        firstDeltaAt = null;
        last = { inTok: event.inputTokens, outTok: event.outputTokens };
        break;
    }
  }

  if (last === null) return null;
  const billedInput = input + cacheRead + cacheWrite;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    billedInputTokens: billedInput,
    totalTokens: billedInput + output,
    costUsd,
    turns,
    steps,
    decodeMs,
    tokensPerSecond: decodeMs > 0 ? output / (decodeMs / 1000) : null,
    contextTokens: last.inTok + last.outTok,
    toolMs,
    ttftMs: ttftRounds > 0 ? Math.round(ttftSum / ttftRounds) : null,
  };
}

/* ------------------------------------------------------------- 上下文分解 */

export interface ContextBreakdown {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messageTokens: number;
}

/**
 * 上下文三段分解的**启发式**近似。
 *
 * dsh 从 token-meter 投影拿到真实的 system / tools / messages 三段；
 * 归一化事件流没有这层信息，只能按可用信号估：
 * 系统提示词取固定地板，工具Schema 按步数放大，剩下全归消息。
 * 真实适配器接入后应换成运行时上报的分解，本函数即退役。
 */
export function estimateContextBreakdown(stats: DerivedStats): ContextBreakdown {
  const SYSTEM_FLOOR = 6_000;
  const PER_STEP = 900;

  const system = Math.min(SYSTEM_FLOOR, stats.contextTokens);
  const tools = Math.min(
    Math.max(stats.steps * PER_STEP, 1_800),
    Math.max(stats.contextTokens - system, 0),
  );
  return {
    systemTokens: system,
    toolsTokens: tools,
    messageTokens: Math.max(stats.contextTokens - system - tools, 0),
  };
}

/* ------------------------------------------------------------- 格式化 */

/**
 * token 缩写，同 dsh 的 token-format：<1000 原值，否则 K / M。
 * 缩放后 ≥100 取整，否则留 1 位小数：517 → 517，12200 → 12.2K，62040 → 62K。
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * 缓存命中率（整数百分比）。billedInput ≤ 0 时返回 null（整段隐藏）。
 * 命中率接近 100% 时保留一位小数 —— 部分命中被四舍五入成 100% 是在骗人。
 */
export function formatCacheHitPercent(cacheRead: number, billedInput: number): number | null {
  if (billedInput <= 0) return null;
  const pct = (cacheRead / billedInput) * 100;
  const rounded = Math.round(pct);
  return rounded >= 100 && cacheRead < billedInput ? Number(pct.toFixed(1)) : rounded;
}

/** 速度格式化：≥10 取整，否则 1 位小数（dsh 的 formatTokensPerSecond） */
export function formatTokensPerSecond(tps: number): string {
  return tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** 耗时：<60s 显示 45.2s，否则 2m42s（dsh 的 formatDuration） */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

/** 成本：小数保留三位，与时间线 usage 行的口径一致 */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}
