/**
 * 执行器内置命令目录（builtin slash command catalogs）。
 *
 * 为什么需要它：大多数执行器的内置斜杠命令是 **TUI 客户端功能**（按键拦截、
 * 改本地 UI/配置），headless/ACP 协议里没有命令发现 API —— zcode 的
 * readPresentation、claude 活会话的 supportedCommands、opencode 的
 * GET /command 是仅有的运行时声明面。对没有运行时声明面的执行器，这份目录
 * 以**官方文档/官方 TUI 实测**为事实源给出静态清单，让斜杠菜单达到与 TUI
 * 同等的可见性；执行仍按既有语义（"/name args" 原样透传给执行器/模型，
 * 适配器有原生分发机制的除外 —— 见各家 listCommands）。
 *
 * 维护约定：每家目录头注释锚定版本与事实源；执行器大版本升级时对照官方
 * 文档复核。描述用官方原文（英文），不在翻译里夹带私货。
 */
import type { NativeCommandInfo } from "../../contract.ts";

/** 目录条目（比 NativeCommandInfo 少 kind/source —— 统一切补） */
export interface BuiltinCommandDef {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
}

/**
 * codex —— 事实源：Codex CLI v0.162.1 TUI 斜杠面板本机截图（2026-10-15）。
 * 剔除纯 TUI 编辑器绑定的 /vim /keymap /ide（Web chat 没有对应物，列出来
 * 只会产生「按了没反应」的噪声）。
 */
const CODEX_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "init", description: "Create an AGENTS.md file with instructions for Codex" },
  { name: "status", description: "Show current session configuration" },
  { name: "permissions", description: "Choose what Codex is allowed to do" },
  { name: "model", description: "Choose what model and reasoning effort to use", argumentHint: "<model>" },
  { name: "review", description: "Review any changes and find issues" },
  { name: "fast", description: "Faster responses, increased usage" },
  { name: "setup-default-sandbox", description: "Set up elevated agent sandbox" },
  { name: "experimental", description: "Toggle experimental features" },
];

/**
 * grok —— 事实源：~/.grok/README.md（grok 1.0.52 自带官方文档）Slash Commands 表。
 * 剔除 /exit（杀 TUI 会话）与 /multiline（TUI 输入框模式）。
 */
const GROK_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "model", description: "Switch to a different model", argumentHint: "<name>", aliases: ["m"] },
  { name: "new", description: "Start a new session (clears context)" },
  { name: "load", description: "Load a previous session", argumentHint: "[workspace] [session]", aliases: ["resume"] },
  { name: "rewind", description: "Rewind to a previous prompt (restores files)", argumentHint: "<prompt>" },
  { name: "compact", description: "Compact conversation history" },
  { name: "always-approve", description: "Toggle auto-approve mode", argumentHint: "[on|off]", aliases: ["yolo"] },
  { name: "memory", description: "Browse, delete, and toggle memory", aliases: ["mem"] },
  { name: "remember", description: "Save a note to global memory", argumentHint: "<text>" },
  { name: "flush", description: "Wait for memory capture of finished turns" },
  { name: "dream", description: "Fold memory observations into topics now" },
  { name: "skills", description: "List skills or inject a skill into context", argumentHint: "[name]" },
  { name: "plugins", description: "Manage plugins (list, reload, trust)", argumentHint: "[list|reload|trust]", aliases: ["plugin"] },
  { name: "hooks-list", description: "Show hooks loaded in this session" },
  { name: "hooks-trust", description: "Trust this folder for hooks (writes folder trust)" },
  { name: "hooks-add", description: "Add a custom hook file or directory", argumentHint: "<path>" },
  { name: "feedback", description: "Report an issue or send feedback", argumentHint: "[message]" },
];

/**
 * claude —— 事实源：Claude Code 官方文档的内置命令集（2.x 长期稳定段）。
 * 只列 chat 语义存在的；terminal_slash_commands（exit / statusline /
 * terminal-setup / vim / ide）与 SDK 清单的隐藏口径一致，不在目录里。
 * 活会话可用时 SDK supportedCommands 的动态全量清单优先（见 claude.ts），
 * 这份目录只在无活会话的文件级兜底路径出现。
 */
