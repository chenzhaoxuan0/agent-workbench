import { MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 左上浮层 —— 对齐 ZCode 的 DesktopTopOverlay。
 *
 * 侧栏开关与新建任务悬浮在侧栏区域上方：宽度对齐侧栏变量；
 * 侧栏收起后浮层原地保留，开关图标换成 PanelLeftOpen。
 */
export function DesktopTopOverlay() {
  const visible = !useShell((s) => s.sidebarCollapsed);
  const width = useShell((s) => s.sidebarWidth);

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
        {/* 侧栏开关：品牌标 ↔ 开关图标的 hover 变形（ZCode 的 logo 复合按钮） */}
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
