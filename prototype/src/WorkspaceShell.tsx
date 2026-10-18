import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { BacklogPage } from "./ui/BacklogPage.tsx";
import { ProposalBanner } from "./ui/ProposalBanner.tsx";
import { ImageStudioPage } from "./ui/ImageStudioPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { Composer } from "./ui/Composer.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SourceControlPage } from "./ui/SourceControlPage.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { Timeline } from "./ui/Timeline.tsx";
import { ChatTerminalDock } from "./ui/ChatTerminalDock.tsx";
import { useWorkbench } from "./store/useWorkbench.ts";
import { useTerminalStore } from "./store/useTerminalStore.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { WorkspaceHeader } from "./ui/WorkspaceHeader.tsx";
import { bindShellShortcuts, useShell } from "./store/useShell.ts";
import { HistoryDialog } from "./ui/HistoryDialog.tsx";
import { SidePaneColumn } from "./ui/SidePanePanel.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { MobileLayout } from "./ui/mobile/MobileLayout.tsx";
import { useIsMobile } from "./ui/mobile/useIsMobile.ts";
import { cn } from "./ui/cn.ts";

/**
 * 工作台外壳 —— 布局结构对齐 ZCode 的 WorkspaceShellLayout。
 *
 * 照搬的 ZCode 约定：
 *   - 侧栏 200px 起，min 200，max 视口 50%，宽度持久化
 *   - **面板收起即归零**：左栏收起不留窄条，重开的唯一入口是
 *     工作区头部那颗状态感知的开关按钮
 *     —— ZCode 的 DesktopTopOverlay / WorkspaceHeaderActionSection 同款约定
 *
 * 会话区形态（docs/13 统一 Web 化）：结构化对话（默认）与终端画布可切换，
 * 终端画布持久挂载（隐藏不卸载）。
 *
 * 与 ZCode 的差异：ZCode 右侧是内嵌浏览器，本项目右侧换成标签页面板
 * —— 因为「多工具平等切换 + 能力对比」比内嵌浏览器更核心。
 *
 * 注：react-resizable-panels v4 的 API 与 v2/v3 不同
 * （Group / Separator / PanelSize{inPixels,asPercentage}）。
 */
export function WorkspaceShell() {
  const settingsOpen = useShell((s) => s.settingsOpen);
  const historyModal = useShell((s) => s.historyModal);
  const closeHistoryModal = useShell((s) => s.closeHistoryModal);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const { isMobile, preference, setPreference } = useIsMobile();
  useEffect(() => bindShellShortcuts(), []);

  // 切 bot 联动：右侧面板按当前 bot 过滤可见 tab（隐藏不销毁、记忆恢复聚焦）。
  // 用 effect 而不是订阅回调 —— selectUnit 与 openTab 可能同帧相邻发生
  //（CommandCenter 先切 bot 再开 tab），effect 保证按 render 顺序收敛到最终值。
  useEffect(() => {
    useSidePane.getState().handleUnitChange(activeUnitId);
  }, [activeUnitId]);

  // 首载重挂：F5 后把 daemon 里还活着的终端进程找回成标签（带最近输出回放）。
  // 不找回的话那些 PTY 就是界面再也关不掉的孤儿进程。
  useEffect(() => {
    void useTerminalStore.getState().reattachFromDaemon();
    // created 帧推送认领：定时任务的 TUI 派发一到点就自动弹标签，不等刷新
    useTerminalStore.getState().installTerminalCreatedClaim();
  }, []);

  if (isMobile) {
    return <MobileLayout preference={preference} onSetPreference={setPreference} />;
  }

  return (
    /* 画布底色只由 body 刷一次（开壁纸时它就是唯一的全局半透明层），
       这里不再叠 bg-canvas —— 嵌套重复刷会让壁纸被多层 70% 黑乘到不可见 */
    <div className="relative flex h-screen flex-col">
      {/* 左上浮层 —— 侧栏开关 / 新建任务（ZCode 的 DesktopTopOverlay）。
          悬浮在侧栏区域上方，侧栏收起后原地保留，主视图切换不消失 */}
      <DesktopTopOverlay />
      {/* 侧栏 + 主对话流 + 右侧标签面板 —— ZCode 三列布局 */}
      <Group orientation="horizontal" id="workbench-shell">
        <SidebarSlot />
        <ResizeHandle />
        <ConversationSlot />
        <SidePaneColumn />
      </Group>

      {/* 设置覆盖层 —— 对齐 ZCode 的 WorkspaceSettingsLayer：absolute inset-0 压在
          shell 之上，shell 不卸载；Esc / 返回工作台退出（useShell.closeSettings） */}
      {settingsOpen && (
        <div className="absolute inset-0 z-40 bg-canvas-solid">
          <SettingsPage />
        </div>
      )}

      {/* 待办提议横幅 —— 确认门的载体，跨主视图常驻（任何视图下都能确认/拒绝） */}
      <ProposalBanner />

      <CommandCenter />

      {historyModal && (
        <HistoryDialog
          unitId={historyModal.unitId}
          unitName={historyModal.unitName}
          focusKey={historyModal.focusKey}
          onClose={closeHistoryModal}
        />
      )}
    </div>
  );
}
function ResizeHandle() {
  return (
    <Separator
      className="group relative w-px bg-line cursor-col-resize transition-colors data-[separator=active]:bg-teal hover:bg-teal/50"
      style={{ cursor: "col-resize" }}
    >
      {/* 16px 宽的命中区域，带明确的 col-resize 光标与 hover/active 激活高亮条 */}
      <span
        className="absolute inset-y-0 -left-2 -right-2 z-20 cursor-col-resize transition-colors group-hover:bg-teal/20 group-data-[separator=active]:bg-teal/30"
        aria-hidden
      />
    </Separator>
  );
}

