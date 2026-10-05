import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileCode,
  FileText,
  FolderOpen,
  GitPullRequest,
  Globe,
  HardDrive,
  MessageSquare,
  Package,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  User,
  X,
  Zap,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  useWorkbench,
  selectActiveUnit,
  selectActiveRuntime,
  selectUnitDeliverables,
} from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import {
  readProjectMemory,
  writeProjectMemory,
  listDailyMemory,
  stewardSearchMemory,
  type StewardSearchHit,
} from "../store/useMemoryPanel.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { ChannelMark, channelIdentityLabel } from "./ChannelMark.tsx";
import { asModelId, asRuntimeId, type WorkUnit, type Deliverable } from "../core/units.ts";
import { cn } from "./cn.ts";

type InspectorTab = "persona" | "memory" | "channels" | "files";

export function AgentInspector() {
  const unit = useWorkbench(selectActiveUnit);
  const runtime = useWorkbench(selectActiveRuntime);
  const runtimes = useWorkbench((s) => s.runtimes);
  const deliverables = useWorkbench(useShallow(selectUnitDeliverables));
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const setOpen = useSidePane((s) => s.setOpen);

  const [activeTab, setActiveTab] = useState<InspectorTab>("persona");

  if (!unit) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-line bg-rail p-6">
        <div className="flex items-center justify-between">
          <span className="text-body-sm text-graphite">Agent 档案</span>
          <button
            onClick={() => setOpen(false)}
            className="rounded-btn p-1 text-graphite hover:bg-line-soft hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-8 text-center text-body-sm text-ash">暂无选中 Agent</p>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-rail text-ink">
      {/* 标头：Agent 身份卡片 + 关闭 */}
      <div className="flex shrink-0 items-start justify-between border-b border-line bg-canvas px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-medium text-ink">{unit.name}</span>
            {unit.id === "steward" && (
              <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] font-medium text-teal">
                👑 总管
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-caption text-graphite">
            {unit.identity?.role || "未分配角色"}
          </p>
          <div className="mt-1.5 flex items-center gap-1 font-mono text-[11px] text-ash">
            <FolderOpen size={11} className="shrink-0" />
            <span className="truncate" title={unit.rootPath}>{unit.rootPath}</span>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="关闭面板"
          className="ml-2 rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      {/* 4 档 Tab 切换 */}
      <div className="flex shrink-0 border-b border-line bg-canvas px-3" role="tablist">
        <TabButton
          active={activeTab === "persona"}
          onClick={() => setActiveTab("persona")}
          icon={User}
          label="设定"
        />
        <TabButton
          active={activeTab === "memory"}
          onClick={() => setActiveTab("memory")}
          icon={Brain}
          label="大脑"
        />
        <TabButton
          active={activeTab === "channels"}
          onClick={() => setActiveTab("channels")}
          icon={Globe}
          label="渠道"
          badge={unit.channels?.filter((c) => c.enabled).length || undefined}
        />
        <TabButton
          active={activeTab === "files"}
          onClick={() => setActiveTab("files")}
          icon={FileText}
          label="产出"
          badge={deliverables.length || undefined}
        />
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "persona" && <PersonaSection unit={unit} runtimes={runtimes} updateUnit={updateUnit} />}
        {activeTab === "memory" && <MemorySection unit={unit} />}
        {activeTab === "channels" && <ChannelsSection unit={unit} />}
        {activeTab === "files" && <FilesSection deliverables={deliverables} />}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof User;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-caption transition",
        active
          ? "border-teal font-medium text-teal"
          : "border-transparent text-graphite hover:text-ink",
      )}
    >
      <Icon size={13} />
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-line-soft px-1 text-[10px] text-graphite">
          {badge}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------- 1. 设定与 AGENTS.md */

