import { MessageCirclePlus, PanelLeftOpen } from "lucide-react";
import { useShell } from "../store/useShell.ts";

/**
 * 左上浮层 —— 仅在侧边栏折叠时常驻左上角，提供展开入口与新建会话。
 * 当侧栏展开时，由 Sidebar 自行渲染顶栏（A 图标、新建会话、搜索、自动化、出图；或在子页面时顶掉为统一的返回工作台）。
 */
export function DesktopTopOverlay() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);

  if (!sidebarCollapsed) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-30 flex h-12 items-center">
      <div className="pointer-events-auto flex items-center gap-1 pl-3 text-body-sm">
        {/* 侧栏开关：点击展开侧栏 */}
        <button
          onClick={() => useShell.getState().toggleSidebar()}
          aria-label="展开侧栏"
          title="展开侧栏 · ⌘B"
          className="group relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <span
            aria-hidden
            className="flex h-5 w-5 items-center justify-center rounded-sm bg-ink text-caption font-medium text-canvas transition-opacity duration-150 group-hover:opacity-0"
          >
            A
          </span>
          <PanelLeftOpen
            size={14}
            className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        </button>

        {/* 新建会话 */}
        <button
          onClick={() => useShell.getState().newTask()}
          aria-label="新建会话"
          title="新建会话 · ⌘N"
          className="rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
        >
          <MessageCirclePlus size={14} />
        </button>
      </div>
    </div>
  );
}
