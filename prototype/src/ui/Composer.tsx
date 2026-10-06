import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, Command, Square, SquareTerminal } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { MemoryScopePicker } from "./MemoryScopePicker.tsx";
import { SlashCommandMenu, SLASH_COMMANDS, type SlashCommand } from "./SlashCommandMenu.tsx";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 对齐 DESIGN.md 的 Search Input + Filled Action Button + Pill Chip：
 * - 羊皮纸底 + 12px 圆角 + 聚焦时青色光晕
 * - 集成独立记忆注入选择（MEMORY.md 与当日精炼 daily）
 * - 支持原生与工作台增强快捷斜杠指令（/mem, /skill, /clear, /model, /plan, /yolo 等）
 */
export function Composer() {
  const terminalOpen = useShell((s) => s.terminalOpen);
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const setPermissionMode = useWorkbench((s) => s.setPermissionMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(46);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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

  // 监听是否呈现斜杠命令菜单
  const isSlashActive = draft.startsWith("/") && !draft.includes("\n") && !draft.includes(" ") && !slashMenuDismissed;
  const slashFilter = isSlashActive ? draft.slice(1) : "";

  const handleSelectSlashCommand = (cmd: SlashCommand) => {
    setSlashMenuDismissed(true);
    setDraft("");

    switch (cmd.id) {
      case "clear":
        useWorkbench.setState({ activeSessionId: null, timeline: [] });
        showEphemeral("已清空当前会话，开启全新上下文");
        break;
      case "plan":
        setPermissionMode("plan");
        showEphemeral("已切换为 Plan 规划模式（只读方案梳理）");
        break;
      case "yolo":
        setPermissionMode("bypass");
        showEphemeral("已切换为 YOLO 自由执行模式（免审批）");
        break;
      case "ask":
        setPermissionMode("ask");
        showEphemeral("已切换为 Ask 询问审批模式");
        break;
      case "terminal":
        useShell.getState().toggleTerminal();
        break;
      case "skill":
        setDraft("@skills/");
        taRef.current?.focus();
        break;
      case "status": {
        const activeRuntime = useWorkbench.getState().activeRuntimeId;
        const scopes = useWorkbench.getState().memoryScopes.join(" + ") || "无";
        showEphemeral(`当前单元: ${unit?.name ?? "未选"} · 执行器: ${activeRuntime} · 记忆注入: [${scopes}]`);
        break;
      }
      case "mem":
        showEphemeral("提示：可在下方工具栏的「记忆胶囊」中直接切换长期/当日精炼注入");
        break;
      case "help":
        showEphemeral("支持指令: /mem(记忆) /skill(技能) /clear(清空) /plan(规划) /yolo(全放行) /ask(审批) /terminal(终端) /status");
        break;
      default:
        setDraft(`${cmd.name} `);
        taRef.current?.focus();
    }
  };

  const showEphemeral = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((cur) => (cur === msg ? null : cur));
    }, 4000);
  };

  const submit = () => {
    const v = draft.trim();
    if (!v) return;

    // 如果是以斜杠开头的已知指令，优先本地拦截执行
    if (v === "/clear") {
      const target = SLASH_COMMANDS.find((c) => c.id === "clear");
      if (target) handleSelectSlashCommand(target);
      return;
    }
    if (v === "/plan" || v === "/yolo" || v === "/ask") {
      const target = SLASH_COMMANDS.find((c) => c.id === v.slice(1));
      if (target) handleSelectSlashCommand(target);
      return;
    }
    if (v === "/terminal") {
      const target = SLASH_COMMANDS.find((c) => c.id === "terminal");
      if (target) handleSelectSlashCommand(target);
      return;
    }

    setDraft("");
    setSlashMenuDismissed(false);
    void run(v);
  };

  const placeholder = !unit
    ? "先选一个工作单元，或新建一个 bot… (输入 / 调出快捷指令)"
    : unit.kind === "bot"
      ? `给「${unit.name}」派活…（输入 / 调出快捷指令，会先读其 AGENTS.md）`
      : `对「${unit.name}」下任务…（输入 / 调出快捷指令，可开 worktree 隔离）`;

  return (
    <div className="shrink-0 border-t border-line bg-rail">
      <div className="mx-auto max-w-[900px] px-8 py-4">
        {/* 短暂状态提示条 */}
        {statusMessage && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-teal-tint px-3 py-1.5 text-xs text-teal border border-teal/20 animate-in fade-in slide-in-from-bottom-1 duration-150">
            <span className="font-medium">{statusMessage}</span>
            <button
              type="button"
              onClick={() => setStatusMessage(null)}
              className="text-teal/70 hover:text-teal font-mono text-[10px]"
            >
              关闭
            </button>
          </div>
        )}

        <div
          className={cn(
            "relative rounded-input border bg-canvas px-4 py-3",
            "border-line",
            "focus-within:shadow-[0_0_0_3px_rgb(1_106_113/0.12)]",
          )}
        >
          {/* 斜杠指令弹出菜单 */}
          {isSlashActive && (
            <SlashCommandMenu
              filter={slashFilter}
              onSelect={handleSelectSlashCommand}
              onClose={() => setSlashMenuDismissed(true)}
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
              if (e.key === "Enter" && !e.shiftKey) {
                if (!isSlashActive) {
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

            {/* 「@ 引用」 */}
            <button
              type="button"
              onClick={() => {
                setDraft(`${draft}@`);
                taRef.current?.focus();
              }}
              aria-label="引用文件"
              title="@ 引用工作单元里的文件 / 会话 / 技能"
              className="shrink-0 rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink transition"
            >
              <AtSign size={14} />
            </button>

            {/* 「记忆注入选择胶囊」 */}
            <MemoryScopePicker />

            {/* 「工作区终端」 */}
            <button
              type="button"
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
              <RuntimePicker />
              <ReasoningEffortPicker />
              <PermissionModePicker />

              {busy ? (
                <button
                  type="button"
                  onClick={() => useWorkbench.getState().cancelRun()}
                  aria-label="停止"
                  title="停止"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-ink text-canvas hover:bg-black"
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
