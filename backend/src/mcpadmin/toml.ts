/**
 * TOML mcp_servers 定点段编辑器 —— 只动 `[mcp_servers.*]` 段落的字节区间，
 * 区间外一字不改（EOL、段间空行、注释全部原样）。
 *
 * 模型：按表头行把文件切成**原始字节切片**（seg = 表头行起点 → 下一表头行起点），
 * 属于 `mcp_servers.<name>`（含 `.env` 等子表）的切片按 name 分组；增删改只替换
 * 目标 name 分组的字节区间，其余切片原样保留。生成的新段落用文件既有 EOL 风格。
 * 这是对 cc-switch 用 toml_edit 保注释/保格式能力的等价实现（Node 生态无同类轻量依赖）。
 *
 * 已知边界（v1 接受）：inline-table 形态（`mcp_servers = { x = {...} }`）不识别
 * ——cc-switch 也会先把它归一化；遇到时该条目不进清单，用户手改一次即可。
 */
import type { McpServerEntry } from "../contract.ts";

/** 一个表头切片；path 为 null 表示文件前导（第一个表头之前的部分） */
interface Seg {
  /** 切片起点（表头行的行首；前导恒为 0） */
  readonly start: number;
  /** 切片终点（下一表头行首，或文件末尾）——含本段的全部尾部空行与 EOL */
  readonly end: number;
  /** 解析出的表头路径（`[mcp_servers.x.env]` → ["mcp_servers","x","env"]）；裸键与带引号键都解 */
  readonly path: string[] | null;
}

/** 构建期中间形态：end 未知，扫完全文后补齐 */
interface SegDraft {
  readonly start: number;
  readonly path: string[] | null;
  end?: number;
}

const HEADER_LINE_RE = /^[ \t]*\[[^\]]+\]/;
const ARRAY_TABLE_RE = /^[ \t]*\[\[/;

function parseHeaderPath(headerLine: string): string[] | null {
  if (ARRAY_TABLE_RE.test(headerLine)) return null; // [[array of tables]] 不是我们的管理面
  const m = HEADER_LINE_RE.exec(headerLine);
  if (m === null) return null;
  // 切片限定在匹配前缀（到第一个 ]）内：行尾注释里的 ] 不能混进表名
  const pref = m[0]!;
  const inner = pref.slice(pref.indexOf("[") + 1, pref.lastIndexOf("]"));
  if (inner === "") return null;
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === " " || inner[i] === "\t")) i++;
    if (i >= inner.length) break;
    if (inner[i] === '"' || inner[i] === "'") {
      const q = inner[i]!;
      const end = inner.indexOf(q, i + 1);
      if (end === -1) return null;
      out.push(inner.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < inner.length && inner[j] !== ".") j++;
      out.push(inner.slice(i, j));
      i = j;
    }
    while (i < inner.length && (inner[i] === " " || inner[i] === "\t")) i++;
    if (inner[i] === ".") i++;
    else if (i < inner.length) return null;
  }
  return out.length === 0 ? null : out;
}

/**
 * 文本 → 切片序列。按行扫偏移，不重排任何字节：CRLF 保留、段间无空行保留、
 * 注释行只用于判定（不修改）。切片 [start,end) 覆盖全文字节，无空洞。
 */
function findSegments(text: string): Seg[] {
  const drafts: SegDraft[] = [];
  let offset = 0;
  // 多行字符串状态：`"""` / `'''` 内的伪表头行不是段边界（否则删改会咬进字符串内容）
  let multiD = false;
  let multiS = false;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1; // +1 换行符（CRLF 的 \r 留在 line 尾部）
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!multiD && !multiS && HEADER_LINE_RE.test(bare)) {
      drafts.push({ start: lineStart, path: parseHeaderPath(bare) });
    }
    if (countTriple(bare, `"""`) % 2 === 1) multiD = !multiD;
    if (countTriple(bare, "'''") % 2 === 1) multiS = !multiS;
  }
  const firstHeaderStart = drafts.length > 0 ? drafts[0]!.start : -1;
  const segs: Seg[] = [{ start: 0, end: firstHeaderStart === -1 ? text.length : firstHeaderStart, path: null }];
  for (let i = 0; i < drafts.length; i++) {
    segs.push({ start: drafts[i]!.start, end: i + 1 < drafts.length ? drafts[i + 1]!.start : text.length, path: drafts[i]!.path });
  }
  return segs;
}