/* ------------------------------------------------------------- 侧栏 */

function SidebarSlot() {
  const collapsed = useShell((s) => s.sidebarCollapsed);
  const setWidth = useShell((s) => s.setSidebarWidth);
  // ⚠ initialWidth 只在挂载时读取一次持久化宽度作为 defaultSize。
  const [initialWidth] = useState(() => useShell.getState().sidebarWidth);
  const ref = useRef<PanelImperativeHandle>(null);
  const isMountedRef = useRef(false);

  // 首帧挂载后显式应用 initialWidth 像素值，并仅在稳定后接收真实用户手势更新
  useEffect(() => {
    if (!collapsed && ref.current) {
      ref.current.resize(`${initialWidth}px`);
    }
    const timer = setTimeout(() => {
      isMountedRef.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, [initialWidth, collapsed]);

  // WP-7 窄屏（手机局域网）：<900px 自动收侧栏，主列全宽——收起即归零语义复用；
  // 只在从宽变窄的瞬间收一次，不把用户的手动展开反复压回
  useEffect(() => {
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
      defaultSize={`${initialWidth}px`}
      minSize="200px"
      maxSize="50%"
      // ZCode：收起即归零（web 侧为 0，桌面端 4px 是它的窗口内缩需求），不留常驻窄条
      collapsedSize="0px"
      collapsible
      onResize={(size) => {
        // 仅在真实交互/挂载就绪后，且未折叠时才持久化宽度
        if (isMountedRef.current && !collapsed) {
          setWidth(size.inPixels);
        }
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
  const mainView = useShell((s) => s.mainView);
  const conversationView = useShell((s) => s.conversationView);

  return (
    <Panel minSize="30%" className="min-w-0">
      {/* 主视图：chat / automations / image / backlog */}
      {mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : mainView === "image" ? (
        /* 出图工作台（独立主视图） */
        <main className="h-full min-h-0" aria-label="出图">
          <ImageStudioPage />
        </main>
      ) : mainView === "backlog" ? (
        /* 待办清单（独立主视图） */
        <main className="h-full min-h-0" aria-label="待办">
          <BacklogPage />
        </main>
      ) : mainView === "sourceControl" ? (
        /* 源代码管理（独立主视图）：分支 / 工作树 */
        <main className="h-full min-h-0" aria-label="源代码管理">
          <SourceControlPage />
        </main>
      ) : (
        <main className="flex h-full min-h-0 flex-col" aria-label="会话">
          {/* 工作区头部：Agent 身份卡 + 会话形态切换（对话/终端） */}
          <WorkspaceHeader />

          {/* 结构化对话视图（docs/13：默认形态）—— 归一化事件流渲染 */}
          {conversationView === "chat" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <Timeline />
              <PermissionDialog />
              <Composer />
              {/* 对话页小终端：在输入框下方（ZCode 同款），与 TUI 终端页互相独立 */}
              <ChatTerminalDock />
            </div>
          )}

          {/* 终端画布持久挂载：切换视图时不杀进程、不丢缓冲，切回瞬间即达 */}
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              conversationView === "terminal" ? "flex" : "hidden",
            )}
          >
            <TerminalPanel variant="canvas" />
          </div>
        </main>
      )}
    </Panel>
  );
}



