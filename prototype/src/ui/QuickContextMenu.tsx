import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactElement } from "react";
import { cn } from "./cn.ts";

/**
 * 轻量右键菜单 —— 侧栏 bot 行 / 历史会话行 / 终端 / tab 条 / 文件 chip 等
 * 自定义上下文动作（本应用的对话区文本编辑右键走 Electron 原生菜单，见
 * electron/main.cjs，两套不重叠）。
 *
 * 受控组件：调用方持有 state（坐标 + 菜单项），onContextMenu 里 setState 打开；
 * 任意点击 / Esc / 滚动 / 窗口缩放都会关闭。坐标做了视口收拢，贴边不裁切。
 *
 * 键盘导航对齐 radix ContextMenu 的手感：打开时不落高亮，↑↓ 移动、Home/End
 * 首末、回车/空格触发、可打印字符按首字母循环跳转；鼠标 hover 与键盘共用
 * 同一个高亮索引（鼠标移开后清空，回到「按 ↓ 才落第一项」的初始态）。
 */

export interface QuickMenuItem {
  /** 分隔线项（separator: true）没有文字，其余必填 */
  readonly label?: string;
  /** lucide 图标或任何 { size } 组件（如品牌 SVG 图标组件） */
  readonly icon?: ComponentType<{ size?: number }>;
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

/** 可聚焦（参与键盘导航）的项：非分隔线且未禁用 */
function isSelectable(item: QuickMenuItem): boolean {
  return item.separator !== true && item.disabled !== true;
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
  /** 键盘导航高亮索引（null = 无高亮，hover 也会写入） */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // 打开 / 换位置时重新测量：菜单尺寸只有挂载后才知道；高亮同步清零
  useLayoutEffect(() => {
    if (menu === null) {
      setPos(null);
      setActiveIndex(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 180;
    const h = el?.offsetHeight ?? 120;
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - h - 4)),
    });
    setActiveIndex(null);
  }, [menu]);

  // 关闭路径：任意左键/右键按下、Esc、滚动、缩放。capture 捕获滚动（子元素内滚动也要关）
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // 键盘导航只在有可选项时才有意义；这些键一律拦截，避免漏进背后的输入框
      const selectable = menu.items.map((item, i) => (isSelectable(item) ? i : -1)).filter((i) => i >= 0);
      if (selectable.length === 0) return;
      const current = activeIndex !== null && selectable.includes(activeIndex) ? activeIndex : null;

      const step = (dir: 1 | -1): void => {
        e.preventDefault();
        if (current === null) {
          setActiveIndex(dir === 1 ? selectable[0]! : selectable[selectable.length - 1]!);
          return;
        }
        const at = selectable.indexOf(current);
        setActiveIndex(selectable[(at + dir + selectable.length) % selectable.length]!);
      };

      if (e.key === "ArrowDown") return step(1);
      if (e.key === "ArrowUp") return step(-1);
      if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(selectable[0]!);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(selectable[selectable.length - 1]!);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (current === null) return;
        e.preventDefault();
        onClose();
        menu.items[current]?.onSelect?.();
        return;
      }
      // 首字母循环跳转（radix 同款）：从当前项之后开始找下一个以该字母开头的项
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ch = e.key.toLowerCase();
        const start = current === null ? 0 : selectable.indexOf(current) + 1;
        const ordered = [
          ...selectable.slice(start),
          ...selectable.slice(0, start),
        ];
        const next = ordered.find(
          (itemIndex) => menu.items[itemIndex]?.label?.toLowerCase().startsWith(ch) === true,
        );
        if (next !== undefined) {
          e.preventDefault();
          setActiveIndex(next);
        }
      }
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
  }, [menu, onClose, activeIndex]);

  if (menu === null) return null;

  return (
    <div
      ref={ref}
      role="menu"
      // pos 为 null 的首帧也按原始坐标渲染（display 之前量不到尺寸）——视觉上一帧内完成校正
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => setActiveIndex(null)}
      /* titlebar-no-drag：挂在 .titlebar-drag 行内时（WorkspaceHeader 的窗口操作
          菜单），浮层自身的空白/内边距不能被系统的标题栏拖拽吞掉 */
      className="titlebar-no-drag fixed z-[90] min-w-[160px] rounded-btn border border-line bg-card py-1 shadow-2xl"
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
            onMouseEnter={() => {
              if (item.disabled !== true) setActiveIndex(i);
            }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-caption text-graphite transition",
              "hover:bg-line-soft hover:text-ink",
              activeIndex === i && item.disabled !== true && "bg-line-soft text-ink",
              item.danger === true && "text-loss hover:bg-loss/10 hover:text-loss",
              item.disabled === true && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-graphite",
            )}
          >
            {item.icon !== undefined && (
              <span className="flex shrink-0 items-center">
                <item.icon size={12} />
              </span>
            )}
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
