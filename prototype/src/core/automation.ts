/**
 * 自动化 / 定时任务 —— 员工模式的时间维度。
 *
 * 设计对齐 ZCode 的 automation 模型：
 * **权威数据是结构化 scheduleRule，不是裸 cron 字符串。**
 * cron 只在「自定义」时作为兜底展示，因为纯解析 cron 会把
 * 「每 30 个月」误显成「每月」、把一次性的「4 分钟后」误显成「每 4 分钟」。
 */

// ---------------------------------------------------------------------------
// 频率
// ---------------------------------------------------------------------------

export type Frequency = "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** 每周的星期，0=周日 … 6=周六 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ScheduleRule {
  readonly frequency: Frequency;
  /** daily / custom 时的触发时刻 */
  readonly hour: number;
  readonly minute: number;
  /** weekly 时生效的星期 */
  readonly weekdays: readonly Weekday[];
  /** monthly 时生效的日 */
  readonly dayOfMonth: number;
  /** custom 时：间隔数 + 单位 */
  readonly interval?: number;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | "months";
  /** custom 时的原始 cron 表达式 */
  readonly rawExpr?: string;
  /** 相对锚点，用于「4 分钟后」这类一次性任务 */
  readonly anchorAt?: number;
}

export type RunStatus = "idle" | "running" | "completed" | "failed" | "paused";

export interface AutomationRun {
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: Exclude<RunStatus, "idle" | "paused">;
  readonly summary?: string;
}

export interface Automation {
  readonly id: string;
  readonly name: string;
  /** 关联的工作单元 id —— 员工模式下自动化是「谁」在干活 */
  readonly unitId: string;
  readonly description?: string;
  /** 跑这条自动化的执行器 */
  readonly runtimeId: string;
  readonly rule: ScheduleRule;
  readonly enabled: boolean;
  /** 一次性任务跑完即停 */
  readonly recurring: boolean;
  readonly maxRuns?: number;
  readonly runs: readonly AutomationRun[];
  /** 跑出来的产出，指向 deliverables */
  readonly deliverableIds: readonly string[];
  readonly createdAt: number;
  /** 最近一次失败会一直挂着徽章，不被后续成功覆盖 —— 对齐 ZCode 的 hasAutomationFailureState */
  readonly lastFailure?: { at: number; reason: string };
}

// ---------------------------------------------------------------------------
// 人类可读描述 —— 对齐 ZCode 的 describeCron / describeCronBuilder
// ---------------------------------------------------------------------------

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** 「08:30」 */
export function formatClock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** 频率描述，不含时刻 —— 对齐 ZCode 的 describeCronBuilder 输出形态 */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.frequency) {
    case "hourly":
      return "每小时";
    case "daily":
      return "每天";
    case "weekly": {
      if (rule.weekdays.length === 0) return "每周";
      if (rule.weekdays.length === 7) return "每天";
      if (isConsecutiveDays(rule.weekdays)) {
        const [a, b] = [rule.weekdays[0]!, rule.weekdays.at(-1)!];
        return `每${WEEKDAY_ZH[a]}至${WEEKDAY_ZH[b]}`;
      }
      return `每${rule.weekdays.map((d) => WEEKDAY_ZH[d]).join("、")}`;
    }
    case "monthly":
      return rule.dayOfMonth === 1 ? "每月" : `每月 ${rule.dayOfMonth} 日`;
    case "custom": {
      const n = rule.interval ?? 1;
      if (!rule.unit) return "自定义";
      const unitZh = {
        minutes: "分钟",
        hours: "小时",
        days: "天",
        weeks: "周",
        months: "个月",
      }[rule.unit];
      return n === 1 ? `每${unitZh}` : `每 ${n} ${unitZh}`;
    }
  }
}

function isConsecutiveDays(days: readonly Weekday[]): boolean {
  if (days.length < 2) return false;
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
}

