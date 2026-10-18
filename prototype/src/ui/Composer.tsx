import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  GitBranch,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { nativeCommandsFor, useNativeCommands } from "../store/useNativeCommands.ts";
import { fetchWorkspacePaths } from "../adapters/daemon/client.ts";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { isProjectUnit } from "../core/units.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { BranchPicker } from "./BranchPicker.tsx";
import { GitActionTrigger } from "./GitActionTrigger.tsx";
import { UnitSwitcher } from "./UnitSwitcher.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { SlashCommandMenu, filterNativeCommands } from "./SlashCommandMenu.tsx";
import { AttachmentsBar } from "./AttachmentsBar.tsx";
import { PathMentionMenu } from "./PathMentionMenu.tsx";
import { ChatTerminalToggleButton } from "./ChatTerminalDock.tsx";
import type { ChatAttachment } from "../core/attachments.ts";
import { MAX_ATTACHMENTS, categorizeAttachment, inferAttachmentMimeType } from "../core/attachments.ts";
import {
  type ActiveMention,
  type WorkspacePathSuggestion,
  draftWithMentionReplaced,
  resolveActiveMention,
} from "../core/workspacePaths.ts";
import { createAttachmentFromFile } from "./attachmentFile.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 移动端结构：
 * - 顶部卡片栏：单元文件夹名称 + 分支 (Branch) + 角色徽标
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
  const pendingFork = useWorkbench((s) => s.pendingFork);
  const cancelFork = useWorkbench((s) => s.cancelFork);
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

  // ---- @ 路径提及（交互对齐 ZCode file-mention）----------------------------
  // 光标位置单独跟踪：@ 触发看「光标前最近的一个 @」，光标移动（点击/方向键）
  // 都要重算，不能只靠 draft 变化。
  const [cursorOffset, setCursorOffset] = useState(draft.length);
  const [mentionDismissedKey, setMentionDismissedKey] = useState<string | null>(null);
  const [mention, setMention] = useState<{
    readonly items: readonly WorkspacePathSuggestion[];
    readonly status: "loading" | "ready" | "error";
    readonly truncated: boolean;
    readonly error?: string;
  }>({ items: [], status: "loading", truncated: false });
  const [mentionIndex, setMentionIndex] = useState(0);
  /** 补全后待恢复的光标位置（受控 textarea 值替换后光标会跳到末尾） */
  const pendingCaretRef = useRef<number | null>(null);

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

  // ---- @ 路径提及：触发解析 + 建议（ZCode file-mention 同款语义）------------

  const activeMention: ActiveMention | undefined = useMemo(
    () => (unit?.rootPath ? resolveActiveMention(draft, cursorOffset) : undefined),
    [draft, cursorOffset, unit?.rootPath],
  );
  const mentionKey = activeMention
    ? `${activeMention.triggerIndex}:${activeMention.endOffset}:${activeMention.token}`
    : "";
  /** Esc 关的是「这一处 @ 触发」（按 @ 位置识别）：继续打字补全 token、挪光标
   *  回来都不重弹；删掉 @ 重新输入、或触发别的 @ 才恢复。键里不能掺
   *  token/endOffset —— 那样 Esc 之后多打一个字就换键，菜单立刻复活并劫持 Enter */
  const mentionDismissKey = activeMention ? String(activeMention.triggerIndex) : "";
  const mentionOpen = activeMention !== undefined && mentionDismissedKey !== mentionDismissKey;
  // 触发本身消失（删掉 @ / 光标离开这个 token）就复位 dismissal ——
  // 否则原地重打一个 @ 会因为位置相同而永远弹不出来
  useEffect(() => {
    if (activeMention === undefined && mentionDismissedKey !== null) setMentionDismissedKey(null);
  }, [activeMention, mentionDismissedKey]);

  // token 变化即拉取（上一笔 abort 掉；本地 readdir 快路径，不做防抖 —— ZCode 同款）
  useEffect(() => {
    if (!mentionOpen || !activeMention || !unit?.rootPath) return;
    const controller = new AbortController();
    // 清掉旧 token 的残余建议：加载窗口里旧列表还能被 Enter/Tab 选中（或误导
    // 点击），跟手输入必须只留当前 token 的结果
    setMention({ items: [], status: "loading", truncated: false, error: undefined });
    setMentionIndex(0);
    void fetchWorkspacePaths(unit.rootPath, activeMention.token, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setMention({ items: result.items, status: "ready", truncated: result.truncated });
        setMentionIndex(0);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setMention({
          items: [],
          status: "error",
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mentionKey 已覆盖 token/位置变化
  }, [mentionKey, mentionOpen, unit?.rootPath]);

  /** 补全 @ 提及：目录 → 落 `@dir/` 继续下钻；文件 → 加附件 + 落 `@path `（ZCode 同款） */
  const completeMention = (item: WorkspacePathSuggestion) => {
    if (!activeMention) return;
    const { draft: next, caret } = draftWithMentionReplaced(
      draft,
      activeMention,
      item.path,
      item.kind === "directory",
    );
    setDraft(next);
    setCursorOffset(caret);
    pendingCaretRef.current = caret;
    if (item.kind === "file") {
      setAttachments((prev) => {
        if (prev.length >= MAX_ATTACHMENTS) return prev;
        // 同一路径只挂一份（ZCode 按 placeholder 判重，这里按工作区相对路径）
        if (prev.some((a) => a.localPath === item.path)) return prev;
        const mimeType = inferAttachmentMimeType(item.name);
        return [
          ...prev,
          {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: item.name,
            size: item.size ?? 0,
            mimeType,
            category: categorizeAttachment(item.name, mimeType),
            // 工作区相对路径 —— 执行器 cwd 就是工作区根，按路径自读（ZCode local_ref 语义）
            localPath: item.path,
          },
        ];
      });
    }
    taRef.current?.focus();
  };

  // 受控 textarea 的值被程序替换后光标会跳到末尾，这里恢复到补全位置
  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });

  /** 提交输入内容："/" 开头的文本原样发给执行器（原生命令透传语义），支持仅带附件或图文混发。 */
  const submit = () => {
    const v = draft.trim();
    if (!v && attachments.length === 0) return;
    const currentAttachments = [...attachments];
    setDraft("");
    setAttachments([]);
    setSlashMenuDismissed(false);
    setPlusMenuOpen(false);
    setMentionDismissedKey(null);
    setCursorOffset(0);
    void run(v, { attachments: currentAttachments });
  };

  const placeholder = !unit
    ? "先选一个 bot 或项目，或新建一个 bot… (输入 / 查看命令/技能/子智能体)"
    : !isProjectUnit(unit)
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

          {/* 对话卡片顶栏：单元切换器 + 分支 (Branch) */}
          <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-1.5 px-0.5 select-none">
            <div className="flex items-center gap-2 min-w-0">
              {/* 专属 bot/项目切换面板（与 ⌘K 搜索分家）；移动端点开抽屉 */}
              <UnitSwitcher current={unit} isMobile={isMobile} onOpenDrawer={onOpenDrawer} />

              {/* 分支选择器（ZCode 同款交互，ADR 0009 窄面）：非 git 仓库时自动隐藏 */}
              <BranchPicker rootPath={unit?.rootPath} />
              {/* 落库触发器（ADR 0010 的 ②）：状态驱动图标，始终展示、干净时置灰 */}
              <GitActionTrigger rootPath={unit?.rootPath} />
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

          {/* 分叉意图条（ADR 0013「意图 + 发送才建段」）：可见、可撤，取消零持久化 */}
          {pendingFork !== null && (
            <div className="mb-2 flex items-center gap-2 rounded-btn border border-teal/30 bg-teal-tint/40 px-3 py-1.5 text-caption text-graphite">
              <GitBranch size={12} className="shrink-0 text-teal" />
              <span className="min-w-0 flex-1">
                {pendingFork.kind === "branch"
                  ? "发送后将从所选轮之后分叉开启新段：新段带此前对话的只读前缀，当前分支保留可回看"
                  : "发送后将编辑重发：在新段里替换那一轮（那轮之前保留为只读前缀；附件与工作区文件改动不回滚）"}
              </span>
              <button
                onClick={cancelFork}
                className="flex shrink-0 items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
                title="放弃分叉意图（不产生任何持久化）"
              >
                <X size={12} />
                <span>取消</span>
              </button>
            </div>
          )}

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

          {/* @ 路径提及弹出菜单（工作区文件/目录引用） */}
          {mentionOpen && activeMention && (
            <PathMentionMenu
              workspaceName={unit?.name ?? "单元"}
              items={mention.items}
              status={mention.status}
              truncated={mention.truncated}
              error={mention.error}
              query={activeMention.token}
              activeIndex={Math.min(mentionIndex, Math.max(0, mention.items.length - 1))}
              onSelect={completeMention}
              onHover={setMentionIndex}
              onClose={() => setMentionDismissedKey(mentionDismissKey)}
            />
          )}

          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSlashMenuDismissed(false);
              setCursorOffset(e.target.selectionStart ?? e.target.value.length);
            }}
            // 光标移动（方向键/点击/选区）都要重算 @ 触发：提及看的是「光标前最近的一个 @」
            onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                void handleAddFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // @ 提及菜单开着且有可选项：↑↓ 导航，Enter/Tab 选定（焦点留在输入框）
              if (mentionOpen && mention.items.length > 0) {
                const picked = mention.items[Math.min(mentionIndex, mention.items.length - 1)];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mention.items.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mention.items.length) % mention.items.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && picked) {
                  e.preventDefault();
                  completeMention(picked);
                  return;
                }
              }
              if (e.key === "Escape" && mentionOpen) {
                setMentionDismissedKey(mentionDismissKey);
                return;
              }
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
            {/* 左侧操作：[+] 扩展菜单（附件/斜杠指令/@引用） + 模式形式 (plan / accept edits / ask / bypass) */}
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => setPlusMenuOpen((v) => !v)}
                  aria-expanded={plusMenuOpen}
                  aria-label="添加指令或附件"
                  title="添加附件、快捷指令，或 @ 引用文件"
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
                        const next = draft ? `${draft} @` : "@";
                        setDraft(next);
                        setCursorOffset(next.length);
                        setMentionDismissedKey(null);
                        taRef.current?.focus();
                      }}
                      className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-line-soft text-teal font-mono text-[11px] font-bold">
                        @
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">引用文件 (@)</span>
                        <span className="block text-[10px] text-ash">输入 @ 选择文件或目录作为上下文</span>
                      </div>
                    </button>
                  </div>
                )}
              </div>

              {/* 权限模式选择器（计划模式 / 变更确认 / 自主模式 / 完全访问） */}
              <PermissionModePicker compact={isMobile} align="left" />

              {/* 对话终端唤起按钮：对话页底部快捷小终端（Shell 在设置 → 终端里选，默认 PowerShell 7） */}
              <ChatTerminalToggleButton />
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
