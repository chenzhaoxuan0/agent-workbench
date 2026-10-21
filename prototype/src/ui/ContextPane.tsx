import { useEffect, useState, type ReactElement } from "react";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import {
  normalizeContextManifest,
  normalizeSkillBinding,
  resolveAgentsMdInjection,
  type ContextManifest,
  type UnitId,
  type WorkUnit,
} from "../core/units.ts";
import { fetchSkillsInventory, listDaemonExecutors, type DaemonExecutorInfo } from "../adapters/daemon/client.ts";
import { Toggle } from "./Toggle.tsx";
import { cn } from "./cn.ts";

/**
 * 上下文清单面板（ADR 0014 / docs/20）——「这个 bot 到底知道什么」的唯一管理面。
 *
 * 数据面全部走 bot.json 的 contextManifest（daemon 是权威），UI 只是编辑器：
 * - AGENTS.md 三态（auto/on/off），auto 的防双注判定 = 当前主绑定执行器的
 *   nativeContextFiles 声明（拉一次 adapter.list 缓存在本组件）；
 * - SOUL / USER / 记忆三柱 开关；预设是写开关的宏（D7），不是第二真相；
 * - SOUL.md 编辑器：与 AGENTS.md 同一套乐观锁（ifSoulMdHash + ifRevision）。
 *
 * 注入本身是 startSession 冻结快照——这里的一切改动只影响下一个新会话。
 */
