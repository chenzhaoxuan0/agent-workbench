/**
 * 记忆系统的后台调度（docs/10 §4.5 / §4.7）。
 *
 * 两件后台活：
 * - **每日总结** —— 把当天会话提炼成日报。按 cron 表达式跑，**默认一天两次**，
 *   且优先在凌晨（人不在的时候）。
 * - **curator** —— 按「间隔到了 **且** 用户空闲」跑记忆整理。
 *
 * 两条纪律来自 docs/10：
 * - **失败绝不外溢**：任何一轮炸了只记日志，绝不影响日常对话
 * - **不重复触发**：daemon 停机期间错过的不补跑，但同一分钟绝不跑两次
 *   （`AutomationScheduler` 也是这个口径 —— 调度器的职责是到点干活，不是补账）
 *
 * curator 刻意**不接 cron**：它的判据包含「用户空闲多久」，那是 cron 给不了的。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";
import { parseCron, cronMatches, type CronFields } from "../automation/cron.ts";
import { DailyDigest } from "./dailyDigest.ts";
import { runCurator, DEFAULT_CURATOR } from "./curator.ts";
import { DbMetaStore } from "./curator.ts";
import { stewardRoot } from "./steward.ts";
import type { Store } from "../store/db.ts";

/** 每日总结默认一天两次：凌晨 3:17 与下午 14:43（错开整点，避开整点拥塞）。 */
export const DEFAULT_DIGEST_CRON = "17 3,14 * * *";

/** curator 的门槛（hermes 的数值）。 */
export const CURATOR_INTERVAL_MS = DEFAULT_CURATOR.intervalHours * 3_600_000;
export const CURATOR_IDLE_MS = DEFAULT_CURATOR.minIdleHours * 3_600_000;

const TICK_MS = 60_000;

export interface MemorySchedulerOptions {
  readonly homeDir: string;
  readonly store: Store;
  /** 已知项目的 rootPath（决定日报写到哪个文件夹） */
  readonly knownProjects: () => readonly string[];
  /** curator 整理哪个项目；缺省整理管家自己 */
  readonly curatorRoot?: () => string;
  readonly digestCron?: string;
  readonly digestEnabled?: () => boolean;
  readonly curatorEnabled?: () => boolean;
  /** 外部记录「最近一次有对话活动」的时刻；没有就给 0 */
  readonly lastActivityAt?: () => number;
  /** curator 上次跑的落点 */
  readonly curatorStatePath?: string;
}

interface SchedulerState {
  lastDigestMinute: string | null;
  lastCuratorAt: number;
  lastActivityAt: number;
  firstSeenAt: number;
}

export class MemoryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private fields: CronFields;
  private statePath: string;
  private busy = false;

  constructor(private readonly opts: MemorySchedulerOptions) {
    this.fields = parseCron(opts.digestCron ?? DEFAULT_DIGEST_CRON);
    this.statePath = opts.curatorStatePath ?? path.join(opts.homeDir, "memory-scheduler.json");
  }

  start(): void {
    if (this.timer !== null) return;
    // 首次观测：把「上次跑过」记成现在，等价于推迟一个完整间隔
    void this.loadState().then((s) => {
      if (s.firstSeenAt === 0) {
        s.firstSeenAt = Date.now();
        s.lastCuratorAt = Date.now(); // curator 首次推迟
        return this.saveState(s);
      }
      return undefined;
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    log.info("memory scheduler started", { digestCron: this.opts.digestCron ?? DEFAULT_DIGEST_CRON, tickMs: TICK_MS });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async loadState(): Promise<SchedulerState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const o = JSON.parse(raw) as Partial<SchedulerState>;
      return {
        lastDigestMinute: o.lastDigestMinute ?? null,
        lastCuratorAt: o.lastCuratorAt ?? 0,
        lastActivityAt: o.lastActivityAt ?? 0,
        firstSeenAt: o.firstSeenAt ?? 0,
      };
    } catch {
      return { lastDigestMinute: null, lastCuratorAt: 0, lastActivityAt: 0, firstSeenAt: 0 };
    }
  }

  private async saveState(s: SchedulerState): Promise<void> {
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(s, null, 2), "utf8");
    } catch (err: unknown) {
      log.warn("memory scheduler state write failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 跑一轮。**同一分钟绝不跑第二次**；上一轮还没结束就跳过这轮。 */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await this.loadState();
      state.lastActivityAt = this.opts.lastActivityAt?.() ?? state.lastActivityAt;

      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
      const due = cronMatches(this.fields, now) && state.lastDigestMinute !== minuteKey;
      if (due) {
        state.lastDigestMinute = minuteKey;
        await this.saveState(state); // 先落盘再干活：崩了也不会同一分钟重跑
        if (this.opts.digestEnabled?.() !== false) await this.runDigest();
      }

      await this.runCuratorIfDue(state, now.getTime());
      await this.saveState(state);
    } catch (err: unknown) {
      log.error("memory scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async runDigest(): Promise<void> {
    try {
      const digest = new DailyDigest(this.opts.homeDir, { knownProjects: this.opts.knownProjects() });
      const r = await digest.run();
      log.info("memory digest done", { ran: r.ran, wrote: r.wrote.length, blocks: r.freshBlocks, scanned: r.scannedFiles });
    } catch (err: unknown) {
      log.error("memory digest crashed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runCuratorIfDue(state: SchedulerState, now: number): Promise<void> {
    if (this.opts.curatorEnabled?.() === false) return;
    if (now - state.lastCuratorAt < CURATOR_INTERVAL_MS) return;
    if (now - state.lastActivityAt < CURATOR_IDLE_MS) return; // 用户还在忙 —— curator 排后面
    state.lastCuratorAt = now; // 先记，再跑：失败也不至于每分钟重试
    try {
      const root = this.opts.curatorRoot?.() ?? stewardRoot(this.opts.homeDir);
      const r = await runCurator(root, { meta: new DbMetaStore(this.opts.store), homeDir: this.opts.homeDir }, DEFAULT_CURATOR);
      log.info("curator done", { root, ran: r.ran, transitions: r.transitions.length, skip: r.skipReason });
    } catch (err: unknown) {
      log.error("curator crashed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
