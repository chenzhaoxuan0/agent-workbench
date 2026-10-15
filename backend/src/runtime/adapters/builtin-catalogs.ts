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

const CATALOGS: Readonly<Record<string, readonly BuiltinCommandDef[]>> = {
  codex: CODEX_BUILTINS,
  grok: GROK_BUILTINS,
  claude: CLAUDE_BUILTINS,
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
