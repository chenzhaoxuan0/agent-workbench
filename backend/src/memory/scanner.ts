/**
 * 通用流式扫描器 —— 读各 CLI 自己的会话落盘（docs/10 §4.3）。
 *
 * 这是全系统**唯一的容错防线**。它扫的是别人家的文件，而且是**正在被写入的文件**：
 * - 读到半行 JSON 是常态（对方刚写了一半）
 * - 格式随对方版本升级而变（mcode 自带 schemaVersion 就是证据）
 *
 * 铁律（红线 2）：**任何单点失败最多让「这一家 / 这一个文件」返回空，
 * 绝不整体抛错。** 解析失败跳行、文件读不了跳文件、目录没了跳这家。
 * 上层永远拿到一个能正常结束的流。
 *
 * 结构性选择：**不按字段名写死解析器**。四家 schema 毫无共性
 * （claude 顶层是 content，codex 是 payload 两层嵌套，pi 是 message.sections，
 * mcode 的会话还是目录），写死四套精确路径必然随升级一起烂掉。
 * 改成「通用递归抽取 + 噪声黑名单」：噪声有明确清单，
 * 而对方加字段时我们**自动就能吃到**，不需要跟着改代码。
 *
 * 不建索引（docs/10 §2.2）：这个接口设计成流式，将来若要建 FTS5 索引，
 * 把输出直接喂进去即可，不用重写扫描逻辑。
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { log } from "../log.ts";
import { redact } from "./redact.ts";

export type CliKind = "claude" | "codex" | "pi" | "mcode" | "zcode" | "dsh" | "opencode";

/** 块的语义类别 —— 日报提炼时可据此筛掉 thinking/tool 噪声。 */
export type BlockKind = "text" | "thinking" | "tool";

export interface ScannedBlock {
  readonly text: string;
  readonly ts: number;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly lineNo: number;
  readonly srcPath: string;
  readonly cli: CliKind;
  readonly kind: BlockKind;
  /** 该块所属的原始文本被截断了（单字段超长） */
  readonly truncated: boolean;
}

export interface ScanSource {
  readonly cli: CliKind;
  /** 扫描根目录 */
  readonly root: string;
  /** 单个文本字段的超长截断线 —— 30KB 的 stdout 进了索引基本是噪声 */
  readonly maxFieldChars: number;
}

/**
 * 各 CLI 执行器的根目录。**可被配置覆盖**（家目录不标准、portable 模式等）。
 * 覆盖当前工作台支持的全部执行器（claude, codex, pi, mcode, zcode, dsh, opencode）。
 */
export function defaultSources(homeDir = os.homedir()): ScanSource[] {
  return [
    { cli: "claude", root: path.join(homeDir, ".claude", "projects"), maxFieldChars: 2000 },
    { cli: "codex", root: path.join(homeDir, ".codex", "sessions"), maxFieldChars: 2000 },
    { cli: "pi", root: path.join(homeDir, ".pi", "agent", "sessions"), maxFieldChars: 2000 },
    { cli: "mcode", root: path.join(homeDir, ".minimax", "v2", "sessions"), maxFieldChars: 2000 },
    { cli: "zcode", root: path.join(homeDir, ".zcode", "v2", "sessions"), maxFieldChars: 2000 },
    { cli: "dsh", root: path.join(homeDir, ".dsh", "sessions"), maxFieldChars: 2000 },
    { cli: "opencode", root: path.join(homeDir, ".local", "share", "opencode"), maxFieldChars: 2000 },
  ];
}

export interface ScanOptions {
  /** 限定扫哪几家；缺省全扫 */
  readonly cli?: readonly CliKind[];
  /** 路径过滤：源文件路径包含此串即收（用于按项目收窄） */
  readonly pathHint?: string;
  /** 只收 ts >= since 的块 */
  readonly since?: number;
  /** 每家最多读多少字节（0 = 不限） */
  readonly limitBytesPerCli?: number;
  /** 单个块的目标长度 */
  readonly chunkChars?: number;
  /** 单个文件最多读多少字节；0 = 不限 */
  readonly maxFileBytes?: number;
  /** 命中的行是否要继续读上下文（false = 读完整文件） */
  readonly sources?: readonly ScanSource[];
}

