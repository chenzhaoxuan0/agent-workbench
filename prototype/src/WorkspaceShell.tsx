import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Ellipsis } from "lucide-react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { Composer } from "./ui/Composer.tsx";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { ImageStudioPage } from "./ui/ImageStudioPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SidePane } from "./ui/SidePane.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { useWorkbench } from "./store/useWorkbench.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { TerminalPage } from "./ui/TerminalPage.tsx";
import { Timeline } from "./ui/Timeline.tsx";
import { WorkspaceHeader } from "./ui/WorkspaceHeader.tsx";
import { TrajectoryView } from "./ui/TrajectoryView.tsx";
import { OpsView } from "./ui/OpsView.tsx";
import { cn } from "./ui/cn.ts";
import { bindNavRecorder } from "./store/useNav.ts";
import { SIDEBAR_DEFAULT, useShell, bindShellShortcuts, type ConversationView } from "./store/useShell.ts";

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
  // setConversationView 由 ConversationViewBar 独占，这里不再需要

  return (
    <Panel defaultSize="62%" minSize="30%" className="min-w-0">
      {/* 主视图只有 chat / automations 两种（ZCode 的 WorkspaceMainView）；
          设置是覆盖层、搜索是命令中心，都不占主列 */}
      {mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : mainView === "image" ? (
        /* 出图工作台 —— gpt_image_playground 逻辑移植的落点（独立功能主视图） */
        <main className="h-full min-h-0" aria-label="出图">
          <ImageStudioPage />
        </main>
      ) : (
        <Group orientation="vertical" id="workbench-conversation">
          <Panel defaultSize="100%" minSize="30%" className="min-h-0">
            <main className="flex h-full min-h-0 flex-col" aria-label="会话">
              {/* 工作区头部 —— 只挂在会话视图（ZCode 的 WorkspaceHeader 是 task 级的，
                  automations 自带面包屑头） */}
              <WorkspaceHeader />
              {/* 会话内页签 → 「对话 + ⋯」。
                  渐进披露：4 个页签常驻是一条 37px 高的固定行 + 4 枚标签，
                  而终端/轨迹/Ops 三者里同一时刻只有一个在用。
                  现在只有「对话」常驻，其余三个收进 ⋯，点开才占版面。
                  仍在会话视口、composer 位置都不变。 */}
              <ConversationViewBar />
              {conversationView === "trajectory" ? (
                /* 轨迹视图（dsh TrajectoryView：占据会话视口，composer 保持底部） */
                <TrajectoryView />
              ) : conversationView === "terminal" ? (
                /* 终端页签（多窗格并开工作台；与底部 dock 终端同组件不同实例，可同屏共存） */
                <TerminalPage />
              ) : conversationView === "ops" ? (
                /* Ops 视图（waku dashboard 的 Ops 页签：发布门 / 两类 eval / Arena / 花费账本） */
                <OpsView />
              ) : (
                <Timeline />
              )}
              {/* 权限卡片 —— 对齐 ZCode 的 V4InteractionDialogs：作为 composer 上方的
                  bottom dock 卡片打断，而不是居中模态。终端 / Ops 是非会话视图，不打断 */}
              {(conversationView === "chat" || conversationView === "trajectory") && <PermissionDialog />}
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
      <SidePane ownerId={sessionId} />
    </Panel>
  );
}

/* ------------------------------------------------- 会话内页签：对话 + ⋯ */

const CONVERSATION_VIEWS: readonly { id: ConversationView; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "terminal", label: "终端" },
  { id: "trajectory", label: "轨迹" },
  { id: "ops", label: "Ops" },
];

/**
 * 会话内视图切换条 —— 渐进披露后只剩两枚控件。
 *
 * 「对话」常驻：它是 95% 时间待着的那一面，必须一直可达。
 * 其余三个（终端 / 轨迹 / Ops）收进 ⋯：
 * - 在「对话」时，⋯ 只显示一个图标，不占文字宽度；
 * - 已切到别的视图时，⋯ **变成当前视图名 + 箭头**，
 *   所以"我现在不在对话里"这件事一眼可见，不会迷失在另一个视口。
 *
 * 四个选项在浮层里全部列出（当前项打勾）——收起的只是版面，不是入口。
 */
function ConversationViewBar() {
  const view = useShell((s) => s.conversationView);
  const setView = useShell((s) => s.setConversationView);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onChat = view === "chat";
  const current = CONVERSATION_VIEWS.find((v) => v.id === view) ?? CONVERSATION_VIEWS[0]!;

  const tabClass = (active: boolean) =>
    cn(
      "-mb-px border-b-2 px-3 py-2 text-body-sm",
      active ? "border-teal font-medium text-ink" : "border-transparent text-graphite hover:text-ink",
    );

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-6" role="tablist">
      <button onClick={() => setView("chat")} role="tab" aria-selected={onChat} className={tabClass(onChat)}>
        对话
      </button>

      <div ref={ref} className="relative -mb-px ml-1">
        <button
          onClick={() => setOpen((o) => !o)}
          role="tab"
          aria-selected={!onChat}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="切换会话视图"
          title="切换会话视图"
          className={cn(
            "flex items-center gap-1 border-b-2 px-2 py-2 text-body-sm",
            onChat
              ? "border-transparent text-graphite hover:text-ink"
              : "border-teal font-medium text-ink",
          )}
        >
          {onChat ? <Ellipsis size={14} /> : <>{current.label}<ChevronDown size={12} className="opacity-60" /></>}
        </button>

        {open && (
          <>
            <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
            <div
              role="listbox"
              aria-label="会话视图"
              className="absolute left-0 top-full z-40 mt-1 w-40 rounded-card border border-line bg-canvas py-1 shadow-subtle"
            >
              {CONVERSATION_VIEWS.map((v) => {
                const active = v.id === view;
                return (
                  <button
                    key={v.id}
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setView(v.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm",
                      active ? "font-medium text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
                    )}
                  >
                    {v.label}
                    {active && <Check size={12} className="ml-auto text-teal" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
