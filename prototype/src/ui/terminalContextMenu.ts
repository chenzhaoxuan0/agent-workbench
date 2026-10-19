/**
 * 终端右键菜单 —— 复制 / 粘贴（对齐 ZCode TerminalSession.tsx 的场景）。
 *
 * xterm 的选区画在 canvas 里，不是 DOM selection：Electron 原生文本右键
 * （electron/main.cjs）对终端无效，必须在终端容器上自接 contextmenu 并调
 * TerminalSession 暴露的选区/剪贴板方法。TerminalPaneSlot（工作台终端）与
 * ChatTerminalDock（对话终端）两个挂点共用本 hook。
 */

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ClipboardPaste, Copy } from "lucide-react";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";

export function useTerminalContextMenu(terminalId: string | null | undefined) {
  const [menu, setMenu] = useState<QuickMenuState | null>(null);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      const session = terminalId ? terminalSessionRegistry.get(terminalId) : undefined;
      // 会话尚未建好（F5 校正窗口等）时保持右键安静，不出空菜单
      if (session === undefined) return;
      setMenu(
        quickMenuFromEvent(e, [
          {
            label: "复制",
            icon: Copy,
            disabled: !session.hasSelection(),
            onSelect: () => void session.copySelection(),
          },
          { label: "粘贴", icon: ClipboardPaste, onSelect: () => void session.pasteFromClipboard() },
        ]),
      );
    },
    [terminalId],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  return { menu, onContextMenu, closeMenu };
}
