import { useEffect, useRef } from "react";
import { Send } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { AttachmentStrip, ComposerAttach } from "./ComposerAttach.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 对齐 DESIGN.md 的 Search Input + Filled Action Button + Pill Chip：
 * - 羊皮纸底 + 12px 圆角 + 聚焦时青色光晕（该设计里唯一的非结构性视觉效果）
 * - 策略选择是胶囊，激活态填 Deep Teal + 白字
 * - 发送是全场唯一的实心按钮：墨色底 + 羊皮纸字
 */
export function Composer() {
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 草稿被外部（建议卡片）填入时，把焦点交给输入框
  useEffect(() => {
    if (draft) taRef.current?.focus();
  }, [draft]);

  const submit = () => {
    const v = draft.trim();
    if (!v || busy) return;
    setDraft("");
    void run(v);
  };

  const placeholder =
    unit?.kind === "employee"
      ? `给「${unit.name}」派活…（会先读它的 AGENTS.md 当岗位说明书）`
      : `对「${unit?.name}」下任务…（项目模式，可开 worktree 隔离）`;

  return (
    <div className="shrink-0 border-t border-line bg-rail">
      <div className="mx-auto max-w-[900px] px-8 py-4">
        <div
          className={cn(
            "rounded-input border bg-canvas px-4 py-3",
            "border-line focus-within:border-teal",
            // DESIGN.md：搜索框周围那一圈青色光晕，全系统唯一的装饰性效果
            "focus-within:shadow-[0_0_0_3px_rgb(1_106_113/0.12)]",
          )}
        >
          <AttachmentStrip />

          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            rows={2}
            aria-label="任务输入"
            className="w-full resize-none bg-transparent text-body leading-relaxed text-ink outline-none placeholder:text-graphite"
          />

          {/* 左：这条消息「带什么」；右：这条消息「怎么跑」。
              分工与 ZCode 的 V4ComposerToolbar 一致。 */}
          <div className="mt-2 flex items-center gap-2">
            <ComposerAttach />

            <div className="ml-auto flex items-center gap-1.5">
              <PermissionModePicker />
              <RuntimePicker />

              <button
                onClick={submit}
                disabled={!draft.trim() || busy}
                aria-label="发送"
                className="flex items-center gap-1.5 rounded-input bg-ink px-3 py-2 text-body-sm text-canvas hover:bg-black disabled:opacity-30"
              >
                <Send size={12} />
                发送
              </button>
            </div>
          </div>
        </div>

        <p className="mt-2 text-center text-caption text-ash">Enter 发送 · Shift + Enter 换行</p>
      </div>
    </div>
  );
}
