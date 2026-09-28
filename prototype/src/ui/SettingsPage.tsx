import type { ReactNode } from "react";
import {
  AlarmClock,
  Anchor,
  Brain,
  ChartBar,
  ChevronLeft,
  History,
  Keyboard,
  Package,
  Palette,
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
    case "runtimes":
      return <RuntimesSection />;
    case "models":
      return (
        <div className="space-y-6">
          {/* 执行器实例面板（T3 Providers 逻辑：左列表+开关 / 右编辑器含 Models 管理） */}
          <ProviderInstancesPanel />
          {/* API 供应商（pi 目录 + 兼容协议）—— dsh ModelsSection 形态 */}
          <ProviderSettingsSection />
        </div>
      );
    case "shortcuts":
      return <ShortcutsSection />;
    case "usage":
      return <UsageSection />;
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

/** 执行器 —— 本项目最该显眼的一节 */
function RuntimesSection() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const select = useWorkbench((s) => s.selectRuntime);

  return (
    <div className="space-y-6">
      <GroupCard>
        {runtimes.map((r) => {
          const caps = Object.values(r.capabilities);
          const on = caps.filter(Boolean).length;
          const active = r.id === activeId;
          const notInstalled = r.state.status === "not_installed";
          return (
            <SettingsRow
              key={r.id}
              label={
                <span className="flex items-center gap-2">
                  <span
                    className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-btn text-caption font-medium text-white"
                    style={{ background: r.presentation.accent }}
                    aria-hidden
                  >
                    {r.presentation.glyph}
                  </span>
                  {r.presentation.displayName}
                  {active && <Badge>默认</Badge>}
                </span>
              }
              description={
                <span className="block">
                  {r.presentation.tagline}
                  <span className="mt-0.5 block font-mono text-caption text-ash">
                    {r.transportKind} · 能力 {on}/{caps.length} · {r.state.status}
                  </span>
                </span>
              }
              control={
                notInstalled ? (
                  <button className="shrink-0 rounded-btn border border-line bg-card px-3 py-1.5 text-body-sm text-graphite hover:border-ash hover:text-ink">
                    安装
                  </button>
                ) : (
                  <button
                    onClick={() => select(r.id)}
                    className={cn(
                      "shrink-0 rounded-btn px-3 py-1.5 text-body-sm",
                      active
                        ? "bg-ink text-canvas"
                        : "border border-line bg-card text-graphite hover:border-ash hover:text-ink",
                    )}
                  >
                    {active ? "使用中" : "设为默认"}
                  </button>
                )
              }
            />
          );
        })}
      </GroupCard>

      <GroupCard>
        <SettingsRow
          label="能力探测"
          description="启动时检查每家工具是否可连。探测失败的工具会在执行器条上标灰，而不是隐藏"
          control={<Toggle on onChange={() => {}} />}
        />
        <SettingsRow
          label="未安装工具"
          description="在执行器条上显示并提供安装入口，还是直接隐藏"
          control={<Toggle on onChange={() => {}} />}
        />
      </GroupCard>
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
