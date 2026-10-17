import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Pencil,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
  Terminal,
  Zap,
} from "lucide-react";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useShell } from "../store/useShell.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { executorIconSrc } from "./executorIcon.ts";
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
    tips: "自动适配本机与内网环境，保持稳定开箱即用状态。",
  },
  agy: {
    desc: "Google 官方 Antigravity Agent 执行器，提供强大的全功能代码与多模态模型调度。",
    authCmd: "agy",
    configPath: "~/.gemini/",
    tips: "支持 Gemini 3.8 / 3.7 / 3.1 等系列模型，具备深度思考、工具调用与多模态能力。",
  },
  antigravity: {
    desc: "Google 官方 Antigravity Agent 执行器，提供强大的全功能代码与多模态模型调度。",
    authCmd: "agy",
    configPath: "~/.gemini/",
    tips: "支持 Gemini 3.8 / 3.7 / 3.1 等系列模型，具备深度思考、工具调用与多模态能力。",
  },
  grok: {
    desc: "SpaceXAI 官方终端 Agent 执行器，深度适配代码感知与多步复杂自动化任务。",
    authCmd: "grok login",
    configPath: "~/.grok/config.toml",
    tips: "支持 xAI 官方账户登录，工作台通过 streaming-messages-json 协议流式直连 Grok Build 执行器。",
  },
  cursor: {
    desc: "Cursor 官方 CLI 模式 Agent 执行器（cursor-agent），支持跨模型路由、推理与工具调用。",
    authCmd: "cursor-agent login",
    configPath: "~/.cursor/",
    tips: "可使用 Cursor 账号或 CURSOR_API_KEY 环境变量登录，工作台通过 stream-json 协议保持双向交互与模型同步。",
  },
  "cursor-agent": {
    desc: "Cursor 官方 CLI 模式 Agent 执行器（cursor-agent），支持跨模型路由、推理与工具调用。",
    authCmd: "cursor-agent login",
    configPath: "~/.cursor/",
    tips: "可使用 Cursor 账号或 CURSOR_API_KEY 环境变量登录，工作台通过 stream-json 协议保持双向交互与模型同步。",
  },
  openclaw: {
    desc: "OpenClaw 统一 Agent 与多渠道消息网关执行器，支持多 Agent 隔离与本地/网关调度。",
    authCmd: "openclaw onboard",
    configPath: "~/.openclaw/openclaw.json",
    tips: "支持通过本地终端配置多模型凭据与网关，工作台动态对接模型目录并支持单轮与多轮会话调度。",
  },
  mockperm: {
    desc: "工作台权限闸（Permission Gate）端到端自动化验收测试夹具。",
    tips: "每轮对话均会触发真实的模拟权限审批挂起，专门用于测试与验收工作台的人机交互闸门。",
  },
};

export interface ProviderInstallGuide {
  readonly title: string;
  readonly commandWindows: string;
  readonly commandPosix?: string;
  readonly altCommand?: string;
  readonly altCommandLabel?: string;
  readonly docUrl?: string;
  readonly tips: string;
}

