import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectActivePair } from "../store/useWorkbench.ts";
import {
  deriveSessionStats,
  estimateContextBreakdown,
  formatCacheHitPercent,
  formatCost,
  formatDuration,
  formatTokens,
  formatTokensPerSecond,
} from "../core/sessionStats.ts";
import { formatContext } from "../core/models.ts";
import { cn } from "./cn.ts";

/**
 * 会话统计坞 —— 挂在 composer 卡片正下方，dsh 的真实挂位。
 *
 * 口径与 dsh 的会话底栏一致：
 * - 统计 pills（StatsPills）：↑计费输入 ↓输出、缓存命中率、tok/s、轮次与步数、
 *   累计成本 —— 运行时没报的字段整段隐藏，不猜数；
 * - 上下文占用环（ContextMeter）：percent = 上下文表面 / 模型窗口，
 *   点开有 system / tools / messages 三段分解面板。
 *
 * 差异：dsh 的 pills 由 token-meter 投影驱动；本原型从归一化事件流
 * 现场派生（core/sessionStats.ts）。轮次/步数常驻（TimePill 语义：
 * 零数据退化为纯文本），token/缓存/速度/成本在有数据后出现。
 */
export function StatsDock() {
  const timeline = useWorkbench((s) => s.timeline);
  // selectActivePair 每次返回新对象 —— 必须 useShallow（见 useWorkbench.ts 的警告注释）
  const { runtime, model } = useWorkbench(useShallow(selectActivePair));

  const stats = useMemo(() => deriveSessionStats(timeline), [timeline]);
  // 模型窗口取当前模型声明；拿不到就按 200K 兜底（Haiku 档的窗口）
  const contextWindow = model?.contextWindow ?? 200_000;
  const percent = stats ? Math.min(100, Math.round((stats.contextTokens / contextWindow) * 100)) : 0;
  const cacheHit = stats ? formatCacheHitPercent(stats.cacheReadTokens, stats.billedInputTokens) : null;

  const runtimeDot =
    runtime?.state.status === "ready"
      ? "bg-gain"
      : runtime?.state.status === "starting"
        ? "bg-teal animate-pulse"
        : runtime?.state.status === "error"
          ? "bg-loss"
          : "bg-ash";

  return (
    <div className="mt-2 flex min-w-0 items-center gap-3 text-caption text-graphite" aria-label="会话统计">
      <span className="min-w-0 shrink-0 text-ash">Enter 发送 · Shift + Enter 换行</span>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        {/* 轮次/步数常驻 —— dsh 的 TimePill 在零数据时退化为纯文本，不隐藏位置 */}
        <span className="tnum" title="LLM 轮数 · 工具调用步数">
          {stats?.turns ?? 0} 轮 · {stats?.steps ?? 0} 步
        </span>
        {stats !== null && (
          <>
            <Hairline />
            <span className="tnum" title={`↑ 计费输入 ${formatTokens(stats.billedInputTokens)}\n↓ 输出 ${formatTokens(stats.outputTokens)}`}>
              <span className="text-ash">↑</span>
              {formatTokens(stats.billedInputTokens)}
              <span className="ml-1 text-ash">↓</span>
              {formatTokens(stats.outputTokens)}
            </span>
            {cacheHit !== null && (
              <>
                <Hairline />
                <span className="tnum" title={`缓存读 ${formatTokens(stats.cacheReadTokens)} / 计费输入 ${formatTokens(stats.billedInputTokens)}`}>
                  缓存 {cacheHit}%
                </span>
              </>
            )}
            {stats.tokensPerSecond !== null && (
              <>
                <Hairline />
                <span className="tnum" title={`解码 ${formatTokens(stats.outputTokens)} token · 耗时 ${formatDuration(stats.decodeMs)}`}>
                  {formatTokensPerSecond(stats.tokensPerSecond)} tok/s
                </span>
              </>
            )}
            <Hairline />
            <span className="tnum" title="本次会话累计成本">
              {formatCost(stats.costUsd)}
            </span>
          </>
        )}

        <Hairline />
        <ContextMeter percent={percent} stats={stats} contextWindow={contextWindow} />

        <Hairline />
        <span className="flex shrink-0 items-center gap-1.5" title={runtime ? `${runtime.presentation.displayName} · ${runtime.state.status}` : "执行器未连接"}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", runtimeDot)} aria-hidden />
          <span className="font-mono text-ash">{model?.displayName ?? "—"}</span>
        </span>
      </div>
    </div>
  );
}

