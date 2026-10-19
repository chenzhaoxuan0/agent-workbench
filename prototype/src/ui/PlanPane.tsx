import { useEffect, useRef, useState } from "react";
import { CircleDashed, CheckCircle2, Loader2, ListChecks, MinusCircle, PauseCircle } from "lucide-react";
import type { PlanStep, PlanStepStatus, RuntimeEvent } from "../core/events.ts";
import { DaemonClient, defaultDaemonEndpoint, fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { UnitId } from "../core/units.ts";
import { cn } from "./cn.ts";

/**
 * 计划 / 任务进度页（ZCode plan-detail 的对位）—— 活跃会话计划的本体可视面。
 *
 * 跟随目标在渲染层解析：workbench 的活跃会话（属于本 bot 时）优先，没有则落
 * 台账里最近一条有 id 的会话 —— tab 只锚 unit，切会话不用重开 tab。
 * 事件面与 LiveSessionPane 同款：session.events.since 补拉 plan.* + 原始广播
 * 实时帧。步骤状态只认事件（proposed 建底、step.updated 翻状态），没有完成度
 * 百分比 —— 步骤权重不等，算出来的数字会骗人（PlanStep 契约注释同款口径）。
 *
 * 现实约束（如实展示）：目前只有 mcode 适配器把原生 plan_update 映射成 plan.*
 * 事件，其他执行器的会话这里会是空态 —— 空态文案直接说清，不装加载中。
 */

interface PlanModel {
  readonly planId: string;
  readonly title: string;
  readonly rationale?: string;
  readonly steps: readonly PlanStep[];
  readonly decision?: "approved" | "rejected" | "edited";
}

function applyPlanEvent(plans: PlanModel[], e: RuntimeEvent): PlanModel[] {
  if (e.type === "plan.proposed") {
    const next: PlanModel = { planId: e.planId, title: e.title, rationale: e.rationale, steps: e.steps };
    const i = plans.findIndex((p) => p.planId === e.planId);
    return i >= 0 ? plans.map((p, j) => (j === i ? { ...next, decision: p.decision } : p)) : [...plans, next];
  }
  if (e.type === "plan.step.updated") {
    return plans.map((p) =>
      p.planId !== e.planId
        ? p
        : { ...p, steps: p.steps.map((s) => (s.id === e.stepId ? { ...s, status: e.status } : s)) },
    );
  }
  if (e.type === "plan.resolved") {
    return plans.map((p) => (p.planId === e.planId ? { ...p, decision: e.decision } : p));
  }
  return plans;
}

const STEP_ICON: Record<PlanStepStatus, typeof CheckCircle2> = {
  pending: CircleDashed,
  in_progress: Loader2,
  done: CheckCircle2,
  skipped: MinusCircle,
  blocked: PauseCircle,
};

const STEP_CLS: Record<PlanStepStatus, string> = {
  pending: "text-ash",
  in_progress: "text-teal",
  done: "text-gain",
  skipped: "text-ash/60",
  blocked: "text-amber-600",
};

function stepLabel(s: PlanStepStatus): string {
  return s === "in_progress" ? "进行中" : s === "done" ? "完成" : s === "skipped" ? "跳过" : s === "blocked" ? "受阻" : "待办";
}

/** 解析跟随目标：活跃会话优先（须属于本 bot），否则台账最近一条有 id 的会话 */
function useFollowedSessionId(unitId: UnitId): { sessionId: string | null; live: boolean } {
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const sessions = useWorkbench((s) => s.sessions);
  const [fallback, setFallback] = useState<string | null>(null);
  /** 每 bot 的台账回退只解析一次：unit 来回切不重复拉，也消掉回退目标在
   *  「活跃会话 / 台账最新」之间来回翻面造成的整段重放抖动 */
  const resolvedRef = useRef(new Set<string>());

  const activeBelongsToUnit =
    activeSessionId !== null && String(activeUnitId) === String(unitId) &&
    sessions.some((x) => String(x.id) === String(activeSessionId));
  const target = activeBelongsToUnit ? String(activeSessionId) : fallback;

  useEffect(() => {
    if (activeBelongsToUnit) return;
    if (resolvedRef.current.has(String(unitId))) return;
    let alive = true;
    // 扫描深度与侧栏历史同口径（100）：台账最新的若干条可能是无 sessionId 的
    // 旧 TUI 行，带 id 的会话在更深处 —— 扫浅了会误报「没有可跟随的会话」
    void fetchUnitHistory(unitId, 100)
      .then((list: readonly UnitHistoryEntry[]) => {
        if (!alive) return;
        resolvedRef.current.add(String(unitId));
        const found = list.find((e) => e.sessionId !== null && e.sessionId !== "");
        setFallback(found?.sessionId ?? null);
      })
      .catch(() => {
        // 瞬时失败不清空既有目标（清了会把正在显示的计划打成空态且不自愈）
      });
    return () => {
      alive = false;
    };
    // activeBelongsToUnit 翻回 false 时沿用缓存，不再重拉
  }, [unitId, activeBelongsToUnit]);

  return { sessionId: target ?? null, live: activeBelongsToUnit };
}

export function PlanPane({ unitId, shown }: { unitId: UnitId; shown: boolean }) {
  const { sessionId, live } = useFollowedSessionId(unitId);
  const [plans, setPlans] = useState<readonly PlanModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 断线重连 / daemon 换代的重建信号（plan 事件不带队内 seq 游标，全量重放最稳） */
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const u1 = client.onResync(() => setReloadKey((k) => k + 1));
    const u2 = client.onGenerationChange(() => setReloadKey((k) => k + 1));
    return () => {
      u1();
      u2();
    };
  }, []);

  useEffect(() => {
    if (sessionId === null) {
      setPlans([]);
      setLoading(false);
      return;
    }
    let alive = true;
    let unsub: (() => void) | undefined;
    /** 回放期间的实时帧先进 stash，响应到达后按到达序合并 —— .then 的整表
     *  替换否则会把这窗口里到的 plan 事件吞掉（applyPlanEvent 幂等，合并安全） */
    const stash: Array<{ seq: number; event: RuntimeEvent }> = [];
    let replayInFlight = true;
    const seqRef = { current: 0 };
    setPlans([]);
    setLoading(true);
    setError(null);
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client
      .rpc<Array<{ seq: number; event: RuntimeEvent }> | null>("session.events.since", { sessionId, afterSeq: 0 }, 20000)
      .then((items) => {
        if (!alive) return;
        replayInFlight = false;
        const bySeq = new Map<number, { seq: number; event: RuntimeEvent }>();
        for (const it of items ?? []) {
          bySeq.set(it.seq, it);
        }
        for (const it of stash) {
          bySeq.set(it.seq, it);
        }
        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        let next: PlanModel[] = [];
        for (const it of merged) {
          if (it.seq > seqRef.current) seqRef.current = it.seq;
          next = applyPlanEvent(next, it.event);
        }
        setPlans(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        replayInFlight = false;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    unsub = client.onEvent((event, seq) => {
      if (!("sessionId" in event) || String(event.sessionId) !== sessionId) return;
      if (event.type !== "plan.proposed" && event.type !== "plan.step.updated" && event.type !== "plan.resolved") return;
      if (seq !== undefined) {
        if (seq <= seqRef.current) return;
        if (replayInFlight) {
          stash.push({ seq, event });
          return;
        }
        seqRef.current = seq;
      } else if (replayInFlight) {
        return;
      }
      setError(null);
      setPlans((prev) => applyPlanEvent([...prev], event));
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [sessionId, reloadKey]);

  const latest = plans.length > 0 ? plans[plans.length - 1]! : null;
  const doneCount = latest !== null ? latest.steps.filter((s) => s.status === "done").length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <ListChecks size={13} className="shrink-0 text-teal" />
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink">
          {latest !== null ? latest.title : "计划 / 任务进度"}
        </span>
        {latest !== null && (
          <span className="tnum shrink-0 text-[10px] text-ash" title="done/total，不做百分比（步骤权重不等）">
            {doneCount}/{latest.steps.length}
          </span>
        )}
        {live && (
          <span className="shrink-0 rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal" title="跟随当前对话页的活跃会话">
            活跃会话
          </span>
        )}
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <p className="flex items-center gap-1.5 text-caption text-ash">
            <Loader2 size={11} className="animate-spin" />
            读取会话计划…
          </p>
        ) : error !== null ? (
          <p className="text-caption text-loss">{error}</p>
        ) : sessionId === null ? (
          <EmptyBlock
            title="这个 bot 还没有可跟随的会话"
            desc="发起一次对话（或让自动化跑一轮）之后，计划会跟随它的会话出现在这里。"
          />
        ) : latest === null ? (
          <EmptyBlock
            title="当前跟随的会话还没有报告过计划"
            desc={`跟随的会话：${sessionId}。计划来自执行器的原生任务清单 —— mcode 的 plan_update 帧，以及 Claude TodoWrite / Codex update_plan 等清单类工具（daemon 统一映射）；这家执行器在这场会话里还没用过。`}
          />
        ) : (
          <div className="space-y-2">
            {latest.decision !== undefined && (
              <p
                className={cn(
                  "rounded-btn border px-2 py-1 text-caption",
                  latest.decision === "rejected" ? "border-loss/30 bg-loss/5 text-loss" : "border-teal-edge bg-teal-tint/40 text-teal",
                )}
              >
                {latest.decision === "approved" ? "计划已批准" : latest.decision === "rejected" ? "计划被否决" : "计划修改后批准"}
              </p>
            )}
            {latest.rationale !== undefined && latest.rationale !== "" && (
              <p className="rounded-btn bg-line-soft/40 px-2 py-1.5 text-caption leading-relaxed text-graphite">{latest.rationale}</p>
            )}
            <ol className="space-y-1">
              {latest.steps.map((step, i) => {
                const Icon = STEP_ICON[step.status];
                return (
                  <li key={step.id} className="flex items-start gap-2 rounded-btn px-1.5 py-1.5 hover:bg-line-soft/40">
                    <Icon
                      size={13}
                      className={cn("mt-0.5 shrink-0", STEP_CLS[step.status], step.status === "in_progress" && "animate-spin")}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-caption",
                          step.status === "done" || step.status === "skipped" ? "text-graphite/70" : "text-ink",
                          step.status === "done" && "line-through decoration-ash/50",
                        )}
                      >
                        <span className="tnum mr-1 text-ash">{i + 1}.</span>
                        {step.title}
                      </span>
                      {step.detail !== undefined && step.detail !== "" && (
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-ash">{step.detail}</span>
                      )}
                    </span>
                    <span className={cn("shrink-0 text-[10px]", STEP_CLS[step.status])}>{stepLabel(step.status)}</span>
                  </li>
                );
              })}
            </ol>
            {plans.length > 1 && (
              <p className="pt-1 text-[10px] text-ash/70">本会话共提出过 {plans.length} 份计划，显示最新一份</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyBlock({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-card border border-dashed border-line px-3 py-6 text-center">
      <p className="text-caption font-medium text-graphite">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ash">{desc}</p>
    </div>
  );
}