export function ContextPane({ unitId, shown }: { unitId: UnitId; shown: boolean }): ReactElement | null {
  const unit = useWorkbench((s) => s.units.find((u) => String(u.id) === String(unitId)));
  const patchUnitContext = useWorkbench((s) => s.patchUnitContext);
  const updateUnit = useWorkbench((s) => s.updateUnit);

  const [adapters, setAdapters] = useState<readonly DaemonExecutorInfo[]>([]);
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    listDaemonExecutors()
      .then((list) => {
        if (alive) setAdapters(list);
      })
      .catch(() => {
        /* daemon 没起：AGENTS.md 的 auto 徽标按「未标注」显示（= 工作台兜底注入） */
      });
    return () => {
      alive = false;
    };
  }, [shown]);

  if (unit === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-caption text-ash">
        这个 bot 已经不在了（目录或定义被移除）
      </div>
    );
  }

  const manifest = normalizeContextManifest(unit.contextManifest);

  // 主绑定执行器（与 askBot.primaryBinding 同口径）：auto 判定与徽标都看它
  const primary = unit.bindings.find((b) => b.primary === true) ?? unit.bindings[0];
  const primaryRuntime = primary?.runtimeId !== undefined ? String(primary.runtimeId).replace(/^daemon:/, "") : "";
  const nativeReadsAgents =
    adapters.find((a) => a.id === primaryRuntime)?.nativeContextFiles?.some((f) => f.toUpperCase() === "AGENTS.MD") === true;

  const onCount =
    (manifest.soul === true ? 1 : 0) +
    (manifest.user === true ? 1 : 0) +
    (manifest.memorySemantic === true ? 1 : 0) +
    (manifest.memoryDaily === true ? 1 : 0) +
    (manifest.memoryStanding === true ? 1 : 0) +
    (manifest.skills === true ? 1 : 0) +
    (resolveAgentsMdInjection(manifest.agentsMd ?? "auto", nativeReadsAgents) ? 1 : 0);

  const patch = (p: Partial<ContextManifest>): void => {
    void patchUnitContext(unit.id, p).catch(() => {});
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3 space-y-3">
      {/* 状态摘要：裸跑是合法状态，但要显式可见（ADR 0014 验收第 1 条） */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-card border px-3 py-2",
          onCount === 0 ? "border-line bg-canvas" : "border-teal/40 bg-teal-tint/40",
        )}
      >
        {onCount === 0 ? <Circle size={13} className="shrink-0 text-ash" /> : <CheckCircle2 size={13} className="shrink-0 text-teal" />}
        <p className="text-caption leading-relaxed text-graphite">
          {onCount === 0 ? (
            <>
              <span className="font-medium text-ink">裸跑</span> —— 未注入任何上下文文件（合法状态，不是错误）。
              新会话起效。
            </>
          ) : (
            <>
              下一个新会话将注入 <span className="tnum font-medium text-ink">{onCount}</span> 项上下文（冻结快照，续聊不重复）。
            </>
          )}
        </p>
      </div>

      {/* 预设：一次性写一组开关的宏，落盘的只有显式开关（D7） */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-ash">预设</span>
        <PresetButton label="裸跑" onClick={() => patch({ agentsMd: "off", soul: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false })} />
        <PresetButton label="基础" onClick={() => patch({ agentsMd: "auto", soul: true, user: true, memorySemantic: true, memoryDaily: false, memoryStanding: true, skills: false })} />
        <PresetButton label="完整" onClick={() => patch({ agentsMd: "auto", soul: true, user: true, memorySemantic: true, memoryDaily: true, memoryStanding: true, skills: true })} />
      </div>

      {/* AGENTS.md 三态 */}
      <Section title="岗位说明书 · AGENTS.md">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-caption text-graphite">
              {nativeReadsAgents
                ? `当前执行器${primaryRuntime !== "" ? `（${primaryRuntime}）` : ""}原生读取 AGENTS.md —— auto 不重复注入（防双注）`
                : `当前执行器${primaryRuntime !== "" ? `（${primaryRuntime}）` : ""}未声明原生读取 —— auto 由工作台注入兜底`}
            </p>
            <p className="mt-0.5 truncate text-[10px] text-ash" title={unit.agentsMdMeta?.path ?? ""}>
              {unit.agentsMdMeta?.path ?? `${unit.rootPath}/AGENTS.md`}
            </p>
          </div>
          <div className="flex shrink-0 rounded-btn border border-line p-0.5">
            {(["auto", "on", "off"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => patch({ agentsMd: mode })}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium transition",
                  (manifest.agentsMd ?? "auto") === mode ? "bg-teal text-canvas" : "text-graphite hover:text-ink",
                )}
              >
                {mode === "auto" ? "auto" : mode === "on" ? "强制注入" : "关闭"}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* 其余各项 */}
      <Section title="注入项">
        <ManifestRow
          title="人设 · SOUL.md"
          desc="这个 bot 的人格与主动行为提示词（用户维护，只读注入）"
          on={manifest.soul === true}
          onToggle={() => patch({ soul: !(manifest.soul === true) })}
        />
        <ManifestRow
          title="关于用户 · USER.md（全局层）"
          desc="作息、偏好、环境等用户级事实，所有 bot 共享一份；对外渠道 bot 建议关闭"
          on={manifest.user === true}
          onToggle={() => patch({ user: !(manifest.user === true) })}
        />
        <ManifestRow
          title="长期事实 · MEMORY.md"
          desc="项目级关键事实（上限 2200 字符，bot 遵照上限自维护）"
          on={manifest.memorySemantic === true}
          onToggle={() => patch({ memorySemantic: !(manifest.memorySemantic === true) })}
        />
        <ManifestRow
          title="当日精炼 · memory/daily/"
          desc="当天会话的关键结论与踩坑（只读参考）"
          on={manifest.memoryDaily === true}
          onToggle={() => patch({ memoryDaily: !(manifest.memoryDaily === true) })}
        />
        <ManifestRow
          title="红线禁令 · STANDING.md"
          desc="不可打破的常驻指令与安全约束（存在即注入；关闭前请确认后果）"
          on={manifest.memoryStanding === true}
          onToggle={() => patch({ memoryStanding: !(manifest.memoryStanding === true) })}
        />
      </Section>

      {/* 技能绑定（ADR 0014 D8）：注入目录 + 名单制过滤 */}
      <SkillsBindingSection unit={unit} manifestSkills={manifest.skills === true} onToggle={() => patch({ skills: !(manifest.skills === true) })} />

      {/* SOUL.md 编辑器 */}
      <SoulEditor
        key={`${unit.id}-${unit.soulMdMeta?.hash ?? "none"}`}
        unit={unit}
        onSave={(content, hash) =>
          updateUnit(
            { ...unit, soulMd: content },
            { ifRevision: unit.revision, ...(hash !== undefined ? { ifSoulMdHash: hash } : {}) },
          )
        }
      />

      <p className="pb-2 text-[10px] leading-relaxed text-ash">
        清单写入 bot.json（contextManifest 节）——工作台、渠道、定时会话同一份；注入只在开新会话时发生一次（冻结快照）。
      </p>
    </div>
  );
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-graphite transition hover:border-teal/50 hover:text-ink"
    >
      {label}
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-canvas">
      <div className="flex items-baseline justify-between gap-2 px-3 pb-1 pt-2.5">
        <p className="text-caption font-medium text-ink">{title}</p>
        {hint !== undefined && hint !== "" ? <span className="truncate text-[10px] text-ash">{hint}</span> : null}
      </div>
      <div className="divide-y divide-line-soft">{children}</div>
    </div>
  );
}

