import { useEffect, useState } from "react";
import { ListMusic } from "lucide-react";
import { isLiveTask, useTaskbar, type TaskEntry } from "../../store/useTaskbar.ts";
import { useShell } from "../../store/useShell.ts";
import { EntryAvatar, TaskChip, TASK_STATUS_META, taskSortWeight } from "./TaskChip.tsx";
import { cn } from "../cn.ts";

/**
 * 任务栏 —— 底栏「正在播放」列表（音乐播放器隐喻）。GlobalStatusBar 常驻挂载
 * 本组件（而不是有任务才挂）：attach() 里的全局事件订阅 / 离开视图侦测必须
 * 在空栏时期就活着，后台自动化/渠道会话才会从第一秒起进榜。
 *
 * 可见 chips 上限 3 条，其余折进「+N」播放列表弹层（StatusIndicators 的
 * popoverUp 模式：fixed 遮罩关层 + absolute bottom-full 左锚定弹层）。
 */

const VISIBLE_CHIPS = 3;

function sortEntries(entries: readonly TaskEntry[]): TaskEntry[] {
  return [...entries].sort((a, b) => {
    const wa = taskSortWeight(a.status);
    const wb = taskSortWeight(b.status);
    if (wa !== wb) return wa - wb;
    // 同权重：活任务新的在前（刚切走的最醒目），完成条目近完成在前
    const ka = isLiveTask(a.status) ? a.startedAt : (a.endedAt ?? a.startedAt);
    const kb = isLiveTask(b.status) ? b.startedAt : (b.endedAt ?? b.startedAt);
    return kb - ka;
  });
}

export function Taskbar() {
  const entries = useTaskbar((s) => s.entries);
  const jumpTo = useTaskbar((s) => s.jumpTo);
  // 底栏高度档位：40px 以上给 chip 的「正在干什么」详情行（上限 44 = 详情
  // chip 的最高占用）—— 默认最薄一档（28px）单行紧凑，高度恒定不因任务出现而变化
  const barHeight = useShell((s) => s.statusBarHeight);
  const detail = barHeight >= 40;
  // 全局侦听挂载（幂等）：台账补种 / daemon 事件 / 离开视图侦测都在里面
  useEffect(() => {
    useTaskbar.getState().attach();
  }, []);
  // 计时心跳：只在有活任务时走秒（完成条目的时刻文本不需要刷新）
  const [, setTick] = useState(0);
  const hasRunning = entries.some((e) => isLiveTask(e.status));
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  const [listOpen, setListOpen] = useState(false);
  const sorted = sortEntries(entries);
  const visible = sorted.slice(0, VISIBLE_CHIPS);
  const rest = sorted.slice(VISIBLE_CHIPS);
  const now = Date.now();
  // 溢出区里藏着「等你」的条目时，+N 钮本身也要亮琥珀——不能让待裁决沉底看不见
  const restUrgent = rest.some((e) => e.status === "awaiting_permission" || e.status === "awaiting_input");

  if (sorted.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {visible.map((e) => (
        <TaskChip key={e.sessionId} entry={e} now={now} detail={detail} />
      ))}
      {rest.length > 0 && (
        <div className="relative shrink-0">
          <button
            data-taskbar-more
            onClick={() => setListOpen((o) => !o)}
            aria-label={`还有 ${rest.length} 个任务，点开列表`}
            aria-expanded={listOpen}
            title={`还有 ${rest.length} 个任务（播放列表）`}
            className={cn(
              "flex items-center gap-1 rounded-btn px-2 text-caption text-graphite transition-colors hover:bg-line-soft hover:text-ink",
              detail ? "h-8" : "h-5",
              restUrgent && "text-amber-600",
            )}
          >
            <ListMusic size={12} />
            +{rest.length}
          </button>
          {listOpen && (
            <>
              <span className="fixed inset-0 z-30" onClick={() => setListOpen(false)} aria-hidden />
              <div className="absolute bottom-full mb-1.5 left-0 z-40 max-h-80 w-96 overflow-y-auto rounded-card border border-line bg-canvas p-1.5 shadow-subtle">
                <p className="px-2 pb-1 pt-0.5 text-caption text-ash">运行与完成清单（{sorted.length}）</p>
                {sorted.map((e) => {
                  const meta = TASK_STATUS_META[e.status];
                  return (
                    <button
                      key={e.sessionId}
                      onClick={() => {
                        setListOpen(false);
                        jumpTo(e.sessionId);
                      }}
                      title={`回到 ${e.unitName} 的这场对话`}
                      className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left transition-colors hover:bg-line-soft"
                    >
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
                      <EntryAvatar entry={e} size={16} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-body-sm text-ink">{e.title}</span>
                        <span className="truncate text-caption text-ash">
                          {e.unitName} · {e.activityText !== "" ? e.activityText : meta.label}
                        </span>
                      </span>
                      <span className="shrink-0 text-caption text-ash">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
