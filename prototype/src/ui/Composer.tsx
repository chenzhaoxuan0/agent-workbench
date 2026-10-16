import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Command,
  FolderGit2,
  GitBranch,
  Paperclip,
  Plus,
  Square,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { nativeCommandsFor, useNativeCommands } from "../store/useNativeCommands.ts";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { SlashCommandMenu, filterNativeCommands } from "./SlashCommandMenu.tsx";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 移动端结构：
 * - 顶部卡片栏：工作空间文件夹名称 + 分支 (Branch) + 角色徽标
 * - 核心文本输入框 (自动高度)
 * - 底部工具栏：
 *   - 左侧：[+] 扩展菜单（斜杠指令/附件/技能） + 运行模式形式（计划模式/变更确认/自主模式/完全访问）
 *   - 右侧：执行器与模型（单图标） + 推理思考力度（单图标） + 发送/停止按钮
 */
export function Composer({ onOpenDrawer }: { onOpenDrawer?: () => void } = {}) {
  const { isMobile } = useIsMobile();
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const activeRuntime = useWorkbench((s) => s.activeRuntimeId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);

  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 800,
  );
  const baseH = isMobile ? 64 : 76;
  const maxH = Math.max(baseH, Math.floor(viewportH - 170));

  const [inputHeight, setInputHeight] = useState(baseH);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  // 监听可视视口尺寸变化（支持手机端软键盘弹出缩减视口、窗口缩放）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      setViewportH(h);
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  // 点击外部关闭 [+] 菜单
  useEffect(() => {
    if (!plusMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [plusMenuOpen]);

  // 当文字被填入时自适应加高：
  // 默认高度容纳 3~4 行；输入多行内容时持续长高，上限直顶 header 的下底边，绝不在 5 行截断或回缩
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!draft) {
      setInputHeight(baseH);
      return;
    }
    ta.style.height = `${baseH}px`;
    const scrollH = ta.scrollHeight;
    const targetH = Math.min(Math.max(scrollH, baseH), maxH);
    ta.style.height = `${targetH}px`;
    setInputHeight(targetH);
  }, [draft, isMobile, baseH, maxH]);

  // 草稿被外部填入时，把焦点交给输入框
  useEffect(() => {
    if (draft) taRef.current?.focus();
  }, [draft]);

  // 监听是否呈现斜杠命令菜单（用户在输入命令本体、尚未输入参数空格时触发）
  const hasSpace = draft.includes(" ");
  const isSlashActive = draft.startsWith("/") && !draft.includes("\n") && !hasSpace && !slashMenuDismissed;
  const slashFilter = isSlashActive ? draft.slice(1) : "";

  // ---- 执行器原生斜杠命令 --------------------------------------------------
  const bareRuntimeId = activeRuntime.startsWith("daemon:") ? activeRuntime.slice("daemon:".length) : activeRuntime;
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

  /** 选中原生命令：只把 "/name " 放进草稿（参数留给用户补），收起菜单，Enter 发送。 */
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
    setPlusMenuOpen(false);
    void run(v);
  };

  const placeholder = !unit
    ? "先选一个工作单元，或新建一个 bot… (输入 / 查看命令/技能/子智能体)"
    : unit.kind === "bot"
      ? `给「${unit.name}」派活…（输入 / 调出 ${executorName} 命令面板，会先读其 AGENTS.md）`
      : `对「${unit.name}」下任务…（输入 / 调出 ${executorName} 命令面板，可开 worktree 隔离）`;

  return (
    <div className="shrink-0">
      <div className={cn("mx-auto max-w-[900px]", isMobile ? "px-3 pb-2 pt-1" : "px-8 pb-4 pt-2")}>
        <div
          className={cn(
            "relative rounded-2xl border bg-canvas shadow-subtle transition",
            isMobile ? "p-2.5 border-line/80 shadow-xs" : "px-4 py-3 border-line",
            "focus-within:border-teal/50 focus-within:ring-2 focus-within:ring-teal/20",
          )}
        >
          {/* 对话卡片顶栏：工作空间文件夹名称 + 分支 (Branch) */}
          <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-1.5 px-0.5 select-none">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => {
                  if (isMobile) {
                    onOpenDrawer?.();
                  } else {
                    useShell.getState().setCommandOpen(true);
                  }
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg bg-line-soft/80 px-2.5 py-1 text-xs text-ink font-semibold truncate hover:bg-line-soft active:scale-95 transition",
                  "max-w-[150px] sm:max-w-[240px]",
                )}
                title="点击切换工作空间或 Agent"
              >
                <FolderGit2 size={13} className="text-teal shrink-0" />
                <span className="truncate">{unit?.name || "agent-workbench"}</span>
                <ChevronDown size={10} className="text-ash shrink-0" />
              </button>

              {/* 分支（先行实现页面展示效果） */}
              <div
                className="flex items-center gap-1 rounded-md border border-line/60 bg-line-soft/60 px-2 py-0.5 text-[11px] font-mono text-graphite hover:text-ink transition select-none cursor-default"
                title="代码仓库分支 (当前为 main 分支)"
              >
                <GitBranch size={11} className="text-teal shrink-0" />
                <span>main</span>
              </div>
            </div>
          </div>

          {/* 斜杠指令参数提示条（命令已选定、输入参数阶段） */}
          {activeCommandHint && !slashMenuDismissed && (
            <div className="absolute bottom-full -left-px -right-px mb-2 px-3.5 py-2 rounded-xl border border-line bg-card/95 shadow-md backdrop-blur-md flex items-center gap-2.5 text-xs animate-in fade-in duration-100 z-40">
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
                <span className="text-graphite text-xs truncate flex-1 min-w-0">
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
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
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
            placeholder={
              isMobile
                ? unit
                  ? `向「${unit.name}」发消息… (输入 / 调出快捷命令)`
                  : "输入任务或指令… (输入 / 调出快捷命令)"
                : placeholder
            }
            aria-label="任务输入"
            className={cn(
              "w-full resize-none overflow-y-auto bg-transparent leading-relaxed text-ink !outline-none focus:!outline-none focus-visible:!outline-none focus-visible:!ring-0 placeholder:text-graphite",
              isMobile ? "text-body-sm min-h-[64px]" : "text-body min-h-[76px]",
            )}
            style={{ height: `${inputHeight}px`, maxHeight: `${maxH}px`, outline: "none", boxShadow: "none" }}
          />

          {/* 底部工具栏 */}
          <div className="mt-2 flex items-center justify-between gap-1.5">
            {/* 左侧操作：+ 添加命令/附件 + 快捷 / + 模式形式 (plan / accept edits / ask / bypass) */}
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => setPlusMenuOpen((v) => !v)}
                  aria-expanded={plusMenuOpen}
                  aria-label="添加指令或附件"
                  title="添加快捷指令、@附件与技能"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 text-teal hover:bg-line-soft active:scale-95 transition",
                    "h-7 w-7 sm:h-8 sm:w-8",
                    plusMenuOpen && "bg-teal-tint text-teal ring-1 ring-teal/30",
                  )}
                >
                  <Plus size={isMobile ? 14 : 16} strokeWidth={2.5} />
                </button>

                {/* [+] 弹出菜单：斜杠指令 / @ 附件提示 */}
                {plusMenuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-line bg-canvas p-1.5 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        setDraft("/");
                        setSlashMenuDismissed(false);
                        taRef.current?.focus();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold">
                        /
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">快捷斜杠命令与技能</span>
                        <span className="block text-[10px] text-ash">呼出 / 命令面板</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        setDraft(draft ? `${draft} @` : "@");
                        taRef.current?.focus();
                      }}
                      className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <Paperclip size={14} className="shrink-0 text-teal" />
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">添加文件与上下文 (@)</span>
                        <span className="block text-[10px] text-ash">文件引用功能即将上线</span>
                      </div>
                      <span className="rounded bg-teal-tint px-1 py-0.2 text-[9px] font-medium text-teal shrink-0">
                        后续
                      </span>
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setDraft("/");
                  setSlashMenuDismissed(false);
                  taRef.current?.focus();
                }}
                aria-label="快捷指令"
                title="查看与运行快捷指令 · 输入 /"
                className="hidden sm:flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-xs text-graphite hover:bg-line-soft hover:text-ink font-mono transition h-7 sm:h-8"
              >
                <Command size={13} className="text-teal" />
                <span className="font-bold text-teal">/</span>
              </button>

              {/* 权限模式选择器（计划模式 / 变更确认 / 自主模式 / 完全访问） */}
              <PermissionModePicker compact={isMobile} align="left" />
            </div>

            {/* 右侧操作：执行器与模型（单图标） + 推理力度（单图标） + 发送/停止按钮 */}
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              <RuntimePicker compact={isMobile} align="right" />
              <ReasoningEffortPicker compact={isMobile} align="right" />

              {busy ? (
                <button
                  type="button"
                  onClick={() => useWorkbench.getState().cancelRun()}
                  aria-label="停止"
                  title="停止"
                  className="flex shrink-0 items-center justify-center rounded-lg bg-ink text-canvas hover:opacity-90 active:scale-95 transition h-7 w-7 sm:h-8 sm:w-8"
                >
                  <Square size={isMobile ? 10 : 12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  aria-label="发送"
                  title="发送 · Enter"
                  className="flex shrink-0 items-center justify-center rounded-lg bg-teal text-canvas hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:bg-ink transition shadow-xs h-7 w-7 sm:h-8 sm:w-8"
                >
                  <ArrowUp size={isMobile ? 14 : 16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
