import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";
import {
  scheduleRuleToCron,
  type Automation,
  type ScheduleRule,
  type Weekday,
} from "../core/automation.ts";
import type { AutomationWriteInput } from "../adapters/daemon/client.ts";
import { useWorkbench, visibleModelsFor } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 新建 / 编辑自动化 —— 自动化页此前只有卡片没有入口，这个对话框补上创建链路。
 *
 * 表单产出的不是裸 cron，而是 **ScheduleRule（权威）**：频率选择器的每个 tab
 * 直接映射成规则对象交给 daemon，daemon 用与 UI 共享的引擎（core/automation.ts）
 * 算 next_run_at 并调度。「N 分钟后」走 delayMinutes，相对时间以 daemon 时钟为锚。
 */

export type FreqTab = "delay" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** 模板预填：名称 + 描述 + 提示词 + 重复规则草稿（空态宫格点进来的半成品表单） */
export interface AutomationDialogPrefill {
  readonly name: string;
  /** 卡片上的一行说明（仅空态宫格展示用） */
  readonly desc?: string;
  readonly prompt: string;
  readonly freq: FreqTab;
  readonly time?: string;
  readonly weekdays?: readonly Weekday[];
  readonly interval?: number;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | "months";
}

const FREQ_TABS: readonly { id: FreqTab; label: string }[] = [
  { id: "delay", label: "一次性" },
  { id: "hourly", label: "每小时" },
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "monthly", label: "每月" },
  { id: "custom", label: "自定义" },
];

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;

const UNIT_OPTIONS: readonly { id: NonNullable<ScheduleRule["unit"]>; label: string }[] = [
  { id: "minutes", label: "分钟" },
  { id: "hours", label: "小时" },
  { id: "days", label: "天" },
  { id: "weeks", label: "周" },
  { id: "months", label: "个月" },
];

const MODE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: "", label: "跟随默认" },
  { id: "build", label: "build（默认权限）" },
  { id: "plan", label: "plan（只读规划）" },
  { id: "edit", label: "edit" },
  { id: "yolo", label: "yolo（免审批）" },
];

const LAUNCH_MODE_OPTIONS: readonly { id: "terminal" | "headless"; label: string; hint: string }[] = [
  { id: "terminal", label: "终端 TUI（默认）", hint: "到点在前端拉起执行器终端界面，可看可插手（自动配免审批）" },
  { id: "headless", label: "纯后台", hint: "原 headless 会话：不弹终端、走会话台账，适合例行任务" },
];

/** 表单里的调度草稿（tab + 各 tab 的字段） */
interface BuilderDraft {
  readonly freq: FreqTab;
  /** "HH:MM"，daily/weekly/monthly/custom(天以上) 用 */
  readonly time: string;
  readonly weekdays: Weekday[];
  readonly dayOfMonth: number;
  readonly interval: number;
  readonly unit: NonNullable<ScheduleRule["unit"]>;
  /** 一次性：N 分钟后 */
  readonly delayMinutes: number;
  readonly recurring: boolean;
  /** 有限次：跑满即停（recurring=false 时生效；recurring=true 时不限） */
  readonly maxRuns: number;
}

