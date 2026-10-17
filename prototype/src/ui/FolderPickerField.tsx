/**
 * 文件夹选择字段 —— 路径输入框 + 轻量目录浏览器弹出层（ADR 0011 第 1 条）。
 *
 * 「新建 / 认领不再要求复制粘贴路径」的兑现：浏览走 daemon 的 workspace.paths.list
 * （与对话输入 @ 提及同一提供面、同一防逃逸约束：一次列一层、跳过 node_modules/.git、
 * resolve 后必须仍在起始根之内），点目录名下钻、「选定此文件夹」把当前目录写回
 * 输入框。手输路径始终保留——输入框是唯一真相源，浏览器只是填它的另一种手段。
 *
 * 起始根候选来自 bot.defaultRoot 的 browseRoots（homeDir + 盘符根）；空 = daemon
 * 未连接，浏览按钮禁用，手输兜底。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Folder, FolderSearch, Loader2, X } from "lucide-react";
import { fetchWorkspacePaths } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

export interface FolderPickerFieldProps {
  value: string;
  onChange: (path: string) => void;
  /** 目录浏览器的起始根候选（bot.defaultRoot 的 browseRoots）。空 = 浏览不可用。 */
  browseRoots: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  /** 输入框内按 Enter（认领对话框的「探测」） */
  onEnter?: () => void;
  /** 输入框与「浏览」之间追加的节点（新建对话框的「在资源管理器中打开」按钮） */
  trailing?: React.ReactNode;
}

/** C:\Users\x + [a,b] → C:\Users\x/a/b —— 只拼显示值，daemon 侧自会 resolve */
function joinDir(root: string, segments: readonly string[]): string {
  const base = root.replace(/[\\/]+$/u, "");
  return segments.length === 0 ? base : `${base}/${segments.join("/")}`;
}

export function FolderPickerField({ value, onChange, browseRoots, placeholder, ariaLabel, onEnter, trailing }: FolderPickerFieldProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [rootIdx, setRootIdx] = useState(0);
  const [segments, setSegments] = useState<readonly string[]>([]);
  const [items, setItems] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const root = browseRoots[rootIdx] ?? "";
  const rel = segments.join("/");

  // 弹出层 fixed 定位：挂在按钮下方（对话框内容区 overflow-y-auto 会裁掉 absolute
  // 子元素，fixed 才能逃出裁剪）。对话框内滚动 / 窗口缩放时跟着重算。
  const reposition = () => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) setPos({ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 420) });
  };

  // 一次列一层（@ 提及同款数据面）：token 为「目录段/」+ 空过滤段 = 全量列该层，
  // 前端只留目录项。请求竞态用 AbortController 兜住——快速下钻时旧响应作废。
  useEffect(() => {
    if (!open || root === "") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchWorkspacePaths(root, rel === "" ? "" : `${rel}/`, { limit: 200, signal: controller.signal })
      .then((r) => {
        setItems(r.items.filter((x) => x.kind === "directory").map((x) => x.name));
        setTruncated(r.truncated);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setItems([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, root, rel]);

  useEffect(() => {
    if (!open) return;
    reposition();
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    // Escape 只关弹出层，不透传给宿主对话框（capture 阶段截停，
    // 否则对话框的 document 级 Escape 监听会把整个对话框一起关掉）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reposition 是读 ref 的稳定闭包
  }, [open]);

  const browseReady = browseRoots.length > 0;
  const target = root === "" ? "" : joinDir(root, segments);

  return (
    <div ref={wrapperRef} className="relative flex min-w-0 flex-1 items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
        spellCheck={false}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
      />
      {trailing}
      <button
        type="button"
        onClick={() => {
          if (!browseReady) return;
          setOpen((v) => !v);
          setRootIdx(0);
          setSegments([]);
        }}
        disabled={!browseReady}
        title={browseReady ? "浏览选择文件夹" : "未连接 daemon，可直接手输路径"}
        className="flex shrink-0 items-center gap-1 rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-caption font-medium text-graphite transition hover:bg-line-soft hover:text-ink disabled:opacity-40"
      >
        <FolderSearch size={12} />
        <span>浏览</span>
      </button>

      {open && pos !== null && (
        <>
          {/* 点外面收起。fixed 层都在对话框 DOM 树内，冒泡到对话框根即被 stopPropagation，不会误关对话框 */}
          <div className="fixed inset-0 z-[59]" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="浏览文件夹"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            className="fixed z-[60] flex max-h-[340px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-subtle"
          >
            {/* 头部：起始根切换 + 当前路径 + 上级 */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
              <select
                value={rootIdx}
                onChange={(e) => {
                  setRootIdx(Number(e.target.value));
                  setSegments([]);
                }}
                aria-label="起始位置"
                className="max-w-[40%] shrink-0 rounded-btn border border-line bg-canvas px-1.5 py-1 text-caption text-ink outline-none"
              >
                {browseRoots.map((r, i) => (
                  <option key={r} value={i}>
                    {r}
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-ash" title={target}>
                {target}
              </span>
              <button
                type="button"
                onClick={() => setSegments((s) => s.slice(0, -1))}
                disabled={segments.length === 0}
                title="上一级"
                className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink disabled:opacity-30"
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭浏览"
                className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>

            {/* 目录清单 */}
            <div className="min-h-[120px] flex-1 overflow-y-auto p-1">
              {loading ? (
                <p className="flex items-center gap-1.5 px-2 py-3 text-caption text-ash">
                  <Loader2 size={11} className="animate-spin" />
                  读取目录…
                </p>
              ) : error !== null ? (
                <p className="px-2 py-3 text-caption text-loss">{error}</p>
              ) : items.length === 0 ? (
                <p className="px-2 py-3 text-caption text-ash">这里没有（可见的）子文件夹</p>
              ) : (
                items.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setSegments((s) => [...s, name])}
                    className="flex w-full items-center gap-1.5 rounded-btn px-2 py-1.5 text-left font-mono text-caption text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    <Folder size={11} className="shrink-0 text-ash" />
                    <span className="truncate">{name}</span>
                  </button>
                ))
              )}
            </div>

            {/* 底部：选定 */}
            <div className="flex shrink-0 items-center gap-2 border-t border-line px-2 py-1.5">
              <p className="min-w-0 flex-1 truncate text-caption text-ash">
                {truncated ? "目录太多已截断，进子目录继续找 · " : ""}点文件夹名进入，选定用下面的按钮
              </p>
              <button
                type="button"
                onClick={() => {
                  onChange(target);
                  setOpen(false);
                }}
                disabled={target === ""}
                className={cn(
                  "shrink-0 rounded-btn px-2.5 py-1 text-caption font-medium text-canvas transition",
                  target === "" ? "bg-line" : "bg-ink hover:opacity-90",
                )}
              >
                选定此文件夹
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