const DEFAULT_CHUNK = 400;

// ---- 噪声黑名单 ---------------------------------------------------------
//
// 这些键**不含对话内容**，抽进去只会污染搜索。四家共有的噪声：
// 标识符、哈希、路径、版本号、模型名、以及各家塞在会话里的**配置与状态快照**
// （codex 的 state.permissions、pi 的 sections.skills、claude 的 system prompt）——
// 那些东西每场会话都重复一遍，进索引纯属浪费。

const NOISE_KEY =
  /^(uuid|id|.*_id|.*Id|.*ID|parent_?uuid|parentUuid|thread_?id|hash|.*hash|signature|revision|version|.*version|schemaVersion|provider|model|model_?id|modelId|model_?provider|modelProvider|cli_?version|cwd|.*cwd.*|.*[Pp]ath|.*[Dd]irectory|.*[Ff]older|workingDirectory|home|timestamp|.*[Tt]imestamp|createdAt|.*[Aa]t$|type|kind|role|msg_?type|source|origin|originator|entrypoint|turnOrigin|permissionMode|promptSource|userType|isSidechain|finish_?reason|state|permissions|approved_command_prefixes|permission_?profile|file_system_sandbox_policy|environments|sections|toolsAdded|tools|base_instructions|host_skills|instructions|collaboration_?mode|multi_agent.*|reasoning.*|token|tokens|usage|cost|attachment|rendered)$/;

/** 这些键的值是正文，值得抽。 */
const TEXT_KEY = /^(text|content|msg_content|msg_?text|thinking|thinking_?content|output|stdout|stderr|description|command|response|answer|result)$/;

/**
 * 最小正文长度。中文一句完整的话一般 10 字往上，卡在 8 能滤掉
 * "ok" / "好" / "收到" 这类噪声，又不至于把短句误杀
 * （早期设 16，把「这条是完整的」这种 14 字整句悄悄丢了）。
 */
const MIN_TEXT = 8;

interface Extracted {
  readonly texts: string[];
  readonly kinds: BlockKind[];
}

function extractText(node: unknown, kind: BlockKind, depth: number, acc: Extracted, maxChars: number): void {
  if (depth > 9) return;
  if (typeof node === "string") {
    const t = node.trim();
    if (t.length < MIN_TEXT) return;
    // 纯路径 / 纯 URL / 纯长 hex 明显不是对话
    if (/^(https?:\/\/|[A-Za-z]:[\\/]|[\w.-]+[\\/]([\w.-]+[\\/]?)+$)/.test(t)) return;
    if (/^[0-9a-fA-F]{24,}$/.test(t)) return;
    acc.texts.push(t.slice(0, maxChars));
    acc.kinds.push(kind);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) extractText(v, kind, depth + 1, acc, maxChars);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (NOISE_KEY.test(k)) continue;
      if (TEXT_KEY.test(k)) {
        const childKind: BlockKind = k === "thinking" || k.startsWith("thinking") ? "thinking" : k === "command" || k === "stdout" || k === "stderr" ? "tool" : kind;
        extractText(v, childKind, depth + 1, acc, maxChars);
      } else if (v !== null && typeof v === "object") {
        extractText(v, kind, depth + 1, acc, maxChars);
      }
    }
  }
}

function newAcc(): Extracted {
  return { texts: [], kinds: [] };
}

// ---- 每家的元数据提取（cwd / sessionId / 时间）---------------------------

function readStr(o: unknown, keys: readonly string[]): string | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function readNum(o: unknown, keys: readonly string[]): number | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v > 1e12 ? v : v > 1e9 ? v * 1000 : v;
    }
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

interface Meta {
  ts: number;
  cwd?: string;
  sessionId?: string;
}

