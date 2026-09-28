import type { ReactNode } from "react";
import {
  AlarmClock,
  ChevronDown,
  Anchor,
  Brain,
  ChartBar,
  ChevronLeft,
  History,
  Keyboard,
  Minus,
  Package,
  Palette,
  Plus,
  Settings2,
  Shield,
  Wand,
} from "lucide-react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  useShell,
  type SettingsSectionDef,
  type SettingsSectionId,
} from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useMemoryPrefs } from "../store/useMemoryPrefs.ts";
import { ProviderInstancesPanel } from "./ProviderInstancesPanel.tsx";
import { ProviderSettingsSection } from "./ProviderSettingsSection.tsx";
import { cn } from "./cn.ts";

const ICONS: Record<string, typeof Settings2> = {
  settings: Settings2,
  palette: Palette,
  package: Package,
  keyboard: Keyboard,
  alarm: AlarmClock,
  wand: Wand,
  brain: Brain,
  anchor: Anchor,
  shield: Shield,
  chart: ChartBar,
  history: History,
};

/** 对齐 ZCode 的 SETTINGS_FRAME_CONTENT_CLASSNAME：max-w-4xl 居中内容列 */
const FRAME = "mx-auto w-full max-w-4xl px-8 pb-12 pt-2";

/**
 * 设置页 —— 骨架对齐 ZCode 的 settingsPageConfig + SettingsPageParts：
 *   左导航三组（基础 / Agent 能力 / 数据与统计）
 *   max-w-4xl 内容列 + 面包屑头
 *   SettingsRow（label + description ｜ control，border-t 分隔）
 *   SettingsGroupCard 包裹
 *
 * 与 ZCode 的差异：分区清单按本项目资产重排，
 * 「执行器」进基础设置（六家工具是一等公民），「自动化」是bot模式的心脏故排首位。
 */
