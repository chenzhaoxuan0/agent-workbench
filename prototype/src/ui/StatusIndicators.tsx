import { useState } from "react";
import { Radio } from "lucide-react";
import { useBacklog } from "../store/useBacklog.ts";
import { cn } from "./cn.ts";

/**
 * 状态徽标（工作中 / 后台守护）—— 落点：全局底栏（GlobalStatusBar）。
 * 迁移史：工作区头部（挤占高频操作）→ 右侧栏底条（太深）→ 左侧栏底部
 * （264px 栏宽装不下 288px 弹层，溢出出横向滚动条）→ 全局底栏：全局状态
 * 住全局层，弹层有整个窗口的宽度可用，与三列布局解耦。移动端远控同批
 * 迁往设置页 remoteControl 分区。
 *
 * popoverUp：栖在底栏时详情层朝上开（默认朝下，供其他位置复用）。
 * align：底栏内容居左，左锚定（"left"）避免弹层向左出窗。
 */

/**
 * 弹层锚定：垂直（popoverUp：栖在栏底时朝上开）+ 水平（align：栖在窗口左缘
 * 的左栏里必须左锚定——右锚定会把 288px 的弹层往左推出窗口外；右栏/头部
 * 场景保持默认右锚定）。
 */
function popoverAnchorCls(up: boolean, align: "left" | "right"): string {
  const vertical = up ? "bottom-full mb-1.5" : "top-full mt-1.5";
  const horizontal = align === "left" ? "left-0" : "right-0";
  return `absolute ${vertical} ${horizontal} z-40`;
}

/**
 * 全局工作状态点（共识 Q18）：工作中/空闲/心跳中/待确认/执行中/待验收。
 * 点开看判定依据（为什么忙/为什么闲）、上次心跳结果，以及强制忙碌开关
 * （一键免打扰，压倒一切自动判定）。
 */
export function WorkPhaseBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const phase = useBacklog((s) => s.state?.phase ?? null);
  const reason = useBacklog((s) => s.state?.reason ?? null);
  const forceBusy = useBacklog((s) => s.state?.forceBusy ?? false);
  const lastOutcome = useBacklog((s) => s.state?.lastBeatOutcome ?? null);
  const nextBeat = useBacklog((s) => s.state?.nextBeatAt ?? null);
  const setForceBusy = useBacklog((s) => s.setForceBusy);

  const meta: Record<string, { cls: string; label: string }> = {
    busy: { cls: "bg-line-strong", label: "工作中" },
    idle: { cls: "bg-gain", label: "空闲" },
    beating: { cls: "bg-teal animate-pulse", label: "心跳中" },
    awaiting_confirm: { cls: "bg-amber-500 animate-pulse", label: "待确认" },
    executing: { cls: "bg-blue-500 animate-pulse", label: "长任务执行中" },
    awaiting_review: { cls: "bg-violet-500", label: "待验收" },
  };
  const m = forceBusy
    ? { cls: "bg-amber-500", label: "强制忙碌" }
    : phase !== null
      ? (meta[phase] ?? meta["busy"]!)
      : { cls: "bg-line", label: "连接中" };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`工作状态：${m.label}，点击查看详情`}
        title={forceBusy ? "工作状态：强制忙碌（心跳免打扰模式生效中）" : `工作状态：${m.label}`}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-btn px-2 transition hover:bg-line-soft",
          forceBusy && "bg-amber-500/10 hover:bg-amber-500/20",
        )}
      >
        <span className={cn("h-2 w-2 rounded-full", m.cls)} />
        <span
          className={cn(
            "text-caption",
            forceBusy ? "font-medium text-amber-700" : "text-graphite",
          )}
        >
          {m.label}
        </span>
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-72 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="flex items-center gap-1.5 border-b border-line-soft pb-1.5 text-body-sm font-medium text-ink">
              <span className={cn("h-2 w-2 rounded-full", m.cls)} />
              {forceBusy ? "强制忙碌（免打扰模式）" : m.label}
            </div>
            <div className="mt-2 space-y-1.5 text-graphite">
              {reason !== null && <p>{reason}</p>}
              {nextBeat !== null && <p className="text-ash">下次心跳：{new Date(nextBeat).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</p>}
              {lastOutcome !== null && <p className="text-ash">上次心跳：{lastOutcome}</p>}
            </div>
            <button
              onClick={() => void setForceBusy(!forceBusy)}
              className={cn(
                "mt-2.5 w-full rounded-btn px-2 py-1.5 text-caption transition",
                forceBusy ? "bg-amber-500/15 text-amber-600" : "bg-line-soft text-graphite hover:text-ink",
              )}
            >
              {forceBusy ? "解除强制忙碌" : "强制忙碌（免打扰）"}
            </button>
            <p className="mt-2 border-t border-line-soft pt-1.5 text-[10px] text-ash">
              空闲心跳会在系统空闲且有余量时提议启动待办长任务 —— 任何启动都要经你确认。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** 后台守护状态指示（飞书 / Telegram / Cron）—— 静态绿点 + 渠道图标，详情点开看 */
export function BackgroundGuardianBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="后台守护通道（飞书 / Telegram / Cron 在线），点击查看详情"
        title="后台守护通道（飞书 / Telegram / Cron 在线）&#10;点击查看详情"
        className="group flex h-6 items-center gap-1.5 rounded-btn px-1.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <Radio size={12} className="text-ash transition group-hover:text-ink" />
        <span className="h-1.5 w-1.5 rounded-full bg-gain" />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-76 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="flex items-center gap-1.5 text-body-sm font-medium text-ink pb-1.5 border-b border-line-soft">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>后台静默守护中（与前台终端完全隔离）</span>
            </div>
            <div className="mt-2 space-y-1.5 text-graphite">
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>飞书 / Telegram</b>：收到移动端指令时在后台无头执行，自动回传消息。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>定时任务 (Cron)</b>：定点执行，产物与总结落盘。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>每日会话精炼</b>：每日提取对话并更新单元记忆。</span>
              </p>
              <p className="mt-2 pt-1.5 border-t border-line-soft text-ash text-[10px]">
                前台终端（TUI）为专享直控界面，后台任务在独立进程中运行，永不抢夺前台标准输入输出。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
