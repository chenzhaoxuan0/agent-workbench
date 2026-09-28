import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 终端页签 —— 多窗格并开工作台（大屏下并排使用多个 provider CLI 的 TUI）。
 *
 * 窗格是同一 TerminalPanel 组件的独立实例（原型期无真 PTY，各窗格
 * 各自状态）；「分屏」最多 3 列，每列头部可单独关闭。最后一格关闭 =
 * 退出终端页签回对话。与底部 dock 终端是两个入口，可同屏共存：
 * 页签在会话 Panel 内占据视口，dock 在其下方 30% 面板。
 */

const MAX_PANES = 3;

export function TerminalPage() {
  const setConversationView = useShell((s) => s.setConversationView);
  const [panes, setPanes] = useState<readonly number[]>([1]);
  const nextId = useRef(2);

  const addPane = () => {
    if (panes.length >= MAX_PANES) return;
    setPanes([...panes, nextId.current]);
    nextId.current += 1;
  };

  const closePane = (id: number) => {
    if (panes.length > 1) {
      setPanes(panes.filter((p) => p !== id));
    } else {
      // 最后一格：退出终端页签（而不是留下空页）
      setConversationView("chat");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {/* 工具条：窗格数 + 分屏入口 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <p className="text-caption text-graphite">
          终端工作台 · {panes.length} 窗格
          <span className="ml-2 text-ash">独立实例，可分别运行不同 provider CLI 的 TUI</span>
        </p>
        <button
          onClick={addPane}
          disabled={panes.length >= MAX_PANES}
          aria-label="新增终端窗格"
          title={panes.length >= MAX_PANES ? `最多 ${MAX_PANES} 个窗格` : "横向分屏"}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite",
            panes.length >= MAX_PANES ? "cursor-not-allowed opacity-50" : "hover:bg-line-soft hover:text-ink",
          )}
        >
          <Plus size={11} />
          分屏
        </button>
      </div>

      {/* 窗格行：横向并开，竖分隔线 */}
      <div className="flex min-h-0 flex-1">
        {panes.map((id, i) => (
          <div key={id} className={cn("min-w-0 flex-1", i > 0 && "border-l border-line")}>
            <TerminalPanel
              variant="page"
              label={`终端 #${i + 1}`}
              onClose={() => closePane(id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