export function SettingsPage() {
  const section = useShell((s) => s.settingsSection);
  const openSettings = useShell((s) => s.openSettings);

  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div className="flex h-full min-h-0">
      {/* 左导航。ZCode lg 以上是 268px，窄屏收 68px icon rail。
          返回按钮在导航列顶部（ZCode 的 TID_SETTINGS_BACK_BUTTON 挂位） */}
      <nav className="w-[268px] shrink-0 overflow-y-auto border-r border-line bg-rail px-3 pb-4 pt-3">
        <button
          onClick={() => useShell.getState().closeSettings()}
          className="mb-2 flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <ChevronLeft size={12} />
          返回工作台
        </button>
        {SETTINGS_GROUPS.map((g) => {
          const items = SETTINGS_SECTIONS.filter((s) => s.groupId === g.id);
          if (items.length === 0) return null;
          return (
            <div key={g.id} className="mb-4">
              <p className="px-2 pb-1.5 text-caption text-ash">{g.title}</p>
              {items.map((it) => {
                const Icon = ICONS[it.icon] ?? Settings2;
                const active = it.id === current.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => openSettings(it.id)}
                    aria-current={active}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-body-sm",
                      active
                        ? "bg-teal-tint font-medium text-ink"
                        : "text-graphite hover:bg-line-soft hover:text-ink",
                    )}
                  >
                    <Icon size={12} className="shrink-0" />
                    <span className="truncate">{it.title}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* 内容列 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* 面包屑头，对齐 ZCode 的 SettingsHeaderBreadcrumb —— 只呈现路径，
            返回动作在左导航列顶部。h-12 与内容列顶带同高 */}
        <div className="sticky top-0 z-10 border-b border-line bg-rail/95 backdrop-blur">
          <div className={cn(FRAME, "flex h-12 items-center gap-2")}>
            <span className="text-body-sm text-ink">设置</span>
            <span className="text-line">/</span>
            <span className="text-body-sm font-medium text-ink">{current.title}</span>
          </div>
        </div>

        <div className={FRAME}>
          <header className="mb-6">
            <h1 className="text-body-lg font-medium text-ink">{current.title}</h1>
            <p className="mt-0.5 text-body-sm text-graphite">{current.desc}</p>
          </header>

          <SectionBody section={current} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 原语 */

/** 对齐 ZCode 的 SettingsRow：左 label+description，右 control，border-t 分隔 */
function SettingsRow({
  label,
  description,
  control,
  detail,
  wide,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="border-t border-line px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          wide ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]" : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-body-sm font-medium text-ink">{label}</div>
          {description && (
            <div className="mt-0.5 text-body-sm leading-relaxed text-graphite">{description}</div>
          )}
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">{control}</div>
      </div>
      {detail && <div className="mt-3">{detail}</div>}
    </div>
  );
}

/** 对齐 ZCode 的 SettingsGroupCard */
function GroupCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-card border border-line bg-card">{children}</div>;
}

function Toggle({ on, onChange }: { on: boolean; onChange?: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange?.(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-chip transition",
        on ? "bg-teal" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-btn bg-line-soft px-2.5 py-1 text-caption text-graphite">{children}</span>
  );
}

/* ------------------------------------------------------------- 分区内容 */

function SectionBody({ section }: { section: SettingsSectionDef }) {
  switch (section.id) {
    case "models":
      return (
        <div className="space-y-6">
          {/* 执行器实例面板（T3 Providers 逻辑：左列表+开关 / 右编辑器含 Models 管理；
              默认执行器与探测策略均已并入面板内部） */}
          <ProviderInstancesPanel />
          {/* API 供应商（pi 目录 + 兼容协议）—— dsh ModelsSection 形态 */}
          <ProviderSettingsSection />
        </div>
      );
    case "shortcuts":
      return <ShortcutsSection />;
    case "usage":
      return <UsageSection />;
    case "memory":
      return <MemorySettingsSection />;
    case "permissions":
      return (
        <div className="space-y-6">
          <GenericSection section={section} />
          <AutomationPolicyRows />
        </div>
      );
    default:
      return <GenericSection section={section} />;
  }
}

/** 记忆分区 —— 对齐 waku-agent 的记忆三柱（semantic / episodic / procedural） */
function MemorySettingsSection() {
  const prefs = useMemoryPrefs((s2) => s2.prefs);
  const update = useMemoryPrefs((s2) => s2.update);

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        记忆分三层（对齐 waku-agent）：语义事实、情节事件、程序性技能。
        每 bot 的接入开关在「添加 bot」时单独声明，这里配置全局后端与策略。
      </p>

      <GroupCard>
        <SettingsRow
          label="语义记忆 · 事实"
          description="关于人、项目、偏好的持久事实（FTS5 关键词检索）。例：「甲方喜欢简报不用长文」"
          control={<Toggle on={prefs.semanticEnabled} onChange={(v) => update({ semanticEnabled: v })} />}
        />
        <SettingsRow
          label="存储后端"
          description="语义事实的存放位置"
          control={
            <MemorySelect
              value={prefs.semanticStore}
              choices={["sqlite", "supabase", "mem0", "zep", "langmem"] as const}
              onChange={(v) => update({ semanticStore: v })}
            />
          }
        />
        <SettingsRow
          label="检索条数"
          description="每次注入的相关事实条数（top K）"
          control={<Stepper value={prefs.semanticTopK} min={1} max={12} step={1} onChange={(v) => update({ semanticTopK: v })} />}
        />
      </GroupCard>

      <GroupCard>
        <SettingsRow
          label="情节记忆 · 事件"
          description="带日期的“发生过什么”——由对话蒸馏出的一句话摘要"
          control={<Toggle on={prefs.episodicEnabled} onChange={(v) => update({ episodicEnabled: v })} />}
        />
        <SettingsRow
          label="存储后端"
          description="情节摘要的存放位置"
          control={
            <MemorySelect
              value={prefs.episodicStore}
              choices={["sqlite", "notion"] as const}
              onChange={(v) => update({ episodicStore: v })}
            />
          }
        />
      </GroupCard>

      <GroupCard>
        <SettingsRow
          label="程序性记忆 · 技能"
          description="怎么做事的流程（SKILL.md）。关键词命中时注入正文，每轮最多 2 个"
          control={<Toggle on={prefs.proceduralEnabled} onChange={(v) => update({ proceduralEnabled: v })} />}
        />
        <SettingsRow
          label="技能目录"
          description="自建技能放在工作目录的 skills/ 下，文件变更自动重扫描"
          control={<span className="font-mono text-caption text-ash">skills/</span>}
        />
      </GroupCard>

      <GroupCard>
        <SettingsRow
          label="检索门控"
          description="小模型先判断本次是否需要检索（“2+2 等于几”不检索）。门控出错即检索（fail-open）"
          control={<Toggle on={prefs.gateEnabled} onChange={(v) => update({ gateEnabled: v })} />}
        />
        <SettingsRow
          label="门控模型"
          description="执行门控判断的便宜模型"
          control={
            <input
              value={prefs.gateModel}
              onChange={(e) => update({ gateModel: e.target.value })}
              spellCheck={false}
              className="w-52 rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none focus:border-teal"
            />
          }
        />
        <SettingsRow
          label="整理频率"
          description="每 N 次交换由小模型从未整理对话中提取事实与情节"
          control={
            <Stepper value={prefs.consolidateEvery} min={2} max={20} step={2} onChange={(v) => update({ consolidateEvery: v })} />
          }
        />
      </GroupCard>

      <GroupCard>
        <SettingsRow
          label="MEMORY.md 人读镜像"
          description="每轮后重新生成 .waku/MEMORY.md，人类可直接打开阅读全部记忆"
          control={<Toggle on={prefs.mirrorMd} onChange={(v) => update({ mirrorMd: v })} />}
        />
        <SettingsRow
          label="导出"
          description="原型占位：导出全部记忆（真运行时接入后可用）"
          control={
            <button className="rounded-btn border border-line px-2.5 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
              导出记忆
            </button>
          }
        />
      </GroupCard>
    </div>
  );
}

function MemorySelect<T extends string>({
  value,
  choices,
  onChange,
}: {
  value: T;
  choices: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="relative w-44">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-label="存储后端"
        className="w-full appearance-none rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
      >
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ash" />
    </div>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max(min, value - step))}
        aria-label="减少"
        className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
      >
        <Minus size={10} />
      </button>
      <span className="tnum w-10 text-center text-body-sm text-ink">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + step))}
        aria-label="增加"
        className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

