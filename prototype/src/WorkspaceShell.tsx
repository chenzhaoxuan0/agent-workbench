import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { Composer } from "./ui/Composer.tsx";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { ImageStudioPage } from "./ui/ImageStudioPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
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
  const settingsOpen = useShell((s) => s.settingsOpen);
  // 导航记账先于快捷键绑定：首帧快照作为历史起点
  useEffect(() => bindNavRecorder(), []);
  useEffect(() => bindShellShortcuts(), []);

  return (
    <div className="relative flex h-screen flex-col bg-canvas">
      {/* 左上浮层 —— 侧栏开关 / 新建任务（ZCode 的 DesktopTopOverlay）。
          悬浮在侧栏区域上方，侧栏收起后原地保留，主视图切换不消失 */}
      <DesktopTopOverlay />
      {/* 侧栏 + 主对话流 —— 极简双栏布局 */}
      <Group orientation="horizontal" id="workbench-shell">
        <SidebarSlot />
        <ResizeHandle />
        <ConversationSlot />
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
  // ⚠ 必须读回持久化宽度：onResize 一直在把拖出来的宽度写进 localStorage，
  // 但这里写死 defaultSize="264px"，于是**每次刷新都被打回 264**——
  // 用户会以为宽度根本没记住。数字会被当成百分比，所以要带 px。
  const sidebarWidth = useShell((s) => s.sidebarWidth);
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
      // 注意：数字会被当成百分比，所以宽度必须写成带单位的字符串
      defaultSize={`${sidebarWidth}px`}
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConversationView("terminal")}
                        className="flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-body-sm text-graphite hover:bg-line-soft hover:text-ink transition"
                      >
                        <ArrowLeft size={13} />
                        <span>返回终端</span>
                      </button>
                      <button
                        onClick={() => setConversationView("chat")}
                        className="flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-body-sm text-graphite hover:bg-line-soft hover:text-ink transition"
                      >
                        <span>查看会话历史</span>
                      </button>
                    </div>
                    <span className="text-caption text-ash font-mono">调用轨迹视图</span>
                  </div>
                  <TrajectoryView />
                </>
              ) : conversationView === "chat" ? (
                <>
                  <Timeline />
                  <PermissionDialog />
                  <Composer />
                </>
              ) : null}

              {/* 终端画布持久挂载：切换视图时不杀进程、不丢缓冲，切回瞬间即达 */}
              <div className={cn("min-h-0 flex-1 flex-col", conversationView === "terminal" ? "flex" : "hidden")}>
                <TerminalPanel variant="canvas" />
              </div>
            </main>
          </Panel>

          {terminalOpen && conversationView !== "terminal" && (
            <>
              <Separator className="group relative h-px bg-line">
                <span className="absolute inset-x-0 -top-1 -bottom-1 transition group-hover:bg-teal/20" />
              </Separator>
              <Panel defaultSize="30%" minSize="10%" maxSize="70%">
                <TerminalPanel variant="dock" />
              </Panel>
            </>
          )}
        </Group>
      )}
    </Panel>
  );
}



