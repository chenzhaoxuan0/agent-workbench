/**
 * YAML mcp_servers 段编辑器（Hermes 专用形态）—— 与 toml.ts 同一纪律的缩进块版：
 * 只动 `mcp_servers:` 顶层键下目标条目的行区间，区间外（其他顶层键、注释、
 * 空行、EOL 风格）一字不改。
 *
 * Hermes 形态（hermes_cli/config.py + cli-config.yaml.example）：
 * - 顶层 `mcp_servers:` 映射，条目两空格缩进，字段四空格缩进
 * - 无 type 字段：有 command 即 stdio、有 url 即 http（读侧同规则）
 * - 条目可带 enabled/timeout/lazy 等扩展键 —— 编辑时原样保留（不在受管键集内）
 *
 * 已知边界（v1 接受）：条目级只解析浅层结构（标量 / flow 数组 / 一层块映射）；
 * anchors、多行块标量等深 YAML 不识别，遇该条目不进清单、写层只按名字定位段。
 */
import type { McpServerEntry } from "../contract.ts";

/** 我们管理的连接字段；条目内其余行（enabled/timeout/…）原字节保留 */
const MANAGED_KEYS = new Set(["command", "args", "env", "url", "headers"]);

/** 条目行（两空格缩进键）：`  name:` / `  'my srv':`（引号名）/ `  name: # 注` */
const ENTRY_LINE_RE = /^  ([^ \t#-][^:]*):(\s|$)/;

/** args 块列表项：`      - 值`（六空格缩进 + 短横线） */
const DASH_ITEM_RE = /^ {6}-\s?(.*)$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** YAML 标量序列化：安全字符裸写，否则单引号包裹（内部 ' 翻倍） */
function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(s) && s !== "" && !/^(true|false|null|~|-?\d+)$/i.test(s)) return s;
  return `'${s.replaceAll("'", "''")}'`;
}

function yamlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : yamlScalar(k);
}

/** 条目 → YAML 行组（两空格条目缩进起，含尾行换行符） */
function generateEntryLines(entry: McpServerEntry, eol: string, kept: readonly string[]): string {
  const lines: string[] = [`  ${yamlKey(entry.name)}:`];
  if (entry.transport === "stdio") {
    if (entry.command !== undefined) lines.push(`    command: ${yamlScalar(entry.command)}`);
    if (entry.args !== undefined && entry.args.length > 0) {
      lines.push(`    args: [${entry.args.map((a) => yamlScalar(a)).join(", ")}]`);
    }
    if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
      lines.push("    env:");
      for (const [k, v] of Object.entries(entry.env)) lines.push(`      ${yamlKey(k)}: ${yamlScalar(v)}`);
    }
  } else {
    if (entry.url !== undefined) lines.push(`    url: ${yamlScalar(entry.url)}`);
    if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) {
      lines.push("    headers:");
      for (const [k, v] of Object.entries(entry.headers)) lines.push(`      ${yamlKey(k)}: ${yamlScalar(v)}`);
    }
  }
  lines.push(...kept);
  return lines.join(eol) + eol;
}

interface YamlBlock {
  /** mcp_servers: 行的行首偏移 */
  readonly keyStart: number;
  /** 块终点（下一个顶层键行首或文件末尾） */
  readonly blockEnd: number;
}

/** 定位顶层 `mcp_servers:` 块；不存在返回 null。块尾 = 其后第一个顶层行行首 */
function findMcpBlock(text: string): YamlBlock | null {
  const lines = text.split("\n");
  let offset = 0;
  let keyStart = -1;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (keyStart === -1) {
      if (/^mcp_servers:\s*(#.*)?$/.test(bare)) keyStart = lineStart;
      continue;
    }
    if (bare.trim() !== "" && !bare.trim().startsWith("#") && /^[^ \t-]/.test(bare)) {
      return { keyStart, blockEnd: lineStart };
    }
  }
  return keyStart === -1 ? null : { keyStart, blockEnd: text.length };
}

/** 条目在块内的行区间：[条目行首, 下一条目行首或块尾]。返回 null = 不存在 */
function findEntryRange(text: string, block: YamlBlock, name: string): { start: number; end: number } | null {
  const body = text.slice(block.keyStart, block.blockEnd);
  const lines = body.split("\n");
  let offset = block.keyStart;
  let entryStart = -1;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const m = ENTRY_LINE_RE.exec(bare);
    if (m !== null) {
      if (entryStart !== -1) {
        // 遇到下一条目：上一条目区间结束
        return { start: entryStart, end: offset };
      }
      // 键要走标量解析比对：`'my srv':` 这类引号名按原文比对永远不命中，
      // 编辑会追加成重名条目、删除会静默变 no-op
      if (parseYamlScalar(m[1]!) === name) entryStart = offset;
    }
    offset += line.length + 1;
  }
  return entryStart === -1 ? null : { start: entryStart, end: block.blockEnd };
}