const CLAUDE_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "add-dir", description: "Add a new working directory", argumentHint: "<path>" },
  { name: "agents", description: "Manage subagents (create/edit/list)" },
  { name: "bug", description: "Report bugs to Anthropic" },
  { name: "clear", description: "Clear conversation history and free up context" },
  { name: "compact", description: "Clear history but keep a summary in context" },
  { name: "config", description: "Open config panel" },
  { name: "cost", description: "Show the total cost and session duration" },
  { name: "doctor", description: "Check the health of your installation" },
  { name: "export", description: "Export the current conversation" },
  { name: "help", description: "Show help and available commands" },
  { name: "init", description: "Initialize a new AGENTS.md / CLAUDE.md here" },
  { name: "login", description: "Switch Anthropic accounts" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit CLAUDE.md memory files" },
  { name: "model", description: "Set the AI model for the session", argumentHint: "<model>" },
  { name: "permissions", description: "View and manage permission rules" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
  { name: "release-notes", description: "View release notes" },
  { name: "resume", description: "Resume a conversation" },
  { name: "review", description: "Review a pull request" },
  { name: "status", description: "Show version, model, account and connectivity" },
  { name: "todos", description: "View the current todo list" },
  { name: "usage", description: "Show plan usage limits" },
  { name: "rewind", description: "Restore code, conversation or both to an earlier point" },
];

/**
 * pi —— 事实源：@earendil-works/pi-coding-agent@1.2.0 官方 docs/slash-commands.md
 * （随包发布的本地文档）。剔除 /quit。技能经 /skill:name 触发（pi 官方约定）。
 */
const PI_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "settings", description: "Open settings" },
  { name: "model", description: "Select a model", argumentHint: "[provider/model]" },
  { name: "thinking", description: "Set the thinking level", argumentHint: "[level]" },
  { name: "scoped-models", description: "Configure the models used by interactive cycling" },
  { name: "login", description: "Add provider authentication", argumentHint: "[provider]" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Switch to another saved session" },
  { name: "name", description: "Set the session display name, or show the current name", argumentHint: "[name]" },
  { name: "session", description: "Show current session information and statistics" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "fork", description: "Create a new session from an earlier user message" },
  { name: "clone", description: "Duplicate the current session at its current position" },
  { name: "compact", description: "Compact the current context", argumentHint: "[instructions]" },
  { name: "import", description: "Import and resume a JSONL session", argumentHint: "<path>" },
  { name: "copy", description: "Copy the last assistant message" },
  { name: "export", description: "Export the session as HTML or JSONL", argumentHint: "[path]" },
  { name: "share", description: "Upload the session and return a viewer link" },
  { name: "bug", description: "Prepare a private bug report for the Pi developers", argumentHint: "[description]" },
  { name: "trust", description: "Save a project trust decision for future Pi processes" },
  { name: "reload", description: "Reload keybindings, extensions, skills, templates and themes" },
];

/**
 * dsh —— 事实源：@deepseek-harness-tui/dsh-tui@0.14.0 官方 guide（dsh-tui-guide/
 * interaction.md Slash Commands 章，随包发布的本地文档）。剔除 /vim /terminal-setup /exit。
 */
