import { useState } from "react";
import {
  Menu,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../../store/useWorkbench.ts";
import { useShell } from "../../store/useShell.ts";
import { Timeline } from "../Timeline.tsx";
import { Composer } from "../Composer.tsx";
import { ChatTerminalDock } from "../ChatTerminalDock.tsx";
import { TerminalPanel } from "../TerminalPanel.tsx";
import { ProposalBanner } from "../ProposalBanner.tsx";
import { SettingsPage } from "../SettingsPage.tsx";
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

  const unit = useWorkbench(selectActiveUnit);
  const busy = useWorkbench((s) => s.busy);
  const conversationView = useShell((s) => s.conversationView);
  const setConversationView = useShell((s) => s.setConversationView);
  const settingsOpen = useShell((s) => s.settingsOpen);

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-canvas text-ink select-none">
      {/* 1. 移动端顶栏 —— 与 PC 顶栏统一使用 bg-rail 与 border-line/60 主题色阶 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line/60 bg-rail px-3 text-ink z-30 select-none">
        {/* 左侧：抽屉菜单按钮 + Agent 名字 */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="打开导航抽屉"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card/80 text-graphite transition active:scale-95 hover:text-ink hover:bg-line-soft"
          >
            <Menu size={16} />
          </button>

          {unit ? (
            <span className="truncate text-body-sm font-semibold text-ink">
              {unit.name}
            </span>
          ) : (
            <span className="text-caption text-ash">未选择 Agent</span>
          )}
        </div>

        {/* 右侧：形态切换 (对话/终端) */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-line bg-card/80 p-0.5">
            <button
              onClick={() => setConversationView("chat")}
              aria-label="切换至对话视图"
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                conversationView === "chat"
                  ? "bg-line-soft text-teal font-semibold shadow-xs"
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
                  ? "bg-line-soft text-teal font-semibold shadow-xs"
                  : "text-graphite hover:text-ink",
              )}
            >
              <SquareTerminal size={12} />
              <span>终端</span>
            </button>
          </div>
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
          <div className="flex flex-1 min-h-0 flex-col">
            <Timeline />
          </div>

          {/* 底部输入框（防键盘顶起，100dvh） */}
          <div className="shrink-0 border-t border-line/40 bg-canvas">
            <Composer onOpenDrawer={() => setDrawerOpen(true)} />
          </div>

          {/* 对话页小终端：输入框下方（与桌面同款） */}
          <ChatTerminalDock />

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
        preference={preference}
        onSetPreference={onSetPreference}
      />

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
