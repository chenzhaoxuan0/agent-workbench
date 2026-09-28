import { useEffect, useMemo, useState } from "react";
import { Activity, Database } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectActivePair } from "../store/useWorkbench.ts";
import {
  deriveSessionStats,
  estimateContextBreakdown,
  formatCacheHitPercent,
  formatTokens,
  formatTokensPerSecond,
} from "../core/sessionStats.ts";
import { formatContext } from "../core/models.ts";
import { cn } from "./cn.ts";

/**
 * 统计坞 —— 挂在 composer 卡片正下方，dsh 的真实挂位。
 *
 * 交互对齐 dsh 的 StatsPills：pills **可点击**，各自弹出锚定在
 * pill 上方的对话框（stat-dialog 形态：标题行 + 发丝线 + 两列
 * dl 网格），同一时刻只开一个：
 * - 时间 pill → 「会话统计」：模型用时 / 工具调用用时 / TTFT / TPS；
 * - 用量 pill → 「Token 用量」：缓存命中 / 未缓存输入 / 缓存读取 /
 *   输出（+ 本项目追加的成本行），标题右侧是精确总量；
 * - 上下文环 → 三段分解面板（ContextMeter）。
 *
 * 数据从归一化事件流派生（core/sessionStats.ts）：dsh 从 JSONL 日志
 * 投影；工具耗时按 callId 配对、TTFT 以 usage 为轮边界近似。
 * 轮次/步数常驻（TimePill 零数据退化为纯文本），其余有数据才出现。
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

  // 同一时刻只开一个对话框（dsh 的互斥 open 槽）
  const [openDialog, setOpenDialog] = useState<"time" | "usage" | null>(null);
  useEffect(() => {
    if (!openDialog) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenDialog(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openDialog]);

  const runtimeDot =
    runtime?.state.status === "ready"
      ? "bg-gain"
      : runtime?.state.status === "starting"
        ? "bg-teal animate-pulse"
        : runtime?.state.status === "error"
          ? "bg-loss"
          : "bg-ash";

  const timeLabel = `${stats?.turns ?? 0} 轮 · ${stats?.steps ?? 0} 步${stats?.tokensPerSecond !== null && stats ? ` · ${formatTokensPerSecond(stats.tokensPerSecond)} tok/s` : ""}`;
  const usageLabel = stats ? `${formatTokens(stats.totalTokens)} tok${cacheHit !== null ? ` · 缓存命中 ${cacheHit}%` : ""}` : null;

  return (
    <div className="mt-2 flex min-w-0 items-center gap-3 text-caption text-graphite" aria-label="会话统计">
      <span className="min-w-0 shrink-0 text-ash">Enter 发送 · Shift + Enter 换行</span>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* 时间 pill → 会话统计（dsh TimePill：零数据退化为纯文本不可点） */}
        <Pill
          active={openDialog === "time"}
          clickable={stats !== null}
          onClick={() => setOpenDialog(openDialog === "time" ? null : "time")}
          icon={<Activity size={11} />}
          label={timeLabel}
          title={stats ? "会话统计" : "运行一次任务后生成"}
        >
          {stats && <TimeDialog stats={stats} />}
        </Pill>

        {/* 用量 pill → Token 用量（dsh UsagePill） */}
        {stats && cacheHit !== null && (
          <Pill
            active={openDialog === "usage"}
            clickable
            onClick={() => setOpenDialog(openDialog === "usage" ? null : "usage")}
            icon={<Database size={11} />}
            label={usageLabel!}
            title="Token 用量"
          >
            <UsageDialog stats={stats} cacheHit={cacheHit!} />
          </Pill>
        )}

        <ContextMeter percent={percent} stats={stats} contextWindow={contextWindow} />

        <span className="flex shrink-0 items-center gap-1.5" title={runtime ? `${runtime.presentation.displayName} · ${runtime.state.status}` : "执行器未连接"}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", runtimeDot)} aria-hidden />
          <span className="font-mono text-ash">{model?.displayName ?? "—"}</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- pill + 对话框壳 */

