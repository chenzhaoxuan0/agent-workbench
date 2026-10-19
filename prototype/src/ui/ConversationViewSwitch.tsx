import { MessageSquare, SquareTerminal } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 会话形态切换（结构化对话 | 终端 TUI）—— PC 头部与手机顶栏共用同一份。
 *
 * 共用不是为了省代码，而是消灭「同一颗控件在两个版式里长得不一样」的跳变：
 * 此前桌面与手机各写一套（字号 12/11、内距 px-2.5/px-2、激活态两种底色、
 * 文案「终端 TUI / 终端」），窗口宽度跨过版式阈值时它不只是换了位置，还换
 * 了样子。规格统一为桌面档（text-[12px] · 图标 13 · px-2.5 py-1），手机
 * 顶栏 h-12 放得下。
 *
 * 位置语义也统一为**靠右**：桌面头部里状态组 ml-auto 锚定后，它压在行尾倒数
 * 第二（右侧仅剩面板开合钮；面板钮让位后它就是最右），手机顶栏天然在右——
 * 缩放窗口的全过程中它不动，周围元素按溢出阶梯让位，跨版式阈值时位置与
 * 外观都不变。
 */
export function ConversationViewSwitch({ className }: { className?: string }) {
  const conversationView = useShell((s) => s.conversationView);
  const setConversationView = useShell((s) => s.setConversationView);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center whitespace-nowrap rounded-btn border border-line/40 bg-line-soft/80 p-0.5",
        className,
      )}
    >
      <button
        onClick={() => setConversationView("chat")}
        aria-label="切换至对话视图"
        title="结构化对话：归一化事件流渲染的消息时间线，支持工具卡片、审批与用量（所有执行器统一形态）"
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-[12px] font-medium transition",
          conversationView === "chat"
            ? "bg-card text-teal shadow-xs font-semibold border border-teal/25"
            : "text-graphite hover:text-ink",
        )}
      >
        <MessageSquare size={13} />
        <span>对话</span>
      </button>
      <button
        onClick={() => setConversationView("terminal")}
        aria-label="切换至终端视图"
        title="交互终端模式：直接在单元根目录运行 Agent CLI，享有原生 TUI 与斜杠命令"
        className={cn(
          "flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-[12px] font-medium transition",
          conversationView === "terminal"
            ? "bg-card text-teal shadow-xs font-semibold border border-teal/25"
            : "text-graphite hover:text-ink",
        )}
      >
        <SquareTerminal size={13} />
        <span>终端 TUI</span>
      </button>
    </div>
  );
}
