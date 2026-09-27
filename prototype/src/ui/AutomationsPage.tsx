import { useMemo, useState } from "react";
import {
  AlarmClock,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  CircleDot,
  MoreHorizontal,
  Play,
  Plus,
} from "lucide-react";
import {
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  describeSchedule,
  filterByStatus,
  formatRelative,
  nextRunAt,
  resolveStatusKind,
  type Automation,
  type StatusFilter,
} from "../core/automation.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 自动化面板 —— 对齐 ZCode 的 AutomationsSection。
 *
 * 照搬的结构：
 *   tab（定时 / 闲时）+ 状态筛选（全部/进行中/已完成/失败）
 *   卡片网格：名称 / 描述 / 频率徽章 / 下次运行 / 最近运行 / 状态徽章 / 开关 / 操作菜单
 *   空态时的模板宫格
 *
 * 两条从 ZCode 抄来的口径，都写在代码注释里，这里再强调一次因为很容易写错：
 * 1. **分组口径以卡片实际展示的状态徽章为准**，不是以内部字段为准。
 * 2. **切 tab 即回到「全部」筛选**，不恢复上次那个 tab 的旧筛选。
 *
 * 与 ZCode 的差异：ZCode 的「闲时」是低优先级的闲时任务，本项目暂未实现，
 * 所以该 tab 呈现为「即将推出」而不是空白页。
 */
