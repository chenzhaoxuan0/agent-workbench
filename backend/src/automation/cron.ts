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
