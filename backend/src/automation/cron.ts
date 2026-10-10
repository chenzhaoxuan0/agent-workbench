/**
 * 最小 cron —— 5 字段（分 时 日 月 周），本地时区。
 *
 * 支持口径刻意从简（避免第二套 cron 方言）：星号、数字、逗号列表、a-b 区间、步进（星号斜杠 n）。
 * 不支持：月份英文名、@hourly、秒级。到点判定按分钟粒度，
 * daemon 停机期间的错过不补跑（调度器的职责是「到点起会话」，不是补账）。
 */

export interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw Object.assign(new Error(`cron needs 5 fields: "${expr}"`), { code: "bad_cron" });
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    // 0-7 都允许，7 视作 0（周日）
    dow: parseField(parts[4]!, 0, 7),
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(",")) {
    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step < 1) throw Object.assign(new Error(`bad cron step: "${piece}"`), { code: "bad_cron" });

    let lo = min;
    let hi = max;
    if (rangePart !== undefined && rangePart !== "*") {
      const dash = rangePart.indexOf("-");
      if (dash >= 0) {
        lo = Number.parseInt(rangePart.slice(0, dash), 10);
        hi = Number.parseInt(rangePart.slice(dash + 1), 10);
      } else {
        lo = hi = Number.parseInt(rangePart, 10);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw Object.assign(new Error(`bad cron range: "${piece}"`), { code: "bad_cron" });
    }
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  if (out.size === 0) throw Object.assign(new Error(`empty cron field: "${field}"`), { code: "bad_cron" });
  return out;
}

export function cronMatches(fields: CronFields, d: Date): boolean {
  return (
    fields.minute.has(d.getMinutes()) &&
    fields.hour.has(d.getHours()) &&
    fields.dom.has(d.getDate()) &&
    fields.month.has(d.getMonth() + 1) &&
    fields.dow.has(d.getDay())
  );
}

/**
 * cron 表达式的下一次触发点（严格大于 from，本地时区）。
 *
 * 只有「没带 scheduleRule 的纯 cron 自动化」才走这里 —— 带 rule 的走共享引擎
 * （prototype/src/core/automation.ts）。按天扫（最多 400 天），每天的
 * 时×分组合取第一个大于 from 的，最坏几万次迭代，量级无虞。
 */
export function cronNextAt(expr: string, from = Date.now()): number | null {
  const f = parseCron(expr);
  const start = new Date(from);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 146_000; i++) {
    if (f.month.has(day.getMonth() + 1) && f.dom.has(day.getDate()) && f.dow.has(day.getDay())) {
      const minutes = [...f.minute].sort((a, b) => a - b);
      for (const h of [...f.hour].sort((a, b) => a - b)) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
          if (t > from) return t;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}