const DSH_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Open the session management view", aliases: ["home", "agentview"] },
  { name: "bg", description: "Background the current session and open session manager", aliases: ["background"] },
  { name: "rename", description: "Rename the current session" },
  { name: "recap", description: "Recent activity summary with a suggested title" },
  { name: "workspace", description: "Resume / rename / open the workspace", argumentHint: "resume|rename|open" },
  { name: "clear", description: "Clear the conversation" },
  { name: "compact", description: "Compact the context" },
  { name: "export", description: "Export the session" },
  { name: "btw", description: "Ask a side question without changing context" },
  { name: "trace", description: "Open the trajectory view" },
  { name: "rewind", description: "Time-travel back (same as double-Esc on empty input)" },
  { name: "context", description: "Show context window usage" },
  { name: "status", description: "Show session status" },
  { name: "cost", description: "Show session cost" },
  { name: "balance", description: "Show DeepSeek account balance" },
  { name: "config", description: "Show / edit configuration" },
  { name: "doctor", description: "Health check" },
  { name: "init", description: "Initialize AGENTS.md for the workspace" },
  { name: "agents", description: "Manage agents" },
  { name: "jobs", description: "Open the background tasks panel" },
  { name: "settings", description: "Open settings" },
  { name: "model", description: "Choose model" },
  { name: "effort", description: "Set reasoning effort (slider or direct)", argumentHint: "[id]" },
  { name: "thinking", description: "Configure thinking display" },
  { name: "tokens", description: "Show token usage" },
  { name: "preset", description: "Choose agent preset (Standard/PTC/…)", argumentHint: "<id>" },
  { name: "kernel", description: "Open the kernel selector (DSH / Claude / Codex)" },
  { name: "channel", description: "Open channel profile selector (Claude backend only)" },
  { name: "panel", description: "Side panel: toggle / focus / zoom / switch" },
  { name: "lang", description: "Switch UI language" },
  { name: "provider", description: "Open provider manager" },
  { name: "login", description: "Log in (e.g. /auth login deepseek-account)" },
  { name: "logout", description: "Log out" },
  { name: "permission", description: "Choose permission mode" },
  { name: "add-dir", description: "Add a workspace directory", argumentHint: "<path>" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "skills", description: "Browse skills found in profile / user / project dirs" },
  { name: "plan", description: "Plan mode (registry command)" },
  { name: "goal", description: "Manage the session goal (registry command)" },
  { name: "help", description: "Show help" },
];

/**
 * mcode（MiniMax Code）—— 事实源：@minimax-ai/code@0.6.8 安装包 chunks 内嵌的
 * 命令注册表（name/description 原文抽取，即当前安装版本的真实清单）。
 * 剔除 /allow /always /deny /decision（审批面板专属）、/quit、/statusline。
 */
const MCODE_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "add-dir", description: "Add a readable and writable workspace directory", argumentHint: "<path>" },
  { name: "archive", description: "Archive the active session" },
  { name: "changelog", description: "Show the packaged MCode update history" },
  { name: "checkin", description: "Claim the daily MiniMax account reward" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "config", description: "Show the effective read-only configuration" },
  { name: "context", description: "Show the Runtime-owned context snapshot" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "doctor", description: "Check the local config file" },
  { name: "export", description: "Export session (HTML default, or .html/.jsonl path)", argumentHint: "[path]" },
  { name: "feedback", description: "Review and submit redacted product feedback" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "goal", description: "Start or manage the current Session Goal" },
  { name: "help", description: "Show available commands" },
  { name: "hotkeys", description: "View and customize TUI keyboard shortcuts" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "login", description: "Sign in to use MiniMax Code Agent features" },
  { name: "logout", description: "Sign out of the shared Desktop account" },
  { name: "mcp", description: "Inspect MCP capabilities and project configuration" },
  { name: "miniapp", description: "Initialize, list, open or publish a Mini App", argumentHint: "<sub>" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "name", description: "Set session display name" },
  { name: "new", description: "Start a new session" },
  { name: "parent", description: "Return from a sub-agent session to its parent" },
  { name: "permission", description: "Choose or inspect the Runtime permission mode" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "session", description: "Show session info and stats" },
  { name: "settings", description: "Configure the MCode terminal interface" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "skill", description: "Load full SKILL.md instructions for a hosted/plugin skill", argumentHint: "<name>" },
  { name: "skills", description: "List built-in and user Skills" },
  { name: "status", description: "Show account and model status" },
  { name: "steer", description: "Steer current work without interrupting it" },
  { name: "stop", description: "Interrupt the running turn" },
  { name: "tasks", description: "Inspect background agents and Runtime tasks" },
  { name: "theme", description: "Choose the MCode color theme and terminal appearance" },
  { name: "transcript", description: "Browse, search, and inspect the full conversation" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "update", description: "Check for and install an MCode update" },
  { name: "usage", description: "Show session usage" },
];

