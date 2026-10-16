/**
 * 五家执行器的 MCP 配置读写适配 —— 每家一个 def，自带「读清单 / 定点写一条 / 定点删一条」
 * 三个纯文本变换函数。生效载体与真相源 = 执行器原生配置文件（ADR 0004）。
 *
 * - claude：~/.claude.json 顶层 mcpServers（大杂烩文件，必须单键外科手术）
 * - codex：~/.codex/config.toml 的 [mcp_servers.*]（TOML 定点段编辑，保注释；
 *   不写 type 字段、stdio/http 字段严格分侧 —— cc-switch 实测：混写会让
 *   Codex 拒绝加载整份 config.toml）
 * - agy/gemini：~/.gemini/settings.json 顶层 mcpServers
 * - opencode：~/.config/opencode/opencode.json 顶层 mcp（local/remote 形态，
 *   command+args 合并为数组、env→environment —— cc-switch mcp/opencode.rs 转换表）
 * - zcode：~/.zcode/cli/config.json 的 mcp.servers 嵌套键（上游 mcpSyncService 同款）
 *
 * Windows cmd /c 包装（service 层统一做，全部 stdio 执行器一个口径）：
 * npx/npm/... 这类 .cmd shim 不包会触发 Claude /doctor 警告、部分 CLI 直接
 * spawn 失败；读取侧拆包防双重包裹（借鉴 cc-switch claude_mcp.rs）。
 */
import type { McpServerEntry } from "../contract.ts";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";
import { readTomlEntries, upsertTomlEntry, removeTomlEntry } from "./toml.ts";
import { readYamlEntries, upsertYamlEntry, removeYamlEntry } from "./yamledit.ts";

/**
 * Hermes 配置路径：显式注入的 configHome（冒烟）→ HERMES_HOME env →
 * Windows %LOCALAPPDATA%\hermes → ~/.hermes（hermes_constants.py 的平台默认）。
 * 注入优先于 env：这台机器常见 HERMES_HOME 常驻，注入目录不抢先的话
 * 冒烟会静默读写真实配置。
 */
function hermesConfigPath(configHome: string): string {
  if (configHome !== homedir()) return joinPath(configHome, "hermes", "config.yaml");
  const envHome = process.env["HERMES_HOME"];
  if (envHome !== undefined && envHome !== "") return joinPath(envHome, "config.yaml");
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? joinPath(homedir(), "AppData", "Local");
    return joinPath(local, "hermes", "config.yaml");
  }
  return joinPath(homedir(), ".hermes", "config.yaml");
}

export interface McpExecutorDef {
  readonly id: string;
  readonly name: string;
  /** 配置文件路径；home 可注入（冒烟用临时家目录，不动真实配置） */
  configPath(configHome: string): string;
  /** 文件不存在时新建用的种子文本（JSON 系 "{}"，TOML/YAML 空串） */
  readonly emptySeed: string;
  /** 读清单（解析失败抛 code=parse_error，绝不静默当空 —— fail-stop 铁律） */
  readServers(text: string): Map<string, McpServerEntry>;
  /** 定点写一条（只动本条目，其余内容含注释原样保留） */
  writeServer(text: string, entry: McpServerEntry): string;
  /** 定点删一条 */
  removeServer(text: string, name: string): string;
  /** 该执行器不支持的传输形态（保存前拒绝 —— 比写出去被 CLI 拒载整份配置友好） */
  readonly disallowedTransports?: readonly McpServerEntry["transport"][];
}

const WRAP_CMDS = new Set(["npx", "npm", "yarn", "pnpm", "node", "bun", "bunx", "deno"]);

/** cmd /c 包装只对 Windows 有意义（.cmd shim 解析）；其他平台包了反而起不来 */
const IS_WIN = process.platform === "win32";

export function wrapCmd(entry: McpServerEntry): McpServerEntry {
  if (!IS_WIN || entry.transport !== "stdio" || entry.command === undefined) return entry;
  if (!WRAP_CMDS.has(entry.command.toLowerCase())) return entry;
  return { ...entry, command: "cmd", args: ["/c", entry.command, ...(entry.args ?? [])] };
}

