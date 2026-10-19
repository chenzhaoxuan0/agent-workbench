import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "./cn.ts";

/**
 * 桌面端无边框窗口的右上角控制按钮（最小化 / 最大化-还原 / 关闭）。
 *
 * 为什么自绘而不用 Electron 的 titleBarOverlay（WCO）：实测 Electron 44 在
 * Win10 上 overlay 的运行时换色不可靠 —— 只改 color 符号不重绘，连续调用还会
 * 底色/符号色串色，深色主题下按钮符号完全不可见。自绘三钮跟着 CSS 令牌走，
 * 主题/壁纸/自定义档案天然同步，浏览器端（无 electronAPI）整个不渲染。
 *
 * 布局约定：常驻窗口右上角（z-50，压在设置页之上）；各顶行用 --wco-w
 * （styles.css）给它让位 —— 该变量只在 <html class="aw-desktop"> 下非 0，
 * 标记就在本模块加上（gated by electronAPI，浏览器不标）。
 */

interface WindowControlsApi {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (listener: (value: boolean) => void) => () => void;
}

const controls = (
  window as unknown as {
    electronAPI?: { windowControls?: WindowControlsApi };
  }
).electronAPI?.windowControls;

if (controls) document.documentElement.classList.add("aw-desktop");

/**
 * drag 行内的 no-drag 占位（让出右上角窗口控制按钮带 / 浮层钮对齐带）。
 *
 * 为什么是「行内子元素」而不是给悬浮的 WindowControls 挂 no-drag 就完事：
 * Chromium 交给操作系统的拖拽区减法只对 drag 元素的**后代**生效（父子模式，
 * 实测有效）；兄弟元素悬浮遮挡时它的 no-drag 不参与减法（实测 Win10 +
 * Electron 44，按钮被整片 drag 区吞掉）。所以每个会延伸到窗口右缘的 drag 行，
 * 都用本组件在行尾占一段 no-drag，让按钮下方的像素真正不可拖拽。
 *
 * width：CSS 宽度串，通常引用 --wco-w（Electron 132px / 浏览器 0）。
 * push：行内没有 ml-auto 元素时用它把占位推到行尾（已有 ml-auto 的行不要再加，
 * 否则剩余空间被两个 auto 均分，右簇会被推离右缘）。
 */
export function TitleBarClearance({
  width,
  push = false,
}: {
  width: string;
  push?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn("titlebar-no-drag h-full shrink-0", push && "ml-auto")}
      style={{ width }}
    />
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let alive = true;
    void controls.isMaximized().then((v) => {
      if (alive) setMaximized(v);
    });
    return controls.onMaximizedChanged((v) => setMaximized(v));
  }, []);

  if (!controls) return null;

  const base =
    "flex w-11 items-center justify-center text-graphite transition-colors hover:bg-line-soft hover:text-ink";
  return (
    <div className="titlebar-no-drag absolute right-0 top-0 z-50 flex h-12 select-none">
      <button onClick={controls.minimize} title="最小化" aria-label="最小化" className={base}>
        <Minus size={13} />
      </button>
      <button
        onClick={controls.toggleMaximize}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        className={base}
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        onClick={controls.close}
        title="关闭"
        aria-label="关闭"
        className="flex w-11 items-center justify-center text-graphite transition-colors hover:bg-[#e81123] hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}