function Pill({
  icon,
  label,
  title,
  active,
  clickable,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  active: boolean;
  clickable: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  if (!clickable) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 text-ash" title={title}>
        {icon}
        <span className="tnum">{label}</span>
      </span>
    );
  }
  return (
    <div className="relative">
      <button
        onClick={onClick}
        aria-expanded={active}
        title={title}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 tnum",
          active ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        {icon}
        {label}
      </button>

      {active && (
        <>
          <span className="fixed inset-0 z-30" onClick={onClick} aria-hidden />
          <div className="absolute bottom-full left-0 z-40 mb-2 w-max min-w-[264px] rounded-card border border-line bg-canvas p-3 shadow-subtle">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

/** 统计对话框的行原语：左标签右数值（dsh 的 dl 网格） */
function DialogRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 py-1">
      <span className="text-caption text-graphite">{label}</span>
      <span className={cn("tnum text-body-sm", strong ? "font-medium text-ink" : "text-ink")}>{value}</span>
    </div>
  );
}

function DialogTitle({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 border-b border-line-soft pb-1.5">
      <span className="text-graphite">{icon}</span>
      <span className="text-caption font-medium text-ink">{label}</span>
      {value && <span className="tnum ml-auto text-caption text-ash">{value}</span>}
    </div>
  );
}

/* ------------------------------------------------------------- 两个对话框 */

function TimeDialog({ stats }: { stats: NonNullable<ReturnType<typeof deriveSessionStats>> }) {
  const tps = stats.tokensPerSecond;
  return (
    <>
      <DialogTitle icon={<Activity size={12} />} label="会话统计" />
      {stats.decodeMs > 0 && <DialogRow label="模型用时" value={formatSeconds(stats.decodeMs)} />}
      {stats.toolMs > 0 && <DialogRow label="工具调用用时" value={formatSeconds(stats.toolMs)} />}
      {stats.ttftMs !== null && stats.ttftMs > 0 && (
        <DialogRow label="首 token 平均（TTFT）" value={formatSeconds(stats.ttftMs)} />
      )}
      {tps !== null && <DialogRow label="输出速度（TPS）" value={`${formatTokensPerSecond(tps)} tok/s`} />}
      {stats.decodeMs === 0 && stats.toolMs === 0 && (
        <p className="text-caption text-ash">事件流里还没有可计量的耗时。</p>
      )}
    </>
  );
}

function UsageDialog({
  stats,
  cacheHit,
}: {
  stats: NonNullable<ReturnType<typeof deriveSessionStats>>;
  cacheHit: number;
}) {
  return (
    <>
      <DialogTitle icon={<Database size={12} />} label="Token 用量" value={`${stats.totalTokens.toLocaleString()} tok`} />
      <DialogRow label="缓存命中" value={`${cacheHit}%`} />
      <DialogRow label="未缓存输入" value={`${stats.inputTokens.toLocaleString()} tok`} />
      <DialogRow label="缓存读取" value={`${stats.cacheReadTokens.toLocaleString()} tok`} />
      {stats.cacheWriteTokens > 0 && (
        <DialogRow label="缓存写入" value={`${stats.cacheWriteTokens.toLocaleString()} tok`} />
      )}
      <DialogRow label="输出" value={`${stats.outputTokens.toLocaleString()} tok`} />
      <DialogRow label="成本" value={`$${stats.costUsd.toFixed(3)}`} />
    </>
  );
}

function formatSeconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(ms / 60_000);
  return `${m} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/* ------------------------------------------------------------- 上下文占用环 */

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 上下文占用环 —— 对齐 dsh 的 ContextMeter：14px 环 + 百分比，
 * 点开分解面板（三段条 + 图例）。dsh 无占位数据时整环隐藏；
 * 本项目保留 0% 环占位（功能位置常驻）。
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
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <p className="text-body-sm text-ink">
                上下文已用 <span className="font-medium">{percent}%</span>
              </p>
              <p className="tnum text-caption text-ash">
                ~{formatTokens(stats.contextTokens)} / {formatContext(contextWindow)}
              </p>
            </div>

            {/* 三段分解条。dsh 用蓝紫区分段；本设计系统只许 teal 一个彩色，
                分段色阶走灰阶：system 最浅、tools 居中、messages 用 teal */}
            <div className="flex h-1 gap-px overflow-hidden rounded-chip">
              <Segment pct={breakdown.systemTokens} total={stats.contextTokens} className="bg-ash" />
              <Segment pct={breakdown.toolsTokens} total={stats.contextTokens} className="bg-graphite" />
              <Segment pct={breakdown.messageTokens} total={stats.contextTokens} className="bg-teal" />
            </div>

            <div className="mt-2.5 space-y-1">
              <LegendRow label="系统提示词" tokens={breakdown.systemTokens} dot="bg-ash" />
              <LegendRow label="工具定义" tokens={breakdown.toolsTokens} dot="bg-graphite" />
              <LegendRow label="对话消息" tokens={breakdown.messageTokens} dot="bg-teal" />
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
