/**
 * 项目记忆文件层 —— semantic 柱的落地面（docs/10 §4.1）。
 *
 * 形态：记忆就是项目文件夹里的普通 Markdown 文件。
 * - MEMORY.md          长期事实，2200 字符硬上限，恒注入
 * - memory/daily/*.md  每天流水摘要，按天分片，不注入
 * - memory/*.md        归档但仍重要的事实（v2 接 WeKnora 语义检索）
 *
 * 为什么是文件而不是数据库：
 * 1. 跨 CLI 可移植 —— 新执行器读同一个文件夹就知道上下文
 * 2. 能进 git —— 团队共享、改动可 review
 * 3. 人可直接编辑 —— 不经过工作台也能改
 *
 * 写路径纪律：原子写（tmp + rename）、写前备份、超限拒绝。
 * 只建文件，不动 bot 文件夹里的任何其他东西（与 bots/inspect.ts 的只读语义对齐）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";
import { buildOverLimitError, checkCapacity, measure, MEMORY_CHAR_LIMIT } from "./limits.ts";

/** 新建 MEMORY.md 时的模板头。刻意保持简短 —— 它也吃 2200 的额度。 */
export const MEMORY_TEMPLATE = [
  "# 项目记忆",
  "",
  "<!-- workbench 记忆系统 · 上限 2200 字符 · 一条一事 · 改动前自动备份 -->",
  "",
  "- （把项目级事实写在这里：约定、环境、教训。每行一条。）",
  "",
].join("\n");

/** 新建 STANDING.md 时的模板头。上限 1000 字符，只读禁令。 */
export const STANDING_TEMPLATE = [
  "# Standing Instructions",
  "",
  "<!-- workbench 记忆系统 · 常驻硬性禁令 · 上限 1000 字符 · Agent 禁改 -->",
  "",
  "- （把项目级不可违反的红线与安全约束写在这里。每行一条。）",
  "",
].join("\n");

export const STANDING_CHAR_LIMIT = 1000;

/**
 * SOUL.md / USER.md 的注入上限（ADR 0014 D5）。超限在注入侧走 truncateToBudget
 * （保留首尾 + 显式截断标记）；USER.md 的写路径另有硬拒绝（见 writeUserFile）。
 */
export const SOUL_CHAR_LIMIT = 2000;
export const USER_CHAR_LIMIT = 2000;

/** 首次创建 USER.md 时的模板头（<homeDir>/USER.md，关于「人」的全局层）。 */
export const USER_TEMPLATE = [
  "# 关于我",
  "",
  "<!-- workbench · USER.md · 关于用户本人的常驻信息（作息、偏好、说话风格、常用环境）· 逐 bot 开关注入 · 改动前自动备份 -->",
  "",
  "- （把希望每个 bot 都知道的用户级事实写在这里。每行一条。）",
  "",
].join("\n");

/** 备份保留份数。超出后按时间淘汰最旧的。 */
export const BACKUP_KEEP = 20;

/** 日报文件名只认 YYYY-MM-DD。挡住 `../../../outside/creds` 这类穿越。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
  return DATE_RE.test(date);
}

export interface ProjectMemoryPaths {
  readonly root: string;
  readonly memoryMd: string;
  readonly standingMd: string;
  readonly memoryDir: string;
  readonly dailyDir: string;
}

export interface MemoryFile {
  readonly path: string;
  readonly content: string;
  readonly chars: number;
  readonly limit: number;
  readonly exists: boolean;
  readonly mtimeMs: number;
}

export interface WriteResult {
  readonly path: string;
  readonly chars: number;
  readonly limit: number;
  readonly backupPath: string | null;
  readonly nearLimit: boolean;
}

// ---- 路径 ----

export function resolvePaths(rootPath: string): ProjectMemoryPaths {
  const memoryDir = path.join(rootPath, "memory");
  return {
    root: rootPath,
    memoryMd: path.join(rootPath, "MEMORY.md"),
    standingMd: path.join(rootPath, "STANDING.md"),
    memoryDir,
    dailyDir: path.join(memoryDir, "daily"),
  };
}

/** rootPath → 稳定的短 id，用于备份分目录（避免路径过长 / 非法字符）。 */
export function scopeId(rootPath: string): string {
  return createHash("sha256").update(rootPath).digest("hex").slice(0, 12);
}

// ---- 读 ----

export async function readStanding(rootPath: string): Promise<MemoryFile> {
  const p = resolvePaths(rootPath);
  return readFileAt(p.standingMd, STANDING_CHAR_LIMIT);
}

