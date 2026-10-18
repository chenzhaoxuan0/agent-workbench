import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn.ts";

/**
 * 轻量右键菜单 —— 侧栏 bot 行 / 历史会话行的自定义上下文动作（本应用的
 * 对话区文本编辑右键走 Electron 原生菜单，见 electron/main.cjs，两套不重叠）。
 *
 * 受控组件：调用方持有 state（坐标 + 菜单项），onContextMenu 里 setState 打开；
 * 任意点击 / Esc / 滚动 / 窗口缩放都会关闭。坐标做了视口收拢，贴边不裁切。
 */

export interface QuickMenuItem {
  /** 分隔线项（separator: true）没有文字，其余必填 */
  readonly label?: string;
  readonly icon?: LucideIcon;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onSelect?: () => void;
  /** 分隔线（本项自身不渲染文字） */
  readonly separator?: boolean;
}

export interface QuickMenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly QuickMenuItem[];
}

export function QuickContextMenu({
  menu,
  onClose,
}: {
  menu: QuickMenuState | null;
  onClose: () => void;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  /** 视口收拢后的实际渲染位置（首帧按原始坐标渲染，测量后校正） */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // 打开 / 换位置时重新测量：菜单尺寸只有挂载后才知道
  useLayoutEffect(() => {
    if (menu === null) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 180;
    const h = el?.offsetHeight ?? 120;
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - h - 4)),
    });
  }, [menu]);

  // 关闭路径：任意左键/右键按下、Esc、滚动、缩放。capture 捕获滚动（子元素内滚动也要关）
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (ref.current !== null && ref.current.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu, onClose]);

  if (menu === null) return null;

  return (
    <div
      ref={ref}
      role="menu"
      // pos 为 null 的首帧也按原始坐标渲染（display 之前量不到尺寸）——视觉上一帧内完成校正
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[90] min-w-[160px] rounded-btn border border-line bg-card py-1 shadow-2xl"
    >
      {menu.items.map((item, i) =>
        item.separator === true ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-line/70" role="separator" />
        ) : (
          <button
            key={item.label ?? `item-${i}`}
            type="button"
            role="menuitem"
            disabled={item.disabled === true}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-caption text-graphite transition",
              "hover:bg-line-soft hover:text-ink",
              item.danger === true && "text-loss hover:bg-loss/10 hover:text-loss",
              item.disabled === true && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-graphite",
            )}
          >
            {item.icon !== undefined && <item.icon size={12} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** 配套的打开辅助：从鼠标事件构造菜单状态（调用方补 items） */
export function quickMenuFromEvent(
  e: { clientX: number; clientY: number; preventDefault: () => void },
  items: readonly QuickMenuItem[],
): QuickMenuState {
  e.preventDefault();
  return { x: e.clientX, y: e.clientY, items };
}
