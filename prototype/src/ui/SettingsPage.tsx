import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock,
  Check,
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
  Trash2,
  X,
} from "lucide-react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  useShell,
  type SettingsSectionDef,
  type SettingsSectionId,
} from "../store/useShell.ts";
import { useWorkbench, visibleModelsFor, selectActiveUnit } from "../store/useWorkbench.ts";
import {
  useMemoryOrchestration,
  type MemoryBackend,
  type BackendType,
} from "../store/useMemoryPrefs.ts";
import { weknoraListKb, weknoraPing, weknoraSaveFact, weknoraSearch, type WeknoraConfig, type WeknoraKb } from "../core/weknora.ts";
import {
  dropLocalHandle,
  indexLocalSource,
  isIndexed,
  loadLocalHandle,
  pickLocalFolder,
  requestPermission,
  saveHandle,
  searchAllLocal,
  sourcePermission,
} from "../core/localMemorySource.ts";
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

/** 记忆分区 —— 后端注册表 + 三层路由 + 门控整理（waku 三柱 / T3 实例逻辑） */
function MemorySettingsSection() {
  const prefs = useMemoryOrchestration((s) => s.prefs);
  const addBackend = useMemoryOrchestration((s) => s.addBackend);
  const updateBackend = useMemoryOrchestration((s) => s.updateBackend);
  const removeBackend = useMemoryOrchestration((s) => s.removeBackend);
  const toggleBackend = useMemoryOrchestration((s) => s.toggleBackend);
  const setRoute = useMemoryOrchestration((s) => s.setRoute);
  const setGate = useMemoryOrchestration((s) => s.setGate);

  const [addingType, setAddingType] = useState<BackendType | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // weknora 创建草稿
  const [wkBase, setWkBase] = useState("http://localhost:18080");
  const [wkKey, setWkKey] = useState("");
  const [wkKbId, setWkKbId] = useState("");
  const [wkTesting, setWkTesting] = useState(false);
  const [wkKbs, setWkKbs] = useState<WeknoraKb[]>([]);
  const [wkStatus, setWkStatus] = useState<string | null>(null);

  // local-folder 创建
  const [lfBusy, setLfBusy] = useState(false);

  const enabledBackends = useMemo(() => prefs.backends.filter((b) => b.enabled), [prefs.backends]);

  // 门控模型选项：已启用执行器的可见模型聚合（跨执行器按模型 id 去重）
  const runtimes = useWorkbench((s) => s.runtimes);
  const runtimePrefs = useWorkbench((s) => s.runtimePrefs);
  const gateModelOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const r of runtimes) {
      if (runtimePrefs[r.id]?.enabled === false) continue;
      for (const m of visibleModelsFor(useWorkbench.getState(), r.id)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ id: m.id, label: `${m.displayName} · ${r.presentation.displayName}` });
      }
    }
    return out;
  }, [runtimes, runtimePrefs]);

  const backendTag: Record<BackendType, string> = {
    sqlite: "SQLite",
    weknora: "WeKnora",
    supabase: "Supabase",
    mem0: "Mem0",
    zep: "Zep",
    langmem: "LangMem",
    notion: "Notion",
    "local-folder": "本地文件夹",
  };

  const addTyped = (type: BackendType) => {
    setAddingType(type);
    if (type === "weknora") {
      setWkBase("http://localhost:18080");
      setWkKey("");
      setWkKbId("");
      setWkKbs([]);
      setWkStatus(null);
    }
  };

  const testWeknora = async () => {
    setWkTesting(true);
    try {
      const list = await weknoraListKb({ baseUrl: wkBase, apiKey: wkKey });
      setWkKbs(list);
      setWkStatus(`连接成功 · ${list.length} 个知识库，已填入第一个`);
      if (list[0]) setWkKbId(list[0].id);
    } catch (e) {
      setWkStatus(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setWkTesting(false);
    }
  };

  const createBackend = async () => {
    if (addingType === null) return;
    const errs: string[] = [];
    if (addingType === "weknora") {
      if (!wkKbId.trim()) errs.push("先测试连接并选择知识库 id");
      if (errs.length > 0) {
        setErrors(errs);
        return;
      }
      const id = addBackend({
        type: "weknora",
        name: `WeKnora · ${wkKbId}`,
        enabled: true,
        baseUrl: wkBase,
        apiKey: wkKey,
        kbId: wkKbId.trim(),
      });
      setRoute("semantic", [...prefs.routes.semantic, id]);
      setAddingType(null);
      return;
    }
    if (addingType === "local-folder") {
      setLfBusy(true);
      try {
        const picked = await pickLocalFolder();
        if (picked) {
          addBackend({
            type: "local-folder",
            name: `本地 · ${picked.name}`,
            enabled: true,
            sourceId: picked.id,
          });
          setAddingType(null);
        }
      } catch (e) {
        setErrors([e instanceof Error ? e.message : String(e)]);
      } finally {
        setLfBusy(false);
      }
      return;
    }
    // sqlite 及云端类型：注册即可用（sqlite 内置；云端由真运行时接入）
    const id = addBackend({
      type: addingType,
      name: backendTag[addingType],
      enabled: true,
    });
    setAddingType(null);
  };

  const routedChips = (layer: "semantic" | "episodic" | "procedural") => {
    const labelMap = { semantic: "语义记忆", episodic: "情节记忆", procedural: "程序性记忆" };
    const routed = prefs.routes[layer];
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-20 shrink-0 text-caption font-medium text-graphite">{labelMap[layer]}</span>
        {enabledBackends.length === 0 ? (
          <span className="text-caption text-ash">没有启用的后端</span>
        ) : (
          enabledBackends.map((b) => {
            const on = routed.includes(b.id);
            return (
              <button
                key={b.id}
                onClick={() => setRoute(layer, on ? routed.filter((x) => x !== b.id) : [...routed, b.id])}
                aria-pressed={on}
                className={cn(
                  "flex items-center gap-1 rounded-chip border px-2 py-0.5 text-caption",
                  on
                    ? "border-teal-edge bg-teal-tint font-medium text-ink"
                    : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {on && <Check size={10} className="text-teal" />}
                {b.name}
              </button>
            );
          })
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        三层记忆（语义 / 情节 / 程序性）各自路由到一组启用的后端：检索合并全部后端的并集，
        写入广播到每一个——分开用有分开的用法，合起来有合起来的用法。
        每 bot 的路由覆盖在「添加 bot」时声明。
      </p>

      {/* 后端注册表 */}
      <GroupCard>
        <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 pb-2 pt-3">
          <p className="text-caption font-medium text-graphite">后端注册表 · {prefs.backends.length}</p>
          <div className="flex flex-wrap items-center gap-1">
            {(["weknora", "local-folder", "sqlite", "supabase", "mem0", "zep", "langmem", "notion"] as const).map((t) => {
              const coming = !["weknora", "local-folder", "sqlite"].includes(t);
              return (
                <button
                  key={t}
                  onClick={() => addTyped(t)}
                  disabled={coming}
                  title={coming ? "真运行时接入后开放" : undefined}
                  className={cn(
                    "rounded-btn border px-1.5 py-0.5 text-caption",
                    coming
                      ? "cursor-not-allowed border-line text-ash opacity-50"
                      : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  + {backendTag[t]}
                </button>
              );
            })}
          </div>
        </div>

        <ul className="divide-y divide-line-soft">
          {prefs.backends.map((b) => {
            const isOpen = expanded === b.id;
            return (
              <li key={b.id}>
                <div className="flex items-center gap-2.5 px-4 py-2.5">
                  <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">
                    {backendTag[b.type]}
                  </span>
                  <button
                    onClick={() => setExpanded(isOpen ? null : b.id)}
                    className="min-w-0 flex-1 truncate text-left text-body-sm text-ink hover:text-teal"
                    aria-expanded={isOpen}
                  >
                    {b.name}
                  </button>
                  <Toggle on={b.enabled} onChange={(v) => toggleBackend(b.id, v)} />
                  <button
                    onClick={() => removeBackend(b.id)}
                    aria-label={`移除 ${b.name}`}
                    className="shrink-0 rounded p-0.5 text-ash hover:bg-line hover:text-loss"
                  >
                    <X size={11} />
                  </button>
                </div>
                {isOpen && (
                  <div className="border-t border-line-soft bg-rail px-4 py-3">
                    {/* 名称：所有类型都可改 */}
                    <div className="mb-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
                      <span className="text-caption font-medium text-graphite">名称</span>
                      <input
                        value={b.name}
                        onChange={(e) => updateBackend(b.id, { name: e.target.value })}
                        className="w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
                      />
                    </div>
                    {b.type === "weknora" && (
                      <div className="space-y-2">
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
                          <span className="text-caption font-medium text-graphite">API 地址</span>
                          <input
                            value={b.baseUrl ?? ""}
                            onChange={(e) => updateBackend(b.id, { baseUrl: e.target.value })}
                            spellCheck={false}
                            className="w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 font-mono text-caption text-ink outline-none focus:border-teal"
                          />
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
                          <span className="text-caption font-medium text-graphite">API Key (X-API-Key)</span>
                          <input
                            type="password"
                            value={b.apiKey ?? ""}
                            onChange={(e) => updateBackend(b.id, { apiKey: e.target.value })}
                            className="w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 font-mono text-caption text-ink outline-none focus:border-teal"
                          />
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
                          <span className="text-caption font-medium text-graphite">知识库 ID</span>
                          <input
                            value={b.kbId ?? ""}
                            onChange={(e) => updateBackend(b.id, { kbId: e.target.value })}
                            spellCheck={false}
                            className="w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 font-mono text-caption text-ink outline-none focus:border-teal"
                          />
                        </div>
                        <p className="text-caption text-ash">知识库列表可在「测试连接」中拉取后直接填写 id。</p>
                      </div>
                    )}
                    {b.type === "local-folder" && (
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-caption text-ash">
                          当前文件夹句柄已保存；换文件夹 = 重新授权新目录（原索引作废重建）。
                        </span>
                        <button
                          onClick={async () => {
                            try {
                              const picked = await pickLocalFolder();
                              if (!picked) return;
                              await saveHandle(`be-${b.id}`, picked.handle);
                              updateBackend(b.id, { sourceId: picked.id });
                            } catch (e) {
                              setErrors([e instanceof Error ? e.message : String(e)]);
                            }
                          }}
                          className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                        >
                          更换文件夹
                        </button>
                      </div>
                    )}
                    {b.type === "sqlite" && (
                      <p className="text-caption text-ash">本地 SQLite（.waku/state.db 精神）：零配置内置后端，无需配置。</p>
                    )}
                    {!["weknora", "local-folder", "sqlite"].includes(b.type) && (
                      <p className="text-caption text-ash">该后端类型由真运行时提供连接配置。</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </GroupCard>

      {/* weknora 创建卡 */}
      {addingType === "weknora" && (
        <GroupCard>
          <div className="space-y-2 px-4 py-3">
            <RowInputLocal label="API 地址" value={wkBase} onChange={setWkBase} />
            <RowInputLocal label="API Key (X-API-Key)" value={wkKey} onChange={setWkKey} password />
            <RowInputLocal label="知识库 ID" value={wkKbId} onChange={setWkKbId} />
            <button
              onClick={() => void testWeknora()}
              disabled={wkTesting}
              className="rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
            >
              {wkTesting ? "测试中…" : "测试连接并拉取知识库"}
            </button>
            {wkStatus && <p className="text-caption text-ash">{wkStatus}</p>}
          </div>
        </GroupCard>
      )}

      {/* local-folder 创建卡 */}
      {addingType === "local-folder" && (
        <GroupCard>
          <div className="space-y-2 px-4 py-3">
            <p className="text-caption text-ash">
              选择一个本地文件夹（markdown / 文本）作为记忆来源。授权句柄存本地 IndexedDB。
            </p>
            <button
              onClick={() => void createBackend()}
              disabled={lfBusy}
              className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black disabled:opacity-40"
            >
              {lfBusy ? "处理中…" : "选择文件夹"}
            </button>
          </div>
        </GroupCard>
      )}

      {/* 路由 */}
      <GroupCard>
        <div className="px-4 pb-2 pt-3">
          <p className="text-caption font-medium text-graphite">三层路由（写入广播 / 检索并集）</p>
        </div>
        <div className="space-y-3 px-4 pb-3">
          {(["semantic", "episodic", "procedural"] as const).map((layer) => routedChips(layer))}
        </div>
      </GroupCard>

      {/* 门控 / 整理 / 镜像 / 检索条数 */}
      <GroupCard>
        <SettingsRow
          label="检索门控"
          description="小模型先判断本次是否需要检索（“2+2 等于几”不检索）。门控出错即检索（fail-open）"
          control={<Toggle on={prefs.gateEnabled} onChange={(v) => setGate({ gateEnabled: v })} />}
        />
        <SettingsRow
          label="门控模型"
          description="执行门控判断的便宜模型（从已接入执行器的模型中选择）"
          control={
            <div className="relative w-64">
              <select
                value={prefs.gateModel}
                onChange={(e) => setGate({ gateModel: e.target.value })}
                aria-label="门控模型"
                className="w-full appearance-none rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
              >
                {gateModelOptions.some((o) => o.id === prefs.gateModel) ? null : (
                  <option value={prefs.gateModel}>{prefs.gateModel}（当前值不在已接入清单）</option>
                )}
                {gateModelOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ash" />
            </div>
          }
        />
        <SettingsRow
          label="整理频率"
          description="每 N 次交换由小模型从未整理对话中提取事实与情节"
          control={
            <Stepper
              value={prefs.consolidateEvery}
              min={2}
              max={20}
              step={2}
              onChange={(v) => setGate({ consolidateEvery: v })}
            />
          }
        />
        <SettingsRow
          label="语义检索条数"
          description="每次注入的相关事实条数（top K）"
          control={<Stepper value={prefs.semanticTopK} min={1} max={12} step={1} onChange={(v) => setGate({ semanticTopK: v })} />}
        />
        <SettingsRow
          label="MEMORY.md 人读镜像"
          description="每轮后重新生成 .waku/MEMORY.md，人类可直接打开阅读全部记忆"
          control={<Toggle on={prefs.mirrorMd} onChange={(v) => setGate({ mirrorMd: v })} />}
        />
      </GroupCard>

      {/* 配置透明化：完整 JSON + 实际存储位置 */}
      <GroupCard>
        <div className="px-4 pb-3 pt-3">
          <details>
            <summary className="flex cursor-pointer items-center justify-between gap-2 text-caption text-graphite hover:text-ink">
              <span>配置文件（当前生效的全部编排配置）</span>
              <span className="font-mono text-ash">localStorage · agent-workbench:memory-orchestration</span>
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-btn bg-rail p-2.5 font-mono text-caption leading-relaxed text-graphite">
              {JSON.stringify(prefs, null, 2)}
            </pre>
            <p className="mt-1.5 text-caption leading-relaxed text-ash">
              原型期编排配置存浏览器 localStorage（上方键名）；真运行时落
              .waku/ 目录（state.db / SOUL.md / MEMORY.md / skills/），
              凭据按 dsh 边界移入独立凭据库、配置只留引用名。
            </p>
          </details>
        </div>
      </GroupCard>

      {/* 实测：写入广播 + 检索合并 */}
      <MemoryTestCard />
    </div>
  );
}

/** 语义记忆实测 —— 写入广播到语义路由的全部 weknora 后端；检索合并 weknora + 本地来源 */
function MemoryTestCard() {
  const prefs = useMemoryOrchestration((s) => s.prefs);
  const [fact, setFact] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [hits, setHits] = useState<{ source: string; content: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const wkBackends = prefs.backends.filter((b) => b.enabled && b.type === "weknora" && b.kbId);
  const localBackends = prefs.backends.filter((b) => b.enabled && b.type === "local-folder" && b.sourceId);

  const writeFact = async () => {
    if (fact.trim().length === 0) return;
    setBusy(true);
    setStatus("写入中…");
    try {
      const done: string[] = [];
      for (const b of wkBackends) {
        await weknoraSaveFact(
          { baseUrl: b.baseUrl ?? "", apiKey: b.apiKey ?? "" },
          b.kbId ?? "",
          `事实 · ${new Date().toLocaleString("zh-CN")}`,
          fact.trim(),
        );
        done.push(b.name);
      }
      setStatus(done.length > 0 ? `已广播写入：${done.join("、")}` : "没有启用的 WeKnora 写入目标");
      setFact("");
    } catch (e) {
      setStatus(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    if (query.trim().length === 0) return;
    setBusy(true);
    setStatus("检索中…");
    try {
      const hits: { source: string; content: string }[] = [];
      for (const b of prefs.backends) {
        if (!b.enabled || b.type !== "weknora" || !b.kbId) continue;
        const list = await weknoraSearch(
          { baseUrl: b.baseUrl ?? "", apiKey: b.apiKey ?? "" },
          [b.kbId],
          query.trim(),
          prefs.semanticTopK,
        );
        hits.push(...list.map((h) => ({ source: b.name, content: h.content })));
      }
      const localIds = localBackends.filter((b) => b.type === "local-folder" && b.sourceId).map((b) => b.sourceId!);
      const local = searchAllLocal(localIds, query.trim(), prefs.semanticTopK);
      hits.push(...local.map((h) => ({ source: h.path, content: h.excerpt })));
      setHits(hits);
      setStatus(`合并检索到 ${hits.length} 条`);
    } catch (e) {
      setStatus(`检索失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GroupCard>
      <div className="px-4 pb-3 pt-3">
        <p className="text-caption font-medium text-graphite">记忆实测（写入广播 · 检索合并）</p>
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              placeholder="写入一条事实"
              aria-label="写入事实"
              className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
            />
            <button
              onClick={() => void writeFact()}
              disabled={fact.trim().length === 0 || busy}
              className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
            >
              写入
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索测试"
              aria-label="检索测试"
              className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
            />
            <button
              onClick={() => void search()}
              disabled={query.trim().length === 0 || busy}
              className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
            >
              检索
            </button>
          </div>
          {status && <p className="text-caption text-ash">{status}</p>}
          {hits !== null && (
            <ul className="space-y-1 rounded-btn bg-rail p-2">
              {hits.length === 0 && <li className="text-caption text-ash">没有命中的内容。</li>}
              {hits.map((h, i) => (
                <li key={i} className="text-caption leading-relaxed text-graphite">
                  [{h.source}] {h.content}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </GroupCard>
  );
}

function RowInputLocal({
  label,
  value,
  onChange,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
      <span className="text-caption font-medium text-graphite">{label}</span>
      <input
        type={password ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
      />
    </div>
  );
}


/** 存储后端多选 chips —— 一个记忆层可同时镜像到多个后端 */
function BackendChips<T extends string>({
  value,
  choices,
  onChange,
}: {
  value: readonly T[];
  choices: readonly T[];
  onChange: (v: readonly T[]) => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {choices.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
            aria-pressed={on}
            className={cn(
              "flex items-center gap-1 rounded-chip border px-2 py-1 text-caption",
              on
                ? "border-teal-edge bg-teal-tint font-medium text-ink"
                : "border-line text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            {on && <Check size={10} className="text-teal" />}
            {c}
          </button>
        );
      })}
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