export async function readLongTerm(rootPath: string): Promise<MemoryFile> {
  const p = resolvePaths(rootPath);
  return readFileAt(p.memoryMd, MEMORY_CHAR_LIMIT);
}

export async function readDaily(rootPath: string, date: string): Promise<MemoryFile> {
  const p = resolvePaths(rootPath);
  // 路径穿越防护：date 直接拼进路径，必须先卡格式
  if (!isValidDate(date)) throw Object.assign(new Error(`bad date: ${date}`), { code: "bad_params" });
  return readFileAt(path.join(p.dailyDir, `${date}.md`), Number.POSITIVE_INFINITY);
}

// ---- SOUL / USER（ADR 0014 D5）----

/**
 * AGENTS.md 兜底注入的截断上限（ADR 0014 D4）：只在执行器未声明原生读取、
 * auto 判定需要工作台注入时才走这条路；原生读取的执行器完全不碰。
 * 读的是根目录规范文件名（自定义 sourcePath 指针不跟随——那是给人看的落点）。
 */
export const AGENTS_INJECT_CHAR_LIMIT = 12000;

export async function readAgentsMd(rootPath: string): Promise<MemoryFile> {
  return readFileAt(path.join(rootPath, "AGENTS.md"), AGENTS_INJECT_CHAR_LIMIT);
}

/** <rootPath>/SOUL.md：人设，用户/设置页维护（bot.put 落盘），注入器只读。 */
export function soulMdPath(rootPath: string): string {
  return path.join(rootPath, "SOUL.md");
}

export async function readSoul(rootPath: string): Promise<MemoryFile> {
  return readFileAt(soulMdPath(rootPath), SOUL_CHAR_LIMIT);
}

/** <homeDir>/USER.md：关于「人」的全局 evergreen 层，逐 bot 开关注入。 */
export function userMdPath(homeDir: string): string {
  return path.join(homeDir, "USER.md");
}

export async function readUser(homeDir: string): Promise<MemoryFile> {
  return readFileAt(userMdPath(homeDir), USER_CHAR_LIMIT);
}

/** USER.md 备份分目录的 scopeKey（全局层没有 rootPath，用固定键派生稳定短 id）。 */
const USER_SCOPE_KEY = "user-global";

/** 覆盖写 USER.md：与 writeLongTerm 同一纪律——查容量 → 备份 → 原子写，
 * 超限抛错且磁盘不发生任何变化。备份进 <homeDir>/backups/<user-scope>/。 */
export async function writeUser(homeDir: string, content: string): Promise<WriteResult> {
  const file = userMdPath(homeDir);
  const current = await readFileAt(file, USER_CHAR_LIMIT);
  const cap = checkCapacity(current.content, content, USER_CHAR_LIMIT);
  if (!cap.ok) throw buildOverLimitError(current.content, content, USER_CHAR_LIMIT);

  const backupPath = await backup(USER_SCOPE_KEY, file, current.content, homeDir);
  await atomicWrite(file, content);
  log.info("user context written", { chars: cap.used, limit: cap.limit, nearLimit: cap.nearLimit });
  return { path: file, chars: cap.used, limit: cap.limit, backupPath, nearLimit: cap.nearLimit };
}

/** 覆盖写 STANDING.md（红线禁令，上下文编辑器的写路径；agent 侧仍走文件工具自改）。 */
export async function writeStanding(
  rootPath: string,
  content: string,
  opts: { homeDir: string },
): Promise<WriteResult> {
  const p = resolvePaths(rootPath);
  const current = await readFileAt(p.standingMd, STANDING_CHAR_LIMIT);
  const cap = checkCapacity(current.content, content, STANDING_CHAR_LIMIT);
  if (!cap.ok) throw buildOverLimitError(current.content, content, STANDING_CHAR_LIMIT);

  const backupPath = await backup(scopeId(rootPath), p.standingMd, current.content, opts.homeDir);
  await atomicWrite(p.standingMd, content);
  log.info("standing instructions written", { root: path.basename(rootPath), chars: cap.used, nearLimit: cap.nearLimit });
  return { path: p.standingMd, chars: cap.used, limit: cap.limit, backupPath, nearLimit: cap.nearLimit };
}

export async function listDaily(rootPath: string): Promise<string[]> {
  const p = resolvePaths(rootPath);
  try {
    const names = await readdir(p.dailyDir);
    return names.filter((n) => n.endsWith(".md")).sort().reverse();
  } catch {
    return [];
  }
}

