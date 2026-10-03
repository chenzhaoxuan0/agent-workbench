import { useState } from "react";
import {
  Check,
  Copy,
  Ellipsis,
  Folder,
  GitBranch,
  Hash,
  History,
  PanelRightOpen,
  Pin,
  SquareTerminal,
} from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 工作区头部栏 —— 对齐 ZCode 的 WorkspaceHeader + DesktopTopOverlay。
 *
 * ZCode 里这两层是分开的：DesktopTopOverlay 浮在侧栏区上（logo / 侧栏开关 /
 * 任务前进后退 / 新建任务），WorkspaceHeader 横在会话区顶（路径 / 标题 /
 * 右侧动作按钮）。本原型是 web 布局，没有自绘窗口拖拽区，两层合成一条
 * 48px 头部：左区导航与工作区上下文，右区动作按钮。
 *
 * 按钮集与 ZCode 一一对应：
 *   侧栏开关   ← DesktopTopOverlay 的 PanelLeftClose/Open
 *   前进/后退  ← DesktopTopOverlay 的任务历史导航（canBack/canForward 禁用态）
 *   工作区     ← WorkspaceHeaderTitleSection 的 Folder 按钮（点开路径弹层）
 *   新建任务   ← DesktopTopOverlay 的 MessageCirclePlus
 *   帮助       ← WorkspaceHelpMenuButton
 *   终端开关   ← WorkspaceTerminalToggleButton
 *   右栏开关   ← WorkspaceSidePaneToggleButton
 */

/** 图标按钮的统一规格：28px 命中区（ZCode 的 icon-md），14px 图标 */
const iconBtn =
  "rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";
/** 按下态（aria-pressed=true 的开关类按钮） */
const pressedBtn = "bg-teal-tint text-teal hover:bg-teal-tint hover:text-teal";

export function WorkspaceHeader() {
  // 侧栏收起后，左上浮层（DesktopTopOverlay）悬在内容区上，头部让出安全区
  // （ZCode：headerWindowControlsPaddingClass 的 pl-38 ≈ 152px）
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const terminalOpen = useShell((s) => s.terminalOpen);
  const toggleTerminal = useShell((s) => s.toggleTerminal);

  const paneOpen = useSidePane((s) => s.open);
  const setPaneOpen = useSidePane((s) => s.setOpen);

  const unit = useWorkbench(selectActiveUnit);
  const session = useWorkbench((s) => s.sessions.find((x) => x.id === s.activeSessionId));

  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 border-b border-line/60 bg-canvas transition-[padding] duration-300",
        sidebarCollapsed ? "pl-[152px]" : "px-3",
      )}
      aria-label="工作区"
    >
      {/* ---- 左区：工作区上下文 + 标题 ---- */}
      {/* 侧栏开关 / 前进 / 后退在左上浮层（DesktopTopOverlay），这里不再重复 —— ZCode 同构 */}
      <WorkspacePopover />

      {/* 标题：单元名 + 当前任务。ZCode 是 h1 truncate，字重封顶 500 用 font-medium */}
      <h1 className="ml-1 flex min-w-0 items-baseline gap-1.5 text-body">
        <span className="shrink-0 font-medium text-ink">{unit?.name ?? "未选择工作单元"}</span>
        {session && (
          <span className="min-w-0 truncate text-body-sm text-graphite">/ {session.title}</span>
        )}
      </h1>

      {/* ZCode 的 TID_WORKSPACE_MORE_BUTTON：任务级操作菜单 */}
      <MoreMenu />

      {/* ---- 右区：动作按钮（ZCode 的 WorkspaceHeaderActionSection）---- */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          onClick={toggleTerminal}
          aria-label="终端"
          aria-pressed={terminalOpen}
          title="终端 · Ctrl+`"
          className={cn(iconBtn, terminalOpen && pressedBtn)}
        >
          <SquareTerminal size={14} />
        </button>

        {/* ZCode 的 WorkspaceHeaderActionSection：右栏开着时头部开关不渲染，
            关闭动作由右栏自己的标签条承担（PanelRightClose） */}
        {!paneOpen && (
          <button
            onClick={() => setPaneOpen(true)}
            aria-label="展开右侧面板"
            title="展开右侧面板"
            className={iconBtn}
          >
            <PanelRightOpen size={14} />
          </button>
        )}
      </div>
    </header>
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
    {
      key: "trace",
      icon: History,
      label: "查看调用轨迹",
      disabled: !session,
      onClick: () => session && useSidePane.getState().openTabType("trace", session.id),
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
          <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-card border border-line bg-canvas py-1 shadow-subtle">
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
        title={unit.rootPath}
        className={cn(iconBtn, open && "bg-line-soft text-ink")}
      >
        <Folder size={14} />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-card border border-line bg-canvas p-3 shadow-subtle">
            <p className="break-all font-mono text-body-sm text-ink">{unit.rootPath}</p>
            {/* 分支行（ZCode 弹层的 GitBranch 行）：项目会话显示 worktree 分支 */}
            <p className="mt-2 flex items-center gap-1.5 text-caption text-graphite">
              <GitBranch size={12} className="shrink-0 text-ash" />
              <span className="font-mono">{branch ?? "main"}</span>
            </p>
            <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
              <span className="text-body-sm text-graphite">
                {unit.name} · {unit.kind === "bot" ? "bot" : "项目"}
              </span>
              <button
                onClick={copyPath}
                className="ml-auto flex items-center gap-1 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
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