/** 完整的一行描述：频率 + 时刻。对齐 ZCode 卡片上的 schedule 文案 */
export function describeSchedule(a: Pick<Automation, "rule" | "recurring" | "maxRuns">): string {
  // 一次性任务没有频率，真实时机由「下次运行」承载 —— 对齐 ZCode 的处理
  if (a.recurring === false && (a.maxRuns ?? 1) <= 1) return "自定义";
  const { rule } = a;
  if (rule.frequency === "hourly") return describeRule(rule);
  if (rule.frequency === "weekly" && rule.weekdays.length === 0) return describeRule(rule);
  return `${describeRule(rule)} ${formatClock(rule.hour, rule.minute)}`;
}

// ---------------------------------------------------------------------------
// 下次运行
// ---------------------------------------------------------------------------

/**
 * 算下一次触发时间。
 * 一次性任务用 anchorAt + interval 表达相对时间，不走日历推进。
 */
export function nextRunAt(a: Automation, from = Date.now()): number | null {
  if (!a.enabled) return null;
  if (a.recurring === false && (a.maxRuns ?? 1) <= 1) {
    if (a.runs.length >= (a.maxRuns ?? 1)) return null;
    return a.rule.anchorAt ?? null;
  }

  const { rule } = a;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(rule.minute);
  d.setHours(rule.hour);

  const step = (() => {
    switch (rule.frequency) {
      case "hourly":
        return () => d.setHours(d.getHours() + 1);
      case "daily":
        return () => d.setDate(d.getDate() + 1);
      case "weekly": {
        const days = rule.weekdays.length > 0 ? rule.weekdays : [1];
        return () => d.setDate(d.getDate() + 1);
      }
      case "monthly":
        return () => d.setMonth(d.getMonth() + 1);
      case "custom": {
        const n = rule.interval ?? 1;
        switch (rule.unit) {
          case "minutes":
            return () => d.setMinutes(d.getMinutes() + n);
          case "hours":
            return () => d.setHours(d.getHours() + n);
          case "days":
            return () => d.setDate(d.getDate() + n);
          case "weeks":
            return () => d.setDate(d.getDate() + n * 7);
          case "months":
            return () => d.setMonth(d.getMonth() + n);
          default:
            return () => d.setDate(d.getDate() + n);
        }
      }
    }
  })();

  // 最多推进 400 天仍不匹配就放弃，避免 weekly 配错导致死循环
  for (let i = 0; i < 400; i++) {
    if (d.getTime() > from) {
      if (rule.frequency !== "weekly") return d.getTime();
      if (rule.weekdays.includes(d.getDay() as Weekday)) return d.getTime();
    }
    step();
  }
  return null;
}

/** 「3 小时后」 / 「2 天前」 —— 对齐 ZCode 的 formatAutomationCardNextRun */
export function formatRelative(target: number, from = Date.now()): string {
  const diff = target - from;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "后" : "前";

  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.round(abs / 3_600_000);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.round(abs / 86_400_000);
  if (day < 30) return `${day} 天${suffix}`;
  return new Date(target).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 卡片状态徽章。
 * 分组口径：**以卡片实际展示的徽章为准** —— 用户看到什么颜色就落在哪一组。
 * 对齐 ZCode 的 automationStatusFilter 注释。
 */
export function resolveStatusKind(a: Automation): "inProgress" | "completed" | "failed" {
  if (a.lastFailure) return "failed";
  const last = a.runs.at(-1);
  if (!last) return "inProgress";
  if (last.status === "completed") return "completed";
  if (last.status === "failed") return "failed";
  return "inProgress";
}

export const STATUS_FILTERS = ["all", "inProgress", "completed", "failed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "全部",
  inProgress: "进行中",
  completed: "已完成",
  failed: "失败",
};

export function filterByStatus(list: readonly Automation[], f: StatusFilter): readonly Automation[] {
  if (f === "all") return list;
  return list.filter((a) => resolveStatusKind(a) === f);
}