function PersonaSection({
  unit,
  runtimes,
  updateUnit,
}: {
  unit: WorkUnit;
  runtimes: readonly any[];
  updateUnit: (unit: WorkUnit) => Promise<void>;
}) {
  const primaryBinding = unit.bindings.find((b) => b.primary) ?? unit.bindings[0];
  const [runtimeId, setRuntimeId] = useState(primaryBinding?.runtimeId ?? "zcode");
  const [modelHint, setModelHint] = useState(primaryBinding?.modelHint ?? "");
  const [agentsMd, setAgentsMd] = useState(unit.agentsMd ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAgentsMd(unit.agentsMd ?? "");
    setRuntimeId(primaryBinding?.runtimeId ?? "zcode");
    setModelHint(primaryBinding?.modelHint ?? "");
  }, [unit]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateUnit({
        ...unit,
        bindings: [
          {
            runtimeId: asRuntimeId(runtimeId),
            modelHint: modelHint ? asModelId(modelHint) : undefined,
            primary: true,
          },
        ],
        agentsMd,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 执行器与模型 */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <label className="text-caption font-medium text-graphite">默认执行器 (CLI)</label>
        <div className="mt-1.5 flex gap-2">
          <select
            value={runtimeId}
            onChange={(e) => setRuntimeId(e.target.value)}
            className="flex-1 rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
          >
            {runtimes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.presentation.displayName} ({r.transportKind})
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2.5">
          <label className="text-caption font-medium text-graphite">执行模型 (Model Hint)</label>
          <input
            type="text"
            value={modelHint}
            onChange={(e) => setModelHint(e.target.value)}
            placeholder="跟随 CLI 默认或指定模型 ID..."
            className="mt-1 w-full rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
          />
        </div>
      </div>

      {/* AGENTS.md 岗位说明书 */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <div className="flex items-center justify-between pb-2">
          <div className="flex items-center gap-1.5">
            <FileCode size={13} className="text-teal" />
            <span className="text-caption font-medium text-ink">AGENTS.md 岗位说明书</span>
          </div>
          <span className="text-[11px] text-ash">
            {agentsMd.length} 字符 · {agentsMd.split("\n").length} 行
          </span>
        </div>
        <p className="pb-2 text-[11px] leading-relaxed text-ash">
          控制此 Agent 的人设、技能指引与规则约束，每次会话启动前自动注入上下文。
        </p>
        <textarea
          value={agentsMd}
          onChange={(e) => setAgentsMd(e.target.value)}
          rows={12}
          className="w-full resize-y rounded-btn border border-line bg-canvas p-2.5 font-mono text-caption leading-relaxed text-ink outline-none focus:border-teal"
          placeholder="# 角色指令与守则..."
        />
        <div className="mt-2.5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas hover:bg-black disabled:opacity-50"
          >
            {saved ? <Check size={12} className="text-gain" /> : <Save size={12} />}
            <span>{saved ? "已保存到文件" : saving ? "保存中..." : "保存设定"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 2. 记忆与大脑 (Docs 10) */

function MemorySection({ unit }: { unit: WorkUnit }) {
  const [content, setContent] = useState("");
  const [dailyNotes, setDailyNotes] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<readonly StewardSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([readProjectMemory(unit.rootPath), listDailyMemory(unit.rootPath)])
      .then(([mem, daily]) => {
        if (!active) return;
        setContent(mem.content);
        setDailyNotes(daily);
      })
      .catch((err) => console.error("加载记忆失败", err))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [unit.rootPath]);

  const charCount = content.length;
  const LIMIT = 2200;
  const ratio = Math.min(1, charCount / LIMIT);
  const isOver = charCount > LIMIT;
  const isWarning = charCount >= LIMIT * 0.8 && !isOver;

  const handleSaveMemory = async () => {
    setSaving(true);
    try {
      await writeProjectMemory(unit.rootPath, content);
    } finally {
      setSaving(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await stewardSearchMemory({
        botId: unit.id,
        query: searchQuery.trim(),
        limit: 5,
        withContext: true,
      });
      setSearchResults(res.hits);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* MEMORY.md 长期记忆 */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <div className="flex items-center justify-between pb-1.5">
          <div className="flex items-center gap-1.5">
            <Brain size={13} className="text-teal" />
            <span className="text-caption font-medium text-ink">MEMORY.md (长期记忆)</span>
          </div>
          <span
            className={cn(
              "font-mono text-caption",
              isOver ? "font-medium text-loss" : isWarning ? "text-amber-600" : "text-ash",
            )}
          >
            {charCount} / {LIMIT} 字
          </span>
        </div>

        {/* 进度条 */}
        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
          <div
            className={cn(
              "h-full transition-all duration-300",
              isOver ? "bg-loss" : isWarning ? "bg-amber-500" : "bg-teal",
            )}
            style={{ width: `${Math.min(100, (charCount / LIMIT) * 100)}%` }}
          />
        </div>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={8}
          placeholder="此 Agent 的核心长期记忆条目..."
          className="w-full resize-y rounded-btn border border-line bg-canvas p-2.5 font-mono text-caption leading-relaxed text-ink outline-none focus:border-teal"
        />

        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[11px] text-ash">超 2200 字符限制时将被拒绝写入</span>
          <button
            onClick={handleSaveMemory}
            disabled={saving || isOver}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas hover:bg-black disabled:opacity-50"
          >
            <Save size={12} />
            <span>{saving ? "写入中..." : "更新记忆"}</span>
          </button>
        </div>
      </div>

      {/* 跨会话记忆检索 */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <span className="text-caption font-medium text-ink">跨会话记忆追溯</span>
        <p className="mt-0.5 text-[11px] text-ash">通过总管跨所有 CLI 历史扫描并回溯相关知识</p>
        <div className="mt-2 flex gap-1.5">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="搜索过去会话与记忆..."
            className="flex-1 rounded-btn border border-line bg-canvas px-2.5 py-1 text-caption text-ink outline-none focus:border-teal"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !searchQuery.trim()}
            className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
          >
            <Search size={12} />
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2">
            {searchResults.map((hit, i) => (
              <div key={i} className="rounded bg-canvas p-2 text-caption">
                <div className="flex items-center justify-between text-[10px] text-ash">
                  <span className="truncate">{hit.cli} {hit.project ? `· ${hit.project}` : ""}</span>
                  <span className="font-mono">{(hit.score * 100).toFixed(0)}%</span>
                </div>
                <p className="mt-1 line-clamp-3 font-mono text-[11px] text-graphite">{hit.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 日报存档 */}
      {dailyNotes.length > 0 && (
        <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
          <span className="text-caption font-medium text-ink">每日总结存档 · {dailyNotes.length} 篇</span>
          <div className="mt-2 max-h-36 overflow-y-auto space-y-1">
            {dailyNotes.map((d) => (
              <div key={d} className="flex items-center justify-between py-1 text-caption text-graphite">
                <span className="font-mono">{d}</span>
                <span className="text-[11px] text-ash">自动生成</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 3. 渠道连通 */

function ChannelsSection({ unit }: { unit: WorkUnit }) {
  const identities = useWorkbench((s) => s.channelIdentity);
  const channels = unit.channels ?? [];
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const feishuChannel = channels.find((c) => c.kind === "feishu");
  const tgChannel = channels.find((c) => c.kind === "telegram");
  const webhookChannel = channels.find((c) => c.kind === "webhook");

  const runDiagnose = async () => {
    setTesting(true);
    setDiagResult(null);
    try {
      const client = DaemonClient.get(defaultDaemonEndpoint());
      const res = await client.rpc<any>("channel.diagnose", { botId: unit.id });
      setDiagResult(res.ok ? "✓ 飞书连通性良好" : `异常：${res.error ?? "配置错误"}`);
    } catch (err: any) {
      setDiagResult(`诊断失败：${err.message || String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 飞书 */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-caption font-medium text-ink">飞书机器人</span>
            {feishuChannel?.enabled ? (
              <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已启用</span>
            ) : (
              <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">未配置</span>
            )}
          </div>
          {feishuChannel?.enabled && (
            <button
              onClick={runDiagnose}
              disabled={testing}
              className="text-caption text-teal hover:underline disabled:opacity-50"
            >
              {testing ? "诊断中..." : "连通诊断"}
            </button>
          )}
        </div>

        {feishuChannel?.accounts && feishuChannel.accounts.length > 0 ? (
          <div className="mt-2.5 space-y-2">
            {feishuChannel.accounts.map((acc, idx) => {
              const ident = identities[acc.profile ?? ""];
              return (
                <div key={idx} className="flex items-center gap-2 rounded bg-canvas p-2">
                  {ident?.avatarUrl ? (
                    <img src={ident.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-teal text-caption font-medium text-white">
                      飞
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-medium text-ink">
                      {ident?.appName || acc.profile || "未指认应用"}
                    </p>
                    <p className="truncate font-mono text-[10px] text-ash">profile: {acc.profile}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-caption text-ash">在创建/编辑对话框中填入 lark-cli profile 即可接入。</p>
        )}

        {diagResult && (
          <p className="mt-2 rounded bg-canvas p-1.5 font-mono text-[11px] text-graphite">{diagResult}</p>
        )}
      </div>

      {/* Telegram */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <div className="flex items-center justify-between">
          <span className="text-caption font-medium text-ink">Telegram Bot</span>
          {tgChannel?.enabled ? (
            <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已启用</span>
          ) : (
            <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">未启用</span>
          )}
        </div>
        <p className="mt-1 text-caption text-ash">
          {tgChannel?.enabled ? "Daemon 网关自动轮询并响应消息" : "支持通过 bot.json 配置 TG bot token 接入。"}
        </p>
      </div>

      {/* Webhook */}
      <div className="rounded-card border border-line bg-card p-3 shadow-subtle">
        <div className="flex items-center justify-between">
          <span className="text-caption font-medium text-ink">入站 Webhook</span>
          {webhookChannel?.enabled ? (
            <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已开启</span>
          ) : (
            <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">未配置</span>
          )}
        </div>
        <p className="mt-1 font-mono text-[11px] text-ash">POST /webhook/bot?botId={unit.id}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 4. 产出文件 */

function FilesSection({ deliverables }: { deliverables: readonly Deliverable[] }) {
  if (deliverables.length === 0) {
    return (
      <div className="py-8 text-center">
        <Package size={20} className="mx-auto text-ash" />
        <p className="mt-2 text-caption text-ash">暂无此 Agent 产出的文件或 diff 变更</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {deliverables.map((d) => (
        <div
          key={d.id}
          className="flex items-start gap-2 rounded-btn bg-card p-2.5 border border-line hover:bg-surface-hover shadow-subtle"
        >
          <FileText size={14} className="mt-0.5 shrink-0 text-graphite" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-caption font-medium text-ink">{d.title}</p>
            {d.path && <p className="truncate font-mono text-[11px] text-ash">{d.path}</p>}
          </div>
          <span className="shrink-0 text-[10px] text-ash">
            {new Date(d.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      ))}
    </div>
  );
}
