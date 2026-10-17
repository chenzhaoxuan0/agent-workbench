import { useEffect, useRef } from "react";
import { FileCode, FileText, Folder, Loader2, Paperclip } from "lucide-react";
import type { WorkspacePathSuggestion } from "../core/workspacePaths.ts";
import { categorizeAttachment, formatAttachmentSize, inferAttachmentMimeType } from "../core/attachments.ts";
import { cn } from "./cn.ts";

/**
 * 工作区路径提及面板 —— 输入 `@` 时在输入框上方弹出，列出当前目录的文件/目录。
 *
 * 交互对齐 ZCode 的 FileMentionPanel（tui/app-file-mention-panel.tsx）：
 * - 一次列一层目录，目录条目带尾随 `/`，选中后 token 变成 `dir/` 自然下钻；
 * - ↑↓ 导航、Enter/Tab 选定、Esc 关闭（键盘处理在 Composer 的 textarea 上，
 *   焦点始终留在输入框 —— 与斜杠面板的 window 监听不同，这里不抢焦点）；
 * - 本组件只管展示：items/loading/截断由 Composer 拉取并注入。
 */
export function PathMentionMenu({
  workspaceName,
  items,
  status,
  truncated,
  error,
  query,
  activeIndex,
  onSelect,
  onHover,
  onClose,
}: {
  workspaceName: string;
  items: readonly WorkspacePathSuggestion[];
  status: "loading" | "ready" | "error";
  truncated: boolean;
  error?: string;
  query: string;
  activeIndex: number;
  onSelect: (item: WorkspacePathSuggestion) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 点击外部收起（textarea 里的点击是在移动光标，不算外部）
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (listRef.current?.contains(target)) return;
      if (target.closest("textarea[aria-label='任务输入']")) return;
      onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  // 键盘选中项滚进可视区
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="path-mention-menu absolute bottom-full -left-px -right-px mb-2.5 rounded-2xl border border-line bg-card/95 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden flex flex-col">
      {/* 头部栏：与斜杠面板同款节奏 */}
      <div className="px-4 py-2.5 border-b border-line-soft flex items-center justify-between bg-canvas/70 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold leading-none shrink-0">
            @
          </span>
          <span className="text-xs font-semibold text-ink truncate">{workspaceName}</span>
          <span className="text-[11px] text-graphite font-normal shrink-0">引用工作区文件</span>
          {items.length > 0 && (
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-full bg-line-soft text-graphite font-medium shrink-0">
              {items.length}
            </span>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[10px] text-graphite/80 font-sans shrink-0">
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">↑</kbd>
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">↓</kbd>
            <span className="ml-0.5">导航</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">↵</kbd>
            <span>选定</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">esc</kbd>
            <span>关闭</span>
          </span>
        </div>
      </div>

      <div ref={listRef} className="max-h-[300px] overflow-y-auto px-2 py-1.5">
        {items.map((item, idx) => {
          const isActive = idx === activeIndex;
          const isDir = item.kind === "directory";
          return (
            <button
              key={item.path}
              data-idx={idx}
              type="button"
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(idx)}
              className={cn(
                "group w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors select-none",
                isActive ? "bg-line-soft text-ink shadow-xs" : "text-graphite hover:bg-line-soft/60 hover:text-ink",
              )}
            >
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs transition-colors",
                  isDir
                    ? isActive
                      ? "border-line bg-canvas text-teal"
                      : "border-transparent bg-canvas/70 text-teal/80"
                    : isActive
                      ? "border-line bg-canvas text-teal"
                      : "border-transparent bg-canvas/70 text-graphite/70",
                )}
              >
                {isDir ? (
                  <Folder size={13} />
                ) : (
                  <PathFileIcon name={item.name} />
                )}
              </div>

              <div className="min-w-0 flex-1 flex items-baseline gap-2">
                <span className={cn("truncate text-xs font-medium", isActive ? "text-ink" : "text-ink/90")}>
                  {item.name}
                  {isDir && <span className="text-ash font-normal">/</span>}
                </span>
                <span className="truncate font-mono text-[10px] text-ash">{item.path}</span>
              </div>

              <span className="ml-auto shrink-0 font-mono text-[10px] text-ash">
                {isDir ? "目录" : item.size !== undefined ? formatAttachmentSize(item.size) : ""}
              </span>
            </button>
          );
        })}

        {status === "loading" && items.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-graphite">
            <Loader2 size={14} className="animate-spin text-teal" />
            <span>正在列出工作区路径…</span>
          </div>
        )}
        {status === "error" && (
          <div className="py-6 text-center text-xs text-graphite leading-relaxed">
            路径建议拉取失败（{error ?? "daemon 不可达"}）。@ 文本仍会原样发给执行器。
          </div>
        )}
        {status !== "loading" && status !== "error" && items.length === 0 && (
          <div className="py-6 text-center text-xs text-graphite leading-relaxed">
            {query === "" ? "工作区根目录是空的" : `未找到与 "${query}" 匹配的路径`}
            <span className="mt-1 block text-[10px] text-ash">输入 / 进入子目录，或继续输入名字过滤</span>
          </div>
        )}
        {truncated && items.length > 0 && (
          <div className="px-2.5 py-1.5 text-center text-[10px] text-ash">
            结果已截断 —— 继续输入缩小范围，或输入 / 进入子目录
          </div>
        )}
      </div>
    </div>
  );
}

function PathFileIcon({ name }: { name: string }) {
  const category = categorizeAttachment(name, inferAttachmentMimeType(name));
  if (category === "code") return <FileCode size={13} />;
  if (category === "document") return <FileText size={13} />;
  return <Paperclip size={13} />;
}