async function readFileAt(file: string, limit: number): Promise<MemoryFile> {
  try {
    const content = await readFile(file, "utf8");
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      /* 读到了内容就够了，mtime 拿不到不致命 */
    }
    return { path: file, content, chars: measure(content), limit, exists: true, mtimeMs };
  } catch {
    return { path: file, content: "", chars: 0, limit, exists: false, mtimeMs: 0 };
  }
}

// ---- 写 ----

/**
 * 覆盖写 MEMORY.md。
 * 顺序：查容量 → 备份 → 原子写。超限直接抛错，**磁盘上不发生任何变化**。
 */
export async function writeLongTerm(
  rootPath: string,
  content: string,
  opts: { homeDir: string },
): Promise<WriteResult> {
  const p = resolvePaths(rootPath);
  const current = await readFileAt(p.memoryMd, MEMORY_CHAR_LIMIT);
  const cap = checkCapacity(current.content, content);

  if (!cap.ok) throw buildOverLimitError(current.content, content);

  await ensureLayout(rootPath);
  const backupPath = await backup(scopeId(rootPath), p.memoryMd, current.content, opts.homeDir);
  await atomicWrite(p.memoryMd, content);

  log.info("project memory written", {
    root: path.basename(rootPath),
    chars: cap.used,
    limit: cap.limit,
    nearLimit: cap.nearLimit,
  });
  return {
    path: p.memoryMd,
    chars: cap.used,
    limit: cap.limit,
    backupPath,
    nearLimit: cap.nearLimit,
  };
}

/** 写某一天的流水摘要。**不设上限**（按天分片天然有界），但同样备份 + 原子写。 */
export async function writeDaily(
  rootPath: string,
  date: string,
  content: string,
  opts: { homeDir: string },
): Promise<WriteResult> {
  if (!isValidDate(date)) throw Object.assign(new Error(`bad date: ${date}`), { code: "bad_params" });
  const p = resolvePaths(rootPath);
  const file = path.join(p.dailyDir, `${date}.md`);
  const current = await readFileAt(file, Number.POSITIVE_INFINITY);

  await ensureLayout(rootPath);
  const backupPath = await backup(scopeId(rootPath), file, current.content, opts.homeDir);
  await atomicWrite(file, content);

  return { path: file, chars: measure(content), limit: Number.POSITIVE_INFINITY, backupPath, nearLimit: false };
}

/** 确保布局存在。幂等：目录在、文件有内容就什么都不做。 */
export async function ensureLayout(rootPath: string): Promise<ProjectMemoryPaths> {
  const p = resolvePaths(rootPath);
  await mkdir(p.dailyDir, { recursive: true });

  const existing = await readFileAt(p.memoryMd, MEMORY_CHAR_LIMIT);
  if (!existing.exists || existing.content.trim() === "") {
    await atomicWrite(p.memoryMd, MEMORY_TEMPLATE);
    log.info("project memory created", { root: path.basename(rootPath) });
  }

  const existingStanding = await readFileAt(p.standingMd, STANDING_CHAR_LIMIT);
  if (!existingStanding.exists || existingStanding.content.trim() === "") {
    await atomicWrite(p.standingMd, STANDING_TEMPLATE);
    log.info("standing instructions created", { root: path.basename(rootPath) });
  }

  return p;
}

// ---- 底层 ----

/** 原子写：先写同目录 tmp 再 rename —— 崩在中间也不会留下半个文件。 */
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (err: unknown) {
    // 某些文件系统上 rename 会因为目标已存在而失败（Windows 偶发）
    await writeFile(file, content, "utf8");
    log.warn("atomic rename fell back to direct write", { file, err: err instanceof Error ? err.message : String(err) });
  }
}

/** 写前备份到 homeDir/backups/<scopeKey>/，按时间淘汰超出份数的旧备份。 */
async function backup(
  scopeKey: string,
  file: string,
  currentContent: string,
  homeDir: string,
): Promise<string | null> {
  // 文件还不存在（首次创建）→ 没有可备份的内容
  if (currentContent.trim() === "") return null;

  const dir = path.join(homeDir, "backups", scopeKey);
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${path.basename(file, ".md")}-${stamp}.md`);
  await writeFile(dest, currentContent, "utf8");

  await pruneBackups(dir);
  return dest;
}

async function pruneBackups(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
    const excess = names.length - BACKUP_KEEP;
    if (excess <= 0) return;
    for (const name of names.slice(0, excess)) {
      // 备份是纯派生数据，淘汰最旧的；出问题还有 git 和用户自己编辑的历史
      await rm(path.join(dir, name), { force: true });
    }
  } catch (err: unknown) {
    log.warn("backup prune failed", { dir, err: err instanceof Error ? err.message : String(err) });
  }
}
