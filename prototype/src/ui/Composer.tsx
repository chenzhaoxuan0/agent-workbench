import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, Brain, Command, Sliders, Square, SquareTerminal } from "lucide-react";
import { useWorkbench, selectActiveUnit, visibleModelsFor } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { useMemoryPanel, readProjectMemory } from "../store/useMemoryPanel.ts";
import { asModelId } from "../core/units.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import { ReasoningEffortPicker } from "./LoopParamsPicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { MemoryScopePicker } from "./MemoryScopePicker.tsx";
import { SlashCommandMenu, type SlashCommand } from "./SlashCommandMenu.tsx";
import { cn } from "./cn.ts";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 对齐 DESIGN.md 的 Search Input + Filled Action Button + Pill Chip：
 * - 羊皮纸底 + 12px 圆角 + 聚焦时青色光晕
 * - 集成独立记忆注入选择（MEMORY.md 与当日精炼 daily）
 * - 真实支持原生与工作台增强快捷斜杠指令（/mem, /skill, /clear, /model, /plan, /yolo, /status 等）
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

  // 监听是否呈现斜杠命令菜单（支持 / 以及带有子参数的实时前缀过滤，如 /model, /mem 等）
  const isSlashActive = draft.startsWith("/") && !draft.includes("\n") && !slashMenuDismissed;
  const slashFilter = isSlashActive ? draft.slice(1) : "";

  const showEphemeral = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((cur) => (cur === msg ? null : cur));
    }, 4000);
  };

  /** 输出运行时诊断报告到时间线 */
  const runStatusReport = () => {
    const s = useWorkbench.getState();
    const activeRuntime = s.activeRuntimeId;
    const activeModel =
      s.runtimeModels[activeRuntime] ??
      s.runtimes.find((r) => r.id === activeRuntime)?.defaultModel ??
      "默认";
    const scopes =
      s.memoryScopes.length > 0
        ? s.memoryScopes
            .map((x) => (x === "semantic" ? "长期事实 (MEMORY.md)" : "当日精炼 (daily/*.md)"))
            .join(" + ")
        : "无 (纯净上下文)";
    const skills = useMemoryPanel.getState().skills;
    const u = selectActiveUnit(s);

    s.pushNotice(
      "运行时全貌与上下文诊断报告",
      `【工作单元】: ${u?.name ?? "未选"} (${u?.kind === "bot" ? "专职 Bot" : "项目代码库"})\n` +
        `【工作路径】: ${u?.rootPath ?? "无"}\n` +
        `【生效执行器】: ${activeRuntime} (大模型: ${activeModel})\n` +
        `【审批模式】: ${s.permissionMode.toUpperCase()}\n` +
        `【记忆注入范围】: ${scopes}\n` +
        `【可用技能资产】: ${skills.length} 项 (${skills.map((x) => x.name).join(", ") || "暂无"})\n` +
        `【当前会话】: ${s.activeSessionId ? `活跃会话 #${s.activeSessionId}` : "就绪 (下条指令开启新会话)"}`,
      {
        level: "info",
        meta: {
          执行器: activeRuntime,
          模型: String(activeModel),
          记忆配置: scopes,
          技能数: `${skills.length} 项`,
          审批档位: s.permissionMode,
        },
      },
    );
  };

  /** 输出记忆诊断报告到时间线 */
  const runMemoryInspect = async () => {
    const s = useWorkbench.getState();
    const u = selectActiveUnit(s);
    const rootPath = u?.rootPath;
    if (!rootPath) {
      s.pushNotice("记忆诊断失败", "当前未选定工作单元，无法定位记忆存储目录。", { level: "warn" });
      return;
    }

    try {
      const mem = await readProjectMemory(rootPath);
      const scopes =
        s.memoryScopes.length > 0
          ? s.memoryScopes
              .map((x) => (x === "semantic" ? "长期事实 (MEMORY.md)" : "当日精炼 (daily/*.md)"))
              .join(" + ")
          : "无 (纯净上下文)";

      s.pushNotice(
        "项目记忆状态诊断详情",
        `项目目录: ${rootPath}\n\n` +
          `【长期事实 MEMORY.md】\n` +
          `· 文件状态: ${mem.exists ? "已存在" : "尚未创建"}\n` +
          `· 字符容量: ${mem.chars} / ${mem.limit} 字符 (${Math.round((mem.chars / mem.limit) * 100)}%)\n\n` +
          `【当日会话精炼 daily/*.md】\n` +
          `· 存储目录: ${rootPath}/.agent-workbench/memory/daily/\n` +
          `· 提取机制: 由总管 Bot 每日定时任务全盘扫描并提炼关键结论与避坑\n\n` +
          `当前会话生效注入: [${scopes}]`,
        {
          level: "info",
          meta: {
            长期记忆: mem.exists ? `${mem.chars}字` : "未建",
            当前注入: scopes,
          },
        },
      );
    } catch (e) {
      s.pushNotice(
        "记忆诊断失败",
        `读取记忆存储失败: ${e instanceof Error ? e.message : String(e)}`,
        { level: "warn" },
      );
    }
  };

  /** 输出快捷指令手册到时间线 */
  const runHelpGuide = () => {
    useWorkbench.getState().pushNotice(
      "快捷指令与原生 CLI 映射手册",
      `【记忆与上下文】\n` +
        `· /mem both - 启用「长期事实 + 当日精炼」双注入模式\n` +
        `· /mem semantic - 仅启用「长期事实 (MEMORY.md)」\n` +
        `· /mem daily - 仅启用「当日精炼 (daily/*.md)」\n` +
        `· /mem off - 关闭所有记忆注入 (纯净上下文)\n` +
        `· /mem inspect - 诊断当前项目记忆字数与今日摘要详情\n` +
        `· /status - 输出当前 Bot、执行器、模型及记忆配置诊断报告\n\n` +
        `【执行器与大模型】\n` +
        `· /model <name> - 即时切换当前执行器生效模型 (如 /model claude-3-7-sonnet)\n` +
        `· /clear - 重置当前会话，清空历史并重开上下文 (对齐 Claude Code /clear)\n\n` +
        `【模式与执行】\n` +
        `· /plan - 切换至 Plan 只读规划分析模式 (对齐 Codex/Claude plan)\n` +
        `· /yolo - 切换至 YOLO 全自动免审批模式 (对齐 ZCode yolo / Codex exec)\n` +
        `· /ask - 切换至 Ask 询问审批安全模式 (默认标准档位)\n\n` +
        `【系统与技能】\n` +
        `· /skill <name> - 引用工作区技能资产 (@skills/<name>)\n` +
        `· /terminal - 展开或收起工作区交互终端 (Ctrl+\`)\n` +
        `· /help - 调出本指令速查手册`,
      { level: "info" },
    );
  };

  const handleSelectSlashCommand = (cmd: SlashCommand) => {
    setSlashMenuDismissed(true);

    // 1. 如果是具体模型选择
    if (cmd.id.startsWith("model:") && cmd.modelId) {
      const activeRuntime = useWorkbench.getState().activeRuntimeId;
      useWorkbench.getState().selectModel(asModelId(cmd.modelId));
      useWorkbench.getState().pushNotice(
        "生效大模型已切换",
        `执行器 [${activeRuntime}] 的当前对话大模型已切换为: ${cmd.title} (${cmd.modelId})`,
        {
          level: "success",
          meta: { 执行器: activeRuntime, 模型: cmd.modelId },
        },
      );
      setDraft("");
      showEphemeral(`已切换为模型: ${cmd.modelId}`);
      return;
    }

    // 2. 如果是记忆具体预设配置
    if (cmd.id.startsWith("mem:") && cmd.memoryPreset !== undefined) {
      useWorkbench.getState().setMemoryScopes(cmd.memoryPreset);
      const label =
        cmd.memoryPreset.length === 2
          ? "长期事实 + 当日精炼"
          : cmd.memoryPreset.includes("semantic")
            ? "仅长期事实 (MEMORY.md)"
            : cmd.memoryPreset.includes("daily")
              ? "仅当日精炼 (daily/*.md)"
              : "关闭注入 (纯净上下文)";

      useWorkbench.getState().pushNotice(
        "记忆注入配置已更新",
        `后续与当前会话 prompt prefix 注入范围已设为: [${label}]。`,
        {
          level: "success",
          meta: { 注入范围: label },
        },
      );
      setDraft("");
      showEphemeral(`记忆注入范围已设为: ${label}`);
      return;
    }

    // 3. 如果是记忆诊断
    if (cmd.id === "mem:inspect") {
      setDraft("");
      void runMemoryInspect();
      return;
    }

    // 4. 如果是技能具体项
    if (cmd.id.startsWith("skill:") && cmd.skillName) {
      setDraft(`@skills/${cmd.skillName} `);
      taRef.current?.focus();
      return;
    }

    // 5. 顶级命令分发
    switch (cmd.id) {
      case "clear":
        useWorkbench.setState({ activeSessionId: null, timeline: [] });
        useWorkbench.getState().pushNotice(
          "会话已重置",
          "已清空当前对话上下文与历史记录，开启全新独立会话。",
          { level: "info" },
        );
        setDraft("");
        showEphemeral("已清空当前会话，开启全新上下文");
        break;

      case "status":
        setDraft("");
        runStatusReport();
        break;

      case "help":
        setDraft("");
        runHelpGuide();
        break;

      case "plan":
        setPermissionMode("plan");
        useWorkbench.getState().pushNotice(
          "模式切换: Plan 规划模式",
          "已切换为 Plan 模式。执行器仅梳理方案与分析，不执行写文件或终端口令。",
          { level: "info", meta: { 模式: "PLAN" } },
        );
        setDraft("");
        showEphemeral("已切换为 Plan 规划模式（只读方案梳理）");
        break;

      case "yolo":
        setPermissionMode("bypass");
        useWorkbench.getState().pushNotice(
          "模式切换: YOLO 免审批模式",
          "已切换为 YOLO 模式。执行器所有文件修改与终端执行均全自动放行。",
          { level: "warn", meta: { 模式: "YOLO (BYPASS)" } },
        );
        setDraft("");
        showEphemeral("已切换为 YOLO 自由执行模式（免审批）");
        break;

      case "ask":
        setPermissionMode("ask");
        useWorkbench.getState().pushNotice(
          "模式切换: Ask 询问审批模式",
          "已恢复为 Ask 模式。遇到关键写文件与终端命令时将请求人工裁决。",
          { level: "info", meta: { 模式: "ASK" } },
        );
        setDraft("");
        showEphemeral("已切换为 Ask 询问审批模式");
        break;

      case "terminal":
        setDraft("");
        useShell.getState().toggleTerminal();
        break;

      case "mem":
        setDraft("/mem ");
        taRef.current?.focus();
        break;

      case "model":
        setDraft("/model ");
        taRef.current?.focus();
        break;

      case "skill":
        setDraft("/skill ");
        taRef.current?.focus();
        break;

      default:
        setDraft(`${cmd.name} `);
        taRef.current?.focus();
    }
  };

  /**
   * 提交输入内容：
   * 真实拦截与执行所有斜杠指令，如果不是已知系统指令则正常发给 Agent。
   */
  const submit = () => {
    const v = draft.trim();
    if (!v) return;

    if (v.startsWith("/")) {
      const parts = v.split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const arg = parts.slice(1).join(" ").trim().toLowerCase();

      // 1. /clear
      if (cmd === "/clear") {
        handleSelectSlashCommand({
          id: "clear",
          name: "/clear",
          title: "清空会话",
          description: "",
          category: "执行器",
          icon: SquareTerminal,
        });
        return;
      }

      // 2. /status
      if (cmd === "/status") {
        setDraft("");
        setSlashMenuDismissed(false);
        runStatusReport();
        return;
      }

      // 3. /help
      if (cmd === "/help") {
        setDraft("");
        setSlashMenuDismissed(false);
        runHelpGuide();
        return;
      }

      // 4. /plan, /yolo, /ask
      if (cmd === "/plan" || cmd === "/yolo" || cmd === "/ask") {
        handleSelectSlashCommand({
          id: cmd.slice(1),
          name: cmd,
          title: cmd,
          description: "",
          category: "模式",
          icon: SquareTerminal,
        });
        return;
      }

      // 5. /terminal
      if (cmd === "/terminal") {
        handleSelectSlashCommand({
          id: "terminal",
          name: "/terminal",
          title: "工作区终端",
          description: "",
          category: "系统",
          icon: SquareTerminal,
        });
        return;
      }

      // 6. /mem 指令解析
      if (cmd === "/mem") {
        setDraft("");
        setSlashMenuDismissed(false);
        if (arg === "both" || arg === "all") {
          handleSelectSlashCommand({
            id: "mem:both",
            name: "/mem both",
            title: "双注入",
            description: "",
            category: "记忆",
            icon: Brain,
            memoryPreset: ["semantic", "daily"],
          });
        } else if (arg === "semantic" || arg === "long") {
          handleSelectSlashCommand({
            id: "mem:semantic",
            name: "/mem semantic",
            title: "仅长期事实",
            description: "",
            category: "记忆",
            icon: Brain,
            memoryPreset: ["semantic"],
          });
        } else if (arg === "daily" || arg === "day") {
          handleSelectSlashCommand({
            id: "mem:daily",
            name: "/mem daily",
            title: "仅当日精炼",
            description: "",
            category: "记忆",
            icon: Brain,
            memoryPreset: ["daily"],
          });
        } else if (arg === "off" || arg === "none" || arg === "0") {
          handleSelectSlashCommand({
            id: "mem:off",
            name: "/mem off",
            title: "关闭记忆注入",
            description: "",
            category: "记忆",
            icon: Brain,
            memoryPreset: [],
          });
        } else if (arg === "inspect") {
          void runMemoryInspect();
        } else {
          // 循环切换
          const cur = useWorkbench.getState().memoryScopes;
          const next =
            cur.length === 2
              ? (["semantic"] as const)
              : cur.includes("semantic")
                ? (["daily"] as const)
                : cur.includes("daily")
                  ? ([] as const)
                  : (["semantic", "daily"] as const);

          handleSelectSlashCommand({
            id: "mem:cycle",
            name: "/mem",
            title: "切换记忆注入",
            description: "",
            category: "记忆",
            icon: Brain,
            memoryPreset: next,
          });
        }
        return;
      }

      // 7. /model 指令解析
      if (cmd === "/model") {
        setDraft("");
        setSlashMenuDismissed(false);
        const activeRuntime = useWorkbench.getState().activeRuntimeId;
        const visible = visibleModelsFor(useWorkbench.getState(), activeRuntime);

        if (!arg) {
          // 未给参数时，列出可用大模型
          useWorkbench.getState().pushNotice(
            `执行器 [${activeRuntime}] 可用模型列表`,
            visible.map((m) => `· ${m.id} (${m.displayName}) - ${m.vendorLabel}`).join("\n") +
              `\n\n提示：可输入 /model <模型ID> 快速切换`,
            { level: "info", meta: { 执行器: activeRuntime, 数量: `${visible.length} 个` } },
          );
          return;
        }

        // 匹配模型
        const matched = visible.find(
          (m) =>
            m.id.toLowerCase() === arg ||
            m.id.toLowerCase().includes(arg) ||
            m.displayName.toLowerCase().includes(arg),
        );

        if (matched) {
          handleSelectSlashCommand({
            id: `model:${matched.id}`,
            name: `/model ${matched.id}`,
            title: matched.displayName,
            description: "",
            category: "执行器",
            icon: Sliders,
            modelId: matched.id,
          });
        } else {
          useWorkbench.getState().pushNotice(
            "未找到匹配的模型",
            `在执行器 [${activeRuntime}] 中未找到包含 "${arg}" 的大模型。\n可用模型: ${visible.map((m) => m.id).join(", ")}`,
            { level: "warn", meta: { 搜索关键词: arg } },
          );
        }
        return;
      }

      // 8. /skill 指令解析
      if (cmd === "/skill") {
        setDraft("");
        setSlashMenuDismissed(false);
        const skills = useMemoryPanel.getState().skills;
        if (!arg) {
          useWorkbench.getState().pushNotice(
            "工作区可用技能列表",
            skills.length > 0
              ? skills.map((s) => `· @skills/${s.name} (${s.kind === "dir" ? "目录" : "文件"})`).join("\n")
              : "当前工作区暂未检测到 skills/ 目录资产。可在项目根目录新建 skills/ 目录与 Markdown 说明书。",
            { level: "info", meta: { 技能总数: `${skills.length} 项` } },
          );
        } else {
          const s = skills.find((x) => x.name.toLowerCase().includes(arg));
          if (s) {
            setDraft(`@skills/${s.name} `);
            taRef.current?.focus();
          } else {
            useWorkbench.getState().pushNotice(
              "未找到匹配的技能",
              `未在工作区找到名称包含 "${arg}" 的技能资产。可用技能: ${skills.map((x) => x.name).join(", ") || "无"}`,
              { level: "warn" },
            );
          }
        }
        return;
      }
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
              // ⚠ 输入法组字中的 Enter 是「选词」，不是「发送」。
              // 中文/日文输入法下按 Enter 上屏候选词时，keydown 的 key 同样是
              // "Enter"、isComposing 为 true —— 不挡就会把半截拼音（或未上屏的
              // 内容）当消息发出去。
              if (e.nativeEvent.isComposing) return;
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
