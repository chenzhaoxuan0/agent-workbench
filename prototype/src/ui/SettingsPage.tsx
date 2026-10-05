import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock,
  ChevronLeft,
  Anchor,
  Brain,
  ChartBar,
  History,
  ImagePlus,
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
import type { WorkUnit } from "../core/units.ts";
import { useMemorySettings } from "../store/useMemoryPrefs.ts";
import { readProjectMemory, runDigestDryRun, type DigestResult } from "../store/useMemoryPanel.ts";
import { ProviderInstancesPanel } from "./ProviderInstancesPanel.tsx";
import { ProviderSettingsSection } from "./ProviderSettingsSection.tsx";
import { ImageSettingsSection } from "./ImageSettingsSection.tsx";
import { cn } from "./cn.ts";

const ICONS: Record<string, typeof Settings2> = {
  settings: Settings2,
  image: ImagePlus,
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
 * 头部行专用：只有水平规格。FRAME 的 pt-2/pb-12 是给可滚动内容列的，
 * 混进固定 h-12 的面包屑行会把内容盒压塌（8+48=56px padding > 48px 高），
 * 文字被顶出/裁掉在顶缘 —— 面包屑上顶格的根因。
 */
const FRAME_HEAD = "mx-auto w-full max-w-4xl px-8";

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
          className="mb-3 flex w-full items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 py-1.5 text-body-sm font-medium text-teal hover:bg-teal/15 transition"
        >
          <ChevronLeft size={14} />
          <span>返回工作台</span>
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
                      "flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-body-sm",
                      active ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
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
          <div className={cn(FRAME_HEAD, "flex h-12 items-center gap-2")}>
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

/**
 * 开关。渠道账号区（ChannelSection 的「流式输出」）也用这个，所以从页面里导出，
 * 而不是让那边再抄一份形状相同的。方向是安全的：SettingsPage 不引用 AddBotDialog，
 * 不会绕成环。
 */
export function Toggle({ on, onChange }: { on: boolean; onChange?: (v: boolean) => void }) {
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
    case "image":
      /* 出图供应商 profile 管理（gpt_image_playground 字段全集） */
      return <ImageSettingsSection />;
    default:
      return null;
  }
}

/**
 * 记忆分区 —— 项目记忆上限 + 逐 bot 跨项目检索授权 + 每日总结（docs/10 §七 WP-8）。
 *
 * 上一版这里是「8 种记忆后端注册表 + 三层路由 + 检索门控」，其中 5 种还标着 coming。
 * **整套在新架构下作废**：记忆是项目文件夹里的普通 Markdown（`MEMORY.md` /
 * `memory/daily/` / `skills/`），跨会话检索是现场扫 CLI 的源目录 ——
 * 既没有「注册到后端」这回事，也不需要向量库和门控小模型。注册表与 coming 标记一并移除。
 */
