import { X } from "lucide-react";
import type { TaskEntry, TaskbarStatus } from "../../store/useTaskbar.ts";
import { useTaskbar } from "../../store/useTaskbar.ts";
import { useAppearance } from "../../store/useAppearance.ts";
import { botAvatarStyle } from "../Sidebar.tsx";
import { cn } from "../cn.ts";

/**
 * 任务栏单条 chip —— 音乐播放器「正在播放的曲目」的对位。点击跳回对话；
 * 完成/失败/停靠的条目 hover 出关闭钮（运行中的不给关——它还活着，关了就失联）。
 *
 * 状态是第一信息，灯的尺寸与色板对齐左侧栏历史列表（Sidebar 的
 * HISTORY_DOT_CLS + h-1.5 w-1.5）：蓝呼吸=运行、绿=完成未读、红=失败、
 * 静态蓝=停靠（进程开着但没在跑）；唯一超出侧栏口径的一档是待裁决/待输入
 * ——琥珀呼吸（蓝只说「在跑」，琥珀说「在等你」），并辅以琥珀描边与角标。
 *
 * 两种形态随底栏高度切换（高度可拖拽，默认最薄 28px）：
 * - 单行紧凑（默认）：灯 + 头像 + 标题 + 计时，一行放下，图标缩小；
 * - 详情行（拉高后）：标题下方多一行「正在干什么」（工具调用/输出摘要）。
 */

export const TASK_STATUS_META: Record<TaskbarStatus, { dot: string; label: string }> = {
  running: { dot: "bg-blue-500 animate-pulse", label: "运行中" },
  // 待裁决/待输入用琥珀呼吸：蓝灯只说「在跑」，琥珀说「在等你行动」——
  // 与工作状态徽标的「待确认」同色系，是最需要被立刻看见的一档
  awaiting_permission: { dot: "bg-amber-500 animate-pulse", label: "待裁决" },
  awaiting_input: { dot: "bg-amber-500 animate-pulse", label: "待输入" },
  done: { dot: "bg-gain", label: "已完成" },
  failed: { dot: "bg-loss", label: "失败" },
  parked: { dot: "bg-blue-500/70", label: "已折叠" },
};

/** 条目排序权重：等你裁决的排最前（它在等你），运行中新者优先，完成未读
 *  是注意信号排在停靠之前，停靠（主动收起的上下文）殿后于所有提醒 */
export function taskSortWeight(s: TaskbarStatus): number {
  if (s === "awaiting_permission") return 0;
  if (s === "awaiting_input") return 1;
  if (s === "running") return 2;
  if (s === "done") return 3;
  if (s === "parked") return 4;
  return 5;
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** bot 头像的微缩版（侧栏 UnitRow 同款视觉：自定义图优先，缺省身份色+双眼） */
export function EntryAvatar({ entry, size = 18 }: { entry: TaskEntry; size?: number }) {
  const frame = useAppearance((s) => s.avatarFrame);
  const style = botAvatarStyle(entry.unitName, frame);
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center overflow-hidden", style.shape)}
      style={{ width: size, height: size, ...(entry.avatar ? undefined : { background: style.color }) }}
    >
      {entry.avatar ? (
        <img src={entry.avatar} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex gap-0.5">
          <span className="h-1 w-0.5 rounded-full bg-white/90" />
          <span className="h-1 w-0.5 rounded-full bg-white/90" />
        </span>
      )}
    </span>
  );
}

export function TaskChip({ entry, now, detail }: { entry: TaskEntry; now: number; detail: boolean }) {
  const jumpTo = useTaskbar((s) => s.jumpTo);
  const dismiss = useTaskbar((s) => s.dismiss);
  const meta = TASK_STATUS_META[entry.status];
  const running =
    entry.status === "running" || entry.status === "awaiting_permission" || entry.status === "awaiting_input";
  const awaiting = entry.status === "awaiting_permission" || entry.status === "awaiting_input";
  const closable = !running;
  const timeText = running
    ? fmtElapsed(now - entry.startedAt)
    : entry.endedAt !== null
      ? new Date(entry.endedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : "";
  return (
    <div className="group/chip relative shrink-0">
      <button
        data-taskbar-session={entry.sessionId}
        onClick={() => jumpTo(entry.sessionId)}
        aria-label={`${entry.unitName}：${meta.label}${entry.title !== "" ? `，${entry.title}` : ""}，点击回到对话`}
        title={`${entry.unitName} —— ${meta.label}${entry.activityText !== "" ? ` · ${entry.activityText}` : ""}\n点击回到这场对话`}
        className={cn(
          "flex items-center gap-1.5 rounded-btn border border-line-soft bg-card pl-1.5 text-left transition-colors hover:border-teal/50 hover:bg-line-soft",
          detail ? "h-8 max-w-[280px]" : "h-5 max-w-[220px]",
          detail ? (closable ? "pr-7" : "pr-2") : closable ? "pr-5" : "pr-1.5",
          awaiting && "border-amber-500/40",
        )}
      >
        {/* 状态灯：侧栏同款尺寸与色板（第一信息） */}
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
        <EntryAvatar entry={entry} size={detail ? 18 : 14} />
        {detail ? (
          <span className="flex min-w-0 flex-col items-start leading-tight">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-caption font-medium text-ink">{entry.title}</span>
              {awaiting && <span className="shrink-0 text-[10px] font-medium text-amber-600">待裁决</span>}
            </span>
            <span className="max-w-full truncate text-[10px] text-ash">
              {running ? (entry.activityText !== "" ? entry.activityText : meta.label) : meta.label}
            </span>
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate text-[11px] text-ink">{entry.title}</span>
            {awaiting && <span className="shrink-0 text-[10px] font-medium text-amber-600">待</span>}
          </>
        )}
        <span className={cn("shrink-0 tabular-nums text-ash", detail ? "text-caption" : "text-[10px]")}>
          {timeText}
        </span>
      </button>
      {closable && (
        <button
          onClick={() => dismiss(entry.sessionId)}
          aria-label={`关闭：${entry.title}（${meta.label}）`}
          title="从底栏移除这条（不影响会话本身，历史里随时可回看）"
          className={cn(
            "absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full text-ash opacity-0 transition-opacity hover:bg-line hover:text-ink group-hover/chip:opacity-100",
            detail ? "h-4 w-4" : "h-3.5 w-3.5",
          )}
        >
          <X size={detail ? 10 : 9} />
        </button>
      )}
    </div>
  );
}
