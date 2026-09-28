import { useEffect, useRef } from "react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { Composer } from "./ui/Composer.tsx";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SidePane } from "./ui/SidePane.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { useWorkbench } from "./store/useWorkbench.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { Timeline } from "./ui/Timeline.tsx";
import { WorkspaceHeader } from "./ui/WorkspaceHeader.tsx";
import { TrajectoryView } from "./ui/TrajectoryView.tsx";
import { OpsView } from "./ui/OpsView.tsx";
import { cn } from "./ui/cn.ts";
import { bindNavRecorder } from "./store/useNav.ts";
import { SIDEBAR_DEFAULT, useShell, bindShellShortcuts } from "./store/useShell.ts";

/**
 * 工作台外壳 —— 布局结构对齐 ZCode 的 WorkspaceShellLayout。
 *
 * 照搬的 ZCode 约定：
 *   - 侧栏 264px 起，min 264，max 视口 50%，宽度持久化
 *   - 对话区纵向再切一层（会话 | 终端），终端默认 30% 高、可开关
 *   - **面板收起即归零**：左栏收起不留窄条、右栏关闭即让位（Group 里条件渲染），
 *     重开的唯一入口是工作区头部那颗状态感知的开关按钮
 *     —— ZCode 的 DesktopTopOverlay / WorkspaceHeaderActionSection 同款约定
 *
 * 与 ZCode 的差异：ZCode 右侧是内嵌浏览器，本项目右侧换成标签页面板
 * —— 因为「多工具平等切换 + 能力对比」比内嵌浏览器更核心。
 *
 * 注：react-resizable-panels v4 的 API 与 v2/v3 不同
 * （Group / Separator / PanelSize{inPixels,asPercentage}）。
 */
export function WorkspaceShell() {
  const paneOpen = useSidePane((s) => s.open);
  const settingsOpen = useShell((s) => s.settingsOpen);
  // 导航记账先于快捷键绑定：首帧快照作为历史起点
  useEffect(() => bindNavRecorder(), []);
  useEffect(() => bindShellShortcuts(), []);

  return (
    <div className="relative flex h-screen flex-col bg-canvas">
      {/* 左上浮层 —— 侧栏开关 / 前进后退 / 新建任务（ZCode 的 DesktopTopOverlay）。
          悬浮在侧栏区域上方，侧栏收起后原地保留，主视图切换不消失 */}
      <DesktopTopOverlay />
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
        {paneOpen && <ResizeHandle />}
        <SidePaneSlot />
      </Group>

      {/* 设置覆盖层 —— 对齐 ZCode 的 WorkspaceSettingsLayer：absolute inset-0 压在
          shell 之上，shell 不卸载；Esc / 返回工作台退出（useShell.closeSettings） */}
      {settingsOpen && (
        <div className="absolute inset-0 z-40 bg-canvas">
          <SettingsPage />
        </div>
      )}

      <CommandCenter />
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

function SidebarSlot() {
  const collapsed = useShell((s) => s.sidebarCollapsed);
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
      // ZCode：收起即归零（web 侧为 0，桌面端 4px 是它的窗口内缩需求），不留常驻窄条
      collapsedSize="0px"
      collapsible
      onResize={(size) => {
        // 折叠过程中不要把 0 写回持久化宽度
        if (!collapsed) setWidth(size.inPixels);
      }}
      className="overflow-hidden"
    >
      {/* 内容保持挂载、由 Panel 裁剪 —— 对齐 ZCode 的 opacity-0 + pointer-events-none 策略 */}
      <Sidebar />
    </Panel>
  );
}

/* ------------------------------------------------------------- 对话区 */

function ConversationSlot() {
  const terminalOpen = useShell((s) => s.terminalOpen);
  const mainView = useShell((s) => s.mainView);
  const conversationView = useShell((s) => s.conversationView);
  const setConversationView = useShell((s) => s.setConversationView);

  return (
    <Panel defaultSize="62%" minSize="30%" className="min-w-0">
      {/* 主视图只有 chat / automations 两种（ZCode 的 WorkspaceMainView）；
          设置是覆盖层、搜索是命令中心，都不占主列 */}
      {mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : (
        <Group orientation="vertical" id="workbench-conversation">
          <Panel defaultSize="100%" minSize="30%" className="min-h-0">
            <main className="flex h-full min-h-0 flex-col" aria-label="会话">
              {/* 工作区头部 —— 只挂在会话视图（ZCode 的 WorkspaceHeader 是 task 级的，
                  automations 自带面包屑头） */}
              <WorkspaceHeader />
              {/* 会话内页签（dsh ConversationSession tabs：对话 / 轨迹与 Chat 并列；
                  Ops 是 LLM-Ops 仪表盘页签，对齐 waku dashboard 的 Ops 页签。
                  前两者是同一会话的两种读法，composer 保持在底部；
                  Ops 是运营视图，占据整个会话视口且不渲染 composer） */}
              <div className="flex shrink-0 items-center gap-1 border-b border-line px-6">
                {(["chat", "trajectory", "ops"] as const).map((v) => {
                  const label = v === "chat" ? "对话" : v === "trajectory" ? "轨迹" : "Ops";
                  const active = conversationView === v;
                  return (
                    <button
                      key={v}
                      onClick={() => setConversationView(v)}
                      role="tab"
                      aria-selected={active}
                      className={cn(
                        "-mb-px border-b-2 px-3 py-2 text-body-sm",
                        active
                          ? "border-teal font-medium text-ink"
                          : "border-transparent text-graphite hover:text-ink",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {conversationView === "trajectory" ? (
                /* 轨迹视图（dsh TrajectoryView：占据会话视口，composer 保持底部） */
                <TrajectoryView />
              ) : conversationView === "ops" ? (
                /* Ops 视图（waku dashboard 的 Ops 页签：发布门 / 两类 eval / Arena / 花费账本） */
                <OpsView />
              ) : (
                <Timeline />
              )}
              {/* 权限卡片 —— 对齐 ZCode 的 V4InteractionDialogs：作为 composer 上方的
                  bottom dock 卡片打断，而不是居中模态。Ops 是运营视图，不打断 */}
              {conversationView !== "ops" && <PermissionDialog />}
              {conversationView !== "ops" && <Composer />}
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
  const expandedSize = useSidePane((s) => s.expandedSize);
  const sessionId = useWorkbench((s) => s.activeSessionId);

  // 关闭即彻底让位（渲染 null）：重开入口在工作区头部的右栏开关
  if (!open) return null;

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
