import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Loader2, Radio } from "lucide-react";
import type { RuntimeEvent } from "../core/events.ts";
import { liveTabId } from "../core/sidePaneTabs.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { executorIconSrc } from "./executorIcon.ts";
import { cn } from "./cn.ts";

/**
 * 会话实时监控页（ZCode bash-output / subagent-session 的对位）—— 后台会话的
 * 伴随视角：自动化定时任务、待办长任务、IM 渠道发起的会话在跑的过程中就能看。
 *
 * 数据面刻意不走 RuntimeAdapter（它会话泵只投递本端 startSession/resume 过的
 * 会话，后台会话进不了它的跟踪集）：直接订阅 DaemonClient 的原始广播（全量
 * 事件、带 seq），进场先用 session.events.since 从头补拉，之后实时帧按 seq
 * 判重追加 —— 与适配器同一条口径，只是自管一份游标。
 *
 * 渲染是「日志带」而不是聊天时间线：监控的诉求是看见它在干什么（工具调用、
 * 状态翻转、错误），不是重放完整对话。正文块（用户 / 助手消息）聚合为块，
 * 工具与状态事件一行一条。事件上限 500 条，防长会话无界涨内存。
 */

/** 单条展示行。正文块（连续 delta 聚合）与事件行混排在同一个数组里 */
type Row =
  | { rid: number; kind: "text"; at: number; role: "user" | "assistant"; text: string }
  | { rid: number; kind: "reasoning"; at: number; chars: number }
  | { rid: number; kind: "tool"; at: number; callId: string; name: string; phase: "started" | "completed"; ok?: boolean }
  | { rid: number; kind: "status"; at: number; label: string; tone: "info" | "warn" | "loss" | "ok" }
  | { rid: number; kind: "usage"; at: number; label: string };

const MAX_ROWS = 500;