function ManifestRow({
  title,
  desc,
  on,
  onToggle,
  disabled,
}: {
  title: string;
  desc: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-3 py-2.5", disabled && "opacity-50")}>
      <div className="min-w-0">
        <p className="text-caption font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-ash">{desc}</p>
      </div>
      <Toggle on={on} onChange={onToggle} disabled={disabled} ariaLabel={title} />
    </div>
  );
}

/**
 * 技能绑定区（ADR 0014 D8）。两层语义分清楚：
 * - 开关 = manifest.skills（这个 bot 注不注技能目录）；
 * - 名单 = bot.json 的 skills 节（"all" / dirName 数组），只过滤**这个 bot 的注入**，
 *   不动文件系统——全局停用（搬 .disabled/）仍在设置页技能分区。
 */
function SkillsBindingSection({
  unit,
  manifestSkills,
  onToggle,
}: {
  unit: WorkUnit;
  manifestSkills: boolean;
  onToggle: () => void;
}): ReactElement {
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const binding = normalizeSkillBinding(unit.skills);
  const [catalog, setCatalog] = useState<readonly { dirName: string; name: string }[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!manifestSkills || !open || catalog !== null) return;
    let alive = true;
    // 展开名单时才拉清单（闲时省一次全盘扫描）；口径与注入一致：只列启用中的
    fetchSkillsInventory(unit.rootPath)
      .then((inv) => {
        if (!alive) return;
        const seen = new Set<string>();
        const entries: { dirName: string; name: string }[] = [];
        for (const g of inv.groups) {
          for (const s of g.skills) {
            if (s.disabled || seen.has(s.dirName)) continue;
            seen.add(s.dirName);
            entries.push({ dirName: s.dirName, name: s.name });
          }
        }
        setCatalog(entries);
      })
      .catch(() => {
        if (alive) setCatalog([]);
      });
    return () => {
      alive = false;
    };
  }, [manifestSkills, open, catalog, unit.rootPath]);

  const isAll = binding.enabled === "all";
  const list = isAll ? [] : binding.enabled;
  const saveBinding = (enabled: "all" | readonly string[]): void => {
    void updateUnit({ ...unit, skills: { enabled } }, { ifRevision: unit.revision }).catch(() => {});
  };
  const toggleSkill = (dirName: string): void => {
    const next = list.includes(dirName) ? list.filter((x) => x !== dirName) : [...list, dirName];
    saveBinding(next); // 空名单是合法状态（manifest 开着但一个都不注），不自动翻回 all
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-canvas">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-caption font-medium text-ink">技能目录 · skills</p>
          <p className="mt-0.5 text-[11px] leading-snug text-ash">
            注入 name + 路径目录（不注 SKILL.md 全文，按需读取）；名单只过滤这个 bot 的注入，全局停用仍在设置页技能分区
          </p>
        </div>
        <Toggle on={manifestSkills} onChange={onToggle} ariaLabel="技能目录注入" />
      </div>
      {manifestSkills && (
        <div className="border-t border-line-soft px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-graphite">
              注入范围：
              {isAll
                ? `全部启用中的技能${catalog !== null ? `（当前发现 ${catalog.length} 个）` : ""}`
                : list.length === 0
                  ? "空名单（不注入任何技能）"
                  : `名单制（${list.length} 个）`}
            </p>
            <div className="flex shrink-0 rounded-btn border border-line p-0.5">
              <button
                type="button"
                onClick={() => saveBinding("all")}
                className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition", isAll ? "bg-teal text-canvas" : "text-graphite hover:text-ink")}
              >
                全部
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(true);
                  if (isAll) saveBinding([]);
                }}
                className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition", !isAll ? "bg-teal text-canvas" : "text-graphite hover:text-ink")}
              >
                名单
              </button>
            </div>
          </div>
          {!isAll && (
            <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
              {catalog === null && <p className="text-[11px] text-ash">加载清单中…</p>}
              {catalog?.length === 0 && (
                <p className="text-[11px] text-ash">没有发现启用中的技能（各执行器技能源都没有 SKILL.md 文件夹）。</p>
              )}
              {catalog?.map((s) => (
                <label
                  key={s.dirName}
                  className="flex cursor-pointer items-center gap-2 rounded-btn px-1.5 py-1 text-[11px] text-graphite transition hover:bg-line-soft"
                >
                  <input
                    type="checkbox"
                    checked={list.includes(s.dirName)}
                    onChange={() => toggleSkill(s.dirName)}
                    className="h-3 w-3 accent-teal"
                  />
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ash">{s.dirName}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** SOUL.md 编辑器：与 AGENTS.md 同构（文件即数据库 + sha256 乐观锁），经 bot.put 落盘 */
function SoulEditor({
  unit,
  onSave,
}: {
  unit: WorkUnit;
  onSave: (content: string, baselineHash: string | undefined) => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState(unit.soulMd ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const baseline = unit.soulMd ?? "";
  const dirty = draft !== baseline;
  const baselineHash = unit.soulMdMeta?.hash;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft, baselineHash);
      // 保存后必须重拉定义（AddBotDialog reloadFromDisk 同款）：applyPutResult 只回写
      // revision，soulMdMeta.hash 还是旧的——不刷新的话第二次保存必带过期 hash 冲突
      await useWorkbench.getState().reloadUnit(unit.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(
        msg.includes("soul_md") || msg.includes("conflict")
          ? "SOUL.md 已被外部修改（VS Code / 另一窗口）——重新打开这个面板加载新内容后再试"
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-canvas">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
        <p className="flex items-center gap-1.5 text-caption font-medium text-ink">
          <Sparkles size={12} className="text-teal" />
          编辑 SOUL.md
        </p>
        <span className="truncate text-[10px] text-ash" title={unit.soulMdMeta?.path ?? `${unit.rootPath}/SOUL.md`}>
          {unit.soulMdMeta?.path ?? `${unit.rootPath}/SOUL.md（保存时创建）`}
        </span>
      </div>
      <div className="space-y-2 px-3 pb-3 pt-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={6}
          placeholder="这个 bot 是谁、怎么说话、主动做什么——一段写给模型看的人设。也可以直接在 VS Code 里编辑根目录的 SOUL.md。"
          className="w-full resize-y rounded-btn border border-line bg-rail px-2.5 py-2 font-mono text-caption leading-relaxed text-ink outline-none focus:border-teal/60"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="tnum text-[10px] text-ash">
            {draft.length.toLocaleString("zh-CN")} 字（注入上限 2000，超限部分注入时截断）
            {baselineHash === undefined && baseline.trim() !== "" ? " · 内容来自旧 persona 字段，保存即物化为 SOUL.md" : ""}
          </p>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="shrink-0 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas transition disabled:opacity-40"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
        {err !== null && (
          <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
        )}
      </div>
    </div>
  );
}
