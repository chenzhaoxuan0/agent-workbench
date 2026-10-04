/**
 * curator —— 记忆/技能的后台整理员（docs/10 §4.7）。
 *
 * 用户 2026-10-04 的判断：「这个功能很重要，防止记忆的腐化。」
 *
 * 机制照搬 hermes 的 curator（`hermes-agent/website/.../features/curator.md`），
 * 但作用对象换成我们自己的记忆条目。两个阶段：
 *
 *   1. **确定性流转（不花钱）**：按「上次用在哪天」做 active → stale → archived
 *   2. **LLM 审查（花钱，用便宜模型）**：给合并/修补/归档建议
 *
 * 六条不可退让的纪律（全部来自 hermes 的实践，每条都是踩过坑的）：
 * - **永不自动删除**，最坏是归档，可一键还原
 * - **每次真动手之前先备份**，出错可回滚，且回滚本身也再备份一次
 * - **pinned 的条目一律跳过**，自动流转和 LLM 审查都跳过
 * - **空闲触发，不是 cron 硬跑**：间隔到了 *且* 用户闲着
 * - **首次运行推迟一个完整间隔**，给用户时间先看清楚
 * - **可 dry-run**：只看报告不动任何东西
 *
 * 遥测字段在 WP-3 就随 `memory_meta` 表一起埋好了 —— 这不是巧合：
 * curator 的每一个判断都依赖「上次什么时候用过」，没埋就永远算不出来。
 */

import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";
import { askModel } from "./llm.ts";
import { readLongTerm, resolvePaths, writeLongTerm } from "./projectMemory.ts";
import { MEMORY_CHAR_LIMIT } from "./limits.ts";

export type MemoryState = "active" | "stale" | "archived";

export interface CuratorConfig {
  /** 两次运行之间的最短间隔（小时） */
  readonly intervalHours: number;
  /** 用户得空闲这么久才动手（小时） */
  readonly minIdleHours: number;
  /** 超过多少天没被注入过 → stale */
  readonly staleAfterDays: number;
  /** 超过多少天没被注入过 → archived */
  readonly archiveAfterDays: number;
  /** LLM 审查这一轮最多读多少条 */
  readonly reviewLimit: number;
  /** 备份保留份数 */
  readonly backupKeep: number;
  /** dry-run：不写任何东西 */
  readonly dryRun: boolean;
}

export const DEFAULT_CURATOR: CuratorConfig = {
  intervalHours: 168, // 7 天
  minIdleHours: 2,
  staleAfterDays: 14,
  archiveAfterDays: 30,
  reviewLimit: 40,
  backupKeep: 5,
  dryRun: false,
};

/** 一条记忆的遥测（与 store 的 memory_meta 表一一对应）。 */
export interface MemoryMeta {
  readonly path: string;
  readonly bytes: number;
  readonly charUsed: number;
  readonly useCount: number;
  readonly lastUsedAt: number | null;
  readonly hitCount: number;
  readonly lastHitAt: number | null;
  readonly state: MemoryState;
  readonly pinned: boolean;
  readonly createdAt: number;
}

export interface CuratorTransition {
  readonly path: string;
  readonly from: MemoryState;
  readonly to: MemoryState;
  readonly reason: string;
}

export interface CuratorReviewNote {
  readonly path: string;
  readonly action: "keep" | "merge" | "patch" | "archive";
  readonly reason: string;
}

export interface CuratorReport {
  readonly ran: boolean;
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly transitions: CuratorTransition[];
  readonly notes: CuratorReviewNote[];
  readonly backupPath: string | null;
  readonly llmSkipReason?: string;
  readonly skipReason?: string;
  readonly elapsedMs: number;
}

const DAY = 86_400_000;

// ---- 遥测存取（状态就存在 memory_meta 表里，这里走一个窄接口） -----------

export interface MetaStore {
  list(prefix?: string): MemoryMeta[];
  get(p: string): MemoryMeta | undefined;
  upsert(m: MemoryMeta): void;
}

/** 纯内存实现（测试用）。 */
export class MemoryMetaStore implements MetaStore {
  private readonly rows = new Map<string, MemoryMeta>();
  list(prefix?: string): MemoryMeta[] {
    const all = [...this.rows.values()];
    return (prefix === undefined ? all : all.filter((m) => m.path.startsWith(prefix))).sort((a, b) => a.path.localeCompare(b.path));
  }
  get(p: string): MemoryMeta | undefined {
    return this.rows.get(p);
  }
  upsert(m: MemoryMeta): void {
    this.rows.set(m.path, m);
  }
}

