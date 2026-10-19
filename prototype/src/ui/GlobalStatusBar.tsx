import { BackgroundGuardianBadge, WorkPhaseBadge } from "./StatusIndicators.tsx";

/**
 * 全局底栏 —— 状态显示类功能的专席，横贯窗口底部。
 *
 * 落点演进（为什么是这里）：
 * 1. 工作区头部 —— 高频操作区，状态徽标挤占身份卡与形态切换的宽度；
 * 2. 右侧栏底条 —— 要先开面板，位置太深；
 * 3. 左侧栏底部 —— 永远可见，但 264px 的栏宽装不下 288px 的详情弹层，
 *    弹出即溢出出横向滚动条（本次迁移的动因）；
 * 4. **全局底栏**：不属于任何一列的全局状态就该住全局层——弹层向上展开时
 *    有整个窗口的宽度可用，与三列布局的任何开合都解耦。
 *
 * 后续状态类功能（守护进程、同步状态等）都往这里放；操作类仍归各列。
 * 弹层朝上开（popoverUp）且左锚定（align=left，底栏内容居左）。
 */
export function GlobalStatusBar() {
  return (
    <footer
      aria-label="全局状态栏"
      className="flex h-7 shrink-0 items-center gap-3 border-t border-line/60 bg-rail px-3"
    >
      <WorkPhaseBadge popoverUp align="left" />
      <BackgroundGuardianBadge popoverUp align="left" />
    </footer>
  );
}
