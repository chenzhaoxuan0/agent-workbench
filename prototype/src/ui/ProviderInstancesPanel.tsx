import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Info,
  KeyRound,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ProviderModelPanel } from "./ModelSettings.tsx";
import { cn } from "./cn.ts";

/**
 * 执行器实例与模型生态面板：
 *
 * 1. 左列：执行器列表（图标 + 名称 + 版本 + 就绪状态 + 启用 Switch）；
 * 2. 右列：
 *    - 顶卡：执行器真实状态卡片（Display Name 内联重命名、默认执行器标识/设为默认、传输通道）；
 *    - 主卡：平铺展开的可用模型生态管理（搜索、星标置顶、上下文窗口、推理/视觉能力、主对话底栏显隐开关）；
 *    - 底卡：终端凭据与配置指南（指导用户在 CLI 终端中如何通过官方命令完成认证与配置，剔除假输入框）。
 */

interface CliGuide {
  desc: string;
  authCmd?: string;
  configPath?: string;
  tips: string;
}

const CLI_GUIDES: Record<string, CliGuide> = {
  codex: {
    desc: "OpenAI 官方终端 Agent 交互式执行器，深度适配代码感知与多步复杂自动化任务。",
    authCmd: "codex login",
    configPath: "~/.codex/config.json",
    tips: "支持绑定 ChatGPT Plus/Pro 订阅或 OpenAI API Key。工作台通过本地子进程 stdio 交互式会话自动继承终端认证状态。",
  },
  claude: {
    desc: "Anthropic 官方终端 Agent 交互式执行器，针对大型工程重构与代码推理具备深度优化。",
    authCmd: "claude login",
    configPath: "环境变量 ANTHROPIC_API_KEY",
    tips: "可使用 Claude 官方账号登录或配置系统环境变量。工作台直接复用终端运行凭据。",
  },
  opencode: {
    desc: "开源灵活的多模型终端 Agent 执行器，支持同时接入数十种主流大模型与自建 API。",
    authCmd: "opencode auth login",
    configPath: "~/.config/opencode/",
    tips: "可在系统终端中配置各厂商的 Provider 密钥，工作台会自动动态探测已就绪的真实模型生态。",
  },
  pi: {
    desc: "轻量级全栈 Agent 终端工具，具备极简的交互架构与多供应商模型路由。",
    authCmd: "pi login",
    configPath: "~/.pi/agent/models.json",
    tips: "支持通过本地终端配置多模型路由与凭据，工作台保持实时状态同步。",
  },
  zcode: {
    desc: "本地极速 Agent 引擎，专为高并发与低延迟自动化交互设计。",
    tips: "无需额外认证，工作台通过专属管道直连本地 Agent 守护进程，开箱即用。",
  },
  mcode: {
    desc: "MCode 研发套件与私有化模型调度执行器。",
    tips: "自动适配本地工作空间与内网环境，保持稳定开箱即用状态。",
  },
  mockperm: {
    desc: "工作台权限闸（Permission Gate）端到端自动化验收测试夹具。",
    tips: "每轮对话均会触发真实的模拟权限审批挂起，专门用于测试与验收工作台的人机交互闸门。",
  },
};

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

  // 打开设置页自动探测一轮：否则上次会话的探测结果（或从未探测）会一直挂着
  // 「已离线」，让人误以为执行器坏了。ref 防重：StrictMode 双挂载只探一次。
  const autoProbedRef = useRef(false);
  useEffect(() => {
    if (autoProbedRef.current) return;
    autoProbedRef.current = true;
    setChecking(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!selected) {
    return <p className="p-4 text-body-sm text-ash">没有已注册的执行器。</p>;
  }

  const pref = prefs[selected.id] ?? { enabled: true };
  const enabled = pref.enabled !== false;

  return (
    <div className="space-y-3">
      {/* 顶栏：检查状态 + 全量重新探测 */}
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div>
          <h2 className="text-body-sm font-medium text-ink">执行器与可用模型</h2>
          <p className="text-caption text-ash">
            工作台直接调度本地安装的 Agent CLI；模型列表由 CLI 动态探测对齐，可在此自定义主对话底栏的显示项。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {checking ? (
            <span className="text-caption text-ash">正在探测本地 CLI…</span>
          ) : (
            <span className="text-caption text-ash">已探测 {checkedLabel}</span>
          )}
          <button
            onClick={() => {
              setChecking(true);
              void refresh();
            }}
            title="重新探测全部本地执行器与模型"
            aria-label="重新探测全部本地执行器与模型"
            className="flex items-center gap-1.5 rounded-btn border border-line bg-canvas px-2.5 py-1 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink transition"
          >
            <RefreshCw size={12} className={cn(checking && "animate-spin text-teal")} />
            重新探测
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[250px_minmax(0,1fr)] gap-4 items-start">
        {/* 左列：实例列表 */}
        <ul className="space-y-2">
          {runtimes.map((r) => {
            const p = prefs[r.id] ?? { enabled: true };
            const isEnabled = p.enabled !== false;
            const isSelected = r.id === selected.id;
            const isDefault = activeId === r.id;
            return (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  aria-current={isSelected}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-card border px-3 py-2.5 text-left transition",
                    isSelected
                      ? "border-teal bg-teal-tint/60 shadow-sm"
                      : "border-line bg-card hover:bg-line-soft",
                    !isEnabled && "opacity-60",
                  )}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-[11px] font-semibold text-white shadow-xs"
                    style={{ background: r.presentation.accent }}
                    aria-hidden
                  >
                    {r.presentation.glyph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate text-body-sm font-medium text-ink">
                        {p.displayName ?? r.presentation.displayName}
                      </span>
                      {r.testOnly && (
                        <span
                          title="测试夹具：模拟触发真实权限审批"
                          className="shrink-0 rounded-chip border border-line bg-line-soft px-1.5 py-px text-[10px] leading-4 text-graphite"
                        >
                          测试夹具
                        </span>
                      )}
                      {isDefault && (
                        <span className="shrink-0 rounded-chip bg-ink px-1.5 py-px text-[10px] font-medium leading-4 text-canvas">
                          默认
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-caption text-ash">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          r.state.status === "ready"
                            ? "bg-teal"
                            : r.state.status === "starting"
                              ? "bg-amber-500"
                              : "bg-ash",
                        )}
                      />
                      <span>
                        {isEnabled ? statusLabel(r.state.status, checking) : "已停用"}
                      </span>
                      {r.state.status === "ready" && r.state.version && (
                        <span className="font-mono text-[10px] text-ash">v{r.state.version}</span>
                      )}
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

        {/* 右列：当前选中执行器的核心管理 */}
        <div className="min-w-0 space-y-4">
          <InstanceEditor
            runtimeId={selected.id}
            isDefault={activeId === selected.id}
            onSetDefault={() => selectRuntime(selected.id)}
          />
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: string | undefined, checking = false): string {
  // 探测进行中，还没拿到结论（ready/error/not_installed 都是结论）的先显示「启动中」
  if (checking && status !== "ready" && status !== "error" && status !== "not_installed") {
    return "启动中";
  }
  switch (status) {
    case "ready":
      return "已就绪";
    case "starting":
      return "启动中";
    case "not_installed":
      return "未安装";
    case "error":
      return "异常";
    case "stopped":
      return "已离线";
    default:
      return "未探测";
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
      title={checked ? "已启用（点击停用）" : "已停用（点击启用）"}
      className={cn(
        "relative h-5 w-9 shrink-0 self-center rounded-full transition-colors",
        checked ? "bg-teal" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-canvas shadow-xs transition-[left]",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------- 详情编辑器 */

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

  if (!runtime) return null;
  const name = pref.displayName ?? runtime.presentation.displayName;
  const guide = CLI_GUIDES[runtimeId] ?? {
    desc: `${name} 终端执行器。`,
    tips: "工作台直接调度本地安装的命令行进程。",
  };

  return (
    <div className="space-y-4">
      {/* 顶部卡片：执行器概览与状态 */}
      <section className="rounded-card border border-line bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card text-body font-medium text-white shadow-xs"
              style={{ background: runtime.presentation.accent }}
            >
              {runtime.presentation.glyph}
            </span>
            <div>
              <div className="flex items-center gap-2">
                {editingName ? (
                  <input
                    value={name}
                    onChange={(e) => setPref(runtimeId, { displayName: e.target.value })}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
                    autoFocus
                    className="rounded-input border border-teal bg-canvas px-2 py-0.5 text-body-sm font-medium text-ink outline-none"
                  />
                ) : (
                  <>
                    <h3 className="text-body font-medium text-ink">{name}</h3>
                    <button
                      onClick={() => setEditingName(true)}
                      title="修改显示名称"
                      className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink transition"
                    >
                      <Pencil size={12} />
                    </button>
                  </>
                )}
                {runtime.state.status === "ready" && (
                  <span className="flex items-center gap-1 rounded-chip bg-teal-tint px-2 py-0.5 text-caption font-medium text-teal">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal" />
                    已就绪
                  </span>
                )}
                {runtime.state.status === "ready" && runtime.state.version && (
                  <span className="rounded-chip border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-graphite">
                    v{runtime.state.version}
                  </span>
                )}
              </div>
              <p className="mt-1 text-caption text-ash leading-relaxed">{guide.desc}</p>
            </div>
          </div>

          {/* 设为默认按钮 */}
          <div className="shrink-0 flex items-center gap-2">
            {isDefault ? (
              <span className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas">
                <CheckCircle2 size={12} className="text-teal" />
                当前默认执行器
              </span>
            ) : (
              <button
                onClick={onSetDefault}
                className="rounded-btn border border-line bg-canvas px-3 py-1.5 text-caption font-medium text-graphite hover:border-teal hover:text-ink hover:bg-line-soft transition"
              >
                设为新对话默认
              </button>
            )}
          </div>
        </div>

        {/* 传输协议与模式透视 */}
        <div className="mt-3 flex items-center gap-4 border-t border-line/60 pt-2.5 text-caption text-ash">
          <span className="flex items-center gap-1.5">
            <Terminal size={12} className="text-graphite" />
            <span>通信通道：</span>
            <span className="font-mono text-graphite">
              {runtime.transportKind === "stdio" ? "本地进程管道 (stdio)" : runtime.transportKind}
            </span>
          </span>
          <span>·</span>
          <span>
            可用模型：<span className="font-medium text-ink">{runtime.models.length}</span> 款
          </span>
        </div>
      </section>

      {/* 核心主区：平铺展开的模型生态管理（不折叠） */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-body-sm font-medium text-ink">模型生态与选择器过滤</h3>
            <p className="text-caption text-ash">
              点击星星可置顶收藏；隐藏的模型不会出现在对话底栏的下拉菜单中，保持界面清爽。
            </p>
          </div>
        </div>
        <ProviderModelPanel runtimeId={runtimeId} displayName={name} />
      </section>

      {/* 底部卡片：终端凭据与配置指南（真实指导） */}
      <section className="rounded-card border border-line bg-card p-4 space-y-2.5">
        <div className="flex items-center gap-2 text-body-sm font-medium text-ink">
          <KeyRound size={14} className="text-teal" />
          <span>终端凭据与配置指南</span>
        </div>
        <p className="text-caption text-graphite leading-relaxed">
          {guide.tips}
        </p>
        {(guide.authCmd || guide.configPath) && (
          <div className="rounded-card border border-line/80 bg-canvas p-3 text-caption font-mono space-y-1.5">
            {guide.authCmd && (
              <div className="flex items-center gap-2">
                <span className="text-ash font-sans select-none">终端登录命令：</span>
                <code className="text-teal font-semibold">{guide.authCmd}</code>
              </div>
            )}
            {guide.configPath && (
              <div className="flex items-center gap-2">
                <span className="text-ash font-sans select-none">本地配置文件：</span>
                <code className="text-graphite">{guide.configPath}</code>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