function metaOf(cli: CliKind, o: unknown, fallbackTs: number): Meta {
  const payload = o !== null && typeof o === "object" ? ((o as Record<string, unknown>)["payload"] as unknown) : undefined;
  const msg = o !== null && typeof o === "object" ? ((o as Record<string, unknown>)["message"] as unknown) : undefined;
  const pick = (keys: readonly string[], objs: unknown[]): string | undefined => {
    for (const obj of objs) {
      const v = readStr(obj, keys);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const pickNum = (keys: readonly string[], objs: unknown[]): number | undefined => {
    for (const obj of objs) {
      const v = readNum(obj, keys);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const ts = pickNum(["timestamp", "createdAtMs", "createdAt", "ts", "time", "created_at", "time_created"], [o, payload, msg]) ?? fallbackTs;
  const cwd = pick(["cwd", "workspacePath", "directory"], [o, payload, msg]);
  const sessionId = pick(["sessionId", "session_id", "taskId", "id"], [o, payload, msg]);
  void cli;
  return { ts, ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }) };
}

/** 尝试从含路径特征的目录名中反解出原始目录（例如 pi / dsh 的 --C-Users-...--） */
function decodeDirCwd(filePath: string): string | undefined {
  const m = filePath.match(/--([A-Za-z])-([A-Za-z0-9_-]+)--/);
  if (m && m[1] && m[2]) {
    const drive = m[1].toUpperCase();
    const rest = m[2].replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }
  return undefined;
}

// ---- 切块 ----------------------------------------------------------------

/**
 * 把一段长文本切成约 chunkChars 的块，尽量落在换行/句读上。
 * 切太细结果碎片化，切太粗搜不准 —— docs/10 定 300–500。
 */
export function chunkText(text: string, chunkChars = DEFAULT_CHUNK): string[] {
  if (text.length <= chunkChars) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkChars, text.length);
    if (end < text.length) {
      // 在后半段找最靠后的自然断点
      const window = text.slice(i, end);
      const br = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(".\n"));
      if (br > chunkChars * 0.5) end = i + br + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece.length > 0) out.push(piece);
    i = end;
  }
  return out;
}

// ---- 文件枚举 ------------------------------------------------------------

/** 文件计数的共享游标（递归里要跨层数，不能用局部变量）。 */
interface Cursor {
  n: number;
}
const at = (c: Cursor, max: number): boolean => max <= 0 || c.n < max;

/** 自己递归（不用 opendir recursive：Dirent 不带父目录，跨 TS lib 不稳） */
async function* listJsonl(dir: string, maxFiles: number, cur: Cursor, depth = 0): AsyncGenerator<string> {
  if (depth > 8 || !at(cur, maxFiles)) return;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return; // 根目录不存在 = 这家没装/没用过，静默跳过
  }
  for (const e of entries) {
    if (!at(cur, maxFiles)) return;
    const p = path.join(dir, e.name);
    if (e.isDir) {
      yield* listJsonl(p, maxFiles, cur, depth + 1);
    } else if (e.name.endsWith(".jsonl")) {
      cur.n++;
      yield p;
    }
  }
}

/** mcode 的会话是**目录**，正文件叫 messages.jsonl。 */
async function* listMcodeSessions(dir: string, maxFiles: number, cur: Cursor, depth = 0): AsyncGenerator<string> {
  if (depth > 8 || !at(cur, maxFiles)) return;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return;
  }
  for (const e of entries) {
    if (!at(cur, maxFiles)) return;
    if (!e.isDir) continue;
    const f = path.join(dir, e.name, "messages.jsonl");
    try {
      await stat(f);
      cur.n++;
      yield f;
      continue; // 是会话目录，不再往里钻
    } catch {
      // 不是会话目录 → 继续往下找（真实布局深达 4 层：sessions/YYYY/MM/DD/<会话>/）
    }
    yield* listMcodeSessions(path.join(dir, e.name), maxFiles, cur, depth + 1);
  }
}

