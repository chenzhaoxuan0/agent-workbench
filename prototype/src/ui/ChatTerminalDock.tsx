import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Loader2, RotateCw, SquareTerminal, X } from "lucide-react";
import {
  CHAT_DOCK_UNIT_ID,
  terminalSessionRegistry,
} from "../store/TerminalSessionManager.ts";
import {
  CHAT_DOCK_MIN_HEIGHT,
  chatTerminalProfile,
  readChatTerminalId,
  useChatTerminal,
  writeChatTerminalId,
} from "../store/useChatTerminal.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";

/**
 * 对话页小终端 —— 对话底部可折叠的快捷终端（Composer 左下角 SquareTerminal 按钮唤起）。
 *
 * 定位与 TUI 终端页刻意区分：这里只放「顺手敲两条命令」的小场景，不起 TUI、
 * 不分屏、不进标签树（daemon 侧按 unitId 标记与 TUI 认领互相看不见）。
 * 复用 TerminalSession 全套设施（PTY / 帧订阅 / 主题 / 自适应尺寸）：
 * - 关面板只收起 UI，PTY 留活；
 * - 换 Shell（设置页）或点重启 → 旧 PTY 杀掉重建；
 * - F5 刷新后按 sessionStorage 记的 id 从 terminal.list 认领回放。
 */
