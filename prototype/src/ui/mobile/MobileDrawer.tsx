import { useRef, useState } from "react";
import {
  Bot,
  Laptop,
  Moon,
  Plus,
  QrCode,
  Settings,
  Smartphone,
  Sun,
  X,
} from "lucide-react";
import { useWorkbench } from "../../store/useWorkbench.ts";
import { useShell } from "../../store/useShell.ts";
import { useAppearance } from "../../store/useAppearance.ts";
import { type LayoutPreference } from "./useIsMobile.ts";
import { cn } from "../cn.ts";

export function MobileDrawer({
  open,
  onClose,
  onOpenRemote,
  preference,
  onSetPreference,
}: {
  open: boolean;
  onClose: () => void;
  onOpenRemote: () => void;
  preference: LayoutPreference;
  onSetPreference: (p: LayoutPreference) => void;
}) {
  const units = useWorkbench((s) => s.units);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const selectUnit = useWorkbench((s) => s.selectUnit);
  const openSettings = useShell((s) => s.openSettings);
  const resolvedAppearance = useAppearance((s) => s.resolvedAppearance);
  const setMode = useAppearance((s) => s.setMode);

  // 原生手势左滑退出状态
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  if (!open) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startPosRef.current = { x: touch.clientX, y: touch.clientY };
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!startPosRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = touch.clientX - startPosRef.current.x;
    const deltaY = touch.clientY - startPosRef.current.y;
    // 主要是横向滑动且向左滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < 0) {
      setDragX(deltaX);
    }
  };

  const handleTouchEnd = () => {
    if (dragX < -70) {
      // 达到阈值：收起侧边栏
      onClose();
    }
    setDragX(0);
    setIsDragging(false);
    startPosRef.current = null;
  };

  return (
    <>
      {/* 遮罩（透明度跟随拖拽衰减） */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        style={{ opacity: Math.max(0.1, 1 - Math.abs(dragX) / 250) }}
        onClick={onClose}
        aria-hidden
      />

      {/* 抽屉侧栏（支持触控阻尼跟随与弹性回弹） */}
      <div
        className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line/80 bg-canvas text-ink shadow-2xl animate-in slide-in-from-left duration-300"
        style={{
          transform: `translateX(${dragX}px)`,
          transition: isDragging ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-line/60 bg-rail/50 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal text-white font-bold text-xs shadow-xs">
              AG
            </div>
            <div>
              <h2 className="text-body-sm font-semibold text-ink">Agent Workbench</h2>
              <span className="text-[10px] text-teal font-medium">移动端控制台</span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭侧栏"
            className="rounded-btn p-1 text-graphite hover:bg-line-soft hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {/* 机器人列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="px-2 py-1 text-[11px] font-semibold text-ash uppercase tracking-wider">
            Agent 机器人列表
          </div>
          {units.map((u) => {
            const isSelected = u.id === activeUnitId;
            return (
              <button
                key={u.id}
                onClick={() => {
                  selectUnit(u.id);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition",
                  isSelected
                    ? "bg-teal/15 text-teal font-semibold shadow-xs"
                    : "text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm",
                    isSelected ? "bg-teal text-white" : "bg-line-soft text-graphite",
                  )}
                >
                  <Bot size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm">{u.name}</span>
                  <span className="block truncate text-[11px] text-ash">
                    {u.identity?.role || "Agent"}
                  </span>
                </div>
                {isSelected && <span className="h-2 w-2 rounded-full bg-teal" />}
              </button>
            );
          })}
        </div>

        {/* 底部工具操作区 */}
        <div className="border-t border-line/60 bg-rail/40 p-3 space-y-2">
          {/* 远控二维码 */}
          <button
            onClick={() => {
              onClose();
              onOpenRemote();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-card px-3 py-2 text-body-sm font-medium text-ink transition hover:border-teal hover:text-teal"
          >
            <QrCode size={16} className="text-teal" />
            <span>移动端远控中心 (二维码)</span>
          </button>

          {/* 布局切换 */}
          <div className="rounded-xl border border-line bg-card p-2 space-y-1">
            <span className="block px-1 text-[10px] text-ash font-medium">显示视图模式</span>
            <div className="grid grid-cols-3 gap-1 text-[11px]">
              <button
                onClick={() => onSetPreference("auto")}
                className={cn(
                  "rounded-lg py-1 transition text-center",
                  preference === "auto" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                自动
              </button>
              <button
                onClick={() => onSetPreference("mobile")}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-lg py-1 transition text-center",
                  preference === "mobile" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                <Smartphone size={11} />
                <span>手机</span>
              </button>
              <button
                onClick={() => onSetPreference("desktop")}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-lg py-1 transition text-center",
                  preference === "desktop" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                <Laptop size={11} />
                <span>电脑</span>
              </button>
            </div>
          </div>

          {/* 底部设置与主题 */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => {
                onClose();
                openSettings();
              }}
              className="flex items-center gap-1.5 text-caption text-graphite hover:text-ink"
            >
              <Settings size={14} />
              <span>设置</span>
            </button>
            <button
              onClick={() => setMode(resolvedAppearance === "dark" ? "light" : "dark")}
              className="flex items-center gap-1 text-caption text-graphite hover:text-ink"
            >
              {resolvedAppearance === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              <span>{resolvedAppearance === "dark" ? "明亮" : "暗黑"}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
