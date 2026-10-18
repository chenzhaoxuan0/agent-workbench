import { useEffect } from "react";
import { Gauge } from "lucide-react";
import { modelSpecFor, useWorkbench } from "../store/useWorkbench.ts";
import { daemonModelId } from "../adapters/daemon/adapter.ts";
import { formatContext } from "../core/models.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { cn } from "./cn.ts";

/**
 * 上下文容量徽标（Composer 底栏右侧，发送键左边 —— ZCode 同款位型）。
 *
 * - 容量：近似口径 = 最近一轮 usage 的 input + 缓存读 + output（最后一次请求的
 *   prompt 规模 + 产出）÷ 模型上下文窗口。**不是**累计 —— 每轮 input 都含全部
 *   历史，加总会严重高估。没有权威 contextWindowState 下这是最接近的现成量。
 * - 额度（如有）：订阅执行器配额余量（QuotaHeadroom），没有数据就不渲染那一截。
 */
export function ContextUsageBadge() {
  const usage = useWorkbench((s) =>
    s.activeSessionId === null ? undefined : s.usageBySession[String(s.activeSessionId)],
  );
  const spec = useWorkbench((s) => {
    const session = s.activeSessionId === null ? undefined : s.sessions.find((x) => x.id === s.activeSessionId);
    const modelId = session?.modelActual ?? s.runtimeModels[s.activeRuntimeId] ?? null;
    return modelSpecFor(
      s.runtimes.find((r) => r.id === s.activeRuntimeId),
      modelId === null ? null : daemonModelId(String(modelId)),
    );
  });
  const bareRuntime = useWorkbench((s) => s.activeRuntimeId.replace(/^daemon:/, ""));
  const quota = useBacklog((s) => s.quotas.find((q) => q.runtimeId === bareRuntime) ?? null);

  // 挂载 / 换执行器时刷一次余量（daemon 侧探测，内部自捕获错误）
  useEffect(() => {
    void useBacklog.getState().refreshQuotas();
  }, [bareRuntime]);

  const contextWindow = spec?.contextWindow;
  if (usage === undefined || contextWindow === undefined || contextWindow <= 0) return null;

  const used = usage.inputTokens + (usage.cacheReadTokens ?? 0) + usage.outputTokens;
  const pct = Math.min(100, Math.round((used / contextWindow) * 100));
  const tone =
    pct >= 90
      ? "text-red-500"
      : pct >= 70
        ? "text-amber-600"
        : "text-graphite";

  const quotaLine =
    quota !== null && quota.percent !== null
      ? `\n额度余量：${quota.percent}%${quota.summary !== null ? `（${quota.summary}）` : ""}`
      : "";
  const cacheLine =
    usage.cacheReadTokens !== undefined ? `，缓存读 ${formatContext(usage.cacheReadTokens)}` : "";

  return (
    <div
      className={cn(
        "hidden sm:flex items-center gap-1 rounded-lg border border-line-soft bg-card/60 px-2 h-7 sm:h-8 select-none font-mono text-caption",
      )}
      title={`上下文 ≈${formatContext(used)} / ${formatContext(contextWindow)}（${pct}%）` +
        `\n口径：最近一轮输入${cacheLine} + 输出 —— 近似值，非服务端权威计数` +
        `\n模型：${spec?.displayName ?? usage.model}` +
        quotaLine}
    >
      <Gauge size={12} className={tone} />
      <span className={tone}>{pct}%</span>
      {quota !== null && quota.percent !== null && (
        <span className="text-ash" title="订阅执行器配额余量（如有）">
          ·余{quota.percent}%
        </span>
      )}
    </div>
  );
}
