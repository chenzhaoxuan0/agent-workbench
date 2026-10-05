import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, Square, SquareTerminal } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
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
  const terminalOpen = useShell((s) => s.terminalOpen);
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(46);

  // 当文字被填入时自适应加高：平时显示 2 行（约 46px），内容输入增加后向上撑高，最多容纳 5 行（约 116px）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!draft) {
      setInputHeight(46);
      return;
    }
    ta.style.height = "auto";
    const scrollH = ta.scrollHeight;
    const targetH = Math.min(Math.max(scrollH, 46), 116);
    setInputHeight(targetH);
  }, [draft]);

  // 草稿被外部（建议卡片）填入时，把焦点交给输入框
  useEffect(() => {
    if (draft) taRef.current?.focus();
  }, [draft]);

  // T3 steer 语义：turn 进行中发消息 = 排队（daemon 在轮落定后自动发出），不拒收
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    void run(v);
  };

  // ⚠ unit 为空时不能走 `${unit?.name}` —— 模板串会把 undefined 印成字面量
  //   "对「undefined」下任务"，那是数据缺失被当成字符串渲染了，不是占位符。
  const placeholder = !unit
    ? "先选一个工作单元，或新建一个 bot…"
    : unit.kind === "bot"
      ? `给「${unit.name}」派活…（会先读它的 AGENTS.md 当岗位说明书）`
      : `对「${unit.name}」下任务…（项目模式，可开 worktree 隔离）`;

  return (
    <div className="shrink-0 border-t border-line bg-rail">
      <div className="mx-auto max-w-[900px] px-8 py-4">
        <div
          className={cn(
            "rounded-input border bg-canvas px-4 py-3",
            "border-line",
            // 聚焦时保留轻量柔和的青色微光，取消深绿色刺眼细内边框
            "focus-within:shadow-[0_0_0_3px_rgb(1_106_113/0.12)]",
          )}
        >
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
            aria-label="任务输入"
            className="w-full min-h-[46px] max-h-[116px] resize-none overflow-y-auto bg-transparent text-body leading-relaxed text-ink !outline-none focus:!outline-none focus-visible:!outline-none focus-visible:!ring-0 placeholder:text-graphite transition-[height] duration-150"
            style={{ height: `${inputHeight}px`, outline: "none", boxShadow: "none" }}
          />

          {/* 左：这条消息「带什么」；右：这条消息「怎么跑」。
              分工与 ZCode 的 V4ComposerToolbar 一致。 */}
          <div className="mt-2 flex items-center gap-2">
            {/* 「@ 引用」：在草稿里插一个 @，剩下的交给 agent 自己解析。
                原先这里还有个回形针「添加附件」，点开是 4 个写死的假文件
                （brief.md / palette.png / …，路径还指向别的项目），加完之后
                attachments 根本没进任何执行器调用 —— 纯装饰。已删。
                真要附件得先有真文件选择（Electron file dialog）+ 后端接收。 */}
            <button
              onClick={() => setDraft(`${draft}@`)}
              aria-label="引用文件"
              title="@ 引用工作单元里的文件 / 会话 / 技能"
              className="shrink-0 rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
            >
              <AtSign size={14} />
            </button>

            <button
              onClick={() => useShell.getState().toggleTerminal()}
              aria-label="工作区终端"
              title="切换工作区终端 · Ctrl+`"
              className={cn(
                "shrink-0 rounded-btn p-1.5 transition",
                terminalOpen ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              <SquareTerminal size={14} />
            </button>

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {/* 展开的直观控制条：执行器与模型、推理力度、权限模式 */}
              <RuntimePicker />
              <ReasoningEffortPicker />
              <PermissionModePicker />

              {/* 主按钮 —— ZCode：发送是 brand 底图标钮（ArrowUp），运行中变停止（实心方块）。
                  mock 没有取消通道，停止只翻 busy 位 */}
              {busy ? (
                <button
                  onClick={() => useWorkbench.getState().cancelRun()}
                  aria-label="停止"
                  title="停止"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-ink text-canvas hover:bg-black"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim()}
                  aria-label="发送"
                  title="发送 · Enter"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-ink text-canvas hover:bg-black disabled:opacity-30"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
