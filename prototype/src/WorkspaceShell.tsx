import { useEffect, useRef } from "react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { PanelLeftOpen } from "lucide-react";
import { Composer } from "./ui/Composer.tsx";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { SearchPanel } from "./ui/SearchPanel.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SidePane } from "./ui/SidePane.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { useWorkbench } from "./store/useWorkbench.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { Timeline } from "./ui/Timeline.tsx";
import { SIDEBAR_DEFAULT, useShell, bindShellShortcuts } from "./store/useShell.ts";

/**
 * 工作台外壳 —— 布局结构对齐 ZCode 的 WorkspaceShellLayout。
 *
 * 照搬的 ZCode 约定：
 *   - 侧栏 264px 起，min 264，max 视口 50%，宽度持久化
 *   - 对话区纵向再切一层（会话 | 终端），终端默认 30% 高、可开关
 *   - 面板可折叠，折叠态保留窄条而不是整个消失
 *
 * 与 ZCode 的差异：ZCode 右侧是内嵌浏览器，本项目右侧换成标签页面板
 * —— 因为「多工具平等切换 + 能力对比」比内嵌浏览器更核心。
 *
 * 注：react-resizable-panels v4 的 API 与 v2/v3 不同
 * （Group / Separator / PanelSize{inPixels,asPercentage}）。
 */
export function WorkspaceShell() {
  useEffect(() => bindShellShortcuts(), []);

  return (
    <div className="flex h-screen flex-col bg-canvas">
      {/* 执行器不在顶部常驻 —— 它和「换模型」同类，挪进了 composer 控制行 */}
      {/* 侧栏 / 对话区 / 右侧面板 —— 布局按 panel id 索引，末位尺寸在 onLayoutChanged 里记忆，
          对齐 ZCode useAnimatedResizablePanel 的 rememberExpandedSize */}
      <Group
        orientation="horizontal"
        id="workbench-shell"
        onLayoutChanged={(layout) => {
          const v = layout[SIDE_PANE_PANEL_ID];
          if (typeof v === "number" && v > 0) {
            useSidePane.getState().setExpandedSize(`${Math.round(v)}%`);
          }
        }}
      >
        <SidebarSlot />
        <ResizeHandle />
        <ConversationSlot />
        <ResizeHandle />
        <SidePaneSlot />
      </Group>

      <CommandCenter />
      <PermissionDialog />
    </div>
  );
}

/** 右侧面板的 panel id，用于从 layout 里取回它的尺寸 */
const SIDE_PANE_PANEL_ID = "side-pane";

function ResizeHandle() {
  return (
    <Separator className="group relative w-px bg-line">
      <span className="absolute inset-y-0 -left-1 -right-1 transition group-hover:bg-teal/20" />
    </Separator>
  );
}

/* ------------------------------------------------------------- 侧栏 */

const COLLAPSED_PX = 44;

function SidebarSlot() {
  const collapsed = useShell((s) => s.sidebarCollapsed);
  const toggle = useShell((s) => s.toggleSidebar);
  const setWidth = useShell((s) => s.setSidebarWidth);
  const ref = useRef<PanelImperativeHandle>(null);

  // 折叠/展开走 panelRef，保证 Group 的子节点结构始终是 Panel / Separator
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (collapsed) p.collapse();
    else p.expand();
  }, [collapsed]);

  return (
    <Panel
      panelRef={ref}
      // 注意：数字会被当成百分比，所以 264px 必须写成带单位的字符串
      defaultSize="264px"
      minSize="264px"
      maxSize="50%"
      collapsedSize={`${COLLAPSED_PX}px`}
      collapsible
      onResize={(size) => {
        // 折叠过程中不要把窄条宽度写回持久化宽度
        if (!collapsed) setWidth(size.inPixels);
      }}
      className="overflow-hidden"
    >
      {collapsed ? (
        <div className="flex h-full flex-col items-center gap-3 border-r border-line bg-rail pt-4">
          <button
            onClick={toggle}
            aria-label="展开侧栏"
            className="rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
          >
            <PanelLeftOpen size={15} />
          </button>
        </div>
      ) : (
        <Sidebar />
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- 对话区 */

function ConversationSlot() {
  const terminalOpen = useShell((s) => s.terminalOpen);
  const mainView = useShell((s) => s.mainView);

  return (
    <Panel defaultSize="62%" minSize="30%" className="min-w-0">
      {/* 设置页 / 自动化 / 搜索各占主列，与会话共享同一套外壳
          —— 对齐 ZCode 的 workspaceMainView（设置与自动化都是主视图，不是弹层） */}
      {mainView === "settings" ? (
        <main className="h-full min-h-0" aria-label="设置">
          <SettingsPage />
        </main>
      ) : mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : mainView === "search" ? (
        <main className="h-full min-h-0" aria-label="搜索">
          <SearchPanel />
        </main>
      ) : (
        <Group orientation="vertical" id="workbench-conversation">
          <Panel defaultSize="100%" minSize="30%" className="min-h-0">
            <main className="flex h-full min-h-0 flex-col" aria-label="会话">
              <Timeline />
              <Composer />
            </main>
          </Panel>

          {terminalOpen && (
            <>
              <Separator className="group relative h-px bg-line">
                <span className="absolute inset-x-0 -top-1 -bottom-1 transition group-hover:bg-teal/20" />
              </Separator>
              <Panel defaultSize="30%" minSize="10%" maxSize="70%">
                <TerminalPanel />
              </Panel>
            </>
          )}
        </Group>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- 右侧面板 */

function SidePaneSlot() {
  const open = useSidePane((s) => s.open);
  const setOpen = useSidePane((s) => s.setOpen);
  const expandedSize = useSidePane((s) => s.expandedSize);
  const sessionId = useWorkbench((s) => s.activeSessionId);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="展开右侧面板"
        className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-line bg-rail pt-4 text-graphite hover:bg-line-soft hover:text-ink"
      >
        <span style={{ writingMode: "vertical-rl" }} className="text-body-sm">
          面板
        </span>
      </button>
    );
  }

  // 展开尺寸由外层 Group 的 onLayoutChanged 统一记忆（v4 的 Panel 上没有该回调）
  return (
    <Panel
      id={SIDE_PANE_PANEL_ID}
      defaultSize={expandedSize}
      minSize="15%"
      maxSize="45%"
      className="overflow-hidden"
    >
      <SidePane ownerId={sessionId} />
    </Panel>
  );
}
