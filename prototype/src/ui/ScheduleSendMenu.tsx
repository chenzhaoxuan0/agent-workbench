import { useMemo, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import type { AutomationWriteInput } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/**
 * 定时发送弹层（Composer 顶栏右上角的常驻按钮入口）—— 把当前输入框内容安排为
 * 「N 分钟后 / 指定几号几点几分」发到**本对话**的一次性任务。
 *
 * 后端零新增：完全复用 automation 体系（dispatchTarget=existing_session，
 * 到点 resume + sendMessage；目标会话正忙时自然进 steer 队列）。
 * 安排成功即清空草稿（消息已交给调度器）；管理/取消在「自动化」页。
 */

const QUICK_MINUTES = [1, 5, 10, 30] as const;

function fmtTarget(t: number): string {
  return new Date(t).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ScheduleSendMenu({ onClose }: { onClose: () => void }) {
  const unit = useWorkbench(selectActiveUnit);
  const draft = useWorkbench((s) => s.draft);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const session = useWorkbench((s) =>
    s.activeSessionId === null ? undefined : s.sessions.find((x) => x.id === s.activeSessionId),
  );
  const activeRuntime = useWorkbench((s) => s.activeRuntimeId);

  const [mode, setMode] = useState<"relative" | "absolute">("relative");
  const [minutes, setMinutes] = useState(5);
  const [dateStr, setDateStr] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [timeStr, setTimeStr] = useState(() => {
    const d = new Date(Date.now() + 10 * 60_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [submitting, setSubmitting] = useState(false);

  // 本对话必须有可续接的会话（live / cli_ref）—— existing_session 派发的硬前提
  const canSchedule = session !== undefined && (session.live === true || session.resumable === true);
  const promptText = draft.trim();

  const target = useMemo((): number | null => {
    if (mode === "relative") {
      return Number.isFinite(minutes) && minutes >= 1 ? Date.now() + minutes * 60_000 : null;
    }
    const t = new Date(`${dateStr}T${timeStr}`).getTime();
    // 30s 宽限：输入「现在」不该被当场判死
    return Number.isFinite(t) && t > Date.now() + 30_000 ? t : null;
  }, [mode, minutes, dateStr, timeStr]);

  const submit = async (): Promise<void> => {
    if (submitting || !canSchedule || promptText === "" || target === null || unit === undefined) return;
    setSubmitting(true);
    try {
      const { createAutomation } = await import("../adapters/daemon/client.ts");
      const input: AutomationWriteInput = {
        name: `定时发送 · ${promptText.replace(/\s+/g, " ").slice(0, 24)}${promptText.length > 24 ? "…" : ""}`,
        unitId: unit.id,
        unitName: unit.name,
        runtimeId: activeRuntime.replace(/^daemon:/, ""),
        rootPath: unit.rootPath,
        prompt: promptText,
        ...(mode === "relative" ? { delayMinutes: Math.round(minutes) } : { runAt: target }),
        dispatchTarget: "existing_session",
        targetSessionId: String(activeSessionId),
        launchMode: "headless",
      };
      const { nextRunAt } = await createAutomation(input);
      useWorkbench.getState().setDraft("");
      useWorkbench.getState().pushNotice(
        "已安排定时发送",
        `将于 ${fmtTarget(nextRunAt ?? target)} 发送到本对话。可在「自动化」页查看或取消。`,
        { level: "success" },
      );
      onClose();
    } catch (err: unknown) {
      useWorkbench.getState().pushNotice(
        "定时发送没安排上",
        err instanceof Error ? err.message : String(err),
        { level: "warn" },
      );
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = canSchedule && promptText !== "" && target !== null && !submitting;

  return (
    <div className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line bg-canvas p-3 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
      <div className="mb-2.5 flex items-center gap-2">
        <CalendarClock size={14} className="shrink-0 text-teal" />
        <span className="text-xs font-semibold">定时发送到本对话</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-ash">{session?.title || unit?.name || ""}</span>
      </div>

      {/* 快捷：N 分钟后 */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {QUICK_MINUTES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode("relative");
              setMinutes(m);
            }}
            className={cn(
              "rounded-chip border px-2 py-0.5 text-[11px] transition",
              mode === "relative" && minutes === m
                ? "border-teal/40 bg-teal-tint text-teal font-medium"
                : "border-line-soft text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            {m} 分钟后
          </button>
        ))}
        <span className="flex items-center gap-1 text-[11px] text-graphite">
          <input
            type="number"
            min={1}
            max={1440}
            value={mode === "relative" ? (Number.isFinite(minutes) ? minutes : "") : ""}
            onChange={(e) => {
              setMode("relative");
              const v = Number(e.target.value);
              setMinutes(v);
            }}
            disabled={mode !== "relative"}
            className="w-14 rounded-btn border border-line-soft bg-card px-1.5 py-0.5 text-center text-[11px] text-ink !outline-none focus:border-teal/50"
            aria-label="自定义分钟后"
          />
          分钟后
        </span>
      </div>

      {/* 指定时刻 */}
      <div className="mb-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setMode("absolute")}
          className={cn(
            "shrink-0 rounded-chip border px-2 py-0.5 text-[11px] transition",
            mode === "absolute"
              ? "border-teal/40 bg-teal-tint text-teal font-medium"
              : "border-line-soft text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          到点发送
        </button>
        <input
          type="date"
          value={dateStr}
          onChange={(e) => {
            setMode("absolute");
            setDateStr(e.target.value);
          }}
          className="min-w-0 flex-1 rounded-btn border border-line-soft bg-card px-1.5 py-0.5 text-[11px] text-ink !outline-none focus:border-teal/50"
          aria-label="发送日期"
        />
        <input
          type="time"
          value={timeStr}
          onChange={(e) => {
            setMode("absolute");
            setTimeStr(e.target.value);
          }}
          className="w-[76px] shrink-0 rounded-btn border border-line-soft bg-card px-1.5 py-0.5 text-[11px] text-ink !outline-none focus:border-teal/50"
          aria-label="发送时间"
        />
      </div>

      {/* 预览 + 提交 */}
      <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-graphite">
          {promptText === ""
            ? "输入框为空 —— 先写点什么"
            : session === undefined
              ? "当前没有打开的对话"
              : !canSchedule
                ? "这个对话接不了定时消息 —— 换个对话试试"
                : target === null
                  ? "时间无效（需在未来）"
                  : `将于 ${fmtTarget(target)} 发送`}
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-teal px-2.5 py-1 text-[11px] font-medium text-canvas transition hover:opacity-90 active:scale-95 disabled:opacity-40"
        >
          {submitting && <Loader2 size={11} className="animate-spin" />}
          <span>安排发送</span>
        </button>
      </div>
    </div>
  );
}