/** Omit 在联合上不分发（会塌成公共键），分发版保住各成员的字段 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RowBody = DistributiveOmit<Row, "rid">;

function appendEvent(rows: readonly Row[], e: RuntimeEvent, rid: () => number): readonly Row[] {
  const last = rows[rows.length - 1];
  const push = (r: RowBody): Row[] => {
    const next = [...rows, { ...r, rid: rid() } as Row];
    return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
  };
  switch (e.type) {
    case "session.started":
      return push({ kind: "status", at: Date.now(), label: "会话开始", tone: "info" });
    case "turn.started":
      return push({ kind: "status", at: Date.now(), label: `第 ${e.turn} 轮开始`, tone: "info" });
    case "turn.completed":
      return push({ kind: "status", at: Date.now(), label: "本轮完成", tone: "ok" });
    case "message.delta": {
      if (e.role !== "user" && e.role !== "assistant") return rows;
      // 连续 delta 聚合进上一块（同角色）；角色切换开新块
      if (last !== undefined && last.kind === "text" && last.role === e.role) {
        const merged: Row = { ...last, text: (last.text + e.text).slice(0, 20000) };
        return [...rows.slice(0, -1), merged];
      }
      return push({ kind: "text", at: Date.now(), role: e.role, text: e.text.slice(0, 20000) });
    }
    case "message.completed":
      // completed 是权威全文（无 role 字段）：收敛末块，没有可收敛的块才补一块
      if (last !== undefined && last.kind === "text") {
        return [...rows.slice(0, -1), { ...last, text: e.text.slice(0, 20000) }];
      }
      if (e.text !== "") {
        return push({ kind: "text", at: Date.now(), role: "assistant", text: e.text.slice(0, 20000) });
      }
      return rows;
    case "reasoning.delta":
      if (last !== undefined && last.kind === "reasoning") {
        return [...rows.slice(0, -1), { ...last, chars: last.chars + e.text.length }];
      }
      return push({ kind: "reasoning", at: Date.now(), chars: e.text.length });
    case "tool.started":
      return push({ kind: "tool", at: Date.now(), callId: e.callId, name: e.toolName, phase: "started" });
    case "tool.completed": {
      // completed 不带工具名：回溯同 callId 的 started 行配对收口
      const i = rows.findIndex((r) => r.kind === "tool" && r.callId === e.callId && r.phase === "started");
      if (i >= 0) {
        const started = rows[i] as Extract<Row, { kind: "tool" }>;
        const closed: Row = { ...started, phase: "completed", ok: e.ok };
        return [...rows.slice(0, i), closed, ...rows.slice(i + 1)];
      }
      return push({ kind: "tool", at: Date.now(), callId: e.callId, name: "工具", phase: "completed", ok: e.ok });
    }
    case "permission.requested":
      return push({ kind: "status", at: Date.now(), label: `等待审批：${e.detail}`, tone: "warn" });
    case "permission.resolved":
      return push({
        kind: "status",
        at: Date.now(),
        label: `审批：${e.decision === "allow" ? "允许" : e.decision === "deny" ? "拒绝" : "始终允许"}`,
        tone: e.decision === "deny" ? "warn" : "info",
      });
    case "session.status":
      return push({
        kind: "status",
        at: Date.now(),
        label: e.status,
        tone: e.status.startsWith("failed") ? "loss" : e.status === "idle" || e.status === "done" ? "ok" : "info",
      });
    case "plan.proposed":
      return push({ kind: "status", at: Date.now(), label: `提出计划：${e.title}（${e.steps.length} 步）`, tone: "info" });
    case "plan.step.updated":
      return push({ kind: "status", at: Date.now(), label: `计划步骤 ${e.stepId} → ${e.status}`, tone: "info" });
    case "plan.resolved":
      return push({
        kind: "status",
        at: Date.now(),
        label: e.decision === "approved" ? "计划已批准" : e.decision === "rejected" ? "计划被否决" : "计划已改后批准",
        tone: e.decision === "rejected" ? "warn" : "ok",
      });
    case "usage":
      return push({
        kind: "usage",
        at: Date.now(),
        label: `用量 ${e.inputTokens}→${e.outputTokens} tok${e.costUsd > 0 ? ` · $${e.costUsd.toFixed(4)}` : ""}`,
      });
    case "error":
      return push({ kind: "status", at: Date.now(), label: e.message, tone: "loss" });
    case "session.ended":
      return push({
        kind: "status",
        at: Date.now(),
        label: `会话结束（${e.reason === "error" ? "出错" : e.reason === "cancelled" ? "取消" : e.reason}）`,
        tone: e.reason === "error" ? "loss" : "ok",
      });
    case "subagent.spawned":
      return push({ kind: "status", at: Date.now(), label: `子代理启动：${e.role}（${e.runtimeId}）`, tone: "info" });
    case "subagent.finished":
      return push({ kind: "status", at: Date.now(), label: `子代理结束：${e.childId}`, tone: "info" });
    case "deliverable":
      return push({ kind: "status", at: Date.now(), label: `产出：${e.title}`, tone: "ok" });
    case "system.notice":
      return push({ kind: "status", at: Date.now(), label: `${e.title}${e.text !== "" ? ` · ${e.text}` : ""}`, tone: e.level === "warn" ? "warn" : "info" });
    case "file.changed":
      return push({ kind: "status", at: Date.now(), label: `文件${e.change === "created" ? "新建" : e.change === "deleted" ? "删除" : "修改"}：${e.path}`, tone: "info" });
    case "file.diff":
      return push({
        kind: "status",
        at: Date.now(),
        label: `diff：${e.path} +${e.additions} -${e.deletions}`,
        tone: "info",
      });
    case "steer.queue":
    case "steer.queued":
    case "steer.boundary":
    case "steer.undelivered":
    case "session.ref":
      return push({ kind: "status", at: Date.now(), label: e.type, tone: "info" });
    default:
      return rows;
  }
}

export function LiveSessionPane({
  sessionId,
  runtimeId,
  title,
  shown,
}: {
  sessionId: string;
  runtimeId: string;
  title: string;
  /** 面板可见且本 tab 激活（保活协议：隐藏时停轮询/滚动，数据流仍跟随） */
  shown: boolean;
}) {
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户上翻时停止自动跟随；回到底部恢复 */
  const followRef = useRef(true);
  const seqRef = useRef(0);
  /** 行 id 单调计数器：行 key 不随前部裁剪漂移（500 行满员后每事件裁一行，
   *  index key 会让整列重渲染，rid key 只动首尾） */
  const ridRef = useRef(0);
  const nextRid = useCallback(() => ++ridRef.current, []);
  /** 断线重连 / daemon 换代的重建信号（换代后 seq 空间归零，旧游标会把
   *  后续所有帧判重丢弃 —— 只能整段重放；重连同样全量补洞） */
  const [reloadKey, setReloadKey] = useState(0);
  /** shown 的最新值：跟随 effect 不依赖 shown（隐藏时数据流仍跟随），闭包里
   *  读它会过期 —— 未读点判定必须用 ref（bumpUnread 只在该 tab 非激活时打） */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const u1 = client.onResync(() => setReloadKey((k) => k + 1));
    const u2 = client.onGenerationChange(() => setReloadKey((k) => k + 1));
    return () => {
      u1();
      u2();
    };
  }, []);

  // 补拉 + 实时跟随：sessionId / 重建信号变化即重放。rows 全量重置。
  // 回放期间的实时帧先进 stash（adapter.ts 的同款手法）：.then 的整表替换
  // 会把已追加的实时行连同其 seq 一起吞掉 —— seq 游标已消费，事件就永久
  // 丢了。响应到达后按 seq 全序合并去重，再一次性重建。
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    const stash: Array<{ seq: number; event: RuntimeEvent }> = [];
    let replayInFlight = true;
    setLoading(true);
    setError(null);
    setEnded(null);
    setRows([]);
    seqRef.current = 0;
    followRef.current = true;
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client
      .rpc<Array<{ seq: number; event: RuntimeEvent }> | null>("session.events.since", { sessionId, afterSeq: 0 }, 20000)
      .then((items) => {
        if (!alive) return;
        replayInFlight = false;
        // 回放窗口期的实时帧只进了 stash、没走下面的 bump 分支：面板没看着时，
        // 这批合并补进来的内容同样该有一次未读点（重连 / 重建补洞时尤其如此）
        const hadStash = stash.length > 0;
        const bySeq = new Map<number, { seq: number; event: RuntimeEvent }>();
        for (const it of items ?? []) {
          bySeq.set(it.seq, it);
        }
        for (const it of stash) {
          bySeq.set(it.seq, it);
        }
        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        let next: readonly Row[] = [];
        for (const it of merged) {
          if (it.seq > seqRef.current) seqRef.current = it.seq;
          if (it.event.type === "session.ended") setEnded(it.event.reason);
          next = appendEvent(next, it.event, nextRid);
        }
        setRows(next);
        if (hadStash && !shownRef.current) useSidePane.getState().bumpUnread(liveTabId(sessionId));
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
      if (event.type === "session.ended") setEnded(event.reason);
      // 回放失败后实时帧继续到达：错误态不能把活数据挡在后面
      setError(null);
      setRows((prev) => appendEvent(prev, event, nextRid));
      // 面板没看着（切走了 / 收起了）→ tab 上打未读点，聚焦时清；alive 挡掉
      // 卸载与关 tab 之间仍在途的帧（别给已卸载的 tab 打点）
      if (alive && !shownRef.current) useSidePane.getState().bumpUnread(liveTabId(sessionId));
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [sessionId, reloadKey, nextRid]);

  // 自动跟随：追加行后若在底部则滚到底。loading 必须进 deps —— setRows 与
  // setLoading(false) 分属两个微任务、两次提交，首次回放完成时内容才真正
  // 上屏，只盯 rows 会滚在一个还撑不开高度的空容器上（回放已结束的会话
  // 再也不会有下一条事件来自愈）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !shown || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, shown, loading]);

  const iconSrc = useMemo(() => executorIconSrc(runtimeId), [runtimeId]);
  const bareExec = runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：会话身份 + 跟随灯 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" title={`执行器：${runtimeId}`}>
          {iconSrc ? (
            <img src={iconSrc} alt={runtimeId} className="h-4 w-4 object-contain" />
          ) : (
            <span className="flex h-4 w-4 items-center justify-center rounded-[2px] bg-line-soft text-[8px] font-semibold uppercase text-ash">
              {bareExec.slice(0, 2)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink" title={title}>
          {title || `会话 ${sessionId}`}
        </span>
        {ended === null ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-teal" title="正在实时跟随该会话的事件流">
            <Radio size={10} className="animate-pulse" />
            跟随中
          </span>
        ) : (
          <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">已结束</span>
        )}
      </div>

      {/* 日志带 */}
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed"
      >
        {loading ? (
          <p className="flex items-center gap-1.5 px-1 py-2 text-caption text-ash">
            <Loader2 size={11} className="animate-spin" />
            回放事件流…
          </p>
        ) : error !== null ? (
          <p className="flex items-start gap-1.5 px-1 py-2 text-caption text-loss">
            <CircleAlert size={11} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-2 text-caption text-ash">还没有可显示的事件 —— 会话一有动静就会出现在这里。</p>
        ) : (
          rows.map((row) => {
            if (row.kind === "text") {
              return (
                <div
                  key={row.rid}
                  className={cn(
                    "mb-1 whitespace-pre-wrap break-words rounded-btn px-2 py-1",
                    row.role === "user" ? "bg-teal-tint/60 text-graphite" : "bg-line-soft/50 text-graphite",
                  )}
                >
                  <span className={cn("mr-1 select-none font-sans text-[9px] font-semibold", row.role === "user" ? "text-teal" : "text-ash")}>
                    {row.role === "user" ? "用户" : "助手"}
                  </span>
                  {row.text}
                </div>
              );
            }
            if (row.kind === "reasoning") {
              return (
                <p key={row.rid} className="px-2 py-0.5 text-ash/80">
                  <span className="select-none">✻ 思考 {row.chars} 字…</span>
                </p>
              );
            }
            if (row.kind === "tool") {
              return (
                <p key={row.rid} className="px-2 py-0.5 text-graphite">
                  <span className="select-none mr-1" aria-hidden>
                    {row.phase === "started" ? "▶" : row.ok === false ? "✗" : "✓"}
                  </span>
                  工具 {row.name}
                </p>
              );
            }
            if (row.kind === "usage") {
              return (
                <p key={row.rid} className="px-2 py-0.5 text-ash/70">
                  {row.label}
                </p>
              );
            }
            return (
              <p
                key={row.rid}
                className={cn(
                  "px-2 py-0.5 font-sans text-[10px]",
                  row.tone === "loss" && "text-loss",
                  row.tone === "warn" && "text-amber-600",
                  row.tone === "ok" && "text-gain",
                  row.tone === "info" && "text-ash",
                )}
              >
                · {row.label}
              </p>
            );
          })
        )}
      </div>
    </div>
  );
}
