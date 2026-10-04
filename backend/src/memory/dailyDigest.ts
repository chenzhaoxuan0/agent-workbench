/**
 * 每日总结任务（docs/10 §4.5）—— 「不建索引」方案成立的前提。
 *
 * 四条硬规则，任何一条破了就说明这套东西在腐化：
 *
 * 1. **增量**：只读上次运行后新增或 mtime 变化过的文件。
 *    没有这个，1.6GB 每跑一次就是全量重扫。
 * 2. **幂等**：输出文件名含日期，**同日重跑整份重写**（不是追加）。
 *    追加会让「跑两次」的日报里同一天出现两遍。
 * 3. **失败不阻塞**：任何一步炸了只记日志，**绝不影响日常对话**。
 *    记忆是增强，不是前置条件。
 * 4. **按天 + 按项目双层切分**：一个日报不能覆盖所有项目。
 *
 * 归属是这道题最难的部分：块的 cwd 可能解析不出来（mcode 压根不带 cwd），
 * 解析不出来就**不写**，绝不瞎猜写到别处去。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";
import { scan, type ScanOptions, type ScannedBlock, type ScanSource } from "./scanner.ts";
import { writeDaily } from "./projectMemory.ts";
import { askModel } from "./llm.ts";
import { redact } from "./redact.ts";

/** 已处理文件台账。放 homeDir 下，纯派生数据，删了会全量重扫但不丢东西。 */
export interface DigestState {
  readonly version: 1;
  readonly files: Record<string, { mtime: number; size: number }>;
  readonly lastRunAt: number;
  readonly lastDate: string | null;
}

const EMPTY: DigestState = { version: 1, files: {}, lastRunAt: 0, lastDate: null };

/** 本地日期（不是 UTC —— 「今天」按用户所在时区算）。 */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 把 cwd 解析成一个已知项目的 bot 文件夹；解析不到/不是已知项目 → null。 */
export type ProjectResolver = (cwd: string | undefined) => string | null;

export interface DigestDeps {
  /** 已知项目的 rootPath 列表（来自 bot 注册表） */
  readonly knownProjects: readonly string[];
  /** 摘要器。注入而非硬编码 —— 便于测试，也便于将来换模型。 */
  readonly summarize?: (blocks: readonly ScannedBlock[], ctx: { date: string; project: string }) => Promise<string>;
  readonly sources?: readonly ScanSource[];
  readonly command?: string;
}

export interface DigestResult {
  readonly ran: boolean;
  /** 本轮是不是演练。UI 要靠它区分「试跑」和「真跑」——两者都返回 ran/skipped。 */
  readonly dryRun: boolean;
  readonly date: string;
  readonly scannedFiles: number;
  readonly freshFiles: number;
  readonly freshBlocks: number;
  readonly wrote: string[];
  readonly skipped: Array<{ project: string; reason: string }>;
  readonly skipReason?: string;
  readonly error?: string;
}

export class DailyDigest {
  private readonly statePath: string;

  constructor(
    private readonly homeDir: string,
    private readonly deps: DigestDeps,
  ) {
    this.statePath = path.join(homeDir, "digest-state.json");
  }

