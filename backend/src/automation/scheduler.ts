/**
 * 自动化调度器（Phase 5）—— daemon 内 cron，到点起会话，运行记录落盘（docs/06 Phase 5）。
 *
 * 结构：tick 每 20 秒扫一遍 enabled 的自动化；cron 命中当前分钟且这一分钟
 * 还没发过火，就调 runner（由 host 侧注入：起会话 + 挂 run 记录）。
 * 会话结束态由 host 的事件流回灌（markFinished），调度器只管「到点没到点」。
 */

import { cronMatches, parseCron } from "./cron.ts";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

export type AutomationRunner = (a: {
  id: number;
  unitId: string;
  unitName: string;
  runtimeId: string;
  rootPath: string;
  prompt: string;
  model: string | null;
  mode: string | null;
}) => Promise<{ runId: number; sessionId: string }>;

const TICK_MS = 20_000;

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** 已发过火的分钟（本地时区 YYYY-MM-DD HH:mm），防同分钟重复 */
  private lastFiredMinute = "";
  private readonly crons = new Map<number, ReturnType<typeof parseCron>>();

  constructor(
    private readonly store: Store,
    private readonly run: AutomationRunner,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    log.info("automation scheduler started", { tickMs: TICK_MS });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (minuteKey === this.lastFiredMinute) return;
    this.lastFiredMinute = minuteKey;

    for (const a of this.store.listAutomations()) {
      if (!a.enabled) continue;
      let fields = this.crons.get(a.id);
      if (fields === undefined) {
        try {
          fields = parseCron(a.cron);
        } catch (err: unknown) {
          log.warn("automation has bad cron, skipping", { id: a.id, cron: a.cron, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        this.crons.set(a.id, fields);
      }
      if (!cronMatches(fields, now)) continue;
      log.info("automation due, firing", { id: a.id, cron: a.cron });
      void this.run(a).catch((err: unknown) =>
        log.warn("automation run failed", { id: a.id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  /** cron 变更后清缓存 */
  invalidate(id: number): void {
    this.crons.delete(id);
  }
}