function MemorySettingsSection() {
  const prefs = useMemorySettings((s) => s.prefs);
  const setPrefs = useMemorySettings((s) => s.setPrefs);
  const units = useWorkbench((s) => s.units);
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const activeRoot = useWorkbench(selectActiveUnit)?.rootPath ?? null;

  const [usage, setUsage] = useState<{ chars: number; limit: number; exists: boolean } | null>(null);
  const [digest, setDigest] = useState<DigestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 当前项目的真实用量。**分母永远取后端给的 limit**（limits.ts 的 MEMORY_CHAR_LIMIT），
  // 上面那个可编辑数字只是工作台侧的提醒阈值 —— 两者不是一回事，别混着显示
  useEffect(() => {
    let alive = true;
    if (activeRoot === null) {
      setUsage(null);
      return;
    }
    void readProjectMemory(activeRoot)
      .then((f) => {
        if (alive) setUsage({ chars: f.chars, limit: f.limit, exists: f.exists });
      })
      .catch(() => {
        if (alive) setUsage(null);
      });
    return () => {
      alive = false;
    };
  }, [activeRoot]);

  /**
   * 跨项目检索开关落盘到 `<rootPath>/.agent-workbench/bot.json` 的 crossSearch 字段
   * （后端 memory/steward.ts 的权限入口就在读它）。
   *
   * `WorkUnit` 没声明这个字段 —— `core/units.ts` 由后端共享（host.ts 从那里 import），
   * 这次不动它；bot.list 会把 bot.json 的额外字段原样带回，bot.put 也会原样落盘。
   */
  const setCrossSearch = async (u: WorkUnit, on: boolean): Promise<void> => {
    setErr(null);
    const next: WorkUnit & { crossSearch: boolean } = { ...u, crossSearch: on };
    try {
      // 乐观锁用进页面时看到的盘上真值：别人改过就抛 conflict，不静默覆盖
      await updateUnit(next, { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash ?? "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const runDigest = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      setDigest(await runDigestDryRun());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const usagePct = usage !== null && usage.limit > 0 ? Math.round((usage.chars / usage.limit) * 100) : null;

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        记忆就是项目文件夹里的普通 Markdown：<span className="font-mono text-ink">MEMORY.md</span> 恒注入，
        <span className="font-mono text-ink">memory/daily/</span> 按天分片、不注入，
        <span className="font-mono text-ink">skills/</span> 是程序性记忆。跨会话检索是第四件事，单独授权、默认关。
      </p>

      {/* 上限 */}
      <GroupCard>
        <SettingsRow
          label="项目记忆上限"
          description="MEMORY.md 的字符上限。参照 hermes（2200 字符 ≈ 800 tokens）—— 限额的意义不是省 token，而是「满了写不进去」逼着 agent 先整合"
          control={
            <Stepper
              value={prefs.memoryCharLimit}
              min={1000}
              max={8000}
              step={100}
              onChange={(v) => setPrefs({ memoryCharLimit: v })}
            />
          }
          detail={
            usage === null ? null : (
              <p className="text-caption leading-relaxed text-ash">
                当前项目实际：
                <span className="tnum text-graphite">
                  {usage.chars.toLocaleString("zh-CN")}/{usage.limit.toLocaleString("zh-CN")}
                </span>{" "}
                字符{usagePct === null ? "" : `（${usagePct}%）`}
                {usage.exists ? "" : " · MEMORY.md 还不存在，派发时自动创建"}。
                <span className="text-graphite">
                  分母由后端 limits.ts 的 MEMORY_CHAR_LIMIT 决定（编译期常量 2200）
                </span>
                —— 改上面的数字只改工作台侧的「先整合」提醒阈值，不改后端的拒绝阈值。
              </p>
            )
          }
        />
      </GroupCard>

      {/* 跨项目检索：逐 bot 授权 */}
      <GroupCard>
        <div className="px-4 pb-1 pt-3">
          <p className="text-caption font-medium text-graphite">跨项目检索</p>
          <p className="mt-0.5 text-caption leading-relaxed text-ash">
            默认全关。全局记忆曾经让 A 项目里冒出 B 项目的记忆，直接摧毁对 agent 的信任。
            铁律：搜到 ≠ 注入 —— 检索结果只出现在它主动查的那一轮，永远不会进项目的 prompt。
          </p>
        </div>
        <ul className="divide-y divide-line-soft">
          {units.length === 0 && <li className="px-4 py-2.5 text-caption text-ash">没有已注册的 bot。</li>}
          {units.map((u) => {
            const a = u as WorkUnit & { crossSearch?: boolean; role?: string };
            const steward = a.role === "steward";
            return (
              <li key={u.id} className="flex items-center gap-2.5 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{u.name}</span>
                {steward ? (
                  // 管家是干这个的，权限写死在后端（stewardDefinition.crossSearch），不给关
                  <span className="shrink-0 text-caption text-ash">管家 · 常开</span>
                ) : (
                  <Toggle on={a.crossSearch === true} onChange={(v) => void setCrossSearch(u, v)} />
                )}
              </li>
            );
          })}
        </ul>
      </GroupCard>

      {/* 每日总结 */}
      <GroupCard>
        <SettingsRow
          label="每日总结"
          description="每天 1–2 次增量读当天会话 → 写 memory/daily/<日期>.md。同日重跑整份重写（幂等）；失败只记日志，绝不影响日常对话"
          control={<Toggle on={prefs.digestEnabled} onChange={(v) => setPrefs({ digestEnabled: v })} />}
        />
        <SettingsRow
          label="立即运行（dryRun）"
          description="只报不写：今天会扫到哪些文件、多少块、会写到哪些项目"
          control={
            <button
              onClick={() => void runDigest()}
              disabled={busy}
              className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
            >
              {busy ? "扫描中…" : "试跑"}
            </button>
          }
          detail={digest === null ? null : <DigestReport result={digest} />}
        />
      </GroupCard>

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}
    </div>
  );
}

/** 试跑报告 —— dryRun 只报不写，所以这一屏全是「本来会发生什么」 */
function DigestReport({ result }: { result: DigestResult }) {
  return (
    <div className="space-y-1 text-caption leading-relaxed text-graphite">
      <p className="tnum">
        {result.date} · 扫了 {result.scannedFiles} 个文件 / {result.freshBlocks} 块（{result.freshFiles} 个文件有新改动）
      </p>
      {result.wrote.length > 0 && <p>会写到：{result.wrote.join("、")}</p>}
      {result.wrote.length === 0 && result.skipReason === undefined && !result.ran && <p className="text-ash">没有可跑的内容。</p>}
      {result.skipped.map((s) => (
        <p key={s.project} className="text-ash">
          跳过 {s.project}：{s.reason}
        </p>
      ))}
      {result.skipReason !== undefined && <p className="text-ash">{result.skipReason}</p>}
      {result.error !== undefined && <p className="text-loss">{result.error}</p>}
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

// 注：原「权限」分区（默认审批策略与信任范围）已删除。它当时只有两行：
// 「错过时补跑」是个 onChange={() => {}} 的假开关，拨了什么都不发生；
// 「常驻调度」是「待实现」徽标。整个分区 100% 是假内容。
// 真正的审批控制在 Composer 的运行配置里（PermissionModePanel），那个是真的。

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
