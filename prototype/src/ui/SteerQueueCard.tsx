import { Clock, Pencil, Play, SendHorizontal, Trash2 } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";

/**
 * 待发送队列卡片（ZCode ConversationQueuePanel 位型）—— 渲染在输入框上方。
 *
 * 数据只来自 store.steerQueues[活跃会话]（daemon 权威快照，steer.queue 事件驱动），
 * 这里不做任何本地排队推演。三个操作：
 * - 立刻发送：取消当前轮，轮落定后这条优先进去（session.queue.sendNow）
 * - 编辑：先删权威面，成功后文本回填输入框（session.queue.remove + setDraft）
 * - 删除：session.queue.remove
 */
export function SteerQueueCard() {
  const queue = useWorkbench((s) =>
    s.activeSessionId === null ? undefined : s.steerQueues[String(s.activeSessionId)],
  );
  const busy = useWorkbench((s) => s.busy);
  const sendQueuedNow = useWorkbench((s) => s.sendQueuedNow);
  const removeQueuedSend = useWorkbench((s) => s.removeQueuedSend);
  const editQueuedSend = useWorkbench((s) => s.editQueuedSend);
  const resumeQueuedSends = useWorkbench((s) => s.resumeQueuedSends);

  const items = queue?.items ?? [];
  if (items.length === 0) return null;
  const paused = queue?.paused ?? false;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-teal/25 bg-teal-tint/15 text-caption">
      <div className="flex items-center gap-1.5 border-b border-line-soft/60 px-3 py-1.5 text-graphite">
        <Clock size={12} className="shrink-0 text-teal" />
        <span className="shrink-0 font-medium text-ink">待发送 {items.length} 条</span>
        <span className="min-w-0 flex-1 truncate">
          {paused
            ? "—— 队列已暂停（停止或上一轮失败后不再自动发送）"
            : busy
              ? "—— 当前轮完成后自动发出"
              : "—— 即将发出…"}
        </span>
      </div>
      <ul className="divide-y divide-line-soft/50">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-ink" title={item.text}>
              {item.text.replace(/\s+/g, " ").trim()}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void sendQueuedNow(item.id)}
                className="flex items-center gap-1 rounded-btn bg-teal/10 px-1.5 py-0.5 text-[11px] font-medium text-teal transition hover:bg-teal/20"
                title="取消当前轮，让这条消息立刻发出去"
              >
                <SendHorizontal size={11} />
                <span>立刻发送</span>
              </button>
              <button
                type="button"
                onClick={() => void editQueuedSend(item.id)}
                className="flex items-center justify-center rounded-btn p-1 text-graphite transition hover:bg-line-soft hover:text-ink"
                title="取回输入框编辑（这条会从队列移除）"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => void removeQueuedSend(item.id)}
                className="flex items-center justify-center rounded-btn p-1 text-graphite transition hover:bg-line-soft hover:text-ink"
                title="删除这条排队消息"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {paused && (
        <button
          type="button"
          onClick={() => void resumeQueuedSends()}
          className="flex w-full items-center justify-center gap-1.5 border-t border-line-soft/60 px-3 py-1.5 font-medium text-teal transition hover:bg-teal-tint/40"
        >
          <Play size={11} />
          <span>恢复自动发送</span>
        </button>
      )}
    </div>
  );
}
