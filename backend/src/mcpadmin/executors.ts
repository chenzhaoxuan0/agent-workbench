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
 * Windows cmd /c 包装（claude/codex 写入侧）：npx/npm/... 这类 .cmd shim 不包会触发
 * Claude /doctor 警告；读取侧拆包防双重包裹（借鉴 cc-switch claude_mcp.rs）。
 */
import type { McpServerEntry } from "../contract.ts";
import { join as joinPath } from "node:path";
import { readTomlEntries, upsertTomlEntry, removeTomlEntry } from "./toml.ts";

export interface McpExecutorDef {
  readonly id: string;
  readonly name: string;
  /** 配置文件路径；home 可注入（冒烟用临时家目录，不动真实配置） */
  configPath(configHome: string): string;
  /** 文件不存在时新建用的种子文本（JSON 系 "{}"，TOML 空串） */
  readonly emptySeed: string;
  /** 读清单（解析失败抛 code=parse_error，绝不静默当空 —— fail-stop 铁律） */
  readServers(text: string): Map<string, McpServerEntry>;
  /** 定点写一条（只动本条目，其余内容含注释原样保留） */
  writeServer(text: string, entry: McpServerEntry): string;
  /** 定点删一条 */
  removeServer(text: string, name: string): string;
}

const WRAP_CMDS = new Set(["npx", "npm", "yarn", "pnpm", "node", "bun", "bunx", "deno"]);

/** cmd /c 包装只对 Windows 有意义（.cmd shim 解析）；其他平台包了反而起不来 */
const IS_WIN = process.platform === "win32";

function wrapCmd(entry: McpServerEntry): McpServerEntry {
  if (!IS_WIN || entry.transport !== "stdio" || entry.command === undefined) return entry;
  if (!WRAP_CMDS.has(entry.command.toLowerCase())) return entry;
  return { ...entry, command: "cmd", args: ["/c", entry.command, ...(entry.args ?? [])] };
}

function unwrapCmd(entry: McpServerEntry): McpServerEntry {
  if (!IS_WIN || entry.transport !== "stdio" || entry.command === undefined) return entry;
  const cmd = entry.command.toLowerCase();
  const args = entry.args ?? [];
  if (cmd !== "cmd" && cmd !== "cmd.exe") return entry;
  if (args[0]?.toLowerCase() !== "/c" || args[1] === undefined) return entry;
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
    readServers: jsonReadServers(["mcpServers"], (n, raw) => {
      const e = claudeLikeToCanonical(n, raw);
      return e === null ? null : unwrapCmd(e);
    }),
    writeServer: jsonUpsert(["mcpServers"], (e) => claudeLikeFromCanonical(wrapCmd(e))),
    removeServer: jsonRemove(["mcpServers"]),
  },
  {
    id: "codex",
    name: "Codex CLI",
    configPath: (home) => joinPath(home, ".codex", "config.toml"),
    emptySeed: "",
    readServers: (text) => {
      const out = new Map<string, McpServerEntry>();
      for (const [k, v] of readTomlEntries(text)) out.set(k, unwrapCmd(v));
      return out;
    },
    writeServer: (text, entry) => upsertTomlEntry(text, wrapCmd(entry)),
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
  },
];

export function findExecutorDef(id: string): McpExecutorDef {
  const def = MCP_EXECUTORS.find((d) => d.id === id);
  if (def === undefined) {
    throw Object.assign(new Error(`unknown mcp executor: ${id}`), { code: "unknown_executor" });
  }
  return def;
}