export function ChatTerminalDock() {
  const { isMobile } = useIsMobile();
  const open = useChatTerminal((s) => s.open);
  const height = useChatTerminal((s) => s.height);
  const setHeight = useChatTerminal((s) => s.setHeight);
  const profileId = useChatTerminal((s) => s.profileId);
  const restartSeq = useChatTerminal((s) => s.restartSeq);
  const restart = useChatTerminal((s) => s.restart);
  const setOpen = useChatTerminal((s) => s.setOpen);
  const unit = useWorkbench(selectActiveUnit);
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);

  const profile = chatTerminalProfile(profileId);
  const mountRef = useRef<HTMLDivElement>(null);
  /** 当前面板绑定的 PTY id（重启/换 Shell 后会变） */
  const activeIdRef = useRef<string | null>(null);
  const [booting, setBooting] = useState(false);

  /** 建会话（或认领刷新前留下的 PTY）并挂载到容器 */
  const boot = useCallback(async () => {
    const container = mountRef.current;
    if (!container) return;
    setBooting(true);
    try {
      // 会话 id 以 sessionStorage 为唯一事实源（重启/换 Shell 时 store 会先清它）：
      // - registry 里还活着（面板反复开关）→ 直接重挂，瞬达；
      // - registry 没有（F5 刷新）→ 查 terminal.list 认领 daemon 存活的 PTY，带回放；
      // - 都没有 → 新建。
      let sessionId = readChatTerminalId();
      let attachScrollback: string | undefined;

      if (sessionId && !terminalSessionRegistry.get(sessionId)) {
        try {
          const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
          const list = await DaemonClient.get(defaultDaemonEndpoint()).rpc<
            Array<{ terminalId: string; unitId?: string; scrollback?: string }>
          >("terminal.list", null, 8000);
          const row = list.find((t) => t.terminalId === sessionId && t.unitId === CHAT_DOCK_UNIT_ID);
          if (row) {
            attachScrollback = row.scrollback ?? "";
          } else {
            sessionId = null; // 旧 PTY 已没了（daemon 重启 / 被清）：老老实实新建
          }
        } catch {
          sessionId = null; // daemon 不可达也照常新建 —— 面板不该打不开
        }
      }

      if (!sessionId) {
        sessionId = `chtdk_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
      }
      writeChatTerminalId(sessionId);
      activeIdRef.current = sessionId;

      const session = terminalSessionRegistry.getOrCreate({
        terminalId: sessionId,
        shell: profile.shell,
        // cwd 只在「新建 PTY」那一刻有意义：取当下活跃工作单元的根目录
        // （getState 直取而非闭包依赖 —— 换 bot 不该重建一个已活着的终端）
        cwd: useWorkbench.getState().units.find((u) => u.id === useWorkbench.getState().activeUnitId)?.rootPath ?? "",
        unitId: CHAT_DOCK_UNIT_ID,
        attachScrollback,
      });
      session.attachTo(container);
      session.focus();
    } finally {
      setBooting(false);
    }
  }, [profile.shell]);

  // 面板展开时建会话；换 Shell / 重启（restartSeq 变化）→ 杀旧建新
  useEffect(() => {
    if (!open) return;
    void boot();
  }, [open, restartSeq, boot]);

  // 收起时只 detach（PTY 留活，重开瞬达）；重启/换 Shell 后旧会话由 restart 的 dispose 负责清理
  useEffect(() => {
    if (open) return;
    const id = activeIdRef.current;
    if (id) terminalSessionRegistry.get(id)?.detach();
  }, [open]);

  // 主题切换跟随（registry.updateAllThemes 只刷新挂载中的画布，这里补收起态的口径）
  useEffect(() => {
    const id = activeIdRef.current;
    if (!id) return;
    terminalSessionRegistry.get(id)?.applyTheme(resolvedTheme === "dark");
  }, [resolvedTheme]);

  // 顶部拖拽改高度（移动端固定 40vh，不出拖拽手柄）
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback((e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, startH: useChatTerminal.getState().height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setHeight(drag.startH + (drag.startY - e.clientY));
    },
    [setHeight],
  );
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!open) return null;

  const dockHeight = isMobile
    ? Math.min(320, Math.max(CHAT_DOCK_MIN_HEIGHT, Math.round(window.innerHeight * 0.4)))
    : height;

  return (
    <div
      className="shrink-0 flex flex-col rounded-t-xl border border-b-0 border-line bg-card shadow-subtle overflow-hidden mx-1"
      style={{ height: `${dockHeight}px` }}
      aria-label="对话终端"
    >
      {/* 顶部拖拽手柄（桌面端）：贴住上缘的细热区 */}
      {!isMobile && (
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          className="h-1.5 shrink-0 cursor-row-resize bg-line-soft/60 hover:bg-teal/40 transition-colors touch-none"
          title="拖拽调整高度"
        />
      )}

      {/* 头部：标题 + Shell 徽标 + 操作 */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line-soft bg-rail/70 px-2.5 select-none">
        <div className="flex min-w-0 items-center gap-1.5">
          <SquareTerminal size={13} className="shrink-0 text-teal" />
          <span className="text-xs font-semibold text-ink">对话终端</span>
          <span className="rounded bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite font-medium truncate max-w-[140px]">
            {profile.name}
          </span>
          {unit?.rootPath && (
            <span
              className="hidden sm:inline truncate font-mono text-[10px] text-ash"
              title={unit.rootPath}
            >
              {unit.rootPath}
            </span>
          )}
          {booting && <Loader2 size={12} className="shrink-0 animate-spin text-ash" />}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => terminalSessionRegistry.get(activeIdRef.current ?? "")?.clear()}
            aria-label="清屏"
            title="清屏"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
          >
            <Eraser size={13} />
          </button>
          <button
            type="button"
            onClick={restart}
            aria-label="重启终端"
            title="重启终端（按当前 Shell 重建）"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
          >
            <RotateCw size={13} />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="收起对话终端"
            title="收起（进程保留，再开瞬达）"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ash hover:bg-rose-500/15 hover:text-loss active:scale-90 transition"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* xterm 挂载点：TerminalSession 的常驻 DOM 直接 append 进来 */}
      <div ref={mountRef} className={cn("min-h-0 flex-1 overflow-hidden relative")} />
    </div>
  );
}

/** Composer 工具栏里的唤起开关 —— 面板开着时常亮 */
export function ChatTerminalToggleButton() {
  const open = useChatTerminal((s) => s.open);
  const toggle = useChatTerminal((s) => s.toggle);
  const { isMobile } = useIsMobile();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="对话终端"
      aria-pressed={open}
      title="对话终端 —— 在对话底部唤起快捷终端（Shell 在设置 → 终端里选）"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 active:scale-95 transition",
        "h-7 w-7 sm:h-8 sm:w-8",
        open ? "bg-teal-tint text-teal ring-1 ring-teal/30" : "text-graphite hover:text-teal hover:bg-line-soft",
      )}
    >
      <SquareTerminal size={isMobile ? 13 : 15} />
    </button>
  );
}