/** 自动化相关只剩两条全局策略，具体的任务管理已独立成主视图 */
function AutomationPolicyRows() {
  return (
    <GroupCard>
      <SettingsRow
        label="错过时补跑"
        description="到点时机器不在线，开机后是否补执行当天漏掉的这一轮"
        control={<Toggle on onChange={() => {}} />}
      />
      <SettingsRow
        label="常驻调度"
        description="退出应用后仍按日程触发。原型期未实现，需要 Electron 托盘常驻"
        control={<Badge>待实现</Badge>}
      />
    </GroupCard>
  );
}

function ShortcutsSection() {
  const items: readonly (readonly [string, string, string])[] = [
    ["命令面板", "⌘K", "全局"],
    ["搜索", "⌘F", "全局"],
    ["打开终端", "⌘`", "全局"],
    ["新建任务", "⌘N", "全局"],
    ["发送", "Enter", "输入框"],
    ["换行", "Shift + Enter", "输入框"],
  ];
  return (
    <GroupCard>
      {items.map(([label, keys, scope]) => (
        <SettingsRow
          key={label}
          label={label}
          description={scope === "全局" ? "应用内任意位置生效" : "仅输入框聚焦时生效"}
          control={
            <span className="flex shrink-0 gap-1">
              {keys.split(" + ").map((k) => (
                <kbd
                  key={k}
                  className="rounded-btn border border-line bg-canvas px-2 py-1 font-mono text-caption text-ink"
                >
                  {k}
                </kbd>
              ))}
            </span>
          }
        />
      ))}
    </GroupCard>
  );
}

function UsageSection() {
  const sessions = useWorkbench((s) => s.sessions);
  const units = useWorkbench((s) => s.units);

  const rows = units.map((u) => {
    const mine = sessions.filter((s) => s.unitId === u.id);
    return {
      name: u.name,
      count: mine.length,
      cost: mine.reduce((sum, s) => sum + s.stats.costUsd, 0),
    };
  });

  return (
    <GroupCard>
      {rows.map((r) => (
        <SettingsRow
          key={r.name}
          label={r.name}
          description={`${r.count} 个会话`}
          control={<span className="tnum shrink-0 font-mono text-body-sm text-ink">${r.cost.toFixed(3)}</span>}
        />
      ))}
    </GroupCard>
  );
}

/** 其余分区：给出真实的结构与占位说明，不做假开关 */
function GenericSection({ section }: { section: SettingsSectionDef }) {
  const unit = useWorkbench(selectActiveUnit);
  const unitScoped = section.id === "skills" || section.id === "memory" || section.id === "hooks";

  return (
    <div className="space-y-6">
      <GroupCard>
        <SettingsRow
          label="作用范围"
          description={
            unitScoped
              ? "该分区随工作单元切换，读取单元目录下的对应文件"
              : "对整个应用生效"
          }
          control={<Badge>{unitScoped ? unit?.name ?? "未选择" : "应用级"}</Badge>}
        />
        <SettingsRow
          label="配置来源"
          description="零迁移：直接读工作单元目录里的文件，不维护影子数据库"
          control={<Badge>文件</Badge>}
        />
      </GroupCard>

      <p className="rounded-card border border-line bg-card px-4 py-3 text-body-sm text-graphite">
        「{section.title}」分区尚未实现具体表单。
        当前只落骨架 —— 导航、面包屑、SettingsRow 排版都已就位，接真实设置项时直接往 GroupCard 里加行即可。
      </p>
    </div>
  );
}
