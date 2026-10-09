import { useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { openFolder } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/** 图标按钮的统一规格：28px 命中区（ZCode 的 icon-md），14px 图标 */
const iconBtn =
  "rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";

export function WorkspaceHeader() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);

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

      {/* ---- 右区：后台守护指示器 ---- */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <BackgroundGuardianBadge />
      </div>
    </header>
  );
}

/** 后台守护状态指示（飞书 / Telegram / Cron）—— 一颗呼吸绿点，详情点开看 */
function BackgroundGuardianBadge() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="后台守护运行中，点击查看详情"
        title="后台守护运行中（飞书 / Telegram / Cron）
点击查看详情"
        className="flex h-6 w-6 items-center justify-center rounded-btn transition hover:bg-line-soft"
      >
        <span className="h-2 w-2 rounded-full bg-gain animate-pulse" />
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