/** 非重叠三引号计数（多行字符串开闭启发式） */
function countTriple(line: string, q: string): number {
  let n = 0;
  for (let i = line.indexOf(q); i !== -1; i = line.indexOf(q, i + q.length)) n++;
  return n;
}

/** `[mcp_servers.<name>…]` 切片组的归属判定：path[0]=mcp_servers 且 path[1]=name */
function isMcpNameSeg(seg: Seg, name: string): boolean {
  return seg.path !== null && seg.path[0] === "mcp_servers" && seg.path.length >= 2 && seg.path[1] === name;
}

/** 取文件既有 EOL 风格（有任一 CRLF 即按 CRLF 生成） */
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 入口剥 UTF-8 BOM（Windows 编辑器常客）：剥后全程用同一文本，切片索引才不偏移 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---- 值的轻量解析（只解我们写得出的形态：字符串 / 字符串数组；解析不出的跳过） ----

function parseTomlString(raw: string): string | undefined {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? undefined : v.slice(1, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i]!;
      if (c === '"') return out;
      if (c === "\\" && i + 1 < v.length) {
        const n = v[i + 1]!;
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "u" && /^[0-9a-fA-F]{4}/.test(v.slice(i + 2, i + 6))) {
          out += String.fromCharCode(Number.parseInt(v.slice(i + 2, i + 6), 16));
          i += 4; // 吃掉 uXXXX 四位（本分支随后的 i++ 与 for 的 i++ 合计再进 2：`\`+`u`+4hex = 6）
        } else out += n;
        i++;
      } else out += c;
    }
    return undefined;
  }
  return undefined;
}

function stripComment(line: string): string {
  // 只剥行尾 # 注释（引号外）。轻量：单/双引号串内 # 罕见于 env/args 值，双保险扫描引号状态。
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && (i === 0 || line[i - 1] !== "\\")) inD = !inD;
    else if (c === "#" && !inS && !inD) return line.slice(0, i);
  }
  return line;
}

/** 段正文行 → 键值表（值为 string 或 string[]；解不动的值跳过） */
function parseBodyKv(lines: readonly string[]): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  for (const line of lines) {
    const clean = stripComment(line).trim();
    if (clean === "" || clean.startsWith("[")) continue;
    const eq = clean.indexOf("=");
    if (eq === -1) continue;
    const key = clean.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const value = clean.slice(eq + 1).trim();
    if (value.startsWith("[")) {
      // 字符串数组：["a", "b"]（跨行数组 v1 不支持，跳过）。元素统一走 parseTomlString
      // 反转义（裸 replace 会把 "\n" 读成 n、下次保存固化损坏）。
      const items: string[] = [];
      const re = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
      let m: RegExpExecArray | null;
      let consumed = 0;
      let ok = true;
      while ((m = re.exec(value)) !== null) {
        const s = parseTomlString(m[0]);
        if (s === undefined) {
          ok = false;
          break;
        }
        items.push(s);
        consumed = re.lastIndex;
      }
      if (ok && value.slice(consumed).includes("]") && items.length > 0) out.set(key, items);
    } else {
      const s = parseTomlString(value);
      if (s !== undefined) out.set(key, s);
    }
  }
  return out;
}

// ---- 值序列化 ----

function tomlString(s: string): string {
  if (!s.includes("'") && !/[\n\r\t\u0000-\u001f\u007f]/.test(s)) return `'${s}'`;
  // 基本串：常规转义之外，其余控制字符（C0 + 0x7f）必须走 \uXXXX ——
  // 裸控制字符是非法 TOML，会害 Codex 拒载整份 config.toml
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0)!;
      out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return out + '"';
}

