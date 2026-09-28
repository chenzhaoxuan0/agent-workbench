import { ArrowLeft, ArrowRight, MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useNav, canNavBack, canNavForward } from "../store/useNav.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 左上浮层 —— 对齐 ZCode 的 DesktopTopOverlay。
 *
 * ZCode 的侧栏开关 / 任务前进后退 / 新建任务不在 WorkspaceHeader 里，
 * 而是悬浮在**侧栏区域上方**：宽度对齐侧栏变量；侧栏收起后浮层原地保留
 * （收成 w-fit），开关图标换成 PanelLeftOpen —— 这就是「收进去之后
 * 通过同一颗按钮打开」的载体。主视图切换（自动化等）时浮层不消失。
 *
 * Win/Linux 分支的 logo 复合按钮：品牌标 hover 时淡出、淡入开关图标
 * （双图层 opacity 过渡，duration 150ms）。
 */
export function DesktopTopOverlay() {
  const visible = !useShell((s) => s.sidebarCollapsed);
  const width = useShell((s) => s.sidebarWidth);
  const canBack = useNav(canNavBack);
  const canForward = useNav(canNavForward);

  const ToggleIcon = visible ? PanelLeftClose : PanelLeftOpen;

  return (
    <div
      style={visible ? { width } : undefined}
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-30 flex h-12 items-center",
        visible && "overflow-hidden transition-[width] duration-200 ease-out",
      )}
    >
      <div className="pointer-events-auto flex items-center gap-1 pl-3 text-body-sm">
        {/* 侧栏开关：品牌标 ↔ 开关图标的 hover 变形（ZCode 的 logo 复合按钮）。
            动作行统一规格：text-body-sm + 14px 图标 + 28px 命中区（与侧栏行、头部按钮同组） */}
        <button
          onClick={() => useShell.getState().toggleSidebar()}
          aria-label={visible ? "收起侧栏" : "展开侧栏"}
          title="切换侧边栏 · ⌘B"
          className="group relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <span
            aria-hidden
            className="flex h-5 w-5 items-center justify-center rounded-sm bg-ink text-caption font-medium text-canvas transition-opacity duration-150 group-hover:opacity-0"
          >
            A
          </span>
          <ToggleIcon
            size={14}
            className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        </button>

        <button
          onClick={() => useNav.getState().back()}
          disabled={!canBack}
          aria-label="后退"
          title="后退 · ⌘["
          className="rounded-btn p-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={() => useNav.getState().forward()}
          disabled={!canForward}
          aria-label="前进"
          title="前进 · ⌘]"
          className="rounded-btn p-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <ArrowRight size={14} />
        </button>

        {/* 新建任务：侧栏可见时宽度动画收起（ZCode：showNewTaskButton = !isSidebarVisible） */}
        <div
          aria-hidden={visible}
          className={cn(
            "inline-flex overflow-hidden transition-[width,opacity] duration-300 ease-out",
            visible ? "pointer-events-none w-0 opacity-0" : "w-7 opacity-100",
          )}
        >
          <button
            onClick={() => useShell.getState().newTask()}
            disabled={visible}
            aria-label="新建任务"
            title="新建任务 · ⌘N"
            tabIndex={visible ? -1 : 0}
            className="rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
          >
            <MessageCirclePlus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
