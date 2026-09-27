import { useEffect, useRef, useState } from "react";
import { Paperclip, AtSign, X, FileText, Image as ImageIcon } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { Attachment } from "../core/units.ts";
import { cn } from "./cn.ts";

/** 原型期可被"上传"的样本，模拟一次文件选择 */
const PICKABLE: readonly Omit<Attachment, "id">[] = [
  { name: "brief.md", kind: "file", path: "content/brief.md" },
  { name: "palette.png", kind: "image", path: "MMXdaily/assets/palette.png" },
  { name: "refs.pdf", kind: "file", path: "content/refs.pdf" },
  { name: "hero.jpg", kind: "image", path: "MMXdaily/assets/hero.jpg" },
];

/**
 * 附件区 —— 对齐 ZCode 的 TID_CHAT_ATTACHMENT_BUTTON 与 attachments 组件。
 *
 * 放在 composer **左侧**：它属于「这条消息带什么」，与右侧的
 * 「这条消息怎么跑」是两件事。左右分工和 ZCode 一致。
 */
export function ComposerAttach() {
  const attachments = useWorkbench((s) => s.attachments);
  const addAttachment = useWorkbench((s) => s.addAttachment);
  const removeAttachment = useWorkbench((s) => s.removeAttachment);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="添加附件"
        aria-expanded={open}
        title="添加附件"
        className={cn(
          "rounded-btn p-1.5",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <Paperclip size={14} />
      </button>

      <button
        onClick={() => setDraftMention()}
        aria-label="引用文件"
        title="@ 引用工作单元里的文件 / 会话 / 技能"
        className="rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
      >
        <AtSign size={14} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 w-[280px] overflow-hidden rounded-input border border-line bg-canvas py-1">
          <p className="px-3 pb-1 pt-0.5 text-caption text-ash">
            附加到本条消息（原型期：点击即加入）
          </p>
          {PICKABLE.filter((p) => !attachments.some((a) => a.path === p.path)).map((p) => (
            <button
              key={p.path}
              onClick={() => {
                addAttachment({ ...p, id: `a${Date.now().toString(36)}` });
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-line-soft"
            >
              {p.kind === "image" ? (
                <ImageIcon size={13} className="shrink-0 text-ash" />
              ) : (
                <FileText size={13} className="shrink-0 text-ash" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm text-graphite">{p.name}</span>
                <span className="block truncate font-mono text-caption text-ash">{p.path}</span>
              </span>
            </button>
          ))}
          {PICKABLE.every((p) => attachments.some((a) => a.path === p.path)) && (
            <p className="px-3 py-3 text-center text-caption text-ash">样例文件都已附加</p>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <span className="tnum ml-1 rounded-chip bg-line-soft px-1.5 text-caption text-graphite">
          {attachments.length}
        </span>
      )}
    </div>
  );
}

function setDraftMention() {
  useWorkbench.getState().setDraft("@");
}

/** 输入框上方的附件 chip 条 */
export function AttachmentStrip() {
  const attachments = useWorkbench((s) => s.attachments);
  const removeAttachment = useWorkbench((s) => s.removeAttachment);
  if (attachments.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <span
          key={a.id}
          className="flex items-center gap-1.5 rounded-chip bg-line-soft px-2 py-1 text-caption text-graphite"
        >
          {a.kind === "image" ? <ImageIcon size={11} /> : <FileText size={11} />}
          <span className="max-w-[160px] truncate">{a.name}</span>
          <button
            onClick={() => removeAttachment(a.id)}
            aria-label={`移除 ${a.name}`}
            className="rounded p-0.5 text-ash hover:text-ink"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