  private async loadState(): Promise<DigestState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const o = JSON.parse(raw) as Partial<DigestState>;
      if (o?.version !== 1 || typeof o.files !== "object" || o.files === null) return EMPTY;
      return { version: 1, files: o.files, lastRunAt: o.lastRunAt ?? 0, lastDate: o.lastDate ?? null };
    } catch {
      return EMPTY; // 没有台账 = 第一次跑
    }
  }

  private async saveState(s: DigestState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(s, null, 2), "utf8");
  }

  private resolver(): ProjectResolver {
    const known = new Set(this.deps.knownProjects.map((p) => path.resolve(p).toLowerCase()));
    return (cwd) => {
      if (cwd === undefined || cwd === "") return null;
      const norm = path.resolve(cwd).toLowerCase();
      if (known.has(norm)) return path.resolve(cwd);
      // cwd 可能是项目的子目录 —— 往上找一层看看是不是已知项目
      let cur = path.dirname(path.resolve(cwd));
      for (let i = 0; i < 4; i++) {
        if (known.has(cur.toLowerCase())) return cur;
        const next = path.dirname(cur);
        if (next === cur) break;
        cur = next;
      }
      return null;
    };
  }

  async run(opts: { date?: string; dryRun?: boolean; force?: boolean; lookbackHours?: number } = {}): Promise<DigestResult> {
    const date = opts.date ?? localDate();
    const dryRun = opts.dryRun === true;
    const base: DigestResult = { ran: false, dryRun, date, scannedFiles: 0, freshFiles: 0, freshBlocks: 0, wrote: [], skipped: [] };

    try {
      const state = opts.force === true ? EMPTY : await this.loadState();
      const since = opts.force === true
        ? Date.now() - (opts.lookbackHours ?? 36) * 3600_000
        : state.lastRunAt > 0
          ? state.lastRunAt
          : Date.now() - (opts.lookbackHours ?? 36) * 3600_000;

      const resolve = this.resolver();
      /** project rootPath → 这次要写的块 */
      const byProject = new Map<string, ScannedBlock[]>();
      const seenFiles = new Set<string>();
      let scannedFiles = 0;
      let freshBlocks = 0;

      const scanOpts: ScanOptions = {
        since,
        chunkChars: 800, // 日报按整段看，块可以大一点
        ...(this.deps.sources === undefined ? {} : { sources: this.deps.sources }),
      };

      for await (const b of scan(scanOpts)) {
        if (!seenFiles.has(b.srcPath)) {
          seenFiles.add(b.srcPath);
          scannedFiles++;
        }
        // 解析不到归属 → 不写，绝不瞎猜
        const proj = resolve(b.cwd);
        if (proj === null) continue;
        const list = byProject.get(proj) ?? [];
        // 一个项目一次最多喂 200 块，防止一天 1GB 把 prompt 撑爆
        if (list.length < 200) list.push(b);
        byProject.set(proj, list);
        freshBlocks++;
      }

      if (byProject.size === 0) {
        const out: DigestResult = { ...base, scannedFiles, freshFiles: 0, freshBlocks: 0, skipReason: "窗口内没有可归属到已知项目的会话" };
        if (!dryRun) await this.saveState({ ...state, lastRunAt: Date.now(), lastDate: date });
        return out;
      }

      const wrote: string[] = [];
      const skipped: Array<{ project: string; reason: string }> = [];

      for (const [proj, blocks] of byProject) {
        const summary = dryRun
          ? `[dry-run] ${blocks.length} 块待摘要`
          : await this.runSummarizer(blocks, { date, project: proj });
        if (summary === null) {
          skipped.push({ project: proj, reason: "摘要器不可用或失败" });
          continue;
        }
        if (dryRun) {
          wrote.push(path.join(proj, "memory", "daily", `${date}.md`));
          continue;
        }
        try {
          const body = renderDaily({ date, project: proj, summary, blockCount: blocks.length, clis: [...new Set(blocks.map((b) => b.cli))] });
          const r = await writeDaily(proj, date, body, { homeDir: this.homeDir });
          wrote.push(r.path);
        } catch (err: unknown) {
          skipped.push({ project: proj, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      // 规则 2 的台账侧：记录本次扫过的文件（含 mtime/size），下次就能跳过
      if (!dryRun) {
        const nextFiles: Record<string, { mtime: number; size: number }> = { ...state.files };
        for (const f of seenFiles) {
          try {
            const st = await stat(f);
            nextFiles[f] = { mtime: st.mtimeMs, size: st.size };
          } catch {
            // 扫完文件就没了（临时目录）→ 不记，下次自然重扫
          }
        }
        await this.saveState({ version: 1, files: nextFiles, lastRunAt: Date.now(), lastDate: date });
      }

      return { ran: true, dryRun, date, scannedFiles, freshFiles: seenFiles.size, freshBlocks, wrote, skipped };
    } catch (err: unknown) {
      // 规则 3：失败只记日志，不往上抛
      const msg = err instanceof Error ? err.message : String(err);
      log.error("daily digest failed", { error: msg });
      return { ...base, error: msg };
    }
  }

  private async runSummarizer(blocks: readonly ScannedBlock[], ctx: { date: string; project: string }): Promise<string | null> {
    if (this.deps.summarize !== undefined) {
      try {
        return await this.deps.summarize(blocks, ctx);
      } catch (err: unknown) {
        log.warn("summarizer threw", { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
    // 默认摘要器：一次 LLM 调用
    const transcript = blocks
      .map((b) => `[${new Date(b.ts).toISOString().slice(11, 16)}·${b.cli}] ${b.text}`)
      .join("\n")
      .slice(0, 40_000);
    const r = await askModel(buildSummaryPrompt(transcript, ctx), ...(this.deps.command === undefined ? [] : [{ command: this.deps.command }]));
    if (!r.ok) {
      log.warn("digest summarize skipped", { reason: r.skipReason });
      return null;
    }
    return redact(r.text);
  }
}

/** 日报正文。人读优先 —— 三个月后回看的人是我和你。 */
export function renderDaily(ctx: { date: string; project: string; summary: string; blockCount: number; clis: readonly string[] }): string {
  return [
    `# ${ctx.date} 会话摘要`,
    "",
    `> ${path.basename(ctx.project)} · ${ctx.clis.join(" / ")} · ${ctx.blockCount} 块`,
    "> 由 workbench 每日总结任务自动生成。同日重跑会整份覆盖。",
    "",
    ctx.summary.trim(),
    "",
  ].join("\n");
}

export function buildSummaryPrompt(transcript: string, ctx: { date: string; project: string }): string {
  return [
    `你在为「${path.basename(ctx.project)}」项目整理 ${ctx.date} 这一天的会话流水。`,
    "",
    "目标：**只留下三个月后还查得到的东西**。",
    "",
    "要写：",
    "- 做了什么决定、结论是什么",
    "- 达成的约定（技术选型、写法、参数）",
    "- 踩过的坑与解法（尤其是反直觉的）",
    "- 完成的重要工作",
    "",
    "不要写：",
    "- 流水账（\"用户问了 X\"）",
    "- 一次性的中间过程、临时路径、无关紧要的报错",
    "- 能重新查到的东西",
    "",
    "格式：Markdown 小标题分组，每条一行，以 `- ` 开头。总长控制在 30 行以内。",
    "",
    "以下是当天的会话流水（已按时间混排，可能是多个 CLI 的）：",
    "---",
    transcript,
    "---",
  ].join("\n");
}
