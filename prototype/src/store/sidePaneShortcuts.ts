import { visibleTabsForUnit } from "../core/sidePaneTabs.ts";
import { useSidePane } from "./useSidePane.ts";

/**
 * 右侧面板的全局快捷键（ZCode 口径：toggleSidePane = Cmd/Ctrl+Alt+B）：
 * - Ctrl+Alt+B：开合右侧面板（状态感知，同头部按钮）
 * - Alt+1..9：激活当前视角第 n 个可见 tab（无第 n 个不吞键）
 * - Ctrl+Tab / Ctrl+Shift+Tab：循环激活（面板未开时顺带展开）
 *
 * 输入框 / 终端聚焦时不接 Alt+数字 与 Ctrl+Tab —— 那里的键属于正在输入的
 * 内容（xterm 的 Ctrl+Tab 会进 PTY，Composer 里 Alt+数字 是用户的字符），
 * 全局拦截会让「面板快捷键」变成「输入法破坏者」。
 */
export function bindSidePaneShortcuts(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      useSidePane.getState().toggleFromHeader();
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el !== null && el.closest("input, textarea, select, [contenteditable='true'], .xterm")) return;

    const pane = useSidePane.getState();
    const visible = visibleTabsForUnit(pane.tabs, pane.scopeUnitId);
    if (visible.length === 0) return;

    // 用 e.code 判数字：macOS 的 Option+数字产生特殊字符（e.key 不是 "1".."9"），
    // Digit1..Digit9 的物理键码跨布局稳定
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      const idx = Number(e.code.slice(5)) - 1;
      if (idx >= visible.length) return;
      e.preventDefault();
      pane.expandAndActivate(visible[idx]!.id);
      return;
    }
    if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
      e.preventDefault();
      const cur = visible.findIndex((t) => t.id === pane.activeTabId);
      // 无聚焦（cur < 0）时从末位起跳，Ctrl+Tab 落到第一个 —— 从 length 起算
      // 会让 (len+1)%len === 1，凭空跳过第一个
      const base = cur < 0 ? visible.length - 1 : cur;
      const dir = e.shiftKey ? -1 : 1;
      const next = visible[(base + dir + visible.length) % visible.length]!;
      pane.expandAndActivate(next.id);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