/** 通用按正则过滤文件并递归枚举（供 zcode .json / dsh .zstd 等使用） */
async function* listPatternFiles(dir: string, pattern: RegExp, maxFiles: number, cur: Cursor, depth = 0): AsyncGenerator<string> {
  if (depth > 8 || !at(cur, maxFiles)) return;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return;
  }
  for (const e of entries) {
    if (!at(cur, maxFiles)) return;
    const p = path.join(dir, e.name);
    if (e.isDir) {
      yield* listPatternFiles(p, pattern, maxFiles, cur, depth + 1);
    } else if (pattern.test(e.name)) {
      cur.n++;
      yield p;
    }
  }
}

/** 分发不同源的文件枚举逻辑 */
async function* listFilesForSource(src: ScanSource, maxFiles: number, cur: Cursor): AsyncGenerator<string> {
  if (src.cli === "mcode") {
    yield* listMcodeSessions(src.root, maxFiles, cur);
  } else if (src.cli === "zcode") {
    yield* listPatternFiles(src.root, /\.json$/i, maxFiles, cur);
  } else if (src.cli === "dsh") {
    yield* listPatternFiles(src.root, /\.(jsonl|zstd|jsonl\.zstd)$/i, maxFiles, cur);
  } else if (src.cli === "opencode") {
    const db = path.join(src.root, "opencode.db");
    try {
      await stat(db);
      cur.n++;
      yield db;
    } catch {
      // 库不存在静默跳过
    }
  } else {
    yield* listJsonl(src.root, maxFiles, cur);
  }
}

// ---- 单文件流式读取 ------------------------------------------------------

/**
 * 逐行读一个文件。支持普通 JSONL、zstd 压缩流、以及 zcode 的单文件 JSON 格式。
 * 正在被写的文件读到不完整的末行是常态，交给上层 fail-open 跳过。
 */
async function* readLines(file: string): AsyncGenerator<{ line: string; lineNo: number }> {
  if (file.endsWith(".zstd")) {
    try {
      const zlib = await import("node:zlib");
      if (typeof zlib.zstdDecompressSync === "function") {
        const buf = await readFile(file);
        const text = zlib.zstdDecompressSync(buf).toString("utf8");
        let lineNo = 0;
        for (const line of text.split("\n")) {
          lineNo++;
          if (line.trim() !== "") yield { line, lineNo };
        }
        return;
      }
    } catch {
      return;
    }
  }

  if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
    try {
      const raw = await readFile(file, "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(obj?.messages)) {
        let lineNo = 0;
        for (const m of obj.messages) {
          lineNo++;
          yield { line: JSON.stringify(m), lineNo };
        }
        return;
      }
    } catch {
      return;
    }
  }

  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (line.trim() !== "") yield { line, lineNo };
    }
  } catch {
    // 读一半文件被截断（对方正在改）→ 已读到的照常给
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 专门针对 opencode.db SQLite 进行流式扫描读取 */
async function* scanOpencodeDb(
  src: ScanSource,
  file: string,
  mtimeMs: number,
  opts: Required<Pick<ScanOptions, "chunkChars">> & { since?: number },
): AsyncGenerator<ScannedBlock> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    let sql = `
      SELECT p.id AS part_id, p.session_id, s.directory AS cwd, p.time_created, p.data
      FROM part p
      JOIN session s ON p.session_id = s.id
    `;
    if (opts.since !== undefined) {
      sql += ` WHERE p.time_created >= ${opts.since}`;
    }
    sql += " ORDER BY p.time_created DESC LIMIT 2000";
    const rows = db.prepare(sql).all() as Array<{
      part_id: string;
      session_id: string;
      cwd: string;
      time_created: number;
      data: string;
    }>;
    db.close();

    let lineNo = 0;
    for (const r of rows) {
      lineNo++;
      let dataObj: unknown;
      try {
        dataObj = JSON.parse(r.data);
      } catch {
        continue;
      }
      const acc = newAcc();
      extractText(dataObj, "text", 0, acc, src.maxFieldChars);
      if (acc.texts.length === 0) continue;

      for (let i = 0; i < acc.texts.length; i++) {
        const raw = acc.texts[i] ?? "";
        const kind = acc.kinds[i] ?? "text";
        for (const piece of chunkText(raw, opts.chunkChars)) {
          yield {
            text: redact(piece),
            ts: r.time_created || mtimeMs,
            cwd: r.cwd,
            sessionId: r.session_id,
            lineNo,
            srcPath: file,
            cli: "opencode",
            kind,
            truncated: raw.length >= src.maxFieldChars,
          };
        }
      }
    }
  } catch (err: unknown) {
    log.warn("scan opencode.db failed", { file, error: err instanceof Error ? err.message : String(err) });
  }
}

