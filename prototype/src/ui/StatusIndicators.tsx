import { useState } from "react";
import { Check, Radio, RotateCcw } from "lucide-react";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkState, WORK_PHASE_DESCRIPTIONS } from "../store/useWorkState.ts";
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

const PHASE_DOT_CLS: Record<string, string> = {
  busy: "bg-line-strong",
  idle: "bg-gain",
  beating: "bg-teal animate-pulse",
  awaiting_confirm: "bg-amber-500 animate-pulse",
  executing: "bg-blue-500 animate-pulse",
  awaiting_review: "bg-violet-500",
};

/**
 * 全局工作状态点（共识 Q18）：工作中/空闲/心跳中/待确认/执行中/待验收。
 * 点开看三件事：
 * - 判定依据（为什么忙/为什么闲）、心跳信息；
 * - **全部状态清单**：每个状态会发生什么（忙碌=待办不自动执行、空闲=心跳提议…），
 *   治「状态是个黑盒」；
 * - **手动指定**：点任一状态把它定为当前状态（显示层覆盖；「工作中」同时打开
 *   后端强制忙碌=真实免打扰门禁），「跟随系统」恢复自动判定。
 */
export function WorkPhaseBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const phase = useBacklog((s) => s.state?.phase ?? null);
  const reason = useBacklog((s) => s.state?.reason ?? null);
  const forceBusy = useBacklog((s) => s.state?.forceBusy ?? false);
  const lastOutcome = useBacklog((s) => s.state?.lastBeatOutcome ?? null);
  const nextBeat = useBacklog((s) => s.state?.nextBeatAt ?? null);
  const setForceBusy = useBacklog((s) => s.setForceBusy);
  const manual = useWorkState((s) => s.manual);
  const setManual = useWorkState((s) => s.setManual);

  const autoPhase = phase !== null ? (phase in PHASE_DOT_CLS ? phase : "busy") : null;
  // 展示优先级：后端强制忙碌（别的入口开的门禁，如实呈现）> 手动指定 > 自动判定 > 未连接
  const shown = forceBusy ? "busy" : (manual ?? autoPhase);
  const m =
    forceBusy
      ? { cls: "bg-amber-500", label: "强制忙碌" }
      : shown !== null
        ? { cls: PHASE_DOT_CLS[shown]!, label: WORK_PHASE_DESCRIPTIONS.find((d) => d.phase === shown)?.label ?? "工作中" }
        : { cls: "bg-line", label: "连接中" };

  /** 手动指定一个状态：「工作中」顺带开真实门禁（forceBusy），其余纯显示覆盖 */
  const applyManual = (p: (typeof WORK_PHASE_DESCRIPTIONS)[number]["phase"]): void => {
    setManual(p);
    if (p === "busy" && !forceBusy) void setForceBusy(true);
    if (p !== "busy" && forceBusy) void setForceBusy(false);
  };
  const backToAuto = (): void => {
    setManual(null);
    if (forceBusy) void setForceBusy(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`工作状态：${m.label}，点击查看详情与全部状态`}
        title={forceBusy ? "工作状态：强制忙碌（心跳免打扰模式生效中）" : `工作状态：${m.label}${manual !== null && !forceBusy ? "（手动指定，点击可改回跟随系统）" : ""}`}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-btn px-2 transition hover:bg-line-soft",
          (forceBusy || manual === "busy") && "bg-amber-500/10 hover:bg-amber-500/20",
        )}
      >
        <span className={cn("h-2 w-2 rounded-full", m.cls)} />
        <span
          className={cn(
            "text-caption",
            forceBusy || manual === "busy" ? "font-medium text-amber-700" : "text-graphite",
          )}
        >
          {m.label}
        </span>
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-80 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="flex items-center gap-1.5 border-b border-line-soft pb-1.5 text-body-sm font-medium text-ink">
              <span className={cn("h-2 w-2 rounded-full", m.cls)} />
              {forceBusy ? "强制忙碌（免打扰模式）" : m.label}
            </div>
            <div className="mt-2 space-y-1.5 text-graphite">
              {reason !== null && manual === null && <p>{reason}</p>}
              {manual !== null && !forceBusy && (
                <p>
                  手动指定中 —— 后台自动判定继续在跑，只是不展示。
                </p>
              )}
              {nextBeat !== null && <p className="text-ash">下次心跳：{new Date(nextBeat).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</p>}
              {lastOutcome !== null && <p className="text-ash">上次心跳：{lastOutcome}</p>}
            </div>

            {/* 全部状态清单：每个状态会发生什么 + 点击手动指定。勾选 = 当前生效态 */}
            <div className="mt-2.5 border-t border-line-soft pt-2">
              <p className="mb-1 text-[10px] font-medium tracking-wide text-ash">全部工作状态（点击指定为当前状态）</p>
              <div className="space-y-0.5">
                {WORK_PHASE_DESCRIPTIONS.map((d) => {
                  const active = shown === d.phase;
                  return (
                    <button
                      key={d.phase}
                      onClick={() => applyManual(d.phase)}
                      title={`把当前状态指定为「${d.label}」`}
                      className={cn(
                        "flex w-full cursor-pointer items-start gap-2 rounded-btn px-1.5 py-1 text-left transition hover:bg-line-soft",
                        active && "bg-teal-tint/60",
                      )}
                    >
                      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", PHASE_DOT_CLS[d.phase])} />
                      <span className="min-w-0 flex-1">
                        <span className={cn("flex items-center gap-1 text-caption", active ? "font-medium text-ink" : "text-graphite")}>
                          {d.label}
                          {active && <Check size={10} className="text-teal" aria-label="当前状态" />}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-ash">{d.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={backToAuto}
                disabled={manual === null && !forceBusy}
                className={cn(
                  "mt-1.5 flex w-full items-center justify-center gap-1 rounded-btn px-2 py-1.5 text-caption transition",
                  manual === null && !forceBusy
                    ? "cursor-default text-ash/60"
                    : "bg-line-soft text-graphite hover:text-ink",
                )}
              >
                <RotateCcw size={10} />
                跟随系统（恢复自动判定）
              </button>
            </div>

            <p className="mt-2 border-t border-line-soft pt-1.5 text-[10px] text-ash">
              指定「工作中」= 强制忙碌（免打扰）：心跳不再提议、待办不自动执行；其余状态仅改变状态显示，判定继续。
              空闲心跳提议启动待办时，任何启动都要经你确认。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 后台守护指示 —— 不是工作状态，是「你不在时工作台仍在值班」的能力在线灯。
 * 绿点恒亮（能力常驻），点开用人话讲清它到底在替你做什么。
 */
export function BackgroundGuardianBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "right" | "left" }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="后台守护：飞书 / Telegram 指令、定时任务、记忆蒸馏在无人值守时照常运行，点击了解详情"
        title="后台守护 —— 你不在电脑前时工作台仍在值班（点击了解它在做什么）"
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
              <span>后台守护在线 —— 你不在时，工作台替你值班</span>
            </div>
            <p className="mt-2 text-graphite">
              这盏绿灯表示：即使你关掉前台、离开电脑，下面这些事仍会照常发生并留下记录 ——
            </p>
            <div className="mt-1.5 space-y-1.5 text-graphite">
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>飞书 / Telegram 指令</b>：从手机发来的消息在后台无头执行，结果自动回传，不用开电脑。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>定时任务</b>：到点自动执行，产物与总结写进 bot 的文件夹。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>记忆蒸馏</b>：每天提取对话要点，更新单元记忆。</span>
              </p>
              <p className="mt-2 pt-1.5 border-t border-line-soft text-ash text-[10px]">
                它们都在独立后台进程里跑，与前台终端（TUI）完全隔离 —— 永不抢夺前台的输入输出。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
