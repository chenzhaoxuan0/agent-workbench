import { useTheme, type ThemeMode } from "../store/useTheme.ts";
import { Sun, Moon, Monitor, Check, Palette, Sparkles, Terminal } from "lucide-react";
import { cn } from "./cn.ts";

export function AppearanceSettingsSection() {
  const mode = useTheme((s) => s.mode);
  const resolvedTheme = useTheme((s) => s.resolvedTheme);
  const setMode = useTheme((s) => s.setMode);

  return (
    <div className="space-y-6">
      {/* 主题选择卡片网格 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Palette size={16} className="text-teal" />
            <h2 className="text-body font-medium text-ink">界面色彩与外观主题</h2>
          </div>
          <p className="mt-1 text-body-sm text-graphite">
            选择界面的基础视觉风格。所有图标排版、内容间距与组件尺寸保持完全一致，仅切换纯色系渲染。
          </p>
        </div>

        <div className="p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* 1. 亮色：Cursor 羊皮纸 */}
            <button
              type="button"
              onClick={() => setMode("light")}
              className={cn(
                "group relative flex flex-col text-left rounded-card border p-3.5 transition",
                mode === "light"
                  ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                  : "border-line bg-canvas hover:border-line-soft hover:bg-surface-hover",
              )}
            >
              {/* 拟态迷你预览窗 */}
              <div className="relative mb-3.5 h-24 w-full overflow-hidden rounded-btn border border-[#cdcdc9] bg-[#f7f7f4] p-2 select-none shadow-xs">
                {/* 迷你顶栏 */}
                <div className="flex h-3 items-center justify-between border-b border-[#cdcdc9] pb-1">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#cdcdc9]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-[#cdcdc9]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-[#cdcdc9]" />
                  </div>
                  <span className="h-1 w-8 rounded-chip bg-[#cdcdc9]" />
                </div>
                {/* 迷你主体：左侧栏 + 右主卡 */}
                <div className="mt-1.5 flex h-14 gap-1.5">
                  <div className="w-6 shrink-0 rounded-btn bg-[#e6e5e0] p-1 flex flex-col gap-1">
                    <span className="h-1 w-full rounded bg-[#cdcdc9]" />
                    <span className="h-1 w-3/4 rounded bg-[#cdcdc9]" />
                  </div>
                  <div className="flex-1 rounded-btn bg-[#f2f1ed] p-1.5 flex flex-col justify-between border border-[#cdcdc9]/60">
                    <div className="space-y-1">
                      <span className="block h-1.5 w-3/4 rounded bg-[#26251e]" />
                      <span className="block h-1 w-1/2 rounded bg-[#84847e]" />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="h-1.5 w-5 rounded bg-[#26251e]" />
                      <span className="h-2 w-2 rounded-full bg-[#f54e00]" />
                    </div>
                  </div>
                </div>
              </div>

              {/* 标题与勾选 */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Sun size={14} className="text-[#f54e00]" />
                  <span className="text-body-sm font-medium text-ink">温润羊皮纸</span>
                </div>
                {mode === "light" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-canvas">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </div>
              <p className="text-caption text-graphite leading-relaxed">
                Cursor 暖白奶油画布、纸阶平坦分层与 Ember 炽橙高亮。
              </p>
            </button>

            {/* 2. 暗色：Warp 黑曜石 */}
            <button
              type="button"
              onClick={() => setMode("dark")}
              className={cn(
                "group relative flex flex-col text-left rounded-card border p-3.5 transition",
                mode === "dark"
                  ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                  : "border-line bg-canvas hover:border-line-soft hover:bg-surface-hover",
              )}
            >
              {/* 拟态迷你预览窗 */}
              <div className="relative mb-3.5 h-24 w-full overflow-hidden rounded-btn border border-[#222221] bg-[#000000] p-2 select-none shadow-xs">
                {/* 迷你顶栏 */}
                <div className="flex h-3 items-center justify-between border-b border-[#222221] pb-1">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#333333]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-[#333333]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-[#333333]" />
                  </div>
                  <span className="h-1 w-8 rounded-chip bg-[#222221]" />
                </div>
                {/* 迷你主体：左侧栏 + 右主卡 */}
                <div className="mt-1.5 flex h-14 gap-1.5">
                  <div className="w-6 shrink-0 rounded-btn bg-[#121212] p-1 flex flex-col gap-1 border border-[#222221]">
                    <span className="h-1 w-full rounded bg-[#333333]" />
                    <span className="h-1 w-3/4 rounded bg-[#333333]" />
                  </div>
                  <div className="flex-1 rounded-btn bg-[#181817] p-1.5 flex flex-col justify-between border border-[#222221]">
                    <div className="space-y-1">
                      <span className="block h-1.5 w-3/4 rounded bg-[#faf9f6]" />
                      <span className="block h-1 w-1/2 rounded bg-[#b4b4b2]" />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="h-1.5 w-5 rounded bg-[#faf9f6]" />
                      <span className="h-2 w-2 rounded-full bg-[#cbb0f7]" />
                    </div>
                  </div>
                </div>
              </div>

              {/* 标题与勾选 */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Moon size={14} className="text-[#cbb0f7]" />
                  <span className="text-body-sm font-medium text-ink">深邃黑曜石</span>
                </div>
                {mode === "dark" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-canvas">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </div>
              <p className="text-caption text-graphite leading-relaxed">
                纯黑终端虚空底色、平坦炭黑面板与荧光紫光标强调。
              </p>
            </button>

            {/* 3. 跟随系统 */}
            <button
              type="button"
              onClick={() => setMode("system")}
              className={cn(
                "group relative flex flex-col text-left rounded-card border p-3.5 transition",
                mode === "system"
                  ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                  : "border-line bg-canvas hover:border-line-soft hover:bg-surface-hover",
              )}
            >
              {/* 拟态迷你预览窗（对角/左右分屏） */}
              <div className="relative mb-3.5 h-24 w-full overflow-hidden rounded-btn border border-line p-2 select-none shadow-xs flex">
                {/* 左半侧：羊皮纸 */}
                <div className="h-full w-1/2 bg-[#f7f7f4] -m-2 p-2 border-r border-[#cdcdc9] flex flex-col justify-between">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#cdcdc9]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-[#cdcdc9]" />
                  </div>
                  <div className="space-y-1">
                    <span className="block h-1.5 w-4/5 rounded bg-[#26251e]" />
                    <span className="block h-1 w-3/5 rounded bg-[#84847e]" />
                  </div>
                  <span className="h-2 w-2 rounded-full bg-[#f54e00]" />
                </div>
                {/* 右半侧：黑曜石 */}
                <div className="h-full w-1/2 bg-[#000000] -m-2 ml-0 p-2 flex flex-col justify-between">
                  <div className="flex items-center justify-end gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#333333]" />
                  </div>
                  <div className="space-y-1">
                    <span className="block h-1.5 w-4/5 rounded bg-[#faf9f6]" />
                    <span className="block h-1 w-3/5 rounded bg-[#b4b4b2]" />
                  </div>
                  <span className="h-2 w-2 rounded-full bg-[#cbb0f7]" />
                </div>
              </div>

              {/* 标题与勾选 */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Monitor size={14} className="text-graphite" />
                  <span className="text-body-sm font-medium text-ink">跟随系统</span>
                </div>
                {mode === "system" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-canvas">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </div>
              <p className="text-caption text-graphite leading-relaxed">
                自动根据当前操作系统明暗设置实时响应切换。
              </p>
            </button>
          </div>
        </div>
      </div>

      {/* 当前生效色彩参数卡片 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-teal" />
            <span className="text-body-sm font-medium text-ink">
              当前渲染主题状态：
              <span className="text-teal ml-1">
                {resolvedTheme === "dark" ? "深邃黑曜石 (Dark)" : "温润羊皮纸 (Light)"}
              </span>
            </span>
          </div>
          <span className="rounded-chip bg-teal-tint px-2 py-0.5 text-caption font-mono text-teal">
            模式: {mode}
          </span>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-caption font-mono">
            <div className="rounded-btn border border-line bg-canvas p-2.5">
              <span className="text-ash block text-[10px] uppercase font-sans">画布 Canvas</span>
              <span className="text-ink font-semibold mt-1 block">
                {resolvedTheme === "dark" ? "#000000 (Obsidian)" : "#f7f7f4 (Parchment)"}
              </span>
            </div>
            <div className="rounded-btn border border-line bg-card p-2.5">
              <span className="text-ash block text-[10px] uppercase font-sans">卡片 Card</span>
              <span className="text-ink font-semibold mt-1 block">
                {resolvedTheme === "dark" ? "#181817 (Onyx)" : "#f2f1ed (Bone)"}
              </span>
            </div>
            <div className="rounded-btn border border-line bg-rail p-2.5">
              <span className="text-ash block text-[10px] uppercase font-sans">侧栏 Rail</span>
              <span className="text-ink font-semibold mt-1 block">
                {resolvedTheme === "dark" ? "#121212 (Graphite)" : "#e6e5e0 (Linen)"}
              </span>
            </div>
            <div className="rounded-btn border border-line bg-card p-2.5">
              <span className="text-ash block text-[10px] uppercase font-sans">强调色 Accent</span>
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className="h-2.5 w-2.5 rounded-full inline-block"
                  style={{
                    backgroundColor: resolvedTheme === "dark" ? "#cbb0f7" : "#f54e00",
                  }}
                />
                <span className="text-ink font-semibold">
                  {resolvedTheme === "dark" ? "#cbb0f7 (Violet)" : "#f54e00 (Ember)"}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-btn border border-line/60 bg-line-soft/30 p-3 flex items-start gap-2 text-caption text-graphite leading-relaxed">
            <Terminal size={14} className="shrink-0 mt-0.5 text-teal" />
            <div>
              <p className="font-medium text-ink">终端与编辑器实时同步</p>
              <p className="mt-0.5 text-ash">
                切换主题时，内置的 xterm 终端画布与背景色会实时同步更新，无需重启后台 Shell 会话。所有历史输出与运行进程完整保留。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