async function* scanOneFile(
  src: ScanSource,
  file: string,
  mtimeMs: number,
  opts: Required<Pick<ScanOptions, "chunkChars">> & { since?: number },
): AsyncGenerator<ScannedBlock> {
  if (src.cli === "opencode" && file.endsWith(".db")) {
    yield* scanOpencodeDb(src, file, mtimeMs, opts);
    return;
  }

  // mtime 由调用方 stat 好传进来：省一次 stat，也避免 TOCTOU
  // mcode 的会话目录里还有 manifest.json，带着 sessionId 与创建时间；zcode .json 自带 meta
  let extraMeta: Record<string, unknown> | undefined;
  if (src.cli === "mcode") {
    try {
      const raw = await readFile(path.join(path.dirname(file), "manifest.json"), "utf8");
      extraMeta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      extraMeta = undefined;
    }
  } else if (src.cli === "zcode" && file.endsWith(".json")) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed?.meta && typeof parsed.meta === "object") {
        extraMeta = parsed.meta as Record<string, unknown>;
      }
    } catch {
      extraMeta = undefined;
    }
  }
  const manifestMeta = extraMeta === undefined ? undefined : metaOf(src.cli, extraMeta, mtimeMs);
  const pathCwd = decodeDirCwd(file);

  let emitted = 0;
  for await (const { line, lineNo } of readLines(file)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 半行 / 坏行 —— 常态，跳过（红线 2）
    }
    if (obj === null || typeof obj !== "object") continue;

    const meta = metaOf(src.cli, obj, mtimeMs);
    const ts = meta.ts || manifestMeta?.ts || mtimeMs;
    if (opts.since !== undefined && ts < opts.since) continue;

    const acc = newAcc();
    extractText(obj, "text", 0, acc, src.maxFieldChars);
    if (acc.texts.length === 0) continue;

    const cwd = meta.cwd ?? manifestMeta?.cwd ?? pathCwd;
    const sessionId = meta.sessionId ?? manifestMeta?.sessionId;

    for (let i = 0; i < acc.texts.length; i++) {
      const raw = acc.texts[i] ?? "";
      const kind = acc.kinds[i] ?? "text";
      for (const piece of chunkText(raw, opts.chunkChars)) {
        yield {
          text: redact(piece),
          ts,
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionId === undefined ? {} : { sessionId }),
          lineNo,
          srcPath: file,
          cli: src.cli,
          kind,
          truncated: raw.length >= src.maxFieldChars,
        };
        emitted++;
      }
    }
  }
  void emitted;
}

// ---- 对外主入口 ----------------------------------------------------------

/**
 * 跨 CLI 流式扫描。任何一家的失败都不会中断整体。
 * 消费者可以放心 `for await`，流一定正常结束。
 */
