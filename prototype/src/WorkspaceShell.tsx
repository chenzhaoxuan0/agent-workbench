import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { Composer } from "./ui/Composer.tsx";
import { MemoryPanel } from "./ui/MemoryPanel.tsx";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { ImageStudioPage } from "./ui/ImageStudioPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { AgentInspector } from "./ui/AgentInspector.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { useWorkbench } from "./store/useWorkbench.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { Timeline } from "./ui/Timeline.tsx";
import { WorkspaceHeader } from "./ui/WorkspaceHeader.tsx";
import { TrajectoryView } from "./ui/TrajectoryView.tsx";
import { cn } from "./ui/cn.ts";
import { bindNavRecorder } from "./store/useNav.ts";
import { useShell, bindShellShortcuts } from "./store/useShell.ts";

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

  // WP-7 窄屏（手机局域网）：<900px 自动收侧栏，主列全宽——收起即归零语义复用；
  // 只在从宽变窄的瞬间收一次，不把用户的手动展开反复压回
  useEffect(() => {
    // wasWide 恒以 true 起步（评审 P2）：首载即窄屏（手机 390px 直开）也要收——
    // 旧初值让首调 onResize 恒为死代码，"从宽变窄"永远不成立
    let wasWide = true;
    const onResize = (): void => {
      const wide = window.innerWidth >= 900;
      if (wasWide && !wide && !useShell.getState().sidebarCollapsed) {
        useShell.setState({ sidebarCollapsed: true });
      }
      wasWide = wide;
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      {/* 主视图只有 chat / automations / image */}
      {mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : mainView === "image" ? (
        /* 出图工作台（独立主视图） */
        <main className="h-full min-h-0" aria-label="出图">
          <ImageStudioPage />
        </main>
      ) : (
        <Group orientation="vertical" id="workbench-conversation">
          <Panel defaultSize="100%" minSize="30%" className="min-h-0">
            <main className="flex h-full min-h-0 flex-col" aria-label="会话">
              {/* 工作区头部：展示 Agent 身份卡、终端抽屉开关、Agent 档案抽屉开关 */}
              <WorkspaceHeader />

              {conversationView === "trajectory" ? (
                <>
                  <div className="flex shrink-0 items-center justify-between border-b border-line bg-canvas px-6 py-2">
                    <button
                      onClick={() => setConversationView("chat")}
                      className="flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-body-sm text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <ArrowLeft size={13} />
                      <span>返回对话</span>
                    </button>
                    <span className="text-caption text-ash font-mono">调用轨迹视图</span>
                  </div>
                  <TrajectoryView />
                </>
              ) : (
                <Timeline />
              )}
              {/* 权限卡片 */}
              {(conversationView === "chat" || conversationView === "trajectory") && <PermissionDialog />}
              {/* 记忆三柱：技能 / 记忆 / 会话搜索，压在 composer 正上方 */}
              {(conversationView === "chat" || conversationView === "trajectory") && <MemoryPanel />}
              {(conversationView === "chat" || conversationView === "trajectory") && <Composer />}
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
      <AgentInspector />
    </Panel>
  );
}

