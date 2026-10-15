import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Command, Square } from "lucide-react";
import { useWorkbench, selectActiveUnit, visibleModelsFor } from "../store/useWorkbench.ts";
import { nativeCommandsFor, useNativeCommands } from "../store/useNativeCommands.ts";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { asModelId } from "../core/units.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { MemoryScopePicker } from "./MemoryScopePicker.tsx";
import { SlashCommandMenu, filterNativeCommands } from "./SlashCommandMenu.tsx";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 对齐 DESIGN.md 的 Search Input + Filled Action Button + Pill Chip：
 * - 羊皮纸底 + 12px 圆角 + 聚焦时青色光晕
 * - 斜杠命令 = 当前执行器的**原生命令**（菜单发现 + 参数提示），"/" 文本
 *   原样透传给执行器分发，工作台不内置任何本地命令
 */
export function Composer() {
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const activeRuntime = useWorkbench((s) => s.activeRuntimeId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(46);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);

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

  // 草稿被外部填入时，把焦点交给输入框
  useEffect(() => {
    if (draft) taRef.current?.focus();
  }, [draft]);

  // 监听是否呈现斜杠命令菜单（用户在输入命令本体、尚未输入参数空格时触发）
  const hasSpace = draft.includes(" ");
  const isSlashActive = draft.startsWith("/") && !draft.includes("\n") && !hasSpace && !slashMenuDismissed;
  const slashFilter = isSlashActive ? draft.slice(1) : "";

  // ---- 执行器原生斜杠命令 --------------------------------------------------
  // 菜单数据源：切换执行器/工作单元时预取（TTL 内不重拉），菜单打开时兜底确保。
  // daemon: 前缀是界面侧命名空间，daemon RPC 要裸执行器 id。
  const bareRuntimeId = activeRuntime.startsWith("daemon:") ? activeRuntime.slice("daemon:".length) : activeRuntime;
  // 无工作单元（落地页）也要能开面板：rootPath 用 "/"，适配器按「仅用户级」
  // 处理（项目级目录 join 出来不存在，自然缺席）—— 与占位文案的承诺一致。
  // ⚠ 选择器与 ensure 必须同一个键（commandsRoot），否则存取错位永远 miss。
  const commandsRoot = unit?.rootPath ?? "/";
  const nativeEntry = useNativeCommands((s) => nativeCommandsFor(s, bareRuntimeId, commandsRoot));
  const executorName =
    useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId)?.presentation.displayName) ?? bareRuntimeId;

  // 当草稿为 "/name ..."（带有空格且指令已就位）时，展示当前选定命令的原生参数提示
  const activeCommandHint = useMemo(() => {
    if (!draft.startsWith("/") || !hasSpace) return null;
    const firstWord = draft.slice(1).split(/\s+/)[0]?.toLowerCase();
    if (!firstWord) return null;
    return (
      nativeEntry.commands.find(
        (c) => c.name.toLowerCase() === firstWord || (c.aliases?.some((a) => a.toLowerCase() === firstWord) ?? false),
      ) ?? null
    );
  }, [draft, hasSpace, nativeEntry.commands]);

  useEffect(() => {
    if (bareRuntimeId) void useNativeCommands.getState().ensure(bareRuntimeId, commandsRoot);
  }, [bareRuntimeId, commandsRoot]);

  /** 选中原生命令：只把 "/name " 放进草稿（参数留给用户补），收起菜单，Enter 发送。
   *  不在本地做任何语义 —— 分发/展开/输出回显都是执行器自己的事。 */
  const handleSelectNativeCommand = (cmd: NativeCommandInfo) => {
    setDraft(`/${cmd.name} `);
    setSlashMenuDismissed(true);
    taRef.current?.focus();
  };

  /** 提交输入内容："/" 开头的文本原样发给执行器（原生命令透传语义）。 */
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    setSlashMenuDismissed(false);
    void run(v);
  };

  const placeholder = !unit
    ? "先选一个工作单元，或新建一个 bot… (输入 / 查看命令/技能/子智能体)"
    : unit.kind === "bot"
      ? `给「${unit.name}」派活…（输入 / 调出 ${executorName} 命令面板，会先读其 AGENTS.md）`
      : `对「${unit.name}」下任务…（输入 / 调出 ${executorName} 命令面板，可开 worktree 隔离）`;

  return (
    <div className="shrink-0">
      <div className="mx-auto max-w-[900px] px-8 pb-4 pt-2">
        <div
          className={cn(
            "relative rounded-input border bg-canvas px-4 py-3 shadow-subtle",
            "border-line",
            "focus-within:border-teal/50 focus-within:ring-2 focus-within:ring-teal/20",
          )}
        >
          {/* 斜杠指令参数提示条（命令已选定、输入参数阶段） */}
          {activeCommandHint && !slashMenuDismissed && (
            <div className="absolute bottom-full left-0 mb-2 px-3 py-1.5 rounded-lg border border-line bg-card/95 shadow-md backdrop-blur-md flex items-center gap-2 text-xs animate-in fade-in duration-100 max-w-[calc(100vw-3rem)] overflow-hidden z-40">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold leading-none">
                /
              </span>
              <span className="font-mono font-bold text-ink shrink-0">/{activeCommandHint.name}</span>
              {activeCommandHint.argumentHint ? (
                <span className="font-mono text-[11px] text-teal px-1.5 py-0.5 rounded bg-teal-tint font-medium shrink-0">
                  {activeCommandHint.argumentHint}
                </span>
              ) : null}
              {activeCommandHint.description ? (
                <span className="text-graphite text-[11px] truncate max-w-[320px]">
                  {activeCommandHint.description}
                </span>
              ) : null}
            </div>
          )}

          {/* 斜杠指令弹出菜单（执行器原生命令） */}
          {isSlashActive && (
            <SlashCommandMenu
              filter={slashFilter}
              onSelect={handleSelectNativeCommand}
              onClose={() => setSlashMenuDismissed(true)}
              native={{
                commands: nativeEntry.commands,
                status: nativeEntry.status,
                error: nativeEntry.error,
                executorName,
              }}
            />
          )}

          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSlashMenuDismissed(false);
            }}
            onKeyDown={(e) => {
              // ⚠ 输入法组字中的 Enter 是「选词」，不是「发送」。
              // 中文/日文输入法下按 Enter 上屏候选词时，keydown 的 key 同样是
              // "Enter"、isComposing 为 true —— 不挡就会把半截拼音（或未上屏的
              // 内容）当消息发出去。
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                // 菜单开着且有可选项 → Enter 交给菜单选命令；否则照常发送
                // （菜单无匹配/拉取中/已收起时不能把 Enter 吞掉 —— 命令文本
                // 透传给执行器本来就是合法输入）。
                const menuHasItems =
                  isSlashActive && filterNativeCommands(nativeEntry.commands, slashFilter).length > 0;
                if (!menuHasItems) {
                  e.preventDefault();
                  submit();
                }
              } else if (e.key === "Escape") {
                setSlashMenuDismissed(true);
              }
            }}
            placeholder={placeholder}
            aria-label="任务输入"
            className="w-full min-h-[46px] max-h-[116px] resize-none overflow-y-auto bg-transparent text-body leading-relaxed text-ink !outline-none focus:!outline-none focus-visible:!outline-none focus-visible:!ring-0 placeholder:text-graphite transition-[height] duration-150"
            style={{ height: `${inputHeight}px`, outline: "none", boxShadow: "none" }}
          />

          {/* 底部工具栏 */}
          <div className="mt-2 flex items-center gap-2">
            {/* 「/ 指令」按钮 */}
            <button
              type="button"
              onClick={() => {
                setDraft("/");
                setSlashMenuDismissed(false);
                taRef.current?.focus();
              }}
              aria-label="快捷指令"
              title="查看与运行快捷指令 · 输入 /"
              className="shrink-0 flex items-center gap-1 rounded-btn px-2 py-1 text-xs text-graphite hover:bg-line-soft hover:text-ink font-mono transition"
            >
              <Command size={13} className="text-teal" />
              <span className="font-bold text-teal">/</span>
            </button>

            {/* 「记忆注入选择胶囊」 */}
            <MemoryScopePicker />

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <RuntimePicker />
              <ReasoningEffortPicker />
              <PermissionModePicker />

              {busy ? (
                <button
                  type="button"
                  onClick={() => useWorkbench.getState().cancelRun()}
                  aria-label="停止"
                  title="停止"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-ink text-canvas hover:opacity-90 active:scale-95 transition"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  aria-label="发送"
                  title="发送 · Enter"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-ink text-canvas hover:opacity-90 active:scale-95 disabled:opacity-30 transition"
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