function Hairline() {
  return <span className="h-3 w-px shrink-0 bg-line" aria-hidden />;
}

/* ------------------------------------------------------------- 上下文占用环 */

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 上下文占用环 —— 对齐 dsh 的 ContextMeter：14px 环 + 百分比，
 * 点开分解面板（三段条 + 图例）。
 */
function ContextMeter({
  percent,
  stats,
  contextWindow,
}: {
  percent: number;
  stats: ReturnType<typeof deriveSessionStats>;
  contextWindow: number;
}) {
  const [open, setOpen] = useState(false);
  const breakdown = stats ? estimateContextBreakdown(stats) : null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="上下文占用"
        title="上下文占用"
        className="flex items-center gap-1.5 rounded-chip px-1 py-0.5 hover:bg-line-soft"
      >
        <svg width={14} height={14} viewBox="0 0 14 14" className="-rotate-90" aria-hidden>
          <circle cx={7} cy={7} r={RING_RADIUS} fill="none" stroke="var(--color-line)" strokeWidth={2.5} />
          <circle
            cx={7}
            cy={7}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--color-teal)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${(RING_CIRCUMFERENCE * percent) / 100} ${RING_CIRCUMFERENCE}`}
          />
        </svg>
        <span className="tnum">{percent}%</span>
      </button>

      {open && breakdown && stats && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute bottom-full right-0 z-40 mb-2 w-72 rounded-card border border-line bg-canvas p-3 shadow-subtle">
            <p className="text-body-sm text-ink">{percent}% 上下文已占用</p>
            <p className="tnum mt-0.5 text-caption text-ash">
              ~{formatTokens(stats.contextTokens)} / {formatContext(contextWindow)}
            </p>

            {/* 三段分解条。dsh 用蓝紫区分段；本设计系统只许 teal 一个彩色，
                分段色阶走灰阶：system 最浅、tools 居中、messages 用 teal */}
            <div className="mt-3 flex h-1 gap-px overflow-hidden rounded-chip">
              <Segment pct={breakdown.systemTokens} total={stats.contextTokens} className="bg-ash" />
              <Segment pct={breakdown.toolsTokens} total={stats.contextTokens} className="bg-graphite" />
              <Segment pct={breakdown.messageTokens} total={stats.contextTokens} className="bg-teal" />
            </div>

            <div className="mt-2.5 space-y-1">
              <LegendRow label="系统提示词" tokens={breakdown.systemTokens} dot="bg-ash" />
              <LegendRow label="工具 Schema" tokens={breakdown.toolsTokens} dot="bg-graphite" />
              <LegendRow label="消息" tokens={breakdown.messageTokens} dot="bg-teal" />
            </div>

            <p className="mt-2.5 border-t border-line-soft pt-2 text-caption text-ash">
              分解为启发式估计 · 真实适配器将上报精确分段
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Segment({ pct, total, className }: { pct: number; total: number; className: string }) {
  const w = total > 0 ? (pct / total) * 100 : 0;
  return <span className={className} style={{ width: `${w}%` }} aria-hidden />;
}

function LegendRow({ label, tokens, dot }: { label: string; tokens: number; dot: string }) {
  return (
    <p className="flex items-center gap-1.5 text-caption text-graphite">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="flex-1">{label}</span>
      <span className="tnum font-mono">~{formatTokens(tokens)}</span>
    </p>
  );
}
