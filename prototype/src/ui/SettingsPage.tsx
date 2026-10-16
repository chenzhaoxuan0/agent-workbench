import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock,
  ChevronLeft,
  Anchor,
  Brain,
  ChartBar,
  Globe,
  History,
  ImagePlus,
  Keyboard,
  Layers,
  Minus,
  Monitor,
  Package,
  Palette,
  Plug,
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
import { getGuardianConfigRpc, readProjectMemory, runDigestDryRun, setGuardianConfigRpc, type DigestResult } from "../store/useMemoryPanel.ts";
import { ProviderInstancesPanel } from "./ProviderInstancesPanel.tsx";
import { SkillsSettingsSection } from "./SkillsSettingsSection.tsx";
import { McpSettingsSection } from "./McpSettingsSection.tsx";
import { BrowserControlSection } from "./BrowserControlSection.tsx";
import { ComputerControlSection } from "./ComputerControlSection.tsx";
import { ImageSettingsSection } from "./ImageSettingsSection.tsx";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection.tsx";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
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
  layers: Layers,
  plug: Plug,
  globe: Globe,
  monitor: Monitor,
};

/** 居中内容列：max-w-5xl 给予多列执行器与模型管理更充裕的呼吸空间 */
const FRAME = "mx-auto w-full max-w-5xl px-6 pb-12 pt-2";
/**
 * 头部行专用：只有水平规格。FRAME 的 pt-2/pb-12 是给可滚动内容列的，
 * 混进固定 h-12 的面包屑行会把内容盒压塌（8+48=56px padding > 48px 高），
 * 文字被顶出/裁掉在顶缘 —— 面包屑上顶格的根因。
 */
