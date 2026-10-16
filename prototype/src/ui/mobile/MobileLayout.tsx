import { useState } from "react";
import {
  Menu,
  MessageSquare,
  QrCode,
  SquareTerminal,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../../store/useWorkbench.ts";
import { useShell } from "../../store/useShell.ts";
import { Timeline } from "../Timeline.tsx";
import { Composer } from "../Composer.tsx";
import { TerminalPanel } from "../TerminalPanel.tsx";
import { ProposalBanner } from "../ProposalBanner.tsx";
import { SettingsPage } from "../SettingsPage.tsx";
import { RemoteControlDialog } from "../RemoteControlDialog.tsx";
import { MobileConfirmationGate } from "./MobileConfirmationGate.tsx";
import { MobileVirtualKeyBar } from "./MobileVirtualKeyBar.tsx";
import { MobileDrawer } from "./MobileDrawer.tsx";
import { type LayoutPreference } from "./useIsMobile.ts";
import { cn } from "../cn.ts";

export function MobileLayout({
  preference,
  onSetPreference,
}: {
  preference: LayoutPreference;
  onSetPreference: (p: LayoutPreference) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);

  const unit = useWorkbench(selectActiveUnit);
  const busy = useWorkbench((s) => s.busy);
  const conversationView = useShell((s) => s.conversationView);
  const setConversationView = useShell((s) => s.setConversationView);
  const settingsOpen = useShell((s) => s.settingsOpen);

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-canvas text-ink select-none">
      {/* 1. 移动端轻量顶栏 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line/70 bg-rail/90 px-3 backdrop-blur-md z-30">
        {/* 左侧：抽屉菜单按钮 + Agent 名字 */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="打开导航抽屉"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-graphite transition active:scale-95 hover:text-ink"
          >
            <Menu size={16} />
          </button>

          {unit ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body-sm font-semibold text-ink">
                {unit.name}
              </span>
              <span className="shrink-0 rounded-full bg-teal-tint px-1.5 py-0.2 text-[10px] font-medium text-teal">
                {unit.identity?.role || "Agent"}
              </span>
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  busy ? "bg-teal animate-pulse" : "bg-gain",
                )}
                title={busy ? "执行中" : "空闲"}
              />
            </div>
          ) : (
            <span className="text-caption text-ash">未选择 Agent</span>
          )}
        </div>

        {/* 右侧：形态切换 (对话/终端) + 远控中心 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-line/60 bg-line-soft/80 p-0.5">
            <button
              onClick={() => setConversationView("chat")}
              aria-label="切换至对话视图"
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                conversationView === "chat"
                  ? "bg-card text-teal font-semibold shadow-xs"
                  : "text-graphite hover:text-ink",
              )}
            >
              <MessageSquare size={12} />
              <span>对话</span>
            </button>
            <button
              onClick={() => setConversationView("terminal")}
              aria-label="切换至终端视图"
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                conversationView === "terminal"
                  ? "bg-card text-teal font-semibold shadow-xs"
                  : "text-graphite hover:text-ink",
              )}
            >
              <SquareTerminal size={12} />
              <span>终端</span>
            </button>
          </div>

          <button
            onClick={() => setRemoteOpen(true)}
            aria-label="远控中心"
            title="移动端远控中心"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-teal transition active:scale-95 hover:bg-teal hover:text-white"
          >
            <QrCode size={15} />
          </button>
        </div>
      </header>

      {/* 2. 主内容展示区 */}
      <main className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* 对话视图 */}
        <div
          className={cn(
            "flex h-full min-h-0 flex-1 flex-col",
            conversationView === "chat" ? "flex" : "hidden",
          )}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <Timeline />
          </div>

          {/* 底部输入框（防键盘顶起，100dvh） */}
          <div className="shrink-0 border-t border-line/40 bg-canvas/90 backdrop-blur-md">
            <Composer />
          </div>

          {/* 底部手势审批确认门浮层 */}
          <MobileConfirmationGate />
        </div>

        {/* 终端视图 */}
        <div
          className={cn(
            "flex h-full min-h-0 flex-1 flex-col",
            conversationView === "terminal" ? "flex" : "hidden",
          )}
        >
          <div className="flex-1 min-h-0 relative bg-black">
            <TerminalPanel variant="canvas" />
          </div>

          {/* 终端虚拟辅助键行 */}
          <MobileVirtualKeyBar />
        </div>
      </main>

      {/* 3. 抽屉与全屏模态 */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenRemote={() => setRemoteOpen(true)}
        preference={preference}
        onSetPreference={onSetPreference}
      />

      {remoteOpen && (
        <RemoteControlDialog onClose={() => setRemoteOpen(false)} />
      )}

      {/* 待办提议横幅 */}
      <ProposalBanner />

      {/* 设置页 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 bg-canvas-solid">
          <SettingsPage />
        </div>
      )}
    </div>
  );
}
