import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  History,
  ListTodo,
  MessageSquare,
  Terminal,
  X,
} from "lucide-react";
import { fetchSessionMessages, fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/**
 * 单元历史会话 —— 每个 bot 一条统一时间轴：自动化任务、待办任务、心跳会话、
 * 手动/IM 会话。核心目的是「打开就能看到这个 bot 历史执行过什么」，不用再去
 * 各执行器的 TUI 会话列表里翻。
 *
 * - headless 条目带 sessionId，可展开内联看对话（session.messages，daemon 对
 *   历史会话有 store 兜底）
 * - TUI 条目没有消息流，只有运行状态与结果摘要（terminal exit / ended: …）
 */

const KIND_META: Record<UnitHistoryEntry["kind"], { icon: typeof History; label: string; cls: string }> = {
  automation: { icon: AlarmClock, label: "定时", cls: "bg-teal-tint text-teal" },
  backlog: { icon: ListTodo, label: "待办", cls: "bg-amber-500/10 text-amber-600" },
  session: { icon: MessageSquare, label: "会话", cls: "bg-line-soft text-graphite" },
};

function statusMeta(status: string): { icon: typeof CircleCheck; cls: string; label: string } {
  if (status === "done" || status === "completed" || status === "idle") {
    return { icon: CircleCheck, cls: "text-gain", label: "完成" };
  }
  if (status === "failed") return { icon: CircleAlert, cls: "text-loss", label: "失败" };
  if (status === "skipped") return { icon: CircleAlert, cls: "text-ash", label: "跳过" };
  if (status === "running") return { icon: CircleDot, cls: "text-blue-500 animate-pulse", label: "运行中" };
  return { icon: CircleDot, cls: "text-graphite", label: status };
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return hm;
  return `${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${hm}`;
}

function formatDuration(entry: UnitHistoryEntry): string | null {
  if (entry.endedAt === null) return null;
  const s = Math.round((entry.endedAt - entry.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function HistoryDialog({
  unitId,
  unitName,
  onClose,
  focusKey,
}: {
  unitId: string;
  unitName: string;
  onClose: () => void;
  /** 侧栏子列表点进来时预展开的条目（对话直接可见，不用再点一次） */
  focusKey?: string;
}): ReactElement {
  const [entries, setEntries] = useState<readonly UnitHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(focusKey ?? null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setErr(null);
    setExpanded(null);
    void fetchUnitHistory(unitId, 200)
      .then((list) => {
        if (alive) setEntries(list);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [unitId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${unitName} 历史会话`}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] max-h-[92vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <History size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">{unitName} · 历史会话</p>
          <span className="text-caption text-ash">{entries === null ? "加载中…" : `${entries.length} 条`}</span>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {err !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>}
          {entries !== null && entries.length === 0 && (
            <p className="px-1 py-6 text-center text-caption text-ash">还没有执行记录 —— 自动化、待办或手动会话跑过之后会出现在这里</p>
          )}
          {entries !== null && entries.map((e) => (
            <HistoryRow
              key={e.key}
              entry={e}
              expanded={expanded === e.key}
              onToggle={() => setExpanded(expanded === e.key ? null : e.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function HistoryRow({ entry, expanded, onToggle }: { entry: UnitHistoryEntry; expanded: boolean; onToggle: () => void }): ReactElement {
  const kind = KIND_META[entry.kind];
  const st = useMemo(() => statusMeta(entry.status), [entry.status]);
  const dur = formatDuration(entry);
  const KIcon = kind.icon;
  const SIcon = st.icon;
  const expandable = entry.sessionId !== null;

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        onClick={expandable ? onToggle : undefined}
        className={cn(
          "flex w-full items-start gap-2 rounded-btn px-2 py-2 text-left transition",
          expandable ? "hover:bg-line-soft" : "cursor-default",
        )}
        title={expandable ? "点击查看对话内容" : entry.launchMode === "terminal" ? "TUI 执行：无对话流，只有运行结果" : undefined}
      >
        <span className={cn("mt-0.5 shrink-0 rounded-chip px-1.5 py-0.5 text-[10px]", kind.cls)}>
          <KIcon size={10} className="mr-0.5 inline-block align-[-1px]" />
          {kind.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{entry.title}</span>
            <SIcon size={12} className={cn("shrink-0", st.cls)} />
            <span className={cn("shrink-0 text-caption", st.cls)}>{st.label}</span>
            {dur !== null && <span className="shrink-0 text-caption text-ash">{dur}</span>}
            <span className="shrink-0 text-caption text-ash">{formatWhen(entry.startedAt)}</span>
            {expandable && (expanded ? <ChevronDown size={13} className="shrink-0 text-ash" /> : <ChevronRight size={13} className="shrink-0 text-ash" />)}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-caption">
            <span className="font-mono text-ash">{entry.runtimeId}</span>
            <span className={cn("rounded-chip px-1 py-px", entry.launchMode === "terminal" ? "bg-teal-tint text-teal" : "bg-line-soft text-ash")}>
              {entry.launchMode === "terminal" ? (
                <>
                  <Terminal size={9} className="mr-0.5 inline-block align-[-1px]" />
                  TUI
                </>
              ) : (
                "后台"
              )}
            </span>
            {entry.subtitle !== null && <span className="min-w-0 flex-1 truncate text-ash">{entry.subtitle}</span>}
          </span>
          {entry.detail !== null && entry.detail !== "" && (
            <span className="mt-0.5 block truncate text-caption text-ash" title={entry.detail}>
              {entry.detail}
            </span>
          )}
        </span>
      </button>
      {expanded && entry.sessionId !== null && <SessionMessages sessionId={entry.sessionId} />}
    </div>
  );
}

/** 展开的对话内容：user/assistant 两栏流（工具消息等次要角色灰显） */
function SessionMessages({ sessionId }: { sessionId: string }): ReactElement {
  const [msgs, setMsgs] = useState<Array<{ at: number; role: string; text: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchSessionMessages(sessionId)
      .then((rows) => {
        if (alive) setMsgs(rows);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (err !== null) return <p className="px-4 pb-2 text-caption text-loss">消息读取失败：{err}</p>;
  if (msgs === null) return <p className="px-4 pb-2 text-caption text-ash">读取对话…</p>;
  if (msgs.length === 0) return <p className="px-4 pb-2 text-caption text-ash">这条会话没有留下消息记录</p>;

  return (
    <div className="mx-2 mb-2 max-h-72 space-y-1.5 overflow-y-auto rounded-btn bg-rail p-2.5">
      {msgs.map((m, i) => (
        <div key={i} className="flex items-start gap-2">
          <span
            className={cn(
              "w-14 shrink-0 text-right text-caption",
              m.role === "user" ? "text-teal" : m.role === "assistant" ? "text-graphite" : "text-ash/60",
            )}
          >
            {m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role}
          </span>
          <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed", m.role === "user" ? "text-ink" : "text-graphite")}>
            {m.text === "" ? "（空）" : m.text}
          </p>
        </div>
      ))}
    </div>
  );
}
