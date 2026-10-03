import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Minus, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import { useProviderProfiles } from "../store/useProviderProfiles.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ProviderModelPanel } from "./ModelSettings.tsx";
import { cn } from "./cn.ts";

/**
 * 执行器实例面板 —— 逻辑对齐 T3 的 Providers 设置页
 * （ProviderSettingsPanel + ProviderInstanceCard）：
 *
 * - 左列：执行器实例列表（图标 + 名称 + 版本 + 状态行 + **启用 Switch**）；
 * - 右列编辑器：Display name / Runtime（端点·协议·启动参数）/
 *   Environment（变量表）/ Models（该 CLI 的模型清单管理）/ Advanced；
 * - 顶栏：「已检查 刚刚」+ 全量重探测刷新。
 *
 * 与 T3 的映射：T3 的 provider instance = 本项目的执行器（六家 CLI）；
 * Models 编辑器复用 per-CLI 模型清单（含收藏/排序/显隐/自定义模型）。
 */

export function ProviderInstancesPanel() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const prefs = useWorkbench((s) => s.runtimePrefs);
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const probeAll = useWorkbench((s) => s.probeAll);

  const [checkedLabel, setCheckedLabel] = useState("刚刚");
  const [checking, setChecking] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(runtimes[0]?.id ?? "");
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const selectRuntime = useWorkbench((s) => s.selectRuntime);

  const selected = runtimes.find((r) => r.id === selectedId) ?? runtimes[0];

  const refresh = async () => {
    setChecking(true);
    await probeAll();
    setChecking(false);
    setCheckedLabel("刚刚");
  };

  if (!selected) {
    return <p className="p-4 text-body-sm text-ash">没有已注册的执行器。</p>;
  }

  const pref = prefs[selected.id] ?? { enabled: true };
  const enabled = pref.enabled !== false;

  return (
    <div className="space-y-2">
      {/* 顶栏：检查状态 + 全量重探测（T3 的 Checked just now + Refresh） */}
      <div className="flex items-center justify-end gap-2">
        {checking ? (
          <span className="text-caption text-ash">检查中…</span>
        ) : (
          <span className="text-caption text-ash">已检查 {checkedLabel}</span>
        )}
        <button
          onClick={() => {
            setChecking(true);
            void refresh();
          }}
          title="重新探测全部执行器"
          aria-label="重新探测全部执行器"
          className="flex items-center gap-1 rounded-btn px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          <RefreshCw size={11} className={cn(checking && "animate-spin")} />
          刷新
        </button>
      </div>

      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3">
        {/* 左列：实例列表 */}
        <ul className="space-y-1.5">
          {runtimes.map((r) => {
            const p = prefs[r.id] ?? { enabled: true };
            const isEnabled = p.enabled !== false;
            const isActive = r.id === selected.id;
            return (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  aria-current={isActive}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-card border px-3 py-2.5 text-left",
                    isActive ? "border-teal-edge bg-teal-tint/60" : "border-line hover:bg-line-soft",
                    !isEnabled && "opacity-60",
                  )}
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-[10px] font-medium text-white"
                    style={{ background: r.presentation.accent }}
                    aria-hidden
                  >
                    {r.presentation.glyph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-body-sm font-medium text-ink">
                        {p.displayName ?? r.presentation.displayName}
                      </span>
                      {/* 测试夹具必须标出来。mockperm 不是厂商工具，是「每轮都真挂起
                          等审批」的假执行器 —— 权限闸唯一的端到端验收手段。不标的话
                          用户会以为那是个没听说过的 CLI。 */}
                      {r.testOnly && (
                        <span
                          title="测试夹具：每轮都真的挂起等审批，用来端到端验收权限闸。真实执行器启动时就把权限定死了，中途不会问你。"
                          className="shrink-0 rounded-chip border border-line bg-line-soft px-1.5 py-px text-[10px] leading-4 text-graphite"
                        >
                          测试
                        </span>
                      )}
                      {activeId === r.id && (
                        <span className="shrink-0 rounded-chip bg-ink px-1.5 py-px text-[10px] leading-4 text-canvas">
                          默认
                        </span>
                      )}
                      {r.state.status === "ready" && r.state.version && (
                        <span className="tnum shrink-0 text-caption text-ash">v{r.state.version}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-ash">
                      {r.testOnly
                        ? "假执行器 · 每轮发一次权限请求并挂起"
                        : isEnabled
                          ? `${statusLabel(r.state.status)} · ${r.transportKind}`
                          : "已停用"}
                    </span>
                  </span>
                  <InstanceSwitch
                    checked={isEnabled}
                    onChange={(v) => setPref(r.id, { enabled: v })}
                    label={`启用 ${r.presentation.displayName}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>

        {/* 右列：选中实例的编辑器 */}
        <div className="min-w-0 space-y-4">
          <InstanceEditor
            runtimeId={selected.id}
            isDefault={activeId === selected.id}
            onSetDefault={() => selectRuntime(selected.id)}
          />

          <Details title="API 供应商（兼容协议 · pi 目录）">
            <p className="text-caption leading-relaxed text-ash">
              中转站 / 自部署 / 兼容协议的接入在下方「API 供应商」卡片中管理
              （目录选型 + 密钥 + 模型清单），与本页的执行器实例互不影响。
            </p>
          </Details>

          <AdvancedSection onChange={() => setPref(selected.id, { lastCheckedAt: Date.now() })} />
        </div>
      </div>

      {/* 探测策略（全局）—— 原执行器分区的两个策略开关并入此处 */}
      <ProbeStrategyCard />
    </div>
  );
}

function ProbeStrategyCard() {
  const [probe, setProbe] = useState(true);
  const [showUninstalled, setShowUninstalled] = useState(true);
  return (
    <section className="rounded-card border border-line bg-canvas px-3.5 py-3">
      <p className="text-caption font-medium text-graphite">探测策略</p>
      <div className="mt-2 space-y-2">
        <ToggleRow
          label="能力探测"
          desc="启动时检查每家工具是否可连。探测失败的工具会在执行器条上标灰，而不是隐藏"
          checked={probe}
          onChange={setProbe}
        />
        <ToggleRow
          label="未安装工具"
          desc="在执行器条上显示并提供安装入口，还是直接隐藏"
          checked={showUninstalled}
          onChange={setShowUninstalled}
        />
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className="flex w-full items-center gap-3 rounded-btn px-1 py-1 text-left hover:bg-line-soft"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-caption font-medium text-ink">{label}</span>
        <span className="block text-caption text-ash">{desc}</span>
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-teal" : "bg-line",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left]",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "已就绪";
    case "starting":
      return "启动中";
    case "not_installed":
      return "未安装";
    case "error":
      return "出错";
    default:
      return "已停止";
  }
}

function InstanceSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative h-5 w-9 shrink-0 self-center rounded-full transition-colors",
        checked ? "bg-teal" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left]",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------- 编辑器 */

function InstanceEditor({
  runtimeId,
  isDefault,
  onSetDefault,
}: {
  runtimeId: string;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === runtimeId));
  const pref = useWorkbench((s) => s.runtimePrefs[runtimeId]) ?? { enabled: true };
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const [editingName, setEditingName] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const modelPrefsMap = useWorkbench((s) => s.modelPrefs);
  const counts = useMemo(() => {
    if (!runtime) return { visible: 0, fav: 0, hidden: 0 };
    const p = prefsOf(modelPrefsMap, runtimeId);
    const visible = resolveVisibleModels(runtime.models, p);
    return {
      visible: visible.length,
      fav: visible.filter((m) => p.favoriteModels.includes(m.id)).length,
      hidden: runtime.models.filter((m) => p.hiddenModels.includes(m.id)).length,
    };
  }, [runtime, modelPrefsMap, runtimeId]);

  if (!runtime) return null;
  const name = pref.displayName ?? runtime.presentation.displayName;

  return (
    <section className="rounded-card border border-line bg-canvas">
      {/* Display name（T3：Display name + 编辑铅笔） */}
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-3">
        <span className="w-28 shrink-0 text-caption font-medium text-graphite">Display name</span>
        {editingName ? (
          <input
            value={name}
            onChange={(e) => setPref(runtimeId, { displayName: e.target.value })}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
            autoFocus
            className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{name}</span>
            <button
              onClick={() => setEditingName(true)}
              aria-label="编辑显示名"
              className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <Pencil size={11} />
            </button>
          </>
        )}
      </div>

      {/* 默认执行器 —— T3 无此概念（本项目的 activeRuntimeId 是 composer 新任务默认） */}
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-caption font-medium text-graphite">默认执行器</span>
          <span className="block text-caption text-ash">composer 的新任务默认由它执行。</span>
        </span>
        {isDefault ? (
          <span className="shrink-0 rounded-chip bg-teal-tint px-1.5 py-0.5 text-caption text-teal">当前默认</span>
        ) : (
          <button
            onClick={onSetDefault}
            className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            设为默认
          </button>
        )}
      </div>

      {/* Runtime 区（T3：Binary path / HOME / Launch arguments → 本项目映射为端点与启动参数） */}
      <div className="border-b border-line px-3.5 py-3">
        <p className="mb-2 text-caption font-medium text-graphite">Runtime</p>
        <div className="space-y-2">
          <RowInput
            label="端点 / 命令"
            desc="该执行器的接入端点或 CLI 命令"
            value={pref.endpoint ?? runtime.transportKind}
            onChange={(v) => setPref(runtimeId, { endpoint: v })}
          />
          <RowText label="传输协议" value={runtime.transportKind} />
          <RowInput
            label="启动参数"
            desc="会话启动时附加的 CLI 参数"
            value={pref.launchArgs ?? ""}
            onChange={(v) => setPref(runtimeId, { launchArgs: v })}
          />
        </div>
      </div>

      {/* Environment 区（T3：Variables 表） */}
      <div className="border-b border-line px-3.5 py-3">
        <p className="text-caption font-medium text-graphite">Environment</p>
        <p className="mt-0.5 text-caption text-ash">API 密钥、端点等实例级 CLI 环境变量。</p>
        <EnvVars runtimeId={runtimeId} />
      </div>

      {/* Models 区：默认折叠（清单管理较长），summary 带计数 */}
      <button
        onClick={() => setModelsOpen((o) => !o)}
        aria-expanded={modelsOpen}
        className="flex w-full items-center gap-1.5 border-b border-line px-3.5 py-2.5 text-left text-caption font-medium text-graphite hover:text-ink"
      >
        <ChevronDown size={11} className={cn("-rotate-90 transition-transform", modelsOpen && "rotate-0")} />
        Models
        <span className="ml-auto font-normal text-ash">
          {counts.visible} 模型 · {counts.fav} 收藏 · {counts.hidden} 隐藏
        </span>
      </button>
      {modelsOpen && (
        <div className="border-t border-line-soft px-3.5 pb-3 pt-2">
          <ProviderModelPanel runtimeId={runtimeId} displayName={name} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- 子原语 */

function RowInput({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_200px] items-center gap-3">
      <span className="min-w-0">
        <span className="block text-caption font-medium text-graphite">{label}</span>
        {desc && <span className="block text-caption text-ash">{desc}</span>}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
      />
    </div>
  );
}

function RowText({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_200px] items-center gap-3">
      <span className="text-caption font-medium text-graphite">{label}</span>
      <span className="font-mono text-caption text-ash">{value}</span>
    </div>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-canvas">
      <p className="px-3.5 py-2.5 text-caption font-medium text-graphite">{title}</p>
      <div className="border-t border-line-soft p-3.5">{children}</div>
    </section>
  );
}

function AdvancedSection({ onChange }: { onChange: () => void }) {
  const [value, setValue] = useState(300);
  return (
    <section className="rounded-card border border-line bg-canvas px-3.5 py-3">
      <p className="text-caption font-medium text-graphite">Advanced · 健康检查间隔</p>
      <p className="mt-0.5 text-caption text-ash">后台刷新执行器状态、版本与模型；设为 0 关闭。</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => setValue((v) => Math.max(0, v - 30))}
          aria-label="减少"
          className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
        >
          <Minus size={10} />
        </button>
        <span className="tnum w-14 text-center text-body-sm text-ink">{value}</span>
        <button
          onClick={() => setValue((v) => v + 30)}
          aria-label="增加"
          className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
        >
          <Plus size={10} />
        </button>
        <span className="text-caption text-ash">seconds</span>
      </div>
      <button onClick={onChange} className="mt-2 text-caption text-ash hover:text-graphite">
        标记为已检查
      </button>
    </section>
  );
}

/* ------------------------------------------------------------- 环境变量表 */

interface EnvVar {
  key: string;
  value: string;
}

function EnvVars({ runtimeId }: { runtimeId: string }) {
  const pref = useWorkbench((s) => s.runtimePrefs[runtimeId]);
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const vars = pref?.envVars ?? [];
  const setVars = (next: readonly EnvVar[]) => setPref(runtimeId, { envVars: next });

  return (
    <div className="mt-2 space-y-1.5">
      {vars.length === 0 && <p className="text-caption text-ash">尚未配置变量。</p>}
      {vars.map((v, i) => (
        <div key={`${v.key}-${i}`} className="flex items-center gap-1.5">
          <input
            value={v.key}
            onChange={(e) => setVars(vars.map((x, xi) => (xi === i ? { ...x, key: e.target.value } : x)))}
            placeholder="KEY"
            aria-label={`变量 ${i + 1} 名`}
            spellCheck={false}
            className="w-40 rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
          />
          <input
            value={v.value}
            onChange={(e) => setVars(vars.map((x, xi) => (xi === i ? { ...x, value: e.target.value } : x)))}
            placeholder="值"
            aria-label={`变量 ${i + 1} 值`}
            className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
          />
          <button
            onClick={() => setVars(vars.filter((_, xi) => xi !== i))}
            aria-label={`移除变量 ${v.key || i + 1}`}
            className="shrink-0 rounded p-0.5 text-ash hover:bg-line hover:text-loss"
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <button
        onClick={() => setVars([...vars, { key: "", value: "" }])}
        className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
      >
        <Plus size={10} />
        添加变量
      </button>
    </div>
  );
}