export async function* scan(opts: ScanOptions = {}): AsyncGenerator<ScannedBlock> {
  const all = opts.sources ?? defaultSources();
  const wanted = opts.cli === undefined ? null : new Set(opts.cli);
  const chunkChars = opts.chunkChars ?? DEFAULT_CHUNK;
  const stats: Record<string, { files: number; blocks: number; errors: number }> = {};

  for (const src of all) {
    if (wanted !== null && !wanted.has(src.cli)) continue;
    const s = (stats[src.cli] ??= { files: 0, blocks: 0, errors: 0 });

    let used = 0;
    const cap = opts.limitBytesPerCli ?? 0;

    let candidates: Array<{ file: string; mtime: number; size: number }> = [];
    let collectedBytes = 0;
    /**
     * 枚举上限 —— **别随手动它，它是提前收手的那一刀**。
     *
     * 已知取舍（2026-10 实测，别再重复这一轮）：
     * 它按**枚举顺序**累计字节，而 candidates 要到循环结束才按 mtime 排序，
     * 所以「字节预算」实际是「枚举顺序前 N MB 之内才参与排序」。目录名带日期的源
     * （codex 的 sessions/YYYY/MM/DD/）在语料极大时，理论上可能把最新几个文件截在外面。
     *
     * 试过两种"修法"，都有实测代价，故维持现状：
     *   1. 收全量候选（去掉本上限）→ 本机真实语料一次 8MB 扫描从 **1.2s 涨到 10 分钟以上**；
     *   2. 只把目录枚举改成按名字倒序（零额外 I/O，看似免费）→ 同样掉到 5 分钟以上 ——
     *      枚举顺序一变，递归先钻进的目录完全不同，代价不是线性的。
     * 真要修，得先给枚举本身加预算（readdir 次数 / 目录深度都计入），那是一次独立改动。
     * 当前兜底：`since` 过滤会把预算内那些过老的内容整段跳过，不会污染记忆。
     */
    const collectCeiling = cap > 0 ? Math.max(cap * 4, 32 * 1024 * 1024) : Number.POSITIVE_INFINITY;
    try {
      for await (const file of listFilesForSource(src, 0, { n: 0 })) {
        if (opts.pathHint !== undefined && opts.pathHint !== "" && !file.includes(opts.pathHint)) continue;
        if (collectedBytes >= collectCeiling) break;
        try {
          const st = await stat(file);
          candidates.push({ file, mtime: st.mtimeMs, size: st.size });
          collectedBytes += st.size;
        } catch {
          s.errors++;
        }
      }
    } catch (err: unknown) {
      s.errors++;
      log.warn("scan source failed", { cli: src.cli, root: src.root, error: err instanceof Error ? err.message : String(err) });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const c of candidates) {
      if (cap > 0 && used >= cap) break;
      // **枚举才是瓶颈**（本机 879+93+895 个文件），不是读取。
      // since 存在时老的文件整个跳过，连内容都不读。
      if (opts.since !== undefined && c.mtime < opts.since) continue;
      if (opts.maxFileBytes !== undefined && opts.maxFileBytes > 0 && c.size > opts.maxFileBytes) continue;
      used += c.size;

      s.files++;
      // 单文件失败只记一笔，继续下一个（红线 2）
      try {
        for await (const b of scanOneFile(src, c.file, c.mtime, { chunkChars, ...(opts.since === undefined ? {} : { since: opts.since }) })) {
          s.blocks++;
          yield b;
        }
      } catch (err: unknown) {
        s.errors++;
        log.warn("scan file failed", { cli: src.cli, file: c.file, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  log.info("scan done", { stats });
}

/** 诊断用：各家扫到了什么（文件数 / 块数 / 错误数），不吐内容。 */
export async function scanStats(opts: ScanOptions = {}): Promise<Record<string, { files: number; blocks: number; errors: number }>> {
  const out: Record<string, { files: number; blocks: number; errors: number }> = {};
  for await (const b of scan({ ...opts, chunkChars: 1 })) {
    const s = (out[b.cli] ??= { files: 0, blocks: 0, errors: 0 });
    s.blocks++;
  }
  for (const src of opts.sources ?? defaultSources()) out[src.cli] ??= { files: 0, blocks: 0, errors: 0 };
  return out;
}