/** 真运行时实现：接 store 的 memory_meta 表。 */
export class DbMetaStore implements MetaStore {
  constructor(
    private readonly store: {
      listMemoryMeta(prefix?: string): Array<{
        path: string; bytes: number; charUsed: number; useCount: number;
        lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
        state: string; pinned: boolean; createdAt: number;
      }>;
      upsertMemoryMeta(m: {
        path: string; bytes: number; charUsed: number; useCount: number;
        lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
        state: string; pinned: boolean; createdAt: number;
      }): void;
    },
  ) {}
  list(prefix?: string): MemoryMeta[] {
    return this.store.listMemoryMeta(prefix).map((r) => ({ ...r, state: r.state as MemoryState }));
  }
  get(p: string): MemoryMeta | undefined {
    return this.list().find((m) => m.path === p);
  }
  upsert(m: MemoryMeta): void {
    const { pinned, ...rest } = m;
    this.store.upsertMemoryMeta({ ...rest, pinned });
  }
}

// ---- 阶段 1：确定性流转 ----------------------------------------------------

/**
 * 按「上次被注入过在哪天」做状态流转。**不调用任何 LLM**，纯算时间。
 * pinned 的条目一律跳过 —— 自动流转和 LLM 审查都跳。
 */
export function planTransitions(metas: readonly MemoryMeta[], now: number, cfg: CuratorConfig): CuratorTransition[] {
  const out: CuratorTransition[] = [];
  for (const m of metas) {
    if (m.pinned) continue;
    if (m.state === "archived") continue; // 归档是终态，除非手工还原
    const ref = m.lastUsedAt ?? m.createdAt;
    const ageDays = Math.floor((now - ref) / DAY);
    const want: MemoryState = ageDays >= cfg.archiveAfterDays ? "archived" : ageDays >= cfg.staleAfterDays ? "stale" : "active";
    if (want === m.state) continue;
    out.push({
      path: m.path,
      from: m.state,
      to: want,
      reason: m.lastUsedAt === null ? `建档后 ${ageDays} 天从未被注入过` : `上次注入在 ${ageDays} 天前`,
    });
  }
  return out;
}

// ---- 阶段 2：LLM 审查 ------------------------------------------------------

export function buildReviewPrompt(entries: readonly MemoryMeta[]): string {
  const body = entries
    .map((m) => {
      const used = m.lastUsedAt === null ? "从未" : `${Math.floor(Date.now() / DAY) - Math.floor(m.lastUsedAt / DAY)} 天前`;
      return `- [${m.state}] ${m.path}（${m.charUsed} 字符，上次注入：${used}，被注入 ${m.useCount} 次）`;
    })
    .join("\n");
  return [
    "你在给一个项目维护记忆表。下面每条是一段项目级事实，附它的使用情况。",
    "",
    "逐条给出处理建议：",
    "- keep    保留原样（绝大多数条目都该是这个）",
    "- merge   和另一条太像/重复，建议合并（reason 里写和哪条合）",
    "- patch   内容已过期或描述不准，需要改（reason 里写该改成什么）",
    "- archive 内容已完全不成立（reason 里写为什么）",
    "",
    "**默认倾向 keep。** 记忆表是要长期用的，宁可保守也不要误删。",
    "",
    "只输出 JSON 数组，不要任何其他文字：",
    '[{"path":"...","action":"keep","reason":"..."}]',
    "",
    "条目：",
    body,
  ].join("\n");
}

export async function reviewEntries(
  metas: readonly MemoryMeta[],
  opts: { command?: string; limit?: number },
): Promise<{ notes: CuratorReviewNote[]; skipReason?: string }> {
  const pool = metas.filter((m) => m.state !== "archived" && !m.pinned).slice(0, opts.limit ?? DEFAULT_CURATOR.reviewLimit);
  if (pool.length === 0) return { notes: [] };

  const r = await askModel(buildReviewPrompt(pool), { timeoutMs: 600_000, ...(opts.command === undefined ? {} : { command: opts.command }) });
  if (!r.ok) return { notes: [], skipReason: r.skipReason ?? "模型不可用" };

  const start = r.text.indexOf("[");
  const end = r.text.lastIndexOf("]");
  if (start < 0 || end <= start) return { notes: [], skipReason: "审查输出里没有 JSON 数组" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text.slice(start, end + 1));
  } catch {
    return { notes: [], skipReason: "审查输出不可解析" };
  }
  if (!Array.isArray(parsed)) return { notes: [], skipReason: "审查输出不是数组" };

  const known = new Set(pool.map((m) => m.path));
  const notes: CuratorReviewNote[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const p = item["path"];
    const a = item["action"];
    if (typeof p !== "string" || !known.has(p)) continue; // 模型编的路径一律丢
    if (a !== "keep" && a !== "merge" && a !== "patch" && a !== "archive") continue;
    notes.push({ path: p, action: a, reason: typeof item["reason"] === "string" ? (item["reason"] as string).slice(0, 300) : "" });
  }
  return { notes };
}

