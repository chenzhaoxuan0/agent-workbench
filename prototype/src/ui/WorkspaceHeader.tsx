import { useState } from "react";
import {
  Check,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  GitBranch,
  Hash,
  Pin,
} from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { openFolder } from "../adapters/daemon/client.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { cn } from "./cn.ts";

/** 图标按钮的统一规格：28px 命中区（ZCode 的 icon-md），14px 图标 */
const iconBtn =
  "rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";

export function WorkspaceHeader() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);

  const unit = useWorkbench(selectActiveUnit);
  const session = useWorkbench((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const busy = useWorkbench((s) => s.busy);

  const avatar = unit ? botAvatarStyle(unit.name) : null;
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
            {/* 头像 Blob */}
            <span
              className={cn("flex h-6 w-6 shrink-0 items-center justify-center text-[12px] font-medium text-canvas shadow-xs", avatar?.shape)}
              style={{ backgroundColor: avatar?.color }}
            >
              {isSteward ? "👑" : unit.name.slice(0, 1)}
            </span>
            {/* 名字 */}
            <span className="truncate text-body font-medium text-ink group-hover:text-teal">
              {unit.name}
            </span>
            {/* 身份/角色徽标 */}
            <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite group-hover:bg-teal-tint group-hover:text-teal">
              {isSteward ? "总管" : unit.identity?.role || "Agent"}
            </span>
            {/* 运行状态 */}
            {busy ? (
              <span className="flex items-center gap-1 text-[11px] text-teal">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
                工作中
              </span>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-line" title="就绪" />
            )}
          </button>

          {/* 会话名称（若有活跃会话） */}
          {session && (
            <span className="hidden xl:flex min-w-0 items-center gap-1.5 text-body-sm text-graphite">
              <span className="text-ash">/</span>
              <span className="truncate max-w-[140px]" title={session.title}>{session.title}</span>
            </span>
          )}

          {/* 路径与绑定弹层 */}
          <WorkspacePopover />
          {/* 任务更多菜单 */}
          <MoreMenu />
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

/** 后台守护状态胶囊（飞书 / Telegram / Cron） */
function BackgroundGuardianBadge() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="后台静默服务运行状态（点击查看详情）"
        className="flex items-center gap-1.5 rounded-chip bg-gain/10 px-2 py-0.5 text-[11px] font-medium text-gain hover:bg-gain/20 transition cursor-pointer"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-gain animate-pulse" />
        <span className="hidden sm:inline">后台守护</span>
        <span className="text-[10px] opacity-75">(飞书/Cron)</span>
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

/* ------------------------------------------------------------- 更多菜单 */

/**
 * 任务更多菜单 —— 标题后的 Ellipsis。
 *
 * 菜单结构同构：复制组 — 轨迹。
 * 这两项是真实动作。
 *
 * 原先还有 置顶 / 重命名 / 归档 / 反馈 四项，点下去只关菜单（`placeholder: true`），
 * 已删除。留着一排点了没反应的按钮，比没有这排按钮更让人以为功能坏了。
 */
function MoreMenu() {
  const unit = useWorkbench(selectActiveUnit);
  const session = useWorkbench((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      /* 剪贴板不可用就安静放弃 */
    }
  };

  const rows: readonly {
    key: string;
    icon: typeof Pin;
    label: string;
    hint?: string;
    disabled?: boolean;
    onClick?: () => void;
  }[] = [
    {
      key: "open-folder",
      icon: FolderOpen,
      label: "在资源管理器中打开",
      disabled: !unit,
      onClick: () => {
        // 与下面的 WorkspacePopover 同一处理：daemon 不可达是常态（README 明说），
        // 不 catch 就是一个未处理的 Promise 拒绝 + 点了没反应
        if (!unit) return;
        void openFolder({ path: unit.rootPath }).catch((err: unknown) => {
          console.error("[workbench] openFolder failed", err);
        });
      },
    },
    {
      key: "copy-path",
      icon: Copy,
      label: copied === "path" ? "已复制路径" : "复制路径",
      disabled: !unit,
      onClick: () => unit && void copy(unit.rootPath, "path"),
    },
    {
      key: "copy-session",
      icon: Hash,
      label: copied === "session" ? "已复制会话 ID" : "复制会话 ID",
      disabled: !session,
      onClick: () => session && void copy(session.id, "session"),
    },
  ];

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="更多"
        title="更多"
        className={cn(iconBtn, open && "bg-line-soft text-ink")}
      >
        <Ellipsis size={14} />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-card border border-line bg-card py-1 shadow-xl">
            {rows.map(({ key, icon: Icon, label, disabled, onClick }) => (
              <button
                key={key}
                disabled={disabled}
                onClick={() => {
                  onClick?.();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm text-graphite hover:bg-line-soft hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 工作区弹层 */

/**
 * 工作区上下文按钮 —— 对齐 ZCode 的 WorkspaceContextPath：
 * 按钮本体是 Folder 图标，点开弹层看完整路径 / 单元信息 / 执行器绑定。
 */
function WorkspacePopover() {
  const unit = useWorkbench(selectActiveUnit);
  const branch = useWorkbench(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.worktree?.branch,
  );
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);

  if (!unit) return null;

  const copyPath = () => {
    try {
      void navigator.clipboard?.writeText(unit.rootPath).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      });
    } catch {
      /* 剪贴板不可用就安静放弃 */
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={`工作区路径：${unit.rootPath}\n点击查看详情与打开文件夹`}
        className={cn(iconBtn, open && "bg-line-soft text-ink")}
      >
        <Folder size={14} />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-card border border-line bg-card p-3 shadow-xl">
            <p className="break-all font-mono text-body-sm text-ink">{unit.rootPath}</p>
            {/* 分支行（ZCode 弹层的 GitBranch 行）：项目会话显示 worktree 分支 */}
            <p className="mt-2 flex items-center gap-1.5 text-caption text-graphite">
              <GitBranch size={12} className="shrink-0 text-ash" />
              <span className="font-mono">{branch ?? "main"}</span>
            </p>
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-line-soft pt-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await openFolder({ path: unit.rootPath });
                    setOpened(true);
                    setTimeout(() => setOpened(false), 2000);
                  } catch (err) {
                    console.error("[WorkspaceHeader] 打开文件夹失败:", err);
                  }
                }}
                className={cn(
                  "flex items-center gap-1 rounded-btn px-2 py-1 text-caption font-medium transition active:scale-95",
                  opened ? "bg-gain/15 text-gain" : "bg-teal-tint text-teal hover:bg-teal/15",
                )}
              >
                {opened ? <Check size={12} className="text-gain" /> : <FolderOpen size={12} />}
                <span>{opened ? "已在资源管理器打开" : "打开文件夹"}</span>
              </button>
              <button
                onClick={copyPath}
                className="ml-auto flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
              >
                {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
                {copied ? "已复制" : "复制路径"}
              </button>
            </div>

            {unit.bindings.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-line-soft pt-2">
                <p className="text-caption text-ash">执行器绑定</p>
                {unit.bindings.map((b) => (
                  <p key={b.runtimeId} className="flex items-center gap-1.5 font-mono text-caption text-graphite">
                    <span className="text-ink">{b.runtimeId}</span>
                    {b.modelHint && <span className="truncate">→ {b.modelHint}</span>}
                  </p>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