export const PROVIDER_INSTALL_GUIDES: Record<string, ProviderInstallGuide> = {
  grok: {
    title: "Grok Build CLI",
    commandWindows: "irm https://x.ai/cli/install.ps1 | iex",
    commandPosix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    altCommand: "cargo build -p xai-grok-pager-bin --release",
    altCommandLabel: "本地源码编译 (grok-build)",
    docUrl: "https://x.ai/cli",
    tips: "SpaceXAI 官方安装脚本会自动下载预编译二进制至 ~/.grok/bin 并写入环境变量。若使用本地 grok-build 源码，也可在源码根目录运行 cargo build 编译。",
  },
  cursor: {
    title: "Cursor Agent CLI (cursor-agent)",
    commandWindows: "npm install -g cursor-agent",
    commandPosix: "npm install -g cursor-agent",
    altCommand: "irm https://cursor.com/install.ps1 | iex",
    altCommandLabel: "官方安装脚本",
    docUrl: "https://cursor.com/cli",
    tips: "Cursor 官方 CLI 模式（cursor-agent）。安装后在终端运行 cursor-agent login 即可完成认证。",
  },
  "cursor-agent": {
    title: "Cursor Agent CLI (cursor-agent)",
    commandWindows: "npm install -g cursor-agent",
    commandPosix: "npm install -g cursor-agent",
    altCommand: "irm https://cursor.com/install.ps1 | iex",
    altCommandLabel: "官方安装脚本",
    docUrl: "https://cursor.com/cli",
    tips: "Cursor 官方 CLI 模式（cursor-agent）。安装后在终端运行 cursor-agent login 即可完成认证。",
  },
  openclaw: {
    title: "OpenClaw CLI",
    commandWindows: "npm install -g openclaw",
    commandPosix: "npm install -g openclaw",
    altCommand: "openclaw onboard",
    altCommandLabel: "初始化向导",
    docUrl: "https://openclaw.ai",
    tips: "OpenClaw 全局 npm 包安装后，在终端执行 openclaw onboard 即可完成初始化网关配置与模型接入。",
  },
  codex: {
    title: "OpenAI Codex CLI",
    commandWindows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    commandPosix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    altCommand: "npm i -g @openai/codex",
    altCommandLabel: "npm 全局安装",
    docUrl: "https://developers.openai.com/codex/cli",
    tips: "OpenAI 官方 Codex CLI。安装后运行 codex login 进行账号登录或绑定 API 密钥。",
  },
  claude: {
    title: "Claude Code CLI",
    commandWindows: "irm https://claude.ai/install.ps1 | iex",
    commandPosix: "curl -fsSL https://claude.ai/install.sh | bash",
    altCommand: "npm i -g @anthropic-ai/claude-code",
    altCommandLabel: "npm 全局安装",
    docUrl: "https://claude.com/product/claude-code",
    tips: "Anthropic 官方 Claude Code 终端执行器。安装后运行 claude login 登录账号。",
  },
  opencode: {
    title: "OpenCode CLI",
    commandWindows: "npm i -g opencode-ai",
    commandPosix: "npm i -g opencode-ai",
    docUrl: "https://opencode.ai",
    tips: "开源多模型终端 Agent 执行器。安装后运行 opencode auth login 配置各厂商模型密钥。",
  },
  pi: {
    title: "Pi Agent CLI",
    commandWindows: "npm i -g @earendil-works/pi-coding-agent",
    commandPosix: "npm i -g @earendil-works/pi-coding-agent",
    tips: "轻量全栈 Agent 工具。安装后运行 pi login 配置模型路由。",
  },
  mcode: {
    title: "MiniMax MCode CLI",
    commandWindows: "npm i -g @minimax/mcode",
    commandPosix: "npm i -g @minimax/mcode",
    tips: "MiniMax Code 研发套件，支持私有化模型调度。",
  },
  hermes: {
    title: "Hermes Agent CLI",
    commandWindows: "pip install hermes-agent",
    commandPosix: "pipx install hermes-agent",
    altCommand: "pipx install hermes-agent",
    altCommandLabel: "pipx 隔离安装",
    tips: "通过 Python pip 或 pipx 安装 hermes-agent。",
  },
  kimi: {
    title: "Kimi Code CLI",
    commandWindows: "npm i -g @moonshot-ai/kimi-code",
    commandPosix: "npm i -g @moonshot-ai/kimi-code",
    tips: "Moonshot Kimi Code 终端执行器，安装后在终端进行认证。",
  },
  dsh: {
    title: "DeepSeek Harness CLI",
    commandWindows: "npm i -g @deepseek-ai/dsh",
    commandPosix: "npm i -g @deepseek-ai/dsh",
    tips: "DeepSeek Harness 官方 CLI，安装后运行 dsh login 或配置 DEEPSEEK_API_KEY。",
  },
  agy: {
    title: "Google Antigravity CLI",
    commandWindows: "agy",
    docUrl: "https://antigravity.google",
    tips: "Google 官方 Antigravity 执行器，已集成在本地环境。",
  },
  antigravity: {
    title: "Google Antigravity CLI",
    commandWindows: "agy",
    docUrl: "https://antigravity.google",
    tips: "Google 官方 Antigravity 执行器，已集成在本地环境。",
  },
};