/**
 * kimi（Kimi Code）—— 事实源：官方文档 moonshotai.github.io/kimi-code
 * reference/slash-commands（2.1.x）。官方语义：不匹配任何内置/Skill 命令的
 * "/" 输入会作为普通消息发给 Agent。剔除 /exit。
 */
const KIMI_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "login", description: "Select an account or platform and log in" },
  { name: "logout", description: "Clear credentials for the current account" },
  { name: "provider", description: "Open the interactive provider manager" },
  { name: "model", description: "Switch the LLM model used in the current session" },
  { name: "secondary-model", description: "Pick the default model for subagents", aliases: ["subagent-model"] },
  { name: "settings", description: "Open the settings panel inside the TUI", aliases: ["config"] },
  { name: "experiments", description: "Open the experimental feature panel", aliases: ["experimental"] },
  { name: "permission", description: "Select a permission mode" },
  { name: "new", description: "Start a fresh session, discarding current context", aliases: ["clear"] },
  { name: "sessions", description: "Browse historical sessions and switch/restore", aliases: ["resume"] },
  { name: "tasks", description: "Browse the background task list", aliases: ["task"] },
  { name: "fork", description: "Fork a new session preserving full history" },
  { name: "title", description: "Show or set the session title (max 200 chars)", argumentHint: "[<text>]", aliases: ["rename"] },
  { name: "compact", description: "Compact context to free tokens", argumentHint: "[<instruction>]" },
  { name: "undo", description: "Undo recent prompts from current context", argumentHint: "[<count>]" },
  { name: "reload", description: "Reload session with latest config.toml / tui.toml" },
  { name: "init", description: "Analyze the codebase and generate AGENTS.md" },
  { name: "export-md", description: "Export the current session as Markdown", argumentHint: "[<path>]", aliases: ["export"] },
  { name: "export-debug-zip", description: "Export the session as a debug ZIP archive" },
  { name: "copy", description: "Copy the last assistant message to the clipboard" },
  { name: "add-dir", description: "Add an extra workspace directory", argumentHint: "[<path>]" },
  { name: "web", description: "Open the session in the web UI" },
  { name: "yolo", description: "Ask-When-Needed mode: routine runs auto, risky still asks", argumentHint: "[on|off]", aliases: ["yes"] },
  { name: "auto", description: "Never-Ask mode: everything runs automatically", argumentHint: "[on|off]" },
  { name: "plan", description: "Toggle Plan mode", argumentHint: "[on|off|clear]" },
  { name: "swarm", description: "Turn swarm mode on/off (or run once with a task)", argumentHint: "on|off|<task>" },
  { name: "goal", description: "Start or manage an autonomous goal", argumentHint: "[status|pause|resume|cancel|replace <obj>|next <obj>]" },
  { name: "help", description: "Show keyboard shortcuts and all commands", aliases: ["h", "?"] },
  { name: "btw", description: "Side conversation in a forked sub-Agent", argumentHint: "[question]" },
  { name: "usage", description: "Show token usage, context and quota info" },
  { name: "status", description: "Show session runtime state (version/model/mode)" },
  { name: "mcp", description: "List MCP servers and connection status" },
  { name: "plugins", description: "Open the interactive plugin manager" },
  { name: "version", description: "Display the Kimi Code CLI version" },
  { name: "feedback", description: "Submit feedback with diagnostics", aliases: ["bug"] },
];

/**
 * openclaw —— 事实源：官方文档 docs.openclaw.ai slash-commands（2026.10）。
 * 工作台适配器是 **Gateway 直连**，聊天文本里的斜杠命令由 Gateway 拦截执行 ——
 * 透传即原生执行，这家的目录不只是「可见性」。剔除 /quit 类与频道独占命令。
 */