const DEFAULT_DRAFT: BuilderDraft = {
  freq: "daily",
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  interval: 30,
  unit: "minutes",
  delayMinutes: 30,
  recurring: true,
  maxRuns: 1,
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** 规则 → 表单草稿（编辑预填）。「N 分钟后」一次性还原成 delay tab。 */
function draftOf(a: Automation): BuilderDraft {
  const rule = a.rule;
  const time = `${pad(rule.hour)}:${pad(rule.minute)}`;
  const oneShot = a.recurring === false && (a.maxRuns ?? 1) <= 1;
  if (oneShot && rule.frequency === "custom" && rule.unit === "minutes" && rule.anchorAt !== undefined) {
    return { ...DEFAULT_DRAFT, freq: "delay", delayMinutes: Math.max(1, rule.interval ?? 1), recurring: false, maxRuns: a.maxRuns ?? 1 };
  }
  const freq: FreqTab = rule.frequency === "custom" ? "custom" : rule.frequency;
  return {
    ...DEFAULT_DRAFT,
    freq,
    time,
    weekdays: [...rule.weekdays],
    dayOfMonth: rule.dayOfMonth,
    interval: rule.interval ?? 30,
    unit: rule.unit ?? "minutes",
    recurring: a.recurring !== false,
    maxRuns: a.maxRuns ?? 1,
  };
}

/** 除锚点外的规则内容（保留策略已由 scheduleTouched 承担，此比较器不再需要） */

/** bot.json 里存的是裸执行器 id；主绑定的优先 */
function unitRuntimeId(u: { readonly bindings: readonly { readonly runtimeId: string; readonly primary: boolean }[] } | undefined): string {
  const primary = u?.bindings.find((b) => b.primary) ?? u?.bindings[0];
  return (primary?.runtimeId ?? "").replace(/^daemon:/, "");
}

export function AutomationDialog({
  initial,
  prefill,
  onClose,
}: {
  initial: Automation | null;
  prefill?: AutomationDialogPrefill;
  onClose: () => void;
}) {
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);
  const createAutomationAction = useWorkbench((s) => s.createAutomationAction);
  const updateAutomationAction = useWorkbench((s) => s.updateAutomationAction);

  const [name, setName] = useState(initial?.name ?? prefill?.name ?? "");
  const [unitId, setUnitId] = useState(initial?.unitId ?? (units[0]?.id ?? ""));
  const [runtimeBare, setRuntimeBare] = useState(
    initial?.runtimeId ?? unitRuntimeId(units[0]),
  );
  const [prompt, setPrompt] = useState(initial?.description ?? prefill?.prompt ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [mode, setMode] = useState(initial?.mode ?? "");
  const [launchMode, setLaunchMode] = useState<"terminal" | "headless">(initial?.launchMode === "headless" ? "headless" : "terminal");
  const [draft, setDraft] = useState<BuilderDraft>(() =>
    initial !== null
      ? draftOf(initial)
      : prefill !== undefined
        ? {
            ...DEFAULT_DRAFT,
            freq: prefill.freq,
            ...(prefill.time !== undefined ? { time: prefill.time } : {}),
            ...(prefill.weekdays !== undefined ? { weekdays: [...prefill.weekdays] } : {}),
            ...(prefill.interval !== undefined ? { interval: prefill.interval } : {}),
            ...(prefill.unit !== undefined ? { unit: prefill.unit } : {}),
          }
        : DEFAULT_DRAFT,
  );
  /** 编辑时碰过调度控件没有。没碰过 = 提交时原样保留旧调度（见 submit），表单的还原是近似的，不能拿来改写用户的原表达式 */
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const unit = units.find((u) => u.id === unitId);
  const rootPath = unit?.rootPath ?? "";

  // 保存时真正要发的时间粒度（预览 cron 用）
  const patch = (p: Partial<BuilderDraft>): void => setDraft((d) => ({ ...d, ...p }));

  /** 调度字段专用：任何一碰就意味着「用户要改调度」，提交时不再保留旧 cron/锚点 */
  const patchSchedule = (p: Partial<BuilderDraft>): void => {
    setScheduleTouched(true);
    setDraft((d) => ({ ...d, ...p }));
  };

  const namespacedRuntime = `daemon:${runtimeBare}`;
  const models = useWorkbench((s) => visibleModelsFor(s, namespacedRuntime));

  // 由草稿构规则（不含 anchorAt —— 提交时按锚点策略补）
  const ruleFromDraft = useMemo((): ScheduleRule | null => {
    const parts = draft.time.split(":");
    const hh = Number.parseInt(parts[0] ?? "", 10);
    const mm = Number.parseInt(parts[1] ?? "", 10);
    const hour = Number.isFinite(hh) ? Math.min(23, Math.max(0, hh)) : 9;
    const minute = Number.isFinite(mm) ? Math.min(59, Math.max(0, mm)) : 0;
    switch (draft.freq) {
      case "delay":
        return null;
      case "hourly":
        return { frequency: "hourly", hour, minute, weekdays: [], dayOfMonth: 1 };
      case "daily":
        return { frequency: "daily", hour, minute, weekdays: [], dayOfMonth: 1 };
      case "weekly":
        return { frequency: "weekly", hour, minute, weekdays: [...draft.weekdays].sort((a, b) => a - b), dayOfMonth: 1 };
      case "monthly":
        return { frequency: "monthly", hour, minute, weekdays: [], dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)) };
      case "custom":
        return {
          frequency: "custom",
          interval: Math.max(1, Math.round(draft.interval)),
          unit: draft.unit,
          hour,
          minute,
          weekdays: [],
          dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)),
        };
    }
  }, [draft]);

  const previewCron = useMemo(() => {
    if (draft.freq === "delay") return `${Math.max(1, Math.round(draft.delayMinutes))} 分钟后跑一次`;
    if (ruleFromDraft === null) return "";
    return scheduleRuleToCron(ruleFromDraft);
  }, [draft, ruleFromDraft]);

  const submit = async (): Promise<void> => {
    if (submitting) return; // 防双击双发
    if (unit === undefined) {
      setErr("先选一个归属单元（bot）—— 自动化是替它跑的");
      return;
    }
    if (name.trim() === "") {
      setErr("取个名字");
      return;
    }
    if (prompt.trim() === "") {
      setErr("提示词不能为空 —— 到点后原样发给执行器");
      return;
    }
    if (draft.freq === "weekly" && draft.weekdays.length === 0) {
      setErr("每周任务至少选一个星期（不选按周一算）");
      return;
    }

    // 调度保留策略（编辑且没碰调度控件时，原样回传 daemon 的权威调度）：
    // - 纯 cron 行：回传 cron 原文。表单的 ruleFromCron 是近似还原（复杂表达式直接
    //   还原不出），拿它落库 = 静默把用户的调度改写成另一回事。
    // - 规则行：回传旧规则对象（含锚点）。改个名字不该重置「每 30 分钟」的相位，
    //   更不该把「N 分钟后」的触发时刻推走。
    const touched = initial === null || scheduleTouched;
    let scheduleRule: ScheduleRule | null = ruleFromDraft;
    let cronPassthrough: string | undefined;
    if (!touched) {
      if (initial.scheduleSource === "cron" && typeof initial.cron === "string" && initial.cron !== "") {
        cronPassthrough = initial.cron;
        scheduleRule = null;
      } else {
        scheduleRule = initial.rule;
      }
    }

    const input: AutomationWriteInput = {
      name: name.trim(),
      unitId: unit.id,
      unitName: unit.name,
      runtimeId: runtimeBare,
      rootPath,
      prompt: prompt.trim(),
      model: model === "" ? null : model,
      mode: mode === "" ? null : mode,
      recurring: draft.freq === "delay" ? false : draft.recurring,
      // delay 分支不发 maxRuns：delayMinutes 本身就定性一次性（跑一次收口），
      // 后端 create 明确拒绝「delayMinutes + maxRuns」组合，带上就是必报错
      maxRuns: draft.freq === "delay" ? undefined : (draft.recurring ? null : Math.max(1, Math.round(draft.maxRuns))),
      launchMode,
      ...(touched && draft.freq === "delay" ? { delayMinutes: Math.max(1, Math.round(draft.delayMinutes)) } : {}),
      ...(scheduleRule !== null ? { scheduleRule } : {}),
      ...(cronPassthrough !== undefined ? { cron: cronPassthrough } : {}),
    };
    setSubmitting(true);
    setErr(null);
    const ok = initial === null ? await createAutomationAction(input) : await updateAutomationAction(initial.id, input);
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initial === null ? "新建自动化" : "编辑自动化"}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <CalendarClock size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">{initial === null ? "新建自动化" : "编辑自动化"}</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Field label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：每日依赖巡检"
              className={inputCls}
            />
          </Field>

          <Field label="归属单元" hint="到点后替它跑（用它的身份与工作目录）">
            {units.length === 0 ? (
              <p className="rounded-input bg-rail px-2.5 py-2 text-caption text-loss">
                还没有任何 bot —— 先在侧栏新建一个，再回来建自动化
              </p>
            ) : (
              <select
                value={unitId}
                onChange={(e) => {
                  setUnitId(e.target.value);
                  const u = units.find((x) => x.id === e.target.value);
                  if (u !== undefined) setRuntimeBare(unitRuntimeId(u));
                }}
                className={inputCls}
              >
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}（{u.kind}）
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="执行器" hint="host 侧注册的裸 id（zcode / codex / claude …）">
            <select value={runtimeBare} onChange={(e) => setRuntimeBare(e.target.value)} className={inputCls}>
              {runtimes.map((r) => (
                <option key={r.id} value={r.id.replace(/^daemon:/, "")}>
                  {r.presentation.displayName}
                </option>
              ))}
              {runtimes.length === 0 && <option value={runtimeBare}>{runtimeBare || "（无可用执行器）"}</option>}
            </select>
          </Field>

          <Field label="执行方式" hint={LAUNCH_MODE_OPTIONS.find((m) => m.id === launchMode)?.hint}>
            <select
              value={launchMode}
              onChange={(e) => setLaunchMode(e.target.value === "headless" ? "headless" : "terminal")}
              className={inputCls}
            >
              {LAUNCH_MODE_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="提示词" hint="到点后原样发给执行器的一段话">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="例如：检查 pnpm 依赖有没有新版本与安全告警，写一份摘要到 docs/"
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </Field>

          <Field label="重复规则" hint={`落库口径：${previewCron}`}>
            <div className="space-y-2.5">
              <div className="flex flex-wrap gap-1">
                {FREQ_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => patchSchedule({ freq: t.id })}
                    className={cn(
                      "rounded-chip px-2.5 py-1 text-caption transition",
                      draft.freq === t.id ? "bg-teal-tint font-medium text-teal" : "text-ash hover:bg-line-soft hover:text-graphite",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {draft.freq === "delay" && (
                <div className="flex items-center gap-2 text-body-sm text-graphite">
                  <span>现在起</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.delayMinutes}
                    onChange={(e) => patchSchedule({ delayMinutes: Number(e.target.value) })}
                    className={cn(inputCls, "w-24")}
                  />
                  <span>分钟后跑一次（以 daemon 时钟为锚，跑完即停）</span>
                </div>
              )}

              {draft.freq !== "delay" && (
                <>
                  {draft.freq !== "hourly" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>触发时刻</span>
                      <input
                        type="time"
                        value={draft.time}
                        onChange={(e) => patchSchedule({ time: e.target.value })}
                        className={cn(inputCls, "w-32")}
                      />
                    </div>
                  )}
                  {draft.freq === "weekly" && (
                    <div className="flex flex-wrap items-center gap-1">
                      {WEEKDAY_ZH.map((label, d) => {
                        const on = draft.weekdays.includes(d as Weekday);
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patchSchedule({
                                weekdays: on
                                  ? draft.weekdays.filter((x) => x !== d)
                                  : [...draft.weekdays, d as Weekday].sort((a, b) => a - b),
                              })
                            }
                            className={cn(
                              "h-7 w-7 rounded-full text-caption transition",
                              on ? "bg-teal text-canvas" : "bg-line-soft text-ash hover:text-graphite",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {draft.freq === "monthly" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>每月</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={draft.dayOfMonth}
                        onChange={(e) => patchSchedule({ dayOfMonth: Number(e.target.value) })}
                        className={cn(inputCls, "w-24")}
                      />
                      <span>日（当月没有这天就跳过）</span>
                    </div>
                  )}
                  {draft.freq === "custom" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>每</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.interval}
                        onChange={(e) => patchSchedule({ interval: Number(e.target.value) })}
                        className={cn(inputCls, "w-20")}
                      />
                      <select
                        value={draft.unit}
                        onChange={(e) => patchSchedule({ unit: e.target.value as BuilderDraft["unit"] })}
                        className={cn(inputCls, "w-28")}
                      >
                        {UNIT_OPTIONS.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      {draft.unit !== "minutes" && <span>的 {draft.time} 触发</span>}
                    </div>
                  )}

                  <div className="flex items-center gap-4 pt-1">
                    <label className="flex cursor-pointer items-center gap-1.5 text-body-sm text-graphite">
                      <input
                        type="checkbox"
                        checked={draft.recurring}
                        onChange={(e) => patch({ recurring: e.target.checked })}
                        className="accent-teal"
                      />
                      循环执行
                    </label>
                    {!draft.recurring && (
                      <label className="flex items-center gap-1.5 text-body-sm text-graphite">
                        跑
                        <input
                          type="number"
                          min={1}
                          value={draft.maxRuns}
                          onChange={(e) => patch({ maxRuns: Number(e.target.value) })}
                          className={cn(inputCls, "w-20")}
                        />
                        次后停
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="模型" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 里可自行切换）" : "可选，缺省跟随执行器默认"}>
              <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
                <option value="">跟随默认</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="权限模式" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 默认免审批）" : "到点的会话以此模式起"}>
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
                {MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {err !== null && (
            <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>
          )}
        </div>

        <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-line px-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-line bg-canvas px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || unit === undefined}
            className="rounded-btn bg-ink px-3.5 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition disabled:opacity-40"
          >
            {submitting ? "保存中…" : initial === null ? "创建" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  // 标签与提示分行：此前同一行 baseline 排布，提示长一点就在双列格子里换行挤压，
  // 与下方控件糊在一起 —— 宁可多占两行也要每行只装一件事。
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-body-sm font-medium text-ink">{label}</span>
        {hint !== undefined && <span className="text-caption leading-snug text-ash">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