// ---- 备份 / 回滚 ----------------------------------------------------------

export interface CuratorBackup {
  readonly dir: string;
  readonly file: string;
  readonly entries: Array<{ path: string; target: string }>;
}

/** 动手之前把要改的文件打包。内容是纯文本，拼 tar 反而麻烦 —— 直接存一份 JSON。 */
export async function snapshot(files: readonly string[], homeDir: string): Promise<CuratorBackup | null> {
  const items: Array<{ path: string; target: string; content: string }> = [];
  for (const f of files) {
    try {
      items.push({ path: f, target: path.basename(f), content: await readFile(f, "utf8") });
    } catch {
      /* 文件没了就跳过 */
    }
  }
  if (items.length === 0) return null;

  const dir = path.join(homeDir, "backups", "curator", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  for (const it of items) await writeFile(path.join(dir, it.target), it.content, "utf8");
  const file = path.join(dir, "manifest.json");
  await writeFile(file, JSON.stringify({ at: Date.now(), entries: items.map(({ path: p, target: t }) => ({ path: p, target: t })) }, null, 2), "utf8");

  await prune(dir);
  return { dir, file, entries: items.map(({ path: p, target: t }) => ({ path: p, target: t })) };
}

async function prune(dir: string): Promise<void> {
  try {
    const root = path.dirname(dir);
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - DEFAULT_CURATOR.backupKeep))) {
      await rm(path.join(root, name), { recursive: true, force: true });
    }
  } catch (err: unknown) {
    log.warn("curator backup prune failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---- 触发条件 -------------------------------------------------------------

export interface CuratorGate {
  readonly lastRunAt: number;
  readonly lastActivityAt: number;
  readonly firstRun: boolean;
}

/**
 * 什么时候该动手。
 * hermes 的判据是「间隔到了 **且** 用户闲着」。首次运行**推迟一个完整间隔**，
 * 给人一整段时间先看看它会干什么 —— 而不是装好就动。
 */
export function shouldRun(gate: CuratorGate, now: number, cfg: CuratorConfig): { run: boolean; reason: string } {
  if (gate.firstRun) return { run: false, reason: `首次运行推迟 ${cfg.intervalHours}h（装好后先看看它要干什么）` };
  const sinceRun = (now - gate.lastRunAt) / 3_600_000;
  if (sinceRun < cfg.intervalHours) return { run: false, reason: `距上次运行才 ${Math.floor(sinceRun)}h（要满 ${cfg.intervalHours}h）` };
  const idle = (now - gate.lastActivityAt) / 3_600_000;
  if (idle < cfg.minIdleHours) return { run: false, reason: `你才闲置 ${Math.floor(idle)}h（要满 ${cfg.minIdleHours}h）` };
  return { run: true, reason: "间隔到了，且用户空闲" };
}

// ---- 主流程 ---------------------------------------------------------------

export interface CuratorDeps {
  readonly meta: MetaStore;
  readonly homeDir: string;
  readonly command?: string;
  /** 归档/复原要真的动文件时，注入这个（测试与 dry-run 用不到） */
  readonly commit?: (path: string, action: "stale" | "archive" | "restore") => Promise<void>;
}

/**
 * 跑一轮。**永不抛错**（对齐日常任务纪律）：任何一步炸了都进报告，
 * 不能把 daemon 带崩。
 */
export async function runCurator(
  rootPath: string,
  deps: CuratorDeps,
  cfg: CuratorConfig = DEFAULT_CURATOR,
  opts: { now?: number; gate?: CuratorGate } = {},
): Promise<CuratorReport> {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const empty: CuratorReport = {
    ran: false, dryRun: cfg.dryRun, scanned: 0, transitions: [], notes: [],
    backupPath: null, elapsedMs: 0,
  };
  try {
    if (opts.gate !== undefined) {
      const g = shouldRun(opts.gate, now, cfg);
      if (!g.run) return { ...empty, skipReason: g.reason, elapsedMs: Date.now() - t0 };
    }

    const prefix = resolvePaths(rootPath).root;
    const metas = deps.meta.list(prefix);
    if (metas.length === 0) return { ...empty, skipReason: "没有可整理的记忆条目", elapsedMs: Date.now() - t0 };

    // 阶段 1：确定性流转（不花钱）
    const transitions = planTransitions(metas, now, cfg);
    const changedPaths = transitions.map((t) => t.path);
    const toTouch = [...new Set([...changedPaths, ...metas.filter((m) => !m.pinned && m.state !== "archived").map((m) => m.path)])];

    // 动手之前先备份（dry-run 不备份）
    const backup = cfg.dryRun ? null : await snapshot(toTouch, deps.homeDir);

    if (deps.commit !== undefined) {
      for (const t of transitions) await deps.commit(t.path, t.to === "archived" ? "archive" : t.to === "stale" ? "stale" : "restore");
    }

    // 阶段 2：LLM 审查
    const review = await reviewEntries(metas, { ...(deps.command === undefined ? {} : { command: deps.command }), limit: cfg.reviewLimit });

    return {
      ran: true,
      dryRun: cfg.dryRun,
      scanned: metas.length,
      transitions,
      notes: review.notes,
      backupPath: backup?.dir ?? null,
      ...(review.skipReason === undefined ? {} : { llmSkipReason: review.skipReason }),
      elapsedMs: Date.now() - t0,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("curator failed", { error: msg });
    return { ...empty, skipReason: `curator 异常：${msg}`, elapsedMs: Date.now() - t0 };
  }
}

/** 复原：把归档的条目放回 active。**只有人能做**（LLM 不许复活）。 */
export async function restore(memoryMd: string, backupDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8")) as {
      entries: Array<{ path: string; target: string }>;
    };
    for (const e of manifest.entries) {
      if (path.resolve(e.path) !== path.resolve(memoryMd)) continue;
      await writeFile(memoryMd, await readFile(path.join(backupDir, e.target), "utf8"), "utf8");
      return true;
    }
  } catch (err: unknown) {
    log.warn("curator restore failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return false;
}

/** 报告渲染成 Markdown（写进 `~/.agentworkbench/logs/curator/<ts>/REPORT.md`）。 */
export function renderReport(r: CuratorReport, cfg: CuratorConfig): string {
  const lines: string[] = [
    `# curator ${r.dryRun ? "[dry-run] " : ""}${new Date().toISOString()}`,
    "",
    `- 条目数：${r.scanned}`,
    `- 状态流转：${r.transitions.length}`,
    `- LLM 审查：${r.notes.length}${r.llmSkipReason === undefined ? "" : `（跳过：${r.llmSkipReason}）`}`,
    `- 备份：${r.backupPath ?? "（dry-run 未备份）"}`,
    "",
  ];
  if (r.transitions.length > 0) {
    lines.push("## 状态流转", "", "| 条目 | 从 | 到 | 原因 |", "|---|---|---|---|");
    for (const t of r.transitions) lines.push(`| ${path.basename(t.path)} | ${t.from} | ${t.to} | ${t.reason} |`);
    lines.push("");
  }
  if (r.notes.length === 0) {
    lines.push("## 审查建议", "", r.llmSkipReason === undefined ? "（本轮没有可审查的条目）" : `（本轮跳过：${r.llmSkipReason}）`, "");
  } else {
    const actionable = r.notes.filter((n) => n.action !== "keep");
    if (actionable.length > 0) {
      lines.push("## 审查建议", "");
      for (const n of actionable) lines.push(`- **${n.action}** \`${path.basename(n.path)}\` —— ${n.reason}`);
      lines.push("");
    } else {
      lines.push("## 审查建议", "", "全部建议保留原样。记忆表状态健康。", "");
    }
  }
  lines.push(
    "---",
    "",
    r.dryRun
      ? "> **这是 dry-run：以上一条都没执行。** 去掉 --dryRun 才会真的动手。"
      : "> LLM 审查只提建议，**一条都没执行**。状态流转已按上表应用。",
    "> pinned 的条目自动流转与审查都会跳过。归档随时可 `restore` 回来。",
    "",
  );
  void cfg;
  return lines.join("\n");
}

export type { MemoryFile } from "./projectMemory.ts";
export { MEMORY_CHAR_LIMIT };
export async function currentState(rootPath: string): Promise<{ chars: number; limit: number; nearLimit: boolean }> {
  const f = await readLongTerm(rootPath);
  return { chars: f.chars, limit: f.limit, nearLimit: f.chars / f.limit >= 0.8 };
}
export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
export { writeLongTerm };