const OPENCLAW_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "new", description: "Archive the current session and start a fresh one", argumentHint: "[model]" },
  { name: "reset", description: "Reset the current session in place", argumentHint: "[soft [message]]" },
  { name: "name", description: "Name or rename the current session" },
  { name: "compact", description: "Compact the session context", argumentHint: "[instructions]" },
  { name: "stop", description: "Abort the current run" },
  { name: "export-session", description: "Export the current session to HTML", argumentHint: "[path]", aliases: ["export"] },
  { name: "export-trajectory", description: "Export a JSONL trajectory bundle", argumentHint: "[path]", aliases: ["trajectory"] },
  { name: "btw", description: "Ask a side question without changing session context", aliases: ["side"] },
  { name: "think", description: "Set the thinking level", aliases: ["thinking", "t"] },
  { name: "verbose", description: "Toggle verbose output", argumentHint: "on|off|full", aliases: ["v"] },
  { name: "reasoning", description: "Toggle reasoning visibility", argumentHint: "on|off|stream", aliases: ["reason"] },
  { name: "fast", description: "Show, set, or clear fast mode", argumentHint: "[status|auto|on|off|default]" },
  { name: "elevated", description: "Toggle elevated mode", argumentHint: "on|off|ask|full", aliases: ["elev"] },
  { name: "model", description: "Show or set the model", argumentHint: "[name|#|status]" },
  { name: "models", description: "List configured providers or models", argumentHint: "[provider]" },
  { name: "queue", description: "Manage active-run queue behavior" },
  { name: "steer", description: "Inject guidance into the active run", aliases: ["tell"] },
  { name: "status", description: "Execution/runtime status, uptime, plugin health" },
  { name: "usage", description: "Per-response usage footer or cost summary", argumentHint: "off|tokens|full|cost" },
  { name: "context", description: "Context window breakdown", argumentHint: "[list|detail|json]" },
  { name: "help", description: "Show the short help summary" },
  { name: "commands", description: "Show the generated command catalog" },
  { name: "whoami", description: "Show your sender id", aliases: ["id"] },
  { name: "skill", description: "Run a skill by name", argumentHint: "<name> [input]" },
  { name: "learn", description: "Draft a reviewable skill from this conversation", argumentHint: "[request]" },
  { name: "subagents", description: "Inspect/control sub-agent runs", argumentHint: "list|kill|log|info|send|steer|spawn" },
  { name: "agents", description: "List thread-bound agents for this session" },
  { name: "kill", description: "Abort one or all running sub-agents" },
  { name: "goal", description: "Manage a long-lived session goal", argumentHint: "[status]" },
  { name: "memory", description: "View or manage persistent memory", argumentHint: "[add|clear]" },
  { name: "tts", description: "Control text-to-speech", argumentHint: "on|off|always|status" },
  { name: "activation", description: "Group activation mode", argumentHint: "mention|always" },
  { name: "update", description: "Update OpenClaw from chat" },
  { name: "restart", description: "Restart the OpenClaw gateway" },
];

/**
 * cursor —— 事实源：官方参考 cursor.com/docs/cli/reference/slash-commands
 * （2026-10 镜像核对）。ACP 通道有一批**远程可透传**命令（compress/model/fork/
 * add-dir/context 等，官方 ACP 集成文档列明），经 chat 发送即真执行；
 * TUI 专属（/vim /config /setup-terminal 等）不列。
 */
