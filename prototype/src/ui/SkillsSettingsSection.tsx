/**
 * 设置页「技能」分区 —— 按技能源分组的技能清单与停用开关。
 *
 * 领域语义（CONTEXT.md「技能与扩展」）：
 * - 停用 = 把技能文件夹搬进技能源内的 `.disabled/`，对读取该源的一切执行器生效；
 *   恢复即搬回。原生文件系统是唯一真相源，这里没有第二份状态。
 * - 影响范围 = 技能源的可见范围：分组头部的执行器徽标就是「停用会影响谁」。
 *   专属目录只影响一个执行器；公共目录（.agents）影响所有读取方 ——
 *   用户在开关的时候自己有这个意识，界面负责把范围摆在眼前。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillEntryInfo, SkillSourceGroupInfo, SkillsInventory } from "../core/skills.ts";
import { fetchSkillsInventory, setSkillDisabledRpc } from "../adapters/daemon/client.ts";
import { useNativeCommands } from "../store/useNativeCommands.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

type LoadStatus = "loading" | "ready" | "error";

export function SkillsSettingsSection() {
  const activeUnit = useWorkbench(selectActiveUnit);
  const activeRoot = activeUnit?.rootPath ?? null;

  const [inv, setInv] = useState<SkillsInventory | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  /** 拉取错误（load 自管：成功清、失败设；有旧数据时不清屏只挂横幅） */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 操作错误（开关/批量）——与 loadErr 分离，清单重载不会把它冲掉 */
  const [err, setErr] = useState<string | null>(null);
  /** 在途开关动作（`${groupId}|${dirName}`），防重复点击与批量闪烁 */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /** 选中的技能源（组 id）；null = 默认第一个源。切 bot 后项目源变化时自动回落 */
  const [selSource, setSelSource] = useState<string | null>(null);
  /** 请求序号：快速切 bot 连发 load 时只有最新一次允许写状态（旧响应后到不得覆盖新数据） */
  const reqSeq = useRef(0);

  const load = useCallback(async (root: string | null): Promise<void> => {
    const seq = ++reqSeq.current;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    try {
      const data = await fetchSkillsInventory(root ?? undefined);
      if (seq !== reqSeq.current) return;
      setInv(data);
      setStatus("ready");
      setLoadErr(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // 拉取失败保留旧清单（好过清屏），只在从没成功过时进 error 态
      setStatus((s) => (s === "ready" ? "ready" : "error"));
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(activeRoot);
  }, [activeRoot, load]);

  const markPending = (key: string, on: boolean): void => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** 单个开关：RPC 搬运 → 清命令缓存 → 重拉清单（盘上世界变了，重新看真相） */
  const toggle = useCallback(
    async (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean): Promise<{ msg: string; code?: string } | null> => {
      const key = `${group.id}|${entry.dirName}`;
      markPending(key, true);
      try {
        await setSkillDisabledRpc(group.dir, entry.dirName, disabled, activeRoot ?? undefined);
        // daemon 已失效自己的缓存；前端 10 分钟 TTL 缓存跟着作废
        useNativeCommands.getState().invalidateAll();
        return null;
      } catch (e) {
        return { msg: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code };
      } finally {
        markPending(key, false);
      }
    },
    [activeRoot],
  );

  const handleToggle = (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean): void => {
    void (async () => {
      const e = await toggle(group, entry, disabled);
      if (e !== null) setErr(e.msg);
      await load(activeRoot);
    })();
  };

  /**
   * 目录级批量：只动状态需要变的条目，逐个搬运；失败聚合报首错（本地 rename，毫秒级）。
   * daemon 断连/超时立即中止 —— 每个失败项都要吃满连接超时，20 项串行能拖两分钟。
   */
  const handleBatch = (group: SkillSourceGroupInfo, disabled: boolean): void => {
    void (async () => {
      const targets = group.skills.filter((s) => s.disabled !== disabled && s.singleForm !== true);
      let firstErr: string | null = null;
      for (const t of targets) {
        const e = await toggle(group, t, disabled);
        if (e !== null) {
          if (firstErr === null) firstErr = e.msg;
          if (e.code === "daemon_unreachable" || e.code === "daemon_rpc_timeout" || e.code === "daemon_disconnected") {
            firstErr = `daemon 连接不可用，批量操作中止（可恢复后重试）：${e.msg}`;
            break;
          }
        }
      }
      if (firstErr !== null) setErr(firstErr);
      await load(activeRoot);
    })();
  };

  // 技能源切换：主源（用户级/项目级）各占一个 tab；只读插件源聚合一个 tab
  //（zcode/agy 插件逐版本成源，单独列 tab 会把切换条挤爆）
  const PLUGIN_TAB = "__plugins__";
  const mainGroups = (inv?.groups ?? []).filter((g) => g.scope !== "plugin");
  const pluginGroups = (inv?.groups ?? []).filter((g) => g.scope === "plugin");
  const activeGroup = mainGroups.find((g) => g.id === selSource) ?? mainGroups[0];
  const pluginTabActive = selSource === PLUGIN_TAB || (selSource === null && mainGroups.length === 0 && pluginGroups.length > 0);

  return (
    <div className="space-y-4">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        停用 = 把技能文件夹移入技能源内的 <span className="font-mono text-ink">.disabled/</span> 目录，
        对读取该源的所有执行器立即生效；恢复即搬回，文件一个不丢。
        每组头部的执行器徽标就是影响范围 —— 专属目录只影响一家，公共目录（.agents）影响所有家。
      </p>

      {status === "loading" && <p className="text-body-sm text-ash">正在扫描技能源…</p>}
      {status === "error" && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">
          技能清单拉取失败：{loadErr ?? "daemon 未响应"}
        </p>
      )}

      {status === "ready" && loadErr !== null && (
        <p className="flex items-center gap-2 rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          <span className="min-w-0 flex-1">清单刷新失败（保留上次内容）：{loadErr}</span>
          <button
            onClick={() => void load(activeRoot)}
            className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            重试
          </button>
        </p>
      )}

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}

      {status === "ready" && inv !== null && inv.groups.length === 0 && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          还没有发现任何技能。把一个含 <span className="font-mono">SKILL.md</span> 的文件夹放进任意技能源
          （如 <span className="font-mono">~/.agents/skills/&lt;name&gt;/</span>）即可被全部执行器发现。
        </p>
      )}

      {/* 技能源切换条（对齐 MCP 分区的执行器 tab 形态） */}
      {status === "ready" && (mainGroups.length > 0 || pluginGroups.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {mainGroups.map((g) => {
            const active = !pluginTabActive && activeGroup?.id === g.id;
            const enabled = g.skills.filter((s) => !s.disabled).length;
            return (
              <button
                key={g.id}
                onClick={() => setSelSource(g.id)}
                className={cn(
                  "rounded-chip border px-2.5 py-1 text-body-sm transition",
                  active
                    ? "border-teal bg-teal-tint font-medium text-ink"
                    : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {g.label}
                <span className="ml-1 tnum text-caption">{enabled}</span>
              </button>
            );
          })}
          {pluginGroups.length > 0 && (
            <button
              onClick={() => setSelSource(PLUGIN_TAB)}
              className={cn(
                "rounded-chip border px-2.5 py-1 text-body-sm transition",
                pluginTabActive
                  ? "border-teal bg-teal-tint font-medium text-ink"
                  : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              插件源
              <span className="ml-1 tnum text-caption">{pluginGroups.length}</span>
            </button>
          )}
        </div>
      )}

      {status === "ready" && !pluginTabActive && activeGroup !== undefined && (
        <SkillGroupCard
          key={activeGroup.id}
          group={activeGroup}
          pending={pending}
          onToggle={handleToggle}
          onBatch={handleBatch}
        />
      )}

      {status === "ready" && pluginTabActive && pluginGroups.map((g) => (
        <SkillGroupCard
          key={g.id}
          group={g}
          pending={pending}
          onToggle={handleToggle}
          onBatch={handleBatch}
        />
      ))}

      {activeRoot !== null && (
        <p className="text-caption leading-relaxed text-ash">
          项目级技能源按当前工作区（{activeUnit?.name}）列出；切换侧栏 bot 后此处随之更新。
        </p>
      )}
    </div>
  );
}

function SkillGroupCard({
  group,
  pending,
  onToggle,
  onBatch,
}: {
  group: SkillSourceGroupInfo;
  pending: ReadonlySet<string>;
  onToggle: (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean) => void;
  onBatch: (group: SkillSourceGroupInfo, disabled: boolean) => void;
}) {
  const activeCount = group.skills.filter((s) => !s.disabled).length;
  const disabledCount = group.skills.length - activeCount;
  const canBatch = !group.readOnly && group.skills.length > 0;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-4 pb-2.5 pt-3">
        <div className="min-w-0">
          <span className="text-body-sm font-medium text-ink">{group.label}</span>
          <span className="ml-2 tnum text-caption text-ash">
            {activeCount} 启用{disabledCount > 0 ? ` · ${disabledCount} 停用` : ""}
          </span>
          <p className="truncate font-mono text-caption text-ash" title={group.dir}>{group.dir}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex max-w-[340px] flex-wrap items-center justify-end gap-1" title="停用该源内的技能会影响这些执行器">
            {group.readers.map((r) => (
              <span key={r.id} className="rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">
                {r.name}
              </span>
            ))}
          </span>
          {canBatch && (
            <span className="flex shrink-0 gap-1.5">
              <BatchButton label="全部停用" onClick={() => onBatch(group, true)} disabled={activeCount === 0} />
              <BatchButton label="全部恢复" onClick={() => onBatch(group, false)} disabled={disabledCount === 0} />
            </span>
          )}
        </div>
      </div>

      {group.readOnly && (
        <p className="border-b border-line-soft bg-rail/40 px-4 py-1.5 text-caption text-ash">
          只读源：由 {group.label.startsWith("agy") ? "Antigravity" : "所属工具"} 自身管理，只展示不提供开关。
        </p>
      )}

      <ul className="divide-y divide-line-soft">
        {group.skills.map((s) => {
          const key = `${group.id}|${s.dirName}`;
          const busy = pending.has(key);
          return (
            <li key={`${s.dirName}${s.disabled ? "|off" : ""}`} className={cn("flex items-center gap-3 px-4 py-2.5", s.disabled && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn("truncate text-body-sm", s.disabled ? "text-graphite" : "text-ink")}>{s.name}</span>
                  {s.dirName !== s.name && (
                    <span className="truncate font-mono text-caption text-ash" title={s.dirName}>{s.dirName}</span>
                  )}
                </div>
                {s.description !== undefined && (
                  <p className="truncate text-caption text-ash" title={s.description}>{s.description}</p>
                )}
              </div>
              {group.readOnly || s.singleForm === true ? (
                <span className="shrink-0 text-caption text-ash" title={s.singleForm === true ? "SKILL.md 直挂源目录，源目录即技能：无法搬进自己内部" : undefined}>
                  {s.singleForm === true ? "单技能形态" : "只读"}
                </span>
              ) : (
                <Toggle on={!s.disabled} onChange={(v) => onToggle(group, s, !v)} />
              )}
              {busy && <span className="shrink-0 text-caption text-ash">…</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BatchButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}