export function AutomationsPage() {
  const automations = useWorkbench((s) => s.automations);
  const units = useWorkbench((s) => s.units);
  const setMainView = useShell((s) => s.setMainView);

  const [tab, setTab] = useState<"scheduled" | "idle">("scheduled");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const unitName = (id: string) => units.find((u) => u.id === id)?.name ?? "—";

  // 口径 1：按 resolveStatusKind 分组，它就是卡片徽章的来源
  const visible = useMemo(() => {
    const list = tab === "scheduled" ? automations : [];
    return filterByStatus(list, filter);
  }, [automations, tab, filter]);

  // 口径 2：切 tab 重置筛选
  const onTab = (next: "scheduled" | "idle") => {
    setTab(next);
    setFilter("all");
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-2">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 pb-3 pt-3">
          <button
            onClick={() => setMainView("chat")}
            className="flex items-center gap-1 rounded-btn px-2 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <ChevronLeft size={13} />
            返回工作台
          </button>
          <span className="text-line">/</span>
          <span className="text-body-sm font-medium text-ink">自动化</span>
        </div>

        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-body-lg font-medium text-ink">自动化</h1>
            <p className="mt-0.5 text-body-sm text-graphite">
              按日程自动派活给工作单元，跑完归档产出
            </p>
          </div>
          <button className="flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-body-sm text-canvas hover:bg-black">
            <Plus size={12} />
            新建
          </button>
        </header>

        {/* tab + 状态筛选 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {(
              [
                ["scheduled", "定时"],
                ["idle", "闲时"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => onTab(id)}
                aria-pressed={tab === id}
                className={cn(
                  "rounded-chip px-3 py-1.5 text-body-sm",
                  tab === id
                    ? "bg-teal-tint font-medium text-ink"
                    : "text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {label}
                {id === "idle" && <span className="ml-1.5 text-caption text-ash">即将推出</span>}
              </button>
            ))}
          </div>

          <div className="ml-auto flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  "rounded-chip px-2.5 py-1 text-caption",
                  filter === f
                    ? "bg-line-soft font-medium text-ink"
                    : "text-ash hover:text-graphite",
                )}
              >
                {STATUS_FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        {/* 卡片网格 */}
        {tab === "idle" ? (
          <EmptyPanel
            icon={<AlarmClock size={15} />}
            title="闲时尚未实现"
            desc="闲时任务是低优先级后台跑的任务，与定时任务共用同一组筛选与状态口径。接真实调度后这里会出现第二张 tab 的内容。"
          />
        ) : visible.length === 0 ? (
          <EmptyPanel
            icon={<CircleAlert size={15} />}
            title={filter === "all" ? "还没有定时任务" : `没有${STATUS_FILTER_LABEL[filter]}的任务`}
            desc={filter === "all" ? "从下面的模板挑一个开始" : "换个筛选看看"}
            templates={filter === "all"}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((a) => (
              <AutomationCard key={a.id} a={a} unitName={unitName(a.unitId)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 卡片 */

const STATUS_META = {
  inProgress: { icon: CircleDot, cls: "bg-line-soft text-graphite", label: "进行中" },
  completed: { icon: CircleCheck, cls: "bg-[#1d3a2c] text-[#5fc99a]", label: "已完成" },
  failed: { icon: CircleAlert, cls: "bg-loss/10 text-loss", label: "失败" },
} as const;

function AutomationCard({ a, unitName }: { a: Automation; unitName: string }) {
  const toggle = useWorkbench((s) => s.toggleAutomation);
  const kind = resolveStatusKind(a);
  const meta = STATUS_META[kind];
  const Icon = meta.icon;
  const next = nextRunAt(a);
  const last = a.runs.at(-1);

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-card border border-line bg-card px-4 py-3",
        !a.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-medium text-ink">{a.name}</p>
          {a.description && (
            <p className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-graphite">
              {a.description}
            </p>
          )}
        </div>
        <button
          aria-label={`${a.name} 更多操作`}
          className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-graphite">
          {describeSchedule(a)}
        </span>
        <span className={cn("flex items-center gap-1 rounded-chip px-2 py-0.5 text-caption", meta.cls)}>
          <Icon size={10} />
          {meta.label}
        </span>
        {!a.enabled && (
          <span className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">已暂停</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line-soft pt-2.5 text-caption">
        <div className="min-w-0">
          <dt className="text-ash">归属</dt>
          <dd className="truncate text-graphite">{unitName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">下次运行</dt>
          <dd className={cn("truncate", next ? "text-graphite" : "text-ash")}>
            {next ? formatRelative(next) : a.enabled ? "已跑完" : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">最近运行</dt>
          <dd className="truncate text-graphite">
            {last ? formatRelative(last.startedAt) : "从未"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">失败记录</dt>
          <dd className={cn("truncate", a.lastFailure ? "text-loss" : "text-graphite")}>
            {a.lastFailure ? formatRelative(a.lastFailure.at) : "无"}
          </dd>
        </div>
      </dl>

      {a.lastFailure && (
        <p className="flex items-start gap-1.5 rounded-btn bg-loss/5 px-2 py-1.5 text-caption text-loss">
          <CircleAlert size={11} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{a.lastFailure.reason}</span>
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-line-soft pt-2.5">
        <span className="font-mono text-caption text-ash">{a.runtimeId}</span>
        <button className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink">
          <Play size={10} />
          立即运行
        </button>
        <button
          role="switch"
          aria-checked={a.enabled}
          aria-label={`${a.name} 开关`}
          onClick={() => toggle(a.id)}
          className={cn(
            "relative ml-auto h-5 w-9 shrink-0 rounded-chip transition",
            a.enabled ? "bg-teal" : "bg-line",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
              a.enabled ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 空态 */

const TEMPLATES = [
  { name: "每日内容产出", desc: "每天早上跑一次，产出当天草稿", freq: "每天 08:00" },
  { name: "周报汇总", desc: "每周五下班前汇总本周进展", freq: "每周五 18:30" },
  { name: "依赖巡检", desc: "每天检查依赖与工具版本", freq: "每天 09:00" },
  { name: "剪藏入库", desc: "把新抓取内容归档进知识库", freq: "每 6 小时" },
] as const;

function EmptyPanel({
  icon,
  title,
  desc,
  templates,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  templates?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
        <span className="mb-2 text-ash">{icon}</span>
        <p className="text-body-sm font-medium text-ink">{title}</p>
        <p className="mt-1 max-w-[420px] text-body-sm leading-relaxed text-graphite">{desc}</p>
      </div>

      {templates && (
        <>
          <p className="px-1 pb-2 pt-5 text-body-sm text-ash">从模板开始</p>
          <div className="grid grid-cols-2 gap-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.name}
                className="flex flex-col gap-1.5 rounded-card bg-card px-4 py-3 text-left shadow-subtle hover:bg-[#f7f4f0]"
              >
                <span className="text-body-sm font-medium text-ink">{t.name}</span>
                <span className="text-caption text-graphite">{t.desc}</span>
                <span className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash w-fit">
                  {t.freq}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
