import { PanelLeftOpen } from "lucide-react";
import { useShell } from "../store/useShell.ts";

/**
 * 左上浮层 —— 仅在侧边栏折叠时常驻左上角，提供侧栏展开入口。
 * 当侧栏展开时，由 Sidebar 自行渲染顶栏（A 图标、搜索、自动化、出图；或在子页面时顶掉为统一的返回工作台）。
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
          <img
            src="/icon.png"
            alt="A"
            className="h-5 w-5 rounded-sm object-cover transition-opacity duration-150 group-hover:opacity-0"
          />
          <PanelLeftOpen
            size={14}
            className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        </button>

      </div>
    </div>
  );
}