function headerName(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/** 条目 → 段组字节文本（主表 + 可选 env / http_headers 子表），用文件既有 EOL */
function generateGroup(entry: McpServerEntry, eol: string, extraMainLines: readonly string[] = []): string {
  const h = headerName(entry.name);
  const main: string[] = [`[mcp_servers.${h}]`];
  if (entry.transport === "stdio") {
    if (entry.command !== undefined) main.push(`command = ${tomlString(entry.command)}`);
    if (entry.args !== undefined && entry.args.length > 0) {
      main.push(`args = [${entry.args.map((a) => tomlString(a)).join(", ")}]`);
    }
  } else {
    if (entry.url !== undefined) main.push(`url = ${tomlString(entry.url)}`);
  }
  main.push(...extraMainLines);
  let text = main.join(eol) + eol;
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
    const envLines = Object.entries(entry.env).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`);
    text += eol + `[mcp_servers.${h}.env]` + eol + envLines.join(eol) + eol;
  }
  if (entry.headers !== undefined && Object.keys(entry.headers).length > 0 && entry.transport !== "stdio") {
    const hLines = Object.entries(entry.headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
    text += eol + `[mcp_servers.${h}.http_headers]` + eol + hLines.join(eol) + eol;
  }
  return text;
}

/** 切片正文行（去掉表头行；CRLF 已剥） */
function segBodyLines(text: string, seg: Seg): string[] {
  const raw = text.slice(seg.start, seg.end);
  const lines = raw.split("\n");
  lines.shift(); // 表头行
  const last = lines[lines.length - 1];
  if (last === undefined || last === "") lines.pop(); // 切片末尾的 \n 产物
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * 读全部 mcp_servers 条目（轻量解析：command/args/url + env / http_headers 子表）。
 * 解析不出的条目不进清单（不报错 —— 展示层宁缺勿假，写层只动能定位的段）。
 */
export function readTomlEntries(text: string): Map<string, McpServerEntry> {
  text = stripBom(text);
  const mains = new Map<string, Map<string, string | string[]>>();
  const envs = new Map<string, Record<string, string>>();
  const headers = new Map<string, Record<string, string>>();
  for (const seg of findSegments(text)) {
    if (seg.path === null || seg.path[0] !== "mcp_servers" || seg.path.length < 2) continue;
    if (seg.path.length === 2) {
      mains.set(seg.path[1]!, parseBodyKv(segBodyLines(text, seg)));
    } else if (seg.path.length === 3 && seg.path[2] === "env") {
      const env: Record<string, string> = {};
      for (const [k, v] of parseBodyKv(segBodyLines(text, seg))) if (typeof v === "string") env[k] = v;
      envs.set(seg.path[1]!, env);
    } else if (seg.path.length === 3 && seg.path[2] === "http_headers") {
      const h: Record<string, string> = {};
      for (const [k, v] of parseBodyKv(segBodyLines(text, seg))) if (typeof v === "string") h[k] = v;
      headers.set(seg.path[1]!, h);
    }
  }
  const out = new Map<string, McpServerEntry>();
  for (const [name, kv] of mains) {
    const command = kv.get("command");
    const url = kv.get("url");
    const args = kv.get("args");
    if (typeof command !== "string" && typeof url !== "string") continue;
    const transport: "stdio" | "http" = typeof command === "string" ? "stdio" : "http";
    const env = envs.get(name);
    const h = headers.get(name);
    out.set(name, {
      name,
      transport,
      ...(typeof command === "string" ? { command } : {}),
      ...(typeof url === "string" ? { url } : {}),
      ...(Array.isArray(args) ? { args } : {}),
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
      ...(h !== undefined && Object.keys(h).length > 0 ? { headers: h } : {}),
    });
  }
  return out;
}

/**
 * 组替换/删除的**终点**：组内最后一段的字节区间会把「下一表头之前的注释行与空行」
 * 划进来（切片以表头定界），但那些行不是组的内容 —— 从组末尾回溯，把尾部连续的
 * 空行/注释行划出替换区原字节保留；最后一个实质行的终结换行归实质行自己。
 */
function groupCutEnd(text: string, first: Seg, last: Seg): number {
  const span = text.slice(first.start, last.end);
  const lines = span.split("\n");
  const lineStart = (i: number): number => {
    let off = 0;
    for (let j = 0; j < i; j++) off += lines[j]!.length + 1;
    return off;
  };
  let lastReal = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const bare = lines[i]!.endsWith("\r") ? lines[i]!.slice(0, -1) : lines[i]!;
    if (bare.trim() !== "" && !bare.trim().startsWith("#")) {
      lastReal = i;
      break;
    }
  }
  if (lastReal === -1) return first.start; // 全空（理论不可达：至少有表头行）
  const hasEol = lastReal < lines.length - 1;
  return first.start + lineStart(lastReal) + lines[lastReal]!.length + (hasEol ? 1 : 0);
}

/** 我们管理的主表键；此外的键值行是用户的扩展字段（如 bearer_token_env_var），编辑时原字节保留 */
const MANAGED_MAIN_KEYS = new Set(["command", "args", "url"]);

/**
 * 从旧主表段提取「我们不管理的键值行」（原字节、剥尾部 \r）。
 * 组内纯注释行随组重建丢弃（组外注释不受影响）——与 codex 拒载整份配置相比，
 * 这是可接受的取舍；扩展键本身是数据，必须活下来。
 */
function collectUnknownMainLines(text: string, group: readonly Seg[], eol: string): string[] {
  const mainSeg = group.find((s) => s.path !== null && s.path.length === 2);
  if (mainSeg === undefined) return [];
  const out: string[] = [];
  for (const line of segBodyLines(text, mainSeg)) {
    const clean = stripComment(line).trim();
    if (clean === "" || clean.startsWith("[")) continue;
    const eq = clean.indexOf("=");
    if (eq === -1) continue;
    const key = clean.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    if (!MANAGED_MAIN_KEYS.has(key)) out.push(line);
  }
  return out;
}

/**
 * 定点替换/新增一个条目段组；返回新全文。
 * - 已存在：原位替换该 name 分组的字节区间（env/http_headers 子表按新条目重生成；
 *   主表未知扩展键值行、任意深度的未知子表、组尾注释/空行原字节保留）
 * - 不存在：文件末尾追加（TOML 语义：末尾新表头安全）
 */
export function upsertTomlEntry(text: string, entry: McpServerEntry): string {
  text = stripBom(text);
  const eol = detectEol(text);
  const segs = findSegments(text);
  const group = segs.filter((s) => isMcpNameSeg(s, entry.name));

  if (group.length === 0) {
    // 末尾追加：补齐行尾，隔一个空行（文件已有独立尾段时不强加）
    if (text === "") return generateGroup(entry, eol);
    let out = text.endsWith("\n") ? text : text + eol;
    if (!/\n[ \t]*\r?\n$/.test(out)) out += eol;
    return out + generateGroup(entry, eol);
  }

  const first = group[0]!;
  const last = group[group.length - 1]!;
  const cutEnd = groupCutEnd(text, first, last);
  const extraMain = collectUnknownMainLines(text, group, eol);
  // 未知子表（env/http_headers 之外的任意深度子表）按原字节保留，维持原有相对顺序
  const keepSubRaw = group
    .filter((s) => {
      const p = s.path;
      return p !== null && p.length >= 3 && !(p.length === 3 && (p[2] === "env" || p[2] === "http_headers"));
    })
    .map((s) => text.slice(s.start, s.end))
    .join("");
  return text.slice(0, first.start) + generateGroup(entry, eol, extraMain) + keepSubRaw + text.slice(cutEnd);
}

/** 定点删除一个条目的全部段（主表 + 子表）：整段字节区间摘除，组尾注释/空行与区间外原样 */
export function removeTomlEntry(text: string, name: string): string {
  text = stripBom(text);
  const segs = findSegments(text);
  const group = segs.filter((s) => isMcpNameSeg(s, name));
  if (group.length === 0) return text;
  const cutEnd = groupCutEnd(text, group[0]!, group[group.length - 1]!);
  return text.slice(0, group[0]!.start) + text.slice(cutEnd);
}