const CURSOR_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "clear", description: "Start a new chat session", aliases: ["new", "new-chat", "newchat"] },
  { name: "resume", description: "Open recent chats and resume one" },
  { name: "fork", description: "Fork the current chat into a new session (ACP pass-through)" },
  { name: "rename", description: "Rename the current chat session" },
  { name: "rewind", description: "Jump back to a previous message" },
  { name: "summarize", description: "Summarize the conversation to reduce context", aliases: ["compress"] },
  { name: "copy", description: "Copy a previous user message to the clipboard" },
  { name: "open", description: "Open the repo's Git root in the Cursor editor", aliases: ["cursor"] },
  { name: "model", description: "Select a model (ACP pass-through)", argumentHint: "[filter]" },
  { name: "plan", description: "Switch to Plan mode or submit a prompt in Plan mode", argumentHint: "[prompt]" },
  { name: "ask", description: "Toggle Ask mode for read-only questions" },
  { name: "debug", description: "Toggle Debug mode or submit a prompt in Debug mode", argumentHint: "[prompt]" },
  { name: "goal", description: "Give the agent a long-lived objective", argumentHint: "[objective]" },
  { name: "run-everything", description: "Toggle Run Everything (no per-command approval)", argumentHint: "[on|off|status]", aliases: ["auto-run"] },
  { name: "max-mode", description: "Toggle Max Mode on legacy request-based plans" },
  { name: "sandbox", description: "Configure sandbox mode and network access" },
  { name: "shell", description: "Enter Shell Mode and run a command directly", argumentHint: "[command]", aliases: ["sh", "run"] },
  { name: "mcp", description: "Manage MCP servers and list tools", argumentHint: "[list|list-tools] [id]" },
  { name: "plugin", description: "Manage plugins and marketplaces" },
  { name: "add-dir", description: "Add a workspace folder (ACP pass-through)", argumentHint: "<path>" },
  { name: "context", description: "Show context usage (ACP pass-through)" },
  { name: "about", description: "Show CLI version, system and account info" },
  { name: "logs", description: "Show the debug log path and copy it" },
  { name: "update", description: "Update the CLI to the latest version" },
  { name: "help", description: "Show help, or details for one command", argumentHint: "[command]" },
  { name: "feedback", description: "Send feedback to the Cursor team" },
  { name: "logout", description: "Sign out" },
];

/**
 * hermes —— 事实源：本机安装的 hermes-agent 0.20.0 源码 gateway/slash_commands.py
 * （52 个官方 handler，docstring 首行即描述；命令名按 handler 名归一）。
 * 剔除 /platform /topic /voice（平台绑定）。这些命令在 gateway 层分发，
 * ACP 入口是否拦截未验证 —— 透传语义。
 */
const HERMES_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "new", description: "Start a new session (reset context)", aliases: ["reset"] },
  { name: "resume", description: "List or switch to a previous session" },
  { name: "sessions", description: "List previous sessions" },
  { name: "branch", description: "Fork the current session into an independent copy", argumentHint: "[name]" },
  { name: "title", description: "Set or show the current session's title" },
  { name: "undo", description: "Back up N user turns (default 1)", argumentHint: "[N]" },
  { name: "retry", description: "Re-send the last user message" },
  { name: "stop", description: "Interrupt a running agent" },
  { name: "background", description: "Run a prompt in a separate background session", argumentHint: "<prompt>" },
  { name: "model", description: "Switch model (interactive picker or by name)" },
  { name: "reasoning", description: "Manage reasoning effort and display toggle" },
  { name: "fast", description: "Mirror the CLI Priority Processing toggle" },
  { name: "yolo", description: "Toggle dangerous-command approval bypass (this session only)" },
  { name: "approve", description: "Unblock waiting agent thread(s)" },
  { name: "deny", description: "Reject pending dangerous command(s)" },
  { name: "approvals", description: "Show or persist the dangerous-command approval mode" },
  { name: "compress", description: "Compact the conversation context" },
  { name: "context", description: "Dedicated context-window view" },
  { name: "usage", description: "Show token usage for the current session" },
  { name: "status", description: "Show session/agent status" },
  { name: "diff", description: "Show git changes in the working directory" },
  { name: "goal", description: "Manage the session goal", argumentHint: "[status|pause|resume|cancel]" },
  { name: "subgoal", description: "Manage sub-goals appended to the active goal" },
  { name: "heartbeat", description: "Set/manage the session's recurring heartbeat" },
  { name: "memory", description: "Review pending memory writes + toggle approval gate" },
  { name: "skills", description: "Pending skill-write review" },
  { name: "bundles", description: "List installed skill bundles" },
  { name: "refine", description: "Run the memory/skill review fork on demand" },
  { name: "reload-skills", description: "Rescan skills dir" },
  { name: "reload-mcp", description: "Reconnect MCP servers and rebuild the agent" },
  { name: "agents", description: "List active agents and running tasks" },
  { name: "kanban", description: "Delegate to the shared kanban CLI" },
  { name: "insights", description: "Show usage insights and analytics" },
  { name: "personality", description: "List or set a personality" },
  { name: "profile", description: "Show the profile serving this source" },
  { name: "version", description: "Show the running Hermes Agent version" },
  { name: "update", description: "Update Hermes Agent to the latest version" },
  { name: "restart", description: "Drain active work, then restart the gateway" },
  { name: "debug", description: "Upload debug report and return paste URLs" },
  { name: "whoami", description: "Show your slash command access on this scope" },
  { name: "help", description: "List available commands" },
];