/**
 * 从条目旧块提取「编辑后必须活下来」的行 —— 标量行与整块，含行内注释。
 * 非受管键（enabled/timeout/…）恒保留；受管键（command/args/env/url/headers）
 * 只在**新条目没有提供**该字段时保留 —— 没提供通常意味着旧值解析不动
 * （args 是块式短横线列表、env 是 flow 映射），按旧逻辑丢弃等于把用户的
 * 连接参数静默删掉。保留的块键（值为空的行）其缩进子行一并保留。
 */
function collectKeptLines(entryText: string, entry: McpServerEntry): string[] {
  const lines = entryText.split("\n");
  const kept: string[] = [];
  let skippingBlockKey: string | null = null;
  for (const line of lines) {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const m = /^    ([^:]+):/.exec(bare);
    if (m !== null) {
      const key = m[1]!.trim().replace(/^["']|["']$/g, "");
      skippingBlockKey = null;
      const supplies =
        key === "command" ? entry.command !== undefined
          : key === "args" ? entry.args !== undefined
            : key === "env" ? entry.env !== undefined
              : key === "url" ? entry.url !== undefined
                : key === "headers" ? entry.headers !== undefined
                  : true;
      if (!MANAGED_KEYS.has(key) || !supplies) {
        kept.push(bare);
        if (/^    [^:]+:\s*$/.test(bare)) skippingBlockKey = key; // 块键（值为空）→ 其缩进子行也保留
      }
      continue;
    }
    if (skippingBlockKey !== null && /^ {6,}/.test(bare)) {
      kept.push(bare); // 保留块键的子行（args 短横线项 / 深层映射行）
    }
  }
  return kept;
}

// ---- 值的轻量解析（标量 / flow 数组 / 一层块映射） ----

function parseYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replaceAll("''", "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return v;
}

function parseFlowArray(raw: string): string[] | undefined {
  const v = raw.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return undefined;
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  // 按逗号切（元素是单引号串或裸标量；含逗号的元素请用块列表，v1 不支持）
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const s = part.trim();
    if (s === "") continue;
    out.push(parseYamlScalar(s));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 读全部条目。解析不出的条目不进清单（宁缺勿假）；transport 按字段推断。
 */
export function readYamlEntries(text: string): Map<string, McpServerEntry> {
  text = stripBom(text);
  const out = new Map<string, McpServerEntry>();
  const block = findMcpBlock(text);
  if (block === null) return out;

  const body = text.slice(block.keyStart, block.blockEnd);
  const lines = body.split("\n");
  interface Draft {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }
  let cur: Draft | null = null;
  let curKey: string | null = null; // 当前块键（env:/headers:）
  let inArgsList = false; // 当前在 args: 的块式短横线列表里
  const flush = (): void => {
    if (cur === null) return;
    if (cur.command !== undefined || cur.url !== undefined) {
      out.set(cur.name, {
        name: cur.name,
        transport: cur.command !== undefined ? "stdio" : "http",
        ...(cur.command !== undefined ? { command: cur.command } : {}),
        ...(cur.args !== undefined ? { args: cur.args } : {}),
        ...(cur.env !== undefined ? { env: cur.env } : {}),
        ...(cur.url !== undefined ? { url: cur.url } : {}),
        ...(cur.headers !== undefined ? { headers: cur.headers } : {}),
      });
    }
    cur = null;
    curKey = null;
  };
  for (const line of lines) {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const entryM = /^  ([^:#\s][^:]*):(\s|$)/.exec(bare);
    // 键首非空白：六空格的 env/headers 子行不能被四空格字段正则抢走（trim 掩盖了缩进）
    const fieldM = /^    ([^:\s][^:]*):(?:\s+(.*))?$/.exec(bare);
    const subM = /^      ([^:\s][^:]*):(?:\s+(.*))?$/.exec(bare);
    if (entryM !== null) {
      flush();
      cur = { name: parseYamlScalar(entryM[1]!) };
      curKey = null;
      inArgsList = false;
      continue;
    }
    if (cur === null) continue;
    // args: 的块式短横线列表项（六空格 + `-`），读到非列表行为止
    if (inArgsList && DASH_ITEM_RE.test(bare)) {
      const item = parseYamlScalar(DASH_ITEM_RE.exec(bare)![1]!);
      if (cur.args === undefined) cur.args = [];
      cur.args.push(item);
      continue;
    }
    inArgsList = false;
    if (subM !== null && curKey !== null) {
      const bucket = curKey === "env" ? cur.env : cur.headers;
      if (bucket !== undefined) bucket[subM[1]!.trim()] = parseYamlScalar(subM[2] ?? "");
      continue;
    }
    if (fieldM !== null) {
      const key = fieldM[1]!.trim();
      const val = fieldM[2] ?? "";
      if (key === "command") cur.command = parseYamlScalar(val);
      else if (key === "url") cur.url = parseYamlScalar(val);
      else if (key === "args") {
        if (val.trim() === "") {
          // 块式列表：args:\n      - a\n      - b —— 后续短横线行在上方聚拢
          cur.args = [];
          inArgsList = true;
          continue;
        }
        cur.args = parseFlowArray(val);
      } else if (key === "env" && val.trim() === "") {
        curKey = "env";
        if (cur.env === undefined) cur.env = {};
        continue;
      } else if (key === "headers" && val.trim() === "") {
        curKey = "headers";
        if (cur.headers === undefined) cur.headers = {};
        continue;
      }
      curKey = null;
    }
  }
  flush();
  return out;
}

/** flow 形态（`mcp_servers: {a: …}`）定点编辑器不可见：追加会造出第二个同名顶层键 */
function assertBlockForm(text: string): void {
  for (const line of text.split("\n")) {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (/^mcp_servers:\s*\{/.test(bare)) {
      throw Object.assign(new Error("flow 形态（mcp_servers: {…}）不支持定点编辑，请先手工展开为块形态"), { code: "parse_error" });
    }
  }
}

/** 定点替换/新增一个条目；返回新全文。文件无 mcp_servers 块时在末尾追加顶层键。 */
export function upsertYamlEntry(text: string, entry: McpServerEntry): string {
  text = stripBom(text);
  assertBlockForm(text);
  const eol = detectEol(text);
  const block = findMcpBlock(text);
  if (block === null) {
    let out = text.length === 0 ? "" : text.endsWith("\n") ? text : text + eol;
    if (out.trim() !== "") out += eol;
    return out + "mcp_servers:" + eol + generateEntryLines(entry, eol, []);
  }
  const range = findEntryRange(text, block, entry.name);
  if (range === null) {
    // 追加到块尾（块尾 = 下一个顶层键行首或文件末尾，插入行自带换行）。
    // 块尾前若无换行（mcp_servers: 是最后一个顶层键且文件无尾换行），
    // 直接拼接会把新条目第一行粘到上一行尾 → 非法 YAML
    let out = text.slice(0, block.blockEnd);
    if (out !== "" && !out.endsWith("\n")) out += eol;
    return out + generateEntryLines(entry, eol, []) + text.slice(block.blockEnd);
  }
  const kept = collectKeptLines(text.slice(range.start, range.end), entry);
  return text.slice(0, range.start) + generateEntryLines(entry, eol, kept) + text.slice(range.end);
}

/** 定点删除一个条目（整段行区间摘除，区间外原样） */
export function removeYamlEntry(text: string, name: string): string {
  text = stripBom(text);
  assertBlockForm(text);
  const block = findMcpBlock(text);
  if (block === null) return text;
  const range = findEntryRange(text, block, name);
  if (range === null) return text;
  return text.slice(0, range.start) + text.slice(range.end);
}
