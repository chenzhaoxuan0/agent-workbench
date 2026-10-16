import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Command,
  FolderGit2,
  Paperclip,
  Plus,
  Square,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { nativeCommandsFor, useNativeCommands } from "../store/useNativeCommands.ts";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { BranchPicker } from "./BranchPicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { SlashCommandMenu, filterNativeCommands } from "./SlashCommandMenu.tsx";
import { AttachmentsBar } from "./AttachmentsBar.tsx";
import type { ChatAttachment } from "../core/attachments.ts";
import { MAX_ATTACHMENTS } from "../core/attachments.ts";
import { createAttachmentFromFile } from "./attachmentFile.ts";
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 800,
  );
  const baseH = isMobile ? 64 : 76;
  const maxH = Math.max(baseH, Math.floor(viewportH - 170));

  const [inputHeight, setInputHeight] = useState(baseH);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  const handleAddFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) return;
    const toAdd = incoming.slice(0, availableSlots);
    const created: ChatAttachment[] = [];
    for (const f of toAdd) {
      try {
        const att = await createAttachmentFromFile(f);
        created.push(att);
      } catch {
        // 忽略单文件读取异常
      }
    }
    if (created.length > 0) {
      setAttachments((prev) => [...prev, ...created]);
    }
  };

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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingOver) setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleAddFiles(e.dataTransfer.files);
    }
  };

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

  /** 提交输入内容："/" 开头的文本原样发给执行器（原生命令透传语义），支持仅带附件或图文混发。 */
  const submit = () => {
    const v = draft.trim();
    if (!v && attachments.length === 0) return;
    const currentAttachments = [...attachments];
    setDraft("");
    setAttachments([]);
    setSlashMenuDismissed(false);
    setPlusMenuOpen(false);
    void run(v, { attachments: currentAttachments });
  };

  const placeholder = !unit
    ? "先选一个工作单元，或新建一个 bot… (输入 / 查看命令/技能/子智能体)"
    : unit.kind === "bot"
      ? `给「${unit.name}」派活…（可添加图片/代码附件，输入 / 调出 ${executorName} 命令面板）`
      : `对「${unit.name}」下任务…（可添加图片/代码附件，输入 / 调出 ${executorName} 命令面板）`;

  return (
    <div className="shrink-0">
      <div className={cn("mx-auto max-w-[900px]", isMobile ? "px-3 pb-2 pt-1" : "px-8 pb-4 pt-2")}>
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "relative rounded-2xl border bg-canvas shadow-subtle transition",
            isMobile ? "p-2.5 border-line/80 shadow-xs" : "px-4 py-3 border-line",
            "focus-within:border-teal/50 focus-within:ring-2 focus-within:ring-teal/20",
            isDraggingOver && "border-teal ring-2 ring-teal/30 bg-teal-tint/10",
          )}
        >
          {/* 隐藏的附件选择器 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleAddFiles(e.target.files);
                e.target.value = "";
              }
            }}
          />

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

              {/* 分支选择器（ZCode 同款交互，ADR 0009 窄面）：非 git 仓库时自动隐藏 */}
              <BranchPicker rootPath={unit?.rootPath} />
            </div>

            {/* 附件数量提示 */}
            {attachments.length > 0 && (
              <span className="text-[11px] font-medium text-teal font-mono">
                {attachments.length}/{MAX_ATTACHMENTS} 附件
              </span>
            )}
          </div>

          {/* 附件条：已选择的图片和文件列表 */}
          <AttachmentsBar
            attachments={attachments}
            onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
            className="mb-2"
          />

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
            onPaste={(e) => {
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                void handleAddFiles(e.clipboardData.files);
              }
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
                  ? `向「${unit.name}」发消息… (可传图/文件，输入 / 调命令)`
                  : "输入任务或指令… (可传图/文件，输入 / 调命令)"
                : placeholder
            }
            aria-label="任务输入"
            className={cn(
              "w-full resize-none overflow-y-auto bg-transparent leading-relaxed text-ink !outline-none focus:!outline-none focus-visible:!outline-none focus-visible:!ring-0 placeholder:text-graphite",
              isMobile ? "text-body-sm min-h-[64px]" : "text-body min-h-[76px]",
            )}
            style={{ height: `${inputHeight}px`, maxHeight: `${maxH}px`, outline: "none", boxShadow: "none" }}
          />

          {/* 拖拽上传覆盖提示 */}
          {isDraggingOver && (
            <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center rounded-2xl bg-teal-tint/90 backdrop-blur-xs border-2 border-dashed border-teal text-teal">
              <Paperclip size={28} className="animate-bounce mb-1" />
              <span className="text-sm font-semibold">松开鼠标添加附件</span>
              <span className="text-xs opacity-75">支持图片、源代码与各类文档</span>
            </div>
          )}

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
                  title="添加文件与图片附件、快捷指令与技能"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 text-teal hover:bg-line-soft active:scale-95 transition",
                    "h-7 w-7 sm:h-8 sm:w-8",
                    plusMenuOpen && "bg-teal-tint text-teal ring-1 ring-teal/30",
                  )}
                >
                  <Plus size={isMobile ? 14 : 16} strokeWidth={2.5} />
                </button>

                {/* [+] 弹出菜单：添加附件 / 斜杠指令 / @ 引用 */}
                {plusMenuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-line bg-canvas p-1.5 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <Paperclip size={14} className="shrink-0 text-teal" />
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">添加文件与图片附件</span>
                        <span className="block text-[10px] text-ash">支持图片、代码、文本 (最多8个)</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        setDraft("/");
                        setSlashMenuDismissed(false);
                        taRef.current?.focus();
                      }}
                      className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
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
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-line-soft text-teal font-mono text-[11px] font-bold">
                        @
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">添加上下文引用 (@)</span>
                        <span className="block text-[10px] text-ash">文件引用功能即将上线</span>
                      </div>
                      <span className="rounded bg-teal-tint px-1 py-0.2 text-[9px] font-medium text-teal shrink-0">
                        后续
                      </span>
                    </button>
                  </div>
                )}
              </div>

              {/* 独立的添加附件快捷按钮（桌面端/中等宽度快捷入口） */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="添加附件"
                title="添加图片或代码文件附件（支持拖拽与粘贴）"
                className="flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 text-graphite hover:text-teal hover:bg-line-soft active:scale-95 transition h-7 w-7 sm:h-8 sm:w-8"
              >
                <Paperclip size={isMobile ? 13 : 15} />
              </button>

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
                  disabled={!draft.trim() && attachments.length === 0}
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