/**
 * agy（Antigravity CLI）—— 事实源：antigravity.google 官方 CLI 文档 +
 * v1.3.4 社区核对表（2026-10 交叉验证）。剔除 /exit /quit。
 */
const AGY_BUILTINS: readonly BuiltinCommandDef[] = [
  { name: "help", description: "Show help (also ? on empty prompt)" },
  { name: "codesearch", description: "Search code", aliases: ["cs", "search"] },
  { name: "config", description: "Open settings", aliases: ["settings"] },
  { name: "permissions", description: "Switch permission preset (request-review/sandbox/always/strict)" },
  { name: "model", description: "Choose model (Gemini/Claude/GPT-OSS lineup)" },
  { name: "effort", description: "Set reasoning effort", argumentHint: "<level>" },
  { name: "plan", description: "Plan mode (or Shift+Tab)" },
  { name: "goal", description: "Run autonomously until the task is fully finished" },
  { name: "boost", description: "Deep reasoning mode" },
  { name: "grill-me", description: "Interview to align on design decisions first" },
  { name: "learn", description: "Teach the agent new workflows persistently" },
  { name: "schedule", description: "Run as one-time timer or recurring schedule" },
  { name: "browser", description: "Control browser debugging in Chrome" },
  { name: "plugin", description: "Manage Marketplace plugins" },
  { name: "teamwork-preview", description: "Agent team preview" },
  { name: "voice", description: "Voice dictation", aliases: ["record"] },
  { name: "skills", description: "Manage skills (reload with 'skills reload')" },
  { name: "agents", description: "Open the custom agents panel" },
  { name: "tasks", description: "Show task logs" },
  { name: "mcp", description: "Open the MCP manager" },
  { name: "hooks", description: "Manage hooks" },
  { name: "diff", description: "Show diffs (also Ctrl+R)" },
  { name: "copy", description: "Copy an earlier response" },
  { name: "resume", description: "Resume conversation" },
  { name: "rewind", description: "Rewind conversation", aliases: ["undo"] },
  { name: "fork", description: "Fork conversation", aliases: ["branch"] },
  { name: "add-dir", description: "Add workspace folder", argumentHint: "<path>" },
  { name: "usage", description: "Show quota usage", aliases: ["quota"] },
  { name: "remote-control", description: "Connect to the current session remotely" },
  { name: "logout", description: "Log out" },
];

const CATALOGS: Readonly<Record<string, readonly BuiltinCommandDef[]>> = {
  codex: CODEX_BUILTINS,
  grok: GROK_BUILTINS,
  claude: CLAUDE_BUILTINS,
  pi: PI_BUILTINS,
  dsh: DSH_BUILTINS,
  mcode: MCODE_BUILTINS,
  kimi: KIMI_BUILTINS,
  openclaw: OPENCLAW_BUILTINS,
  cursor: CURSOR_BUILTINS,
  hermes: HERMES_BUILTINS,
  agy: AGY_BUILTINS,
};

const catalogCache = new Map<string, readonly NativeCommandInfo[]>();

/** 取某执行器的内置目录（→ NativeCommandInfo，builtin 段）。未知执行器返回 []。 */
export function builtinCommandsFor(id: string): readonly NativeCommandInfo[] {
  const hit = catalogCache.get(id);
  if (hit !== undefined) return hit;
  const defs = CATALOGS[id];
  if (defs === undefined) return [];
  const out = defs.map((d) => ({
    name: d.name,
    description: d.description,
    argumentHint: d.argumentHint,
    aliases: d.aliases,
    builtin: true,
    source: "builtin" as const,
    kind: "command" as const,
  }));
  catalogCache.set(id, out);
  return out;
}
