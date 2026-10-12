import { useState } from "react";
import { Check, FolderOpen, History, Radio } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { openFolder } from "../adapters/daemon/client.ts";
import { HistoryDialog } from "./HistoryDialog.tsx";
import { cn } from "./cn.ts";

/** 图标按钮的统一规格：28px 命中区（ZCode 的 icon-md），14px 图标 */
const iconBtn =
  "rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";

export function WorkspaceHeader() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const [historyOpen, setHistoryOpen] = useState(false);

  const unit = useWorkbench(selectActiveUnit);
  const isSteward = unit?.id === "steward";

  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b border-line/60 bg-rail transition-[padding] duration-300",
        sidebarCollapsed ? "pl-[152px]" : "px-4",
      )}
      aria-label="工作区"
    >
      {/* ---- 左区：Agent 身份卡片 ---- */}
      {unit ? (
        <div className="flex min-w-0 items-center gap-2">
          {/* 可点击的 Agent 头衔（点击打开 Agent 设置） */}
          <button
            onClick={() => useShell.getState().openUnitSettings(unit.id)}
            title="查看与编辑 Agent 设置（身份 / 执行器 / 模型 / AGENTS.md / 渠道）"
            className="group flex min-w-0 items-center gap-2 rounded-btn px-2 py-1 transition hover:bg-line-soft"
          >
            {/* 名字 */}
            <span className="truncate text-body font-medium text-ink group-hover:text-teal">
              {unit.name}
            </span>
            {/* 身份/角色徽标 */}
            <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite group-hover:bg-teal-tint group-hover:text-teal">
              {isSteward ? "总管" : unit.identity?.role || "Agent"}
            </span>
          </button>

          {/* 工作区：单击直接在资源管理器中打开，路径悬停可见 */}
          {unit && <OpenWorkspaceFolder path={unit.rootPath} />}
        </div>
      ) : (
        <span className="text-body-sm text-ash">未选择 Agent</span>
      )}

      {/* ---- 右区：工作状态 + 区分割线 + 后台守护通道 ---- */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <WorkPhaseBadge />
        <div className="h-3.5 w-px bg-line/80" aria-hidden />
        {unit !== undefined && (
          <button
            onClick={() => setHistoryOpen(true)}
            aria-label={`查看 ${unit.name} 的历史会话`}
            title={`查看 ${unit.name} 的历史会话：自动化任务、待办任务、心跳与手动会话的时间轴`}
            className={cn(iconBtn, historyOpen && "bg-line-soft text-ink")}
          >
            <History size={14} />
          </button>
        )}
        <BackgroundGuardianBadge />
      </div>

      {historyOpen && unit !== undefined && (
        <HistoryDialog unitId={unit.id} unitName={unit.name} onClose={() => setHistoryOpen(false)} />
      )}
    </header>
  );
}

/**
 * 全局工作状态点（共识 Q18）：工作中/空闲/心跳中/待确认/执行中/待验收。
 * 点开看判定依据（为什么忙/为什么闲）、上次心跳结果，以及强制忙碌开关
 * （一键免打扰，压倒一切自动判定）。
 */
function WorkPhaseBadge() {
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
          <div className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed">
            <div className="flex items-center gap-1.5 border-b border-line-soft pb-1.5 text-body-sm font-medium text-ink">
              <span className={cn("h-2 w-2 rounded-full", m.cls)} />
              {forceBusy ? "强制忙碌（免打扰模式生效中）" : m.label}
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
              {forceBusy ? "解除强制忙碌" : "强制忙碌（心跳免打扰）"}
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
function BackgroundGuardianBadge() {
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
          <div className="absolute right-0 top-full z-40 mt-1.5 w-76 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed">
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
                <span><b>每日会话精炼</b>：每日提取对话并更新工作区记忆。</span>
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

/* ------------------------------------------------------------- 工作区直达 */

/**
 * 工作区打开按钮 —— 单击直接在资源管理器中打开，不再经弹层二跳。
 * 路径放 title 里悬停可见；打开成功短暂打勾作为反馈（daemon 不可达时失败只进 console）。
 */
function OpenWorkspaceFolder({ path }: { path: string }) {
  const [opened, setOpened] = useState(false);

  return (
    <button
      onClick={() => {
        void openFolder({ path })
          .then(() => {
            setOpened(true);
            window.setTimeout(() => setOpened(false), 1500);
          })
          .catch((err: unknown) => console.error("[WorkspaceHeader] 打开文件夹失败:", err));
      }}
      aria-label="在资源管理器中打开工作区文件夹"
      title={`工作区路径：${path}
单击在资源管理器中打开`}
      className={cn(iconBtn, opened && "text-gain")}
    >
      {opened ? <Check size={14} className="text-gain" /> : <FolderOpen size={14} />}
    </button>
  );
}
