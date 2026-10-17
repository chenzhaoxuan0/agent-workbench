import { cn } from "./cn.ts";

/**
 * 会话段 readiness 三态徽标（ADR 0012，host 台账口径，不依赖适配器自觉）：
 * - 进行中（live）：daemon 内 impl 存活，可直接续聊
 * - 可恢复（resumable）：有执行器原生引用（cli_ref），resumeSession 可接回
 * - 仅历史：账本投影可看，发消息将开新段
 *
 * Timeline 的段 divider 与 HistoryDialog 的条目共用同一份语义。
 */
export function SessionReadinessBadge({
  live,
  resumable,
  className,
}: {
  live: boolean | undefined;
  resumable: boolean | undefined;
  className?: string;
}) {
  if (live === true) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[10px] text-teal", className)}>
        <span className="h-1 w-1 animate-pulse rounded-full bg-teal" aria-hidden />
        进行中
      </span>
    );
  }
  if (resumable === true) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[10px] text-graphite", className)}>
        <span className="h-1 w-1 rounded-full bg-graphite/60" aria-hidden />
        可恢复
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] text-ash", className)}>
      <span className="h-1 w-1 rounded-full bg-ash/50" aria-hidden />
      仅历史
    </span>
  );
}