function InstallGuideCard({
  runtimeId,
  displayName,
  hint,
  status,
  onRecheck,
}: {
  runtimeId: string;
  displayName: string;
  hint?: string;
  status: string;
  onRecheck?: () => void;
}) {
  const bareId = runtimeId.replace(/^daemon:/, "").toLowerCase();
  const guide = PROVIDER_INSTALL_GUIDES[bareId];
  const [copiedMain, setCopiedMain] = useState(false);
  const [copiedAlt, setCopiedAlt] = useState(false);
  const [runningInTerminal, setRunningInTerminal] = useState(false);
  const [checking, setChecking] = useState(false);

  if (!guide && !hint) return null;

  const isWindows = typeof navigator !== "undefined" ? navigator.userAgent.includes("Windows") : true;
  const mainCmd = (isWindows ? guide?.commandWindows : (guide?.commandPosix ?? guide?.commandWindows)) ?? "";

  const handleCopy = (cmd: string, isAlt: boolean) => {
    if (!cmd) return;
    void navigator.clipboard.writeText(cmd);
    if (isAlt) {
      setCopiedAlt(true);
      setTimeout(() => setCopiedAlt(false), 2000);
    } else {
      setCopiedMain(true);
      setTimeout(() => setCopiedMain(false), 2000);
    }
  };

  const handleRunInTerminal = (cmdToRun: string) => {
    if (!cmdToRun) return;
    setRunningInTerminal(true);
    // 复制到剪贴板兜底
    void navigator.clipboard.writeText(cmdToRun);

    // 在工作台终端新建标签
    const termId = useTerminalStore.getState().createTab({
      profileId: "pwsh",
      title: `安装 ${displayName}`,
    });

    // 关闭设置页切到终端让用户直接观看安装
    useShell.getState().closeSettings();

    // 稍等 PTY 初始化完成后注入命令并回车执行
    setTimeout(() => {
      try {
        const client = DaemonClient.get(defaultDaemonEndpoint());
        void client.rpc("terminal.input", { terminalId: termId, data: `${cmdToRun}\r` }).catch(() => {});
      } catch {
        /* ignore */
      }
      setRunningInTerminal(false);
    }, 800);
  };

  const handleRecheck = async () => {
    setChecking(true);
    try {
      if (onRecheck) {
        await onRecheck();
      }
    } finally {
      setTimeout(() => setChecking(false), 600);
    }
  };

  return (
    <section className="rounded-card border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-500">
            <Download size={15} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-body-sm font-semibold text-ink">未检测到该执行器 CLI</h4>
              <span className="rounded-chip bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-500">
                需要安装
              </span>
            </div>
            <p className="mt-1 text-caption text-graphite leading-relaxed">
              {hint ?? guide?.tips ?? "检测到本机未安装或 PATH 中尚未包含该执行器可执行文件。可通过下方官方命令一键安装。"}
            </p>
          </div>
        </div>

        {/* 重新探测按钮 */}
        <button
          onClick={handleRecheck}
          disabled={checking}
          title="重新检测该执行器安装状态"
          className="shrink-0 flex items-center gap-1.5 rounded-btn border border-line bg-card px-2.5 py-1 text-caption font-medium text-graphite hover:border-teal hover:text-ink hover:bg-line-soft transition"
        >
          <RefreshCw size={12} className={cn(checking && "animate-spin text-teal")} />
          <span>重新检测</span>
        </button>
      </div>

      {mainCmd && (
        <div className="rounded-card border border-line bg-canvas p-3 space-y-2">
          <div className="flex items-center justify-between text-caption text-ash">
            <span className="font-sans font-medium">推荐安装命令（Windows PowerShell / 终端）：</span>
            {guide?.docUrl && (
              <a
                href={guide.docUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-teal hover:underline"
              >
                <span>官方文档</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 rounded bg-card px-3 py-2 border border-line/60 font-mono text-caption text-ink">
            <span className="select-all overflow-x-auto whitespace-nowrap">{mainCmd}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => handleCopy(mainCmd, false)}
                title="复制命令"
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-sans font-medium border border-line bg-canvas hover:border-teal hover:text-teal transition"
              >
                {copiedMain ? <Check size={11} className="text-teal" /> : <Copy size={11} />}
                <span>{copiedMain ? "已复制" : "复制"}</span>
              </button>
              <button
                onClick={() => handleRunInTerminal(mainCmd)}
                disabled={runningInTerminal}
                title="新建终端标签并自动执行安装命令"
                className="flex items-center gap-1 rounded bg-teal px-2.5 py-1 text-[11px] font-sans font-medium text-white hover:bg-teal-hover transition shadow-xs"
              >
                <Terminal size={11} />
                <span>在终端运行安装</span>
              </button>
            </div>
          </div>

          {guide?.altCommand && (
            <div className="flex items-center justify-between pt-1 text-[11px] text-ash">
              <span className="font-sans">
                {guide.altCommandLabel ?? "备选方案"}：
                <code className="ml-1 text-graphite font-mono">{guide.altCommand}</code>
              </span>
              <button
                onClick={() => handleCopy(guide.altCommand!, true)}
                className="text-teal hover:underline font-sans ml-2"
              >
                {copiedAlt ? "已复制" : "复制备选命令"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ProviderInstancesPanel() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const prefs = useWorkbench((s) => s.runtimePrefs);
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const probeAll = useWorkbench((s) => s.probeAll);
  const syncModelsAll = useWorkbench((s) => s.syncModelsAll);
  const syncingModels = useWorkbench((s) => s.syncingModels);
  const modelSync = useWorkbench((s) => s.modelSync);

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

  /**
   * 模型清单刷新 —— 与执行器探测**分成两个按钮**。
   *
   * 之前模型刷新寄生在执行器探测里（daemon 的 probe 顺带调 syncModels），两个后果：
   * 一是点「探测」要等模型 CLI 冷启动才知道装没装；二是刷新结果只留在 daemon 内存里，
   * 界面永远看不到，用户只能反复点然后怀疑「是不是我该重启一下」。
   *
   * 只读元数据探测，零 token 零计费 —— 可以放心按。
   */
  const refreshModels = async () => {
    await syncModelsAll();
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

  /** 每家的模型同步来源 → 一句话标签。static = 没刷到，用的是内置兜底清单 */
  const syncLabel = useMemo(() => {
    const m = new Map<string, { live: boolean; count: number; reason?: string }>();
    for (const r of modelSync?.report ?? []) {
      m.set(r.runtimeId, { live: r.source === "live", count: r.count, reason: r.reason });
    }
    return m;
  }, [modelSync]);

  const modelsSyncedLabel = modelSync === null ? "尚未刷新" : `已刷新 ${formatAgo(modelSync.at)}`;
  const liveCount = (modelSync?.report ?? []).filter((r) => r.source === "live").length;
  const totalCount = (modelSync?.report ?? []).length;

  if (!selected) {
    return <p className="p-4 text-body-sm text-ash">没有已注册的执行器。</p>;
  }

  const pref = prefs[selected.id] ?? { enabled: true };
  const enabled = pref.enabled !== false;

  return (
    <div className="space-y-3">
      {/* 顶栏：两个独立按钮 —— 执行器探测 / 模型探测 */}
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div>
          <h2 className="text-body-sm font-medium text-ink">执行器与可用模型</h2>
          <p className="text-caption text-ash">
            工作台直接调度本地安装的 Agent CLI；模型清单单独探测，订阅里有新模型点一下就能刷出来。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end gap-0.5">
            {syncingModels ? (
              <span className="text-caption text-ash">正在读各执行器的模型清单…</span>
            ) : (
              <span className="text-caption text-ash">
                {modelsSyncedLabel}
                {totalCount > 0 && (
                  <span className="tnum">
                    {" "}
                    · {liveCount}/{totalCount} 家实时
                  </span>
                )}
              </span>
            )}
            <span className="text-[11px] text-ash/80">探测执行器：{checking ? "进行中…" : checkedLabel}</span>
          </div>
          <button
            onClick={() => {
              setChecking(true);
              void refresh();
            }}
            disabled={checking}
            title="重新检测各执行器的安装状态与版本（不碰模型清单）"
            aria-label="重新探测执行器"
            className="flex items-center gap-1.5 rounded-btn border border-line bg-canvas px-2.5 py-1 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-50 transition"
          >
            <RefreshCw size={12} className={cn(checking && "animate-spin text-teal")} />
            探测执行器
          </button>
          <button
            onClick={() => void refreshModels()}
            disabled={syncingModels}
            title="重新读取各执行器的可用模型（模型 id / 名称 / 上下文窗口）。只读元数据，不发任何请求、不消耗用量。"
            aria-label="重新探测模型"
            className="flex items-center gap-1.5 rounded-btn border border-teal/40 bg-teal-tint/50 px-2.5 py-1 text-caption font-medium text-ink hover:bg-teal-tint disabled:opacity-50 transition"
          >
            <Sparkles size={12} className={cn(syncingModels && "animate-pulse text-teal")} />
            探测模型
          </button>
        </div>
      </div>

      {modelSync?.error !== undefined && (
        <p className="flex items-center gap-1.5 rounded-card border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-caption text-amber-600">
          <AlertCircle size={12} className="shrink-0" />
          模型刷新失败：{modelSync.error}
        </p>
      )}

      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
        {/* 左列：实例列表 */}
        <ul className="space-y-2">
          {runtimes.map((r) => {
            const p = prefs[r.id] ?? { enabled: true };
            const isEnabled = p.enabled !== false;
            const isSelected = r.id === selected.id;
            const isDefault = activeId === r.id;
            const rawVersion = r.state.status === "ready" ? r.state.version : undefined;
            const shortVer = formatShortVersion(rawVersion);
            const displayName = cleanDisplayName(p.displayName ?? r.presentation.displayName);
            return (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  aria-current={isSelected}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-card border px-3 py-2.5 text-left transition",
                    isSelected
                      ? "border-teal bg-teal-tint/60 shadow-sm"
                      : "border-line bg-card hover:bg-line-soft",
                    !isEnabled && "opacity-60",
                  )}
                >
                  {executorIconSrc(r.id) ? (
                    <img
                      src={executorIconSrc(r.id) ?? undefined}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-btn object-contain"
                      aria-hidden
                    />
                  ) : (
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-[11px] font-semibold text-white shadow-xs"
                      style={{ background: r.presentation.accent }}
                      aria-hidden
                    >
                      {r.presentation.glyph}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 overflow-hidden">
                    {/* 第一行：执行器名称 + 默认标识 */}
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-body-sm font-medium text-ink">
                        {displayName}
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

                    {/* 第二行：状态 + 版本号（严格单行，绝不折断中文字符，超长尾部截断） */}
                    <span className="mt-1 flex items-center gap-1.5 text-caption text-ash min-w-0 whitespace-nowrap overflow-hidden">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full shrink-0",
                          r.state.status === "ready"
                            ? "bg-teal"
                            : r.state.status === "starting"
                              ? "bg-amber-500"
                              : "bg-ash",
                        )}
                      />
                      <span className="shrink-0 whitespace-nowrap">
                        {isEnabled ? statusLabel(r.state.status, checking) : "已停用"}
                      </span>
                      {shortVer && (
                        <span
                          title={rawVersion}
                          className="font-mono text-[10px] text-ash truncate min-w-0"
                        >
                          {shortVer}
                        </span>
                      )}
                    </span>

                    {/* 第三行：模型清单来源。这是「刷新有没有用」的唯一可见依据 ——
                        没标的话，用户对着一个从没变过的列表只会怀疑是自己没刷新对 */}
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-ash min-w-0">
                      <span className="tnum shrink-0">模型 {r.models.length}</span>
                      {r.modelsCachedAt !== null ? (
                        /* 这一档排最前，因为它盖过其余所有情况：连实时源都没碰到，
                           显示的是上次成功探测的结果。用户必须一眼看出「这不是刚探的」，
                           否则「我明明刷新过」和「其实没刷到」永远分不开。 */
                        <span
                          className="shrink-0 text-amber-600"
                          title="本次启动没能连上实时源，当前清单来自上次成功探测的结果"
                        >
                          · 来自上次探测 {formatAgo(r.modelsCachedAt)}
                        </span>
                      ) : !r.modelsDiscoverable ? (
                        <span
                          className="shrink-0 text-ash/90"
                          title="该执行器没有模型清单查询接口，只能用内置清单 —— 刷新对它无效"
                        >
                          · 静态清单
                        </span>
                      ) : modelSync === null ? (
                        <span className="shrink-0">· 未刷新</span>
                      ) : (
                        syncLabel.get(r.id.replace(/^daemon:/, ""))?.live === true ? (
                          <span className="shrink-0 text-teal" title="已从该执行器的 CLI / 本地目录实时读到">
                            · 实时
                          </span>
                        ) : (
                          <span
                            className="shrink-0 text-amber-600"
                            title={
                              syncLabel.get(r.id.replace(/^daemon:/, ""))?.reason ??
                              "没读到实时清单，当前显示的是内置兜底"
                            }
                          >
                            · 兜底
                          </span>
                        )
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

/**
 * 清洗执行器显示名称：
 * 去除历史或默认生成的「 · daemon」后缀，保持名称极简精炼。
 */
export function cleanDisplayName(name: string | undefined): string {
  if (!name) return "";
  return name.replace(/\s*·\s*daemon$/i, "").trim();
}

/**
 * 提取精简版本号（保证左侧实例卡第二行单行展示，不换行）：
 * 优先提取核心版本号（如 v0.16.9, v0.20.0, v2026.10.2），
 * 剔除冗长的包名前缀或长括号说明，多余内容由右侧卡片与悬浮 title 显示。
 */
/** 距今多久（模型刷新时间的展示用）。超过 1 分钟就不再精确到秒 —— 没人关心 3 分钟前的刷新 */
function formatAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function formatShortVersion(rawVersion: string | undefined): string | null {  if (!rawVersion || rawVersion.trim() === "") return null;
  const trimmed = rawVersion.trim();
  // 匹配类似 0.16.9 / v0.20.0 / 2026.10.2 / 0.2.0-rc.2 / 1.0.52
  const match = trimmed.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  if (match?.[1]) {
    return `v${match[1]}`;
  }
  const first = trimmed.split(/[\s(]/)[0] ?? trimmed;
  return first.startsWith("v") || first.startsWith("V") ? first : `v${first}`;
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
  const probeAll = useWorkbench((s) => s.probeAll);
  const [editingName, setEditingName] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const agyDefaultYolo = useTerminalStore((s) => s.agyDefaultYolo);
  const setAgyDefaultYolo = useTerminalStore((s) => s.setAgyDefaultYolo);

  if (!runtime) return null;
  const bareRuntimeId = runtimeId.replace(/^daemon:/, "").toLowerCase();
  const name = cleanDisplayName(pref.displayName ?? runtime.presentation.displayName);
  const guide = CLI_GUIDES[bareRuntimeId] ?? {
    desc: `${name} 终端执行器。`,
    tips: "工作台直接调度本地安装的命令行进程。",
  };

  return (
    <div className="space-y-4">
      {/* 顶部卡片：执行器概览与状态 */}
      <section className="rounded-card border border-line bg-card p-4">
        <div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {executorIconSrc(runtime.id) ? (
              <img
                src={executorIconSrc(runtime.id) ?? undefined}
                alt=""
                className="h-10 w-10 shrink-0 rounded-card object-contain"
                aria-hidden
              />
            ) : (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card text-body font-medium text-white shadow-xs"
                style={{ background: runtime.presentation.accent }}
              >
                {runtime.presentation.glyph}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
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
                  <div className="flex items-center gap-1 shrink-0">
                    <h3 className="text-body font-medium text-ink whitespace-nowrap">{name}</h3>
                    <button
                      onClick={() => setEditingName(true)}
                      title="修改显示名称"
                      className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink transition"
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                )}
                {runtime.state.status === "ready" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-teal-tint px-2 py-0.5 text-caption font-medium text-teal">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />
                    已就绪
                  </span>
                )}
                {runtime.state.status === "ready" && runtime.state.version && (
                  <span
                    title={runtime.state.version}
                    className="max-w-[200px] shrink-0 truncate rounded-chip border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-graphite whitespace-nowrap"
                  >
                    {runtime.state.version.startsWith("v") || runtime.state.version.startsWith("V")
                      ? runtime.state.version
                      : /^\d/.test(runtime.state.version)
                        ? `v${runtime.state.version}`
                        : runtime.state.version}
                  </span>
                )}
                {runtime.state.status === "not_installed" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-caption font-medium text-amber-500">
                    <AlertCircle size={11} />
                    未安装
                  </span>
                )}
                {runtime.state.status === "error" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-red-500/10 border border-red-500/25 px-2 py-0.5 text-caption font-medium text-red-500">
                    <AlertCircle size={11} />
                    异常
                  </span>
                )}
              </div>
              <p className="mt-1 text-caption text-ash leading-relaxed line-clamp-2">{guide.desc}</p>
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

      {/* 未安装 / 异常引导卡片：一键在终端安装与复制命令 */}
      {(runtime.state.status === "not_installed" || runtime.state.status === "error") && (
        <InstallGuideCard
          runtimeId={runtimeId}
          displayName={name}
          hint={runtime.state.status === "not_installed" ? runtime.state.hint : (runtime.state.status === "error" ? runtime.state.message : undefined)}
          status={runtime.state.status}
          onRecheck={probeAll}
        />
      )}

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

      {/* Antigravity 专属：终端默认 YOLO 免审批开关 */}
      {(bareRuntimeId === "agy" || bareRuntimeId === "antigravity") && (
        <section className="rounded-card border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-body-sm font-medium text-ink">
                <Zap size={14} className="text-amber-500" />
                <span>终端默认启用 YOLO 免审批模式</span>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500 font-mono">
                  --dangerously-skip-permissions
                </span>
              </div>
              <p className="text-caption text-ash leading-relaxed">
                开启后，在工作台启动 Antigravity 终端时将自动注入免审批参数，自动放行所有终端命令与文件读写，无需每步手动确认。
              </p>
            </div>
            <InstanceSwitch
              checked={agyDefaultYolo}
              onChange={setAgyDefaultYolo}
              label="终端默认启用 YOLO 免审批模式"
            />
          </div>
        </section>
      )}

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
            {PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows && (
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-line/60">
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="text-ash font-sans select-none shrink-0">安装命令：</span>
                  <code className="text-graphite font-mono truncate">{PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows}</code>
                </div>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows ?? "");
                    setCopiedInstall(true);
                    setTimeout(() => setCopiedInstall(false), 2000);
                  }}
                  title="复制安装命令"
                  className="text-teal hover:underline text-[11px] font-sans shrink-0 font-medium"
                >
                  {copiedInstall ? "已复制" : "复制"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