const FRAME_HEAD = "mx-auto w-full max-w-5xl px-6";

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
      {/* 左导航：宽度 264px 与侧边栏一致，顶栏高 48px 与工作台顶栏完全对齐 */}
      <nav className="flex h-full w-[264px] shrink-0 min-h-0 flex-col border-r border-line bg-rail">
        <div className="flex h-12 shrink-0 items-center border-b border-line/60 px-3">
          <button
            onClick={() => useShell.getState().closeSettings()}
            className="flex h-8 w-full items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 text-body-sm font-medium text-teal transition hover:bg-teal/15"
          >
            <ChevronLeft size={14} />
            <span>返回工作台</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
        </div>
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
export function SettingsRow({
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

/** 对齐 ZCode 的 SettingsGroupCard（浏览器/电脑控制分区也从这里取，保持单一来源） */
export function GroupCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-card border border-line bg-card">{children}</div>;
}

/**
 * 开关。渠道账号区（ChannelSection 的「流式输出」）也用这个，所以从页面里导出，
 * 而不是让那边再抄一份形状相同的。方向是安全的：SettingsPage 不引用 AddBotDialog，
 * 不会绕成环。disabled：扇出/拉起这类秒级 RPC 进行中锁开关，防并发写竞争。
 */
export function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-chip transition",
        on ? "bg-teal" : "bg-line",
        disabled ? "opacity-40" : undefined,
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
    case "appearance":
      return <AppearanceSettingsSection />;
    case "models":
      return (
        <div className="space-y-6">
          <ProviderInstancesPanel />
        </div>
      );
    case "shortcuts":
      return <ShortcutsSection />;
    case "history":
      return <HistorySettingsSection />;
    case "skills":
      return <SkillsSettingsSection />;
    case "mcp":
      return <McpSettingsSection />;
    case "browserControl":
      return <BrowserControlSection />;
    case "computerControl":
      return <ComputerControlSection />;
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
  const memoryScopes = useWorkbench((s) => s.memoryScopes);
  const toggleMemoryScope = useWorkbench((s) => s.toggleMemoryScope);

  const [usage, setUsage] = useState<{ chars: number; limit: number; exists: boolean } | null>(null);
  const [digest, setDigest] = useState<DigestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 挂载时用 daemon kv 里的权威配置校准显示。localStorage 只是离线兜底——
  // 换浏览器 / 清缓存 / agent 直改配置文件后，不同步就会显示一个假状态，
  // 用户「再保存一次」旧值就把权威配置悄悄改回去了。
  useEffect(() => {
    let alive = true;
    getGuardianConfigRpc()
      .then((c) => {
        if (!alive) return;
        setPrefs({
          guardianRunner: c.runner,
          guardianModel: c.model,
          autoConsolidate: c.autoConsolidate,
          digestEnabled: c.digestEnabled,
        });
      })
      .catch(() => {
        /* daemon 没起：保持 localStorage 兜底值，不报错不打断页面 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时同步一次；setPrefs 是 zustand 稳定引用
  }, []);

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

      {/* 会话记忆注入范围 */}
      <GroupCard>
        <div className="px-4 pb-1 pt-3">
          <p className="text-caption font-medium text-graphite">会话记忆注入范围</p>
          <p className="mt-0.5 text-caption leading-relaxed text-ash">
            控制发送任务时要自动注入到执行器上下文中的记忆类型。
          </p>
        </div>
        <div className="divide-y divide-line-soft">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-body-sm font-medium text-ink">长期事实记忆 (MEMORY.md)</p>
              <p className="text-caption text-ash">自动注入项目根目录 MEMORY.md 沉淀的关键设定与业务事实</p>
            </div>
            <Toggle
              on={memoryScopes.includes("semantic")}
              onChange={() => toggleMemoryScope("semantic")}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-body-sm font-medium text-ink">当日会话精炼 (Daily Digest)</p>
              <p className="text-caption text-ash">自动注入当天多轮会话提炼出的关键进展与临时上下文</p>
            </div>
            <Toggle
              on={memoryScopes.includes("daily")}
              onChange={() => toggleMemoryScope("daily")}
            />
          </div>
        </div>
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

      {/* 后台守护引擎配置 */}
      <GroupCard>
        <div className="px-4 pb-1 pt-3">
          <p className="text-caption font-medium text-graphite">后台守护引擎 (Guardian Engine)</p>
          <p className="mt-0.5 text-caption leading-relaxed text-ash">
            配置用于后台合并压缩（Auto-Consolidator）、每日总结与健康审查的轻量执行器与小模型。
          </p>
        </div>
        <SettingsRow
          label="守护执行器 (Runner)"
          description="调度哪家 CLI 执行后台轻量任务（推荐本机已有免鉴权环境的 CLI）"
          control={
            <select
              value={prefs.guardianRunner}
              onChange={(e) => {
                const runner = e.target.value as "zcode" | "claude" | "codex" | "pi" | "mcode" | "agy" | "custom";
                setPrefs({ guardianRunner: runner });
                void setGuardianConfigRpc({ runner });
              }}
              className="h-8 rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none"
            >
              <option value="zcode">zcode</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="pi">pi</option>
              <option value="mcode">mcode</option>
              <option value="agy">agy</option>
              <option value="custom">custom</option>
            </select>
          }
        />
        <SettingsRow
          label="轻量模型名称 (Model)"
          description="指定后台执行合并压缩使用的小模型名称（如 deepseek-chat, gpt-4o-mini, MiniMax-M3.1-Flash-Preview 等）"
          control={
            <input
              type="text"
              value={prefs.guardianModel}
              onChange={(e) => {
                const model = e.target.value;
                setPrefs({ guardianModel: model });
              }}
              onBlur={() => {
                void setGuardianConfigRpc({ model: prefs.guardianModel });
              }}
              placeholder="deepseek-chat"
              className="h-8 w-48 rounded-btn border border-line bg-canvas px-2.5 font-mono text-body-sm text-ink focus:border-teal focus:outline-none"
            />
          }
        />
        <SettingsRow
          label="超限自动自愈合并"
          description="当 MEMORY.md 接近或超过 2200 字符时，由上述配置的小模型在后台自动合并同类项并剔除失效事实，避免硬拒绝写入"
          control={
            <Toggle
              on={prefs.autoConsolidate}
              onChange={(v) => {
                setPrefs({ autoConsolidate: v });
                void setGuardianConfigRpc({ autoConsolidate: v });
              }}
            />
          }
        />
      </GroupCard>

      {/* 每日总结 */}
      <GroupCard>
        <SettingsRow
          label="每日总结"
          description="每天 1–2 次增量读当天会话 → 写 memory/daily/<日期>.md。同日重跑整份重写（幂等）；失败只记日志，绝不影响日常对话"
          control={
            <Toggle
              on={prefs.digestEnabled}
              onChange={(v) => {
                setPrefs({ digestEnabled: v });
                // 写穿到 daemon kv —— 调度器每 tick 动态读，改完即生效，无需重启。
                // 只存 localStorage 的话这就是个假开关：daemon 根本看不见它。
                void setGuardianConfigRpc({ digestEnabled: v });
              }}
            />
          }
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

function ShortcutsSection() {
  // 与 bindShellShortcuts（useShell.ts）和 Electron 层的缩放绑定逐一对应。
  // 旧表里的「打开终端 ⌘`」「发送 Enter / 换行 Shift+Enter」随终端抽屉与
  // 输入框的移除一并删除 —— 列死快捷键比不列更误导。
  const items: readonly (readonly [string, readonly string[], string])[] = [
    ["命令面板", ["⌘", "K"], "全局"],
    ["搜索", ["⌘", "F"], "全局"],
    ["收起 / 展开侧栏", ["⌘", "B"], "全局"],
    ["打开设置", ["⌘", ","], "全局"],
    ["关闭弹层", ["Esc"], "全局"],
    ["内容缩放", ["Ctrl", "="], "全局（Electron）"],
    ["内容缩小", ["Ctrl", "-"], "全局（Electron）"],
    ["缩放复位", ["Ctrl", "0"], "全局（Electron）"],
  ];
  return (
    <GroupCard>
      {items.map(([label, keys, scope]) => (
        <SettingsRow
          key={label}
          label={label}
          description={scope}
          control={
            <span className="flex shrink-0 gap-1">
              {keys.map((k) => (
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

function HistorySettingsSection() {
  const prefs = useHistoryPrefs((s) => s.prefs);
  const setPrefs = useHistoryPrefs((s) => s.setPrefs);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-body-sm font-semibold text-ink">历史会话展示偏好</h3>
        <p className="mt-1 text-caption text-ash">
          标为红色或执行失败的会话通常无法重现或继续交互。默认隐藏失败会话以保持界面整洁，可在需要排查故障或复盘时随时重新开启。
        </p>
      </div>

      <GroupCard>
        <SettingsRow
          label="在左侧栏中隐藏失败会话"
          description="侧边栏 Bot 展开的历史时间轴中隐藏标红或执行失败的会话，避免占据侧栏有限空间。"
          control={
            <Toggle
              on={prefs.hideFailedInSidebar}
              onChange={(v) => setPrefs({ hideFailedInSidebar: v })}
            />
          }
        />
        <SettingsRow
          label="在历史会话弹窗中隐藏失败会话"
          description="点击进入完整历史会话弹窗时默认隐藏失败会话；在弹窗顶部也可快捷临时切换查看。"
          control={
            <Toggle
              on={prefs.hideFailedInDialog}
              onChange={(v) => setPrefs({ hideFailedInDialog: v })}
            />
          }
        />
      </GroupCard>
    </div>
  );
}