/**
 * 拆包只认「包的是我们认的 shim 命令」（npx/node/…，容忍 .cmd/.exe 后缀）：
 * `cmd /c mytool.cmd` 是用户自己选的启动方式，拆了再写回去就丢了包装，
 * Windows 上直接起 .cmd 会 ENOENT。
 */
export function unwrapCmd(entry: McpServerEntry): McpServerEntry {
  if (!IS_WIN || entry.transport !== "stdio" || entry.command === undefined) return entry;
  const cmd = entry.command.toLowerCase();
  const args = entry.args ?? [];
  if (cmd !== "cmd" && cmd !== "cmd.exe") return entry;
  if (args[0]?.toLowerCase() !== "/c" || args[1] === undefined) return entry;
  const inner = args[1]!.toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (!WRAP_CMDS.has(inner)) return entry;
  return { ...entry, command: args[1]!, args: args.slice(2) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}
function strMap(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- JSON 系通用件（claude / agy / opencode / zcode）----

function parseJsonRoot(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`), { code: "parse_error" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("配置根不是 JSON 对象"), { code: "parse_error" });
  }
  return parsed as Record<string, unknown>;
}

/** 沿键路径取条目表；中间层缺失返回 undefined（读侧容忍），类型不对抛 parse_error */
function serversObject(root: Record<string, unknown>, keyPath: readonly string[], mode: "read" | "write"): Record<string, unknown> | undefined {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keyPath.length; i++) {
    const k = keyPath[i]!;
    const next = cur[k];
    if (next === undefined) {
      if (mode === "write") cur[k] = {}; // 写侧按需建中间层
      else return undefined;
    } else if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw Object.assign(new Error(`键路径 ${keyPath.join(".")} 上有非对象值`), { code: "parse_error" });
    }
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

function jsonReadServers(
  keyPath: readonly string[],
  toCanonical: (name: string, raw: Record<string, unknown>) => McpServerEntry | null,
): (text: string) => Map<string, McpServerEntry> {
  return (text) => {
    const root = parseJsonRoot(text);
    const servers = serversObject(root, keyPath, "read");
    const out = new Map<string, McpServerEntry>();
    if (servers === undefined) return out;
    for (const [name, raw] of Object.entries(servers)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue; // 非对象条目不进清单
      const e = toCanonical(name, raw as Record<string, unknown>);
      if (e !== null) out.set(name, e);
    }
    return out;
  };
}

function jsonUpsert(
  keyPath: readonly string[],
  fromCanonical: (entry: McpServerEntry) => Record<string, unknown>,
): (text: string, entry: McpServerEntry) => string {
  return (text, entry) => {
    const root = parseJsonRoot(text);
    const servers = serversObject(root, keyPath, "write")!;
    const existing = servers[entry.name];
    const fresh = fromCanonical(entry);
    // 编辑时保留条目上我们不认识的键（用户手加的扩展字段不丢）
    let merged = fresh;
    if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      const known = new Set(Object.keys(fresh));
      merged = { ...fresh };
      for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
        if (!known.has(k)) merged[k] = v;
      }
    }
    servers[entry.name] = merged;
    return JSON.stringify(root, null, 2) + "\n";
  };
}

function jsonRemove(keyPath: readonly string[]): (text: string, name: string) => string {
  return (text, name) => {
    const root = parseJsonRoot(text);
    const servers = serversObject(root, keyPath, "read");
    if (servers !== undefined) delete servers[name];
    return JSON.stringify(root, null, 2) + "\n";
  };
}

// ---- claude / gemini 原生形态（type + command/args/env 或 url/headers）----

function claudeLikeToCanonical(name: string, raw: Record<string, unknown>): McpServerEntry | null {
  const command = str(raw.command);
  const url = str(raw.url);
  if (command === undefined && url === undefined) return null;
  const declared = str(raw.type);
  const transport: McpServerEntry["transport"] =
    declared === "http" || declared === "sse" ? declared : command !== undefined ? "stdio" : "http";
  return {
    name,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(strArray(raw.args) !== undefined ? { args: strArray(raw.args) } : {}),
    ...(strMap(raw.env) !== undefined ? { env: strMap(raw.env) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(strMap(raw.headers) !== undefined ? { headers: strMap(raw.headers) } : {}),
  };
}

function claudeLikeFromCanonical(entry: McpServerEntry): Record<string, unknown> {
  return {
    type: entry.transport,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined && entry.args.length > 0 ? { args: [...entry.args] } : {}),
    ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.headers !== undefined ? { headers: { ...entry.headers } } : {}),
  };
}

export const MCP_EXECUTORS: readonly McpExecutorDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    configPath: (home) => joinPath(home, ".claude.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcpServers"], (n, raw) => claudeLikeToCanonical(n, raw)),
    writeServer: jsonUpsert(["mcpServers"], claudeLikeFromCanonical),
    removeServer: jsonRemove(["mcpServers"]),
  },
  {
    id: "codex",
    name: "Codex CLI",
    configPath: (home) => joinPath(home, ".codex", "config.toml"),
    emptySeed: "",
    // cmd /c 包装/拆包统一在 service 层做（所有执行器一个口径），这里保持纯形态转换
    readServers: (text) => readTomlEntries(text),
    writeServer: (text, entry) => upsertTomlEntry(text, entry),
    removeServer: removeTomlEntry,
  },
  {
    id: "agy",
    name: "Antigravity (Gemini)",
    configPath: (home) => joinPath(home, ".gemini", "settings.json"),
    emptySeed: "{}",
    // gemini-cli 的 remote 字段是 httpUrl / sseUrl（上游文档口径）；读侧兼容旧通用 url
    readServers: jsonReadServers(["mcpServers"], (name, raw) => {
      const httpUrl = str(raw.httpUrl);
      const sseUrl = str(raw.sseUrl);
      const genericUrl = str(raw.url);
      if (httpUrl === undefined && sseUrl === undefined) {
        if (genericUrl === undefined) return claudeLikeToCanonical(name, raw); // stdio 走通用解析
        return { name, transport: "http", url: genericUrl };
      }
      const url = httpUrl ?? sseUrl!;
      return {
        name,
        transport: httpUrl !== undefined ? "http" : "sse",
        url,
        ...(strMap(raw.headers) !== undefined ? { headers: strMap(raw.headers) } : {}),
      };
    }),
    writeServer: jsonUpsert(["mcpServers"], (entry) => {
      // gemini 按字段自判传输，不写 type（stdio: command/args/env；remote: httpUrl/sseUrl）
      if (entry.transport === "stdio") {
        return {
          ...(entry.command !== undefined ? { command: entry.command } : {}),
          ...(entry.args !== undefined && entry.args.length > 0 ? { args: [...entry.args] } : {}),
          ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
        };
      }
      return {
        [entry.transport === "http" ? "httpUrl" : "sseUrl"]: entry.url ?? "",
        ...(entry.headers !== undefined ? { headers: { ...entry.headers } } : {}),
      };
    }),
    removeServer: jsonRemove(["mcpServers"]),
  },
  {
    id: "opencode",
    name: "OpenCode",
    configPath: (home) => joinPath(home, ".config", "opencode", "opencode.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcp"], (name, raw) => {
      // local：command 数组拆 command+args，environment→env；remote：url
      if (raw.type === "remote" || str(raw.url) !== undefined) {
        const url = str(raw.url);
        if (url === undefined) return null;
        return { name, transport: "http", url, ...(strMap(raw.headers) !== undefined ? { headers: strMap(raw.headers) } : {}) };
      }
      const cmdArr = strArray(raw.command);
      if (cmdArr === undefined || cmdArr.length === 0) return null;
      return {
        name,
        transport: "stdio",
        command: cmdArr[0],
        ...(cmdArr.length > 1 ? { args: cmdArr.slice(1) } : {}),
        ...(strMap(raw.environment) !== undefined ? { env: strMap(raw.environment) } : {}),
      };
    }),
    writeServer: jsonUpsert(["mcp"], (entry) => {
      if (entry.transport === "stdio") {
        return {
          type: "local",
          command: [entry.command ?? "", ...(entry.args ?? [])],
          ...(entry.env !== undefined ? { environment: { ...entry.env } } : {}),
        };
      }
      return {
        type: "remote",
        url: entry.url ?? "",
        ...(entry.headers !== undefined ? { headers: { ...entry.headers } } : {}),
      };
    }),
    removeServer: jsonRemove(["mcp"]),
  },
  {
    id: "zcode",
    name: "ZCode",
    configPath: (home) => joinPath(home, ".zcode", "cli", "config.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcp", "servers"], (name, raw) => {
      const e = claudeLikeToCanonical(name, raw);
      if (e === null) return null;
      // 上游 ZCode 认 streamableHttp；统一形态里归一为 http
      return e.transport === "stdio" ? e : { ...e, transport: "http" };
    }),
    writeServer: jsonUpsert(["mcp", "servers"], claudeLikeFromCanonical),
    removeServer: jsonRemove(["mcp", "servers"]),
    // ZCode 上游 McpServerConfig 认 stdio/http/sse/streamableHttp —— 全支持
  },

  // ---- 第二批：ACP 系与其余 CLI（各源码逐一查证，见各条注释里的依据） ----

  {
    // minimax-code: runtime/config-file.ts 读 dataDir/mcp.json 顶层 mcpServers；
    // type 可为 http/streamable-http（读侧归一），条目扩展键（enabled/configured/timeout…）
    // 由 jsonUpsert 的未知键保留机制原样存活
    id: "mcode",
    name: "MiniMax Code",
    configPath: (home) => joinPath(home, ".minimax", "mcp.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcpServers"], (name, raw) => {
      const declared = str(raw.type);
      if (declared === "streamable-http" || declared === "streamableHttp") {
        const url = str(raw.url);
        return url === undefined ? null : { name, transport: "http", url, ...(strMap(raw.headers) !== undefined ? { headers: strMap(raw.headers) } : {}) };
      }
      return claudeLikeToCanonical(name, raw);
    }),
    writeServer: jsonUpsert(["mcpServers"], (e) => claudeLikeFromCanonical(e.transport === "stdio" ? e : { ...e, transport: "http" })),
    removeServer: jsonRemove(["mcpServers"]),
  },
  {
    // kimi-code: app/mcpConfig/configLoader.ts 读 ~/.kimi-code/mcp.json 顶层 mcpServers；
    // 字段名是 transport（不是 type！），stdio/http/sse 三态显式声明
    id: "kimi",
    name: "Kimi Code",
    configPath: (home) => joinPath(home, ".kimi-code", "mcp.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcpServers"], (name, raw) => {
      const declared = str(raw.transport) ?? str(raw.type);
      const command = str(raw.command);
      const url = str(raw.url);
      if (command === undefined && url === undefined) return null;
      const transport: McpServerEntry["transport"] =
        declared === "http" || declared === "sse" ? declared : command !== undefined ? "stdio" : "http";
      return {
        name,
        transport,
        ...(command !== undefined ? { command } : {}),
        ...(strArray(raw.args) !== undefined ? { args: strArray(raw.args) } : {}),
        ...(strMap(raw.env) !== undefined ? { env: strMap(raw.env) } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(strMap(raw.headers) !== undefined ? { headers: strMap(raw.headers) } : {}),
      };
    }),
    writeServer: jsonUpsert(["mcpServers"], (entry) => ({
      transport: entry.transport,
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.args !== undefined && entry.args.length > 0 ? { args: [...entry.args] } : {}),
      ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.headers !== undefined ? { headers: { ...entry.headers } } : {}),
    })),
    removeServer: jsonRemove(["mcpServers"]),
  },
  {
    // grok-build: xai-grok-config mcp_server_config.rs —— 与 codex 同构的
    // [mcp_servers.x] TOML，但请求头键是 headers（非 http_headers）、不写 type、无 sse
    id: "grok",
    name: "Grok Build",
    configPath: (home) => joinPath(home, ".grok", "config.toml"),
    emptySeed: "",
    readServers: (text) => readTomlEntries(text),
    writeServer: (text, entry) => upsertTomlEntry(text, entry, { headersKey: "headers" }),
    removeServer: removeTomlEntry,
    disallowedTransports: ["sse"],
  },
  {
    // pi: packages/coding-agent extensions/mcp/config.ts 读 agentDir/mcp.json 顶层
    // mcpServers（claude 同形）；MCP 明确拒绝 SSE（core/mcp-servers.ts）
    id: "pi",
    name: "pi",
    configPath: (home) => joinPath(home, ".pi", "agent", "mcp.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcpServers"], (name, raw) => {
      const e = claudeLikeToCanonical(name, raw);
      return e === null ? null : e.transport === "sse" ? { ...e, transport: "http" } : e;
    }),
    writeServer: jsonUpsert(["mcpServers"], (e) => claudeLikeFromCanonical(e.transport === "sse" ? { ...e, transport: "http" } : e)),
    removeServer: jsonRemove(["mcpServers"]),
    disallowedTransports: ["sse"],
  },
  {
    // hermes: hermes_cli/config.py —— home 在 Windows 是 %LOCALAPPDATA%\hermes
    //（测试经 HERMES_HOME env 注入），config.yaml 顶层 mcp_servers，无 type 推断式
    id: "hermes",
    name: "Hermes",
    configPath: (home) => hermesConfigPath(home),
    emptySeed: "",
    readServers: (text) => readYamlEntries(text),
    writeServer: (text, entry) => upsertYamlEntry(text, entry),
    removeServer: removeYamlEntry,
    disallowedTransports: ["sse"],
  },
  {
    // openclaw: src/config/types.openclaw.ts —— 顶层 mcp.servers 嵌套（zcode 同形），
    // JSON/JSON5 均可（含注释的 JSON5 会 parse_error fail-stop，用户手改一次即可）；
    // 条目原生 enabled 字段属于未知键，编辑时原样保留
    id: "openclaw",
    name: "OpenClaw",
    configPath: (home) => joinPath(home, ".openclaw", "openclaw.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcp", "servers"], (name, raw) => claudeLikeToCanonical(name, raw)),
    writeServer: jsonUpsert(["mcp", "servers"], claudeLikeFromCanonical),
    removeServer: jsonRemove(["mcp", "servers"]),
  },
  {
    // cursor: ~/.cursor/mcp.json 顶层 mcpServers（claude 同形）
    id: "cursor",
    name: "Cursor",
    configPath: (home) => joinPath(home, ".cursor", "mcp.json"),
    emptySeed: "{}",
    readServers: jsonReadServers(["mcpServers"], claudeLikeToCanonical),
    writeServer: jsonUpsert(["mcpServers"], claudeLikeFromCanonical),
    removeServer: jsonRemove(["mcpServers"]),
  },
];

/** 无持久化 MCP 配置面的执行器（UI 展示说明用）：
 * dsh 的 MCP 走 ACP session/new 参数（per-session，不落盘）；
 * sdk-bridge 是 Cursor SDK 桥协议，MCP 在 CreateAgent/SendOptions 里带内传递 */
export const MCP_UNSUPPORTED_EXECUTORS: readonly { id: string; name: string; reason: string }[] = [
  { id: "dsh", name: "DeepSeek Harness", reason: "MCP 随 ACP 会话参数注入（per-session），无持久化配置文件" },
  { id: "sdk-bridge", name: "Cursor SDK Bridge", reason: "MCP 在协议调用时带内传递（CreateAgent/SendOptions），无配置文件" },
];

export function findExecutorDef(id: string): McpExecutorDef {
  const def = MCP_EXECUTORS.find((d) => d.id === id);
  if (def === undefined) {
    throw Object.assign(new Error(`unknown mcp executor: ${id}`), { code: "unknown_executor" });
  }
  return def;
}
