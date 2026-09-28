import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Braces,
  Boxes,
  Check,
  ChevronDown,
  ChevronsDownUp,
  Circle,
  CircleDot,
  FileCode,
  FileDiff,
  Files,
  FolderTree,
  Gauge,
  GitBranch,
  Globe,
  History,
  Layers,
  ListOrdered,
  ListTree,
  MessageSquare,
  Minus,
  Network,
  PenTool,
  Plus,
  PanelRightClose,
  Radio,
  RotateCcw,
  Square,
  Terminal,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import {
  blockedReason,
  canOpenTab,
  deriveTabBadges,
  getVisibleTabs,
  groupTabTypesByScope,
  metaOf,
  NEEDS_RUNTIME,
  scopeOf,
  SCOPE_LABEL,
  shouldKeepMounted,
  TAB_META,
  type SidePaneTab,
  type SidePaneTabType,
} from "../core/sidepane.ts";
import { isShellTool, type PlanStep, type PlanStepStatus } from "../core/events.ts";
import { formatContext, formatPrice, modelById } from "../core/models.ts";
import { formatDuration, formatTokensPerSecond } from "../core/sessionStats.ts";
import { deriveTrajectory, trajTokenText, type TrajKind } from "../core/trajectory.ts";
import { useShallow } from "zustand/react/shallow";
import { useSidePane } from "../store/useSidePane.ts";
import {
  selectVisibleModels,
  useWorkbench,
  selectActiveRuntime,
  selectActiveUnit,
  selectUnitDeliverables,
} from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";
import type { RuntimeCapabilities } from "../core/adapter.ts";
import { OverviewTrigger, SidePaneOverview } from "./SidePaneOverview.tsx";
import { WorkspaceFilesPane } from "./WorkspaceFilesPane.tsx";

/**
 * 23 种可见页签各配一个图标（另有 treemapping 按 ZCode 口径隐藏，映射仍穷尽）。
 * 映射表必须穷尽 —— 少一个就是 tsc 报错，不给静默兜底的机会。
 * 新增页签类型时这里会逼你补上图标。
 */
const ICON: Record<SidePaneTabType, typeof Layers> = {
  // 工作区级
  capabilities: Layers,
  deliverables: Files,
  tools: Wrench,
  "developer-tools": Braces,
  terminal: Terminal,
  git: GitBranch,
  "code-viewer": FileCode,
  whiteboard: PenTool,
  browser: Globe,
  "browser-use": Radio,
  treemapping: Network,
  "model-trajectory": Gauge,

  // 会话级
  files: FileDiff,
  "workspace-files": FolderTree,
  trace: History,
  plan: ListOrdered,
  "selection-chat": MessageSquare,
  "workflow-run": Workflow,
  "workflow-directory": ListTree,
  "workflow-actor": CircleDot,
  "workflow-workspace": Boxes,
  "workflow-artifact": FileCode,

  // 会话树根级
  subagent: Activity,
  "subagent-directory": FolderTree,
  "bash-output": Square,
};

/**
 * 右侧标签面板 —— 对齐 ZCode 的 `AnimatedSidePanePanel` + `SidePaneTabTrigger`。
 *
 * 对齐的 7 项行为（不是样式）：
 * 1. 可见性作用域 —— session 级 tab 随会话切换而隐藏
 * 2. 关激活页落到**右邻**，不是第一个
 * 3. 拖拽重排，且不改变 activeTabId
 * 4. 标签总览 popover + 评分搜索
 * 5. 溢出检测 → 入口退化
 * 6. 记住展开尺寸
 * 7. 常驻挂载（keepMounted 的 tab 面板收起时仍不卸载）
 *
 * 页签功能面：23 种全部可开（treemapping 按 ZCode 口径隐藏）。
 * **不因为「当前是空的」就藏起来** —— 缺运行时的页签照常开门，
 * 内容区明写缺什么、什么时候接。看不见 = 功能不存在。
 */
export function SidePane({ ownerId }: { ownerId: string | null }) {
  const state = useSidePane((s) => s.state);
  const open = useSidePane((s) => s.open);
  const recentlyClosed = useSidePane((s) => s.recentlyClosed);
  const activate = useSidePane((s) => s.setActiveTab);
  const closeTab = useSidePane((s) => s.closeTab);
  const closeOther = useSidePane((s) => s.closeOtherTabs);
  const closeAll = useSidePane((s) => s.closeAllTabs);
  const reopen = useSidePane((s) => s.reopenClosedTab);
  const reorder = useSidePane((s) => s.reorderTab);

  const [overview, setOverview] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // 切会话时按新归属修正激活页
  useEffect(() => {
    useSidePane.getState().syncOwner(ownerId);
  }, [ownerId]);

  const visible = useMemo(() => getVisibleTabs(state, ownerId), [state, ownerId]);
  const activeTab = visible.find((t) => t.id === state?.activeTabId);
  const badges = useTabBadges(ownerId);

  // 常驻挂载：面板收起时，keepMounted 的 tab 内容仍然渲染
  const keepMounted = shouldKeepMounted(open, state?.tabs ?? []);

  if (!open || !state) {
    return (
      <div className="flex h-full flex-col items-center justify-start gap-3 border-l border-line bg-rail pt-4 text-graphite">
        <button
          onClick={() => (recentlyClosed.length > 0 ? reopen() : useSidePane.getState().setOpen(true))}
          className="rounded-btn p-1.5 hover:bg-line-soft hover:text-ink"
          aria-label="展开面板"
          title={recentlyClosed.length > 0 ? "恢复最近关闭的标签" : "展开面板"}
        >
          {recentlyClosed.length > 0 ? <RotateCcw size={14} /> : <Layers size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-rail">
      {/* 顶条：只放当前页签名 + 动作按钮。页签本体已移到右缘竖排任务栏，
          顶部不再被一排页签占满 */}
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line/60 px-2">
        <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">
          {activeTab ? activeTab.title : "面板"}
        </span>
        {recentlyClosed.length > 0 && (
          <button
            onClick={reopen}
            title="恢复最近关闭的标签"
            aria-label="恢复最近关闭的标签"
            className="shrink-0 rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink"
          >
            <RotateCcw size={12} />
          </button>
        )}
        {visible.length > 1 && (
          <button
            onClick={closeAll}
            title="关闭全部标签页"
            className="shrink-0 whitespace-nowrap rounded-btn px-2 py-1 text-caption text-ash hover:bg-line-soft hover:text-ink"
          >
            清空
          </button>
        )}
        <button
          onClick={() => setCatalog(true)}
          title="打开面板标签"
          aria-label="打开面板标签"
          className="shrink-0 rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink"
        >
          <Plus size={12} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
        <button
          onClick={() => useSidePane.getState().setOpen(false)}
          title="收起右栏"
          aria-label="收起右栏"
          className="shrink-0 rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink"
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      {catalog && <TabCatalog ownerId={ownerId} onClose={() => setCatalog(false)} />}

      <div className="flex min-h-0 flex-1">
        {/* 内容 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-body-sm text-graphite">当前会话下没有可见标签</p>
              <p className="max-w-[260px] text-caption text-ash">
                会话级标签只在它归属的那条会话里出现。工作区级标签可以随时打开。
              </p>
              <button
                onClick={() => useSidePane.getState().openTabType("capabilities", ownerId)}
                className="mt-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black"
              >
                打开工作区级标签
              </button>
            </div>
          ) : keepMounted ? (
            <TabContent tab={activeTab} ownerId={ownerId} />
          ) : null}
        </div>

        {/* 右缘竖排任务栏 —— 页签本体。图标竖排、激活高亮 + 左侧 teal 指示条，
            badge 挂图标角上，hover 露出关闭钮；拖拽纵向重排 */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-l border-line bg-rail py-1.5">
          {visible.map((t) => {
            const Icon = ICON[t.type];
            const active = t.id === state.activeTabId;
            const badge = badges.get(t.type) ?? 0;
            return (
              <div
                key={t.id}
                draggable
                onDragStart={() => setDragId(t.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverId(t.id);
                }}
                onDragEnd={() => {
                  if (dragId && overId) reorder(dragId, overId);
                  setDragId(null);
                  setOverId(null);
                }}
                onDrop={() => {
                  if (dragId && overId) reorder(dragId, overId);
                  setDragId(null);
                  setOverId(null);
                }}
                className={cn(
                  "group relative flex cursor-grab items-center justify-center active:cursor-grabbing",
                  dragId === t.id && "opacity-40",
                  overId === t.id && dragId !== t.id && "ring-1 ring-teal",
                )}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-teal"
                    aria-hidden
                  />
                )}
                <button
                  onClick={() => activate(t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    closeOther(t.id);
                  }}
                  title={`${t.title} · ${SCOPE_LABEL[t.scope]}\n${metaOf(t.type).typeLabel} — ${metaOf(t.type).hint}\n拖拽重排 · 右键关闭其他`}
                  aria-pressed={active}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-btn",
                    active ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon size={16} />
                    {badge > 0 && (
                      <span
                        className="tnum absolute -right-2 -top-1.5 rounded-chip bg-line-soft px-1 text-caption leading-none leading-3 text-graphite"
                        title={`${badge}`}
                      >
                        {badge}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  onClick={() => closeTab(t.id)}
                  aria-label={`关闭 ${t.title}`}
                  className="absolute right-0 top-0 hidden rounded p-px text-ash hover:text-loss group-hover:block"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <div className="mt-auto">
            <OverviewTrigger onOpen={() => setOverview(true)} compact />
          </div>
        </div>
      </div>

      {overview && <SidePaneOverview ownerId={ownerId} onClose={() => setOverview(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页签目录（ZCode 的「+」add button 菜单）
// ---------------------------------------------------------------------------

/**
 * 全部 23 种可见页签的入口，按作用域分三段。
 *
 * 这是「功能可见」的主要承担者：即使某页当前无数据、运行时也没接，
 * 它照样在菜单里，缺什么直接写在行内。开会话级页签需要先有会话，
 * 此时行是禁用态并写明原因 —— 不可点 ≠ 不存在。
 */
function TabCatalog({ ownerId, onClose }: { ownerId: string | null; onClose: () => void }) {
  const state = useSidePane((s) => s.state);
  const openTabType = useSidePane((s) => s.openTabType);
  const groups = useMemo(() => groupTabTypesByScope(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* 点空白处关闭：整屏 backdrop，不是只铺面板宽度 */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="打开面板标签"
        className="absolute right-2 top-11 z-40 max-h-[min(60vh,440px)] w-[320px] overflow-y-auto rounded-card border border-line bg-canvas p-2 shadow-subtle"
      >
        {groups.map((g) => (
          <section key={g.scope} className="mb-2 last:mb-0">
            <p className="px-1.5 py-1 text-caption text-ash">{g.label}</p>
            {g.types.map((type) => {
              const meta = TAB_META[type];
              const Icon = ICON[type];
              const open = state?.tabs.some((t) => t.type === type) ?? false;
              const enabled = canOpenTab(type, ownerId);
              const blocked = blockedReason(type, ownerId);
              const needs = NEEDS_RUNTIME[type];

              return (
                <button
                  key={type}
                  disabled={!enabled}
                  onClick={() => {
                    openTabType(type, ownerId);
                    onClose();
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-btn px-1.5 py-1.5 text-left",
                    enabled ? "hover:bg-line-soft" : "cursor-not-allowed opacity-50",
                  )}
                >
                  <Icon size={12} className="mt-1 shrink-0 text-graphite" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-body-sm text-ink">{meta.title}</span>
                      <span className="shrink-0 font-mono text-caption text-ash">{meta.typeLabel}</span>
                      {open && <span className="shrink-0 text-caption text-teal">已开</span>}
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-ash">
                      {blocked ?? (needs ? `待接：${needs.needs}（${needs.when}）` : meta.hint)}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 内容分发
// ---------------------------------------------------------------------------

function TabContent({ tab, ownerId }: { tab?: SidePaneTab; ownerId: string | null }) {
  if (!tab) return null;
  switch (tab.type) {
    /* 工作区级 */
    case "capabilities":
      return <CapabilitiesPane />;
    case "deliverables":
      return <DeliverablesPane />;
    case "tools":
      return <ToolsPane />;
    case "developer-tools":
      return <DeveloperToolsPane />;
    case "git":
      return <GitPane />;
    case "code-viewer":
      return <CodeViewerPane subject={tab.subject ?? null} />;
    case "model-trajectory":
      return <ModelTrajectoryPane />;

    /* 工作区级 */
    case "workspace-files":
      return <WorkspaceFilesPane />;

    /* 会话级 */
    case "files":
      return <FilesPane ownerId={tab.ownerId ?? ownerId} />;
    case "trace":
      return <TracePane ownerId={tab.ownerId ?? ownerId} />;
    case "plan":
      return <PlanPane ownerId={tab.ownerId ?? ownerId} />;

    /* 会话树根级 */
    case "subagent":
      return <SubagentPane ownerId={tab.ownerId ?? ownerId} />;
    case "subagent-directory":
      return <SubagentDirectoryPane ownerId={tab.ownerId ?? ownerId} />;
    case "bash-output":
      return <BashOutputPane ownerId={tab.ownerId ?? ownerId} />;

    /* 未接运行时：全部显式说明缺什么，不隐藏 */
    case "terminal":
      return <TerminalPane />;
    case "browser":
    case "browser-use":
    case "whiteboard":
    case "selection-chat":
      return <PendingRuntimePane type={tab.type} />;
    case "workflow-run":
    case "workflow-directory":
    case "workflow-actor":
    case "workflow-workspace":
    case "workflow-artifact":
      return <WorkflowPane type={tab.type} />;
    case "treemapping":
      // 按 ZCode 口径被 normalizeSidePaneState 过滤掉，正常流程到不了这里。
      // 仍然给出说明，而不是渲染空白 —— 万一旧状态漏进来，用户看得懂为什么是空的。
      return <HiddenByDesignPane type="treemapping" />;
  }
}

// ---------------------------------------------------------------------------
// 未接运行时
// ---------------------------------------------------------------------------

function PendingRuntimePane({ type }: { type: SidePaneTabType }) {
  const meta = TAB_META[type];
  const needs = NEEDS_RUNTIME[type];
  return (
    <PaneSection title={meta.typeLabel}>
      <p className="text-body-sm text-ink">{meta.title}</p>
      <p className="mt-1 text-caption text-graphite">{meta.hint}</p>
      <dl className="mt-4 space-y-2 border-t border-line pt-3">
        <Row label="缺什么" value={needs?.needs ?? "—"} />
        <Row label="什么时候接" value={needs?.when ?? "—"} />
        <Row label="归属" value={SCOPE_LABEL[scopeOf(type)]} />
      </dl>
      <p className="mt-4 text-caption text-ash">
        这一页已经开门、占着位置，运行时接上后内容直接落进来。
        没有因为「现在是空的」就把它藏起来。
      </p>
    </PaneSection>
  );
}

function WorkflowPane({ type }: { type: SidePaneTabType }) {
  const meta = TAB_META[type];
  return (
    <PaneSection title={meta.typeLabel}>
      <p className="text-body-sm text-ink">{meta.title}</p>
      <p className="mt-1 text-caption text-graphite">{meta.hint}</p>
      <p className="mt-4 text-caption text-ash">
        ZCode 的 workflow-* 需要编排运行时。本产品已移除「更好效果 / 更短时间 / 更低成本」的编排策略
        （见北极星），但类型与归属保留 —— 将来接回不用改右栏契约。
      </p>
    </PaneSection>
  );
}

function HiddenByDesignPane({ type }: { type: SidePaneTabType }) {
  const meta = TAB_META[type];
  return (
    <PaneSection title={meta.typeLabel}>
      <p className="text-body-sm text-ink">{meta.title}</p>
      <p className="mt-2 text-caption text-graphite">
        按 ZCode 的 <code className="font-mono">normalizeWorkspaceSidePaneState</code> 口径，这一类当前被过滤掉，
        不会出现在标签栏与目录里。这里只是兜底：万一旧状态漏进来，能看懂为什么是空的。
      </p>
    </PaneSection>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-caption text-ash">{label}</dt>
      <dd className="min-w-0 flex-1 text-caption text-graphite">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------- 执行器能力 */

const CAP_LABELS: readonly (readonly [keyof RuntimeCapabilities, string])[] = [
  ["resumeSession", "恢复会话"],
  ["fileDiff", "diff"],
  ["terminal", "内建终端"],
  ["permissions", "权限审批"],
  ["subagents", "子代理"],
  ["worktrees", "worktree"],
  ["sandbox", "沙箱"],
  ["mcp", "MCP"],
  ["usage", "用量计量"],
  ["multimodal", "多模态"],
];

function CapabilitiesPane() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const active = useWorkbench(selectActiveRuntime);
  const activeModel = useWorkbench((s) => modelById(s.runtimeModels[s.activeRuntimeId]));
  // 有效清单 = 声明 − 用户隐藏 + 自定义。与选择器读的是同一个函数 ——
  // 这里读声明清单的话，用户在设置里藏掉的模型会「只在一处生效」，
  // 那是典型的「设置改了但没生效」。
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const activeModels = useWorkbench(selectVisibleModels(activeRuntimeId));
  // 「藏了几个」要比**内置**那一侧：activeModels 里含用户自定义模型，
  // 直接拿两个总数相减会把「自定义」也算成「被隐藏的」。
  const hiddenBuiltin = active
    ? active.models.length - activeModels.filter((m) => m.source !== "custom").length
    : 0;
  if (!active) return <p className="p-4 text-body-sm text-ash">无执行器</p>;
  const caps = Object.values(active.capabilities);

  return (
    <>
      <PaneSection title={`执行器 · ${caps.filter(Boolean).length}/${caps.length}`}>
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-body-sm font-medium text-white"
            style={{ background: active.presentation.accent }}
            aria-hidden
          >
            {active.presentation.glyph}
          </span>
          <div className="min-w-0">
            <p className="truncate text-body-sm font-medium text-ink">{active.presentation.displayName}</p>
            <p className="truncate text-caption text-ash">{active.presentation.tagline}</p>
          </div>
        </div>
        <p className="mt-3 font-mono text-caption text-ash">
          transport: {active.transportKind} · {active.state.status}
        </p>

        {/* 执行器 + 模型是两个维度，这一页是它们的对照表 */}
        {activeModel && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-1.5 text-caption text-ash">当前模型</p>
            <p className="truncate text-body-sm text-ink">{activeModel.displayName}</p>
            <p className="tnum mt-0.5 font-mono text-caption text-ash">
              {formatPrice(activeModel.inputPerMTok)}/{formatPrice(activeModel.outputPerMTok)} ·{" "}
              {formatContext(activeModel.contextWindow)} · {activeModel.vendorLabel}
            </p>
            <p className="mt-1 text-caption text-ash">{activeModel.note}</p>
          </div>
        )}
      </PaneSection>

      <PaneSection title={`可选模型 · ${activeModels.length} 个`}>
        {activeModels.map((m) => (
          <div
            key={m.id}
            className={cn(
              "-mx-2 flex items-baseline gap-2 rounded-btn px-2 py-1.5",
              m.id === activeModel?.id && "bg-teal-tint",
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-body-sm",
                m.id === activeModel?.id ? "font-medium text-ink" : "text-graphite",
              )}
            >
              {m.displayName}
            </span>
            {m.source === "custom" && <span className="shrink-0 text-caption text-teal">自定义</span>}
            <span className="tnum shrink-0 font-mono text-caption text-ash">
              {m.inputPerMTok > 0 ? formatPrice(m.inputPerMTok) : "—"}
            </span>
          </div>
        ))}
        {hiddenBuiltin > 0 && (
          <p className="mt-2 text-caption text-ash">
            有 {hiddenBuiltin} 个内置模型已在设置里隐藏 · 去「设置 / 模型」调整
          </p>
        )}
      </PaneSection>

      <PaneSection title="能力矩阵">
        <div className="grid grid-cols-2 gap-1">
          {CAP_LABELS.map(([key, label]) => {
            const has = active.capabilities[key];
            return (
              <div key={key} className={cn("flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm", has ? "text-ink" : "text-ash")}>
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-caption",
                    has ? "bg-teal text-white" : "border border-line",
                  )}
                  aria-hidden
                >
                  {has ? "✓" : "✕"}
                </span>
                <span className={cn("truncate", !has && "line-through")}>{label}</span>
              </div>
            );
          })}
        </div>
      </PaneSection>

      <PaneSection title="全部执行器">
        {runtimes.map((r) => {
          const c = Object.values(r.capabilities);
          return (
            <div key={r.id} className="-mx-2 flex items-center gap-2 rounded-btn px-2 py-1.5">
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-caption font-medium text-white"
                style={{ background: r.presentation.accent }}
                aria-hidden
              >
                {r.presentation.glyph}
              </span>
              <span className="truncate text-body-sm text-graphite">{r.presentation.displayName}</span>
              <span className="tnum ml-auto shrink-0 text-caption text-ash">
                {c.filter(Boolean).length}/{c.length}
              </span>
            </div>
          );
        })}
      </PaneSection>
    </>
  );
}

function DeliverablesPane() {
  const unit = useWorkbench(selectActiveUnit);
  // selectUnitDeliverables 每次返回新数组 —— 必须 useShallow（旧 RightPanel 踩过这个坑），
  // 裸用会在 React 19 触发 getSnapshot 无限循环 → 整页白屏
  const deliverables = useWorkbench(useShallow(selectUnitDeliverables));
  if (!unit) return null;
  return (
    <PaneSection title={`产出归档 · ${deliverables.length}`}>
      {deliverables.length === 0 && <p className="text-body-sm text-ash">暂无产出</p>}
      {deliverables.map((d) => (
        <div key={d.id} className="-mx-2 rounded-btn px-2 py-2 hover:bg-line-soft">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-body-sm text-ink">{d.title}</p>
            <span className="tnum shrink-0 text-caption text-ash">
              {new Date(d.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
            </span>
          </div>
          {d.path && <p className="truncate font-mono text-caption text-ash">{d.path}</p>}
        </div>
      ))}
    </PaneSection>
  );
}

/* ------------------------------------------------------------- 变更 / diff */

const CHANGE_GLYPH = { created: "A", modified: "M", deleted: "D" } as const;
const CHANGE_COLOR = { created: "text-gain", modified: "text-teal", deleted: "text-loss" } as const;

/** 从事件流里抽出「路径 → 状态 + 行数统计」。git / files / code-viewer 三页共用同一份推导。 */
function useFileChanges() {
  const timeline = useWorkbench((s) => s.timeline);
  return useMemo(() => {
    const map = new Map<string, { path: string; change: "created" | "modified" | "deleted"; add: number; del: number; patch?: string }>();
    for (const { event } of timeline) {
      if (event.type === "file.changed") {
        const cur = map.get(event.path) ?? { path: event.path, change: event.change, add: 0, del: 0 };
        map.set(event.path, { ...cur, change: event.change });
      } else if (event.type === "file.diff") {
        const cur = map.get(event.path) ?? { path: event.path, change: "modified", add: 0, del: 0 };
        map.set(event.path, { ...cur, add: cur.add + event.additions, del: cur.del + event.deletions, patch: event.patch ?? cur.patch });
      }
    }
    return [...map.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
  }, [timeline]);
}

/** git 页 —— 工作区级的变更审查：跨会话，按路径聚合 */
function GitPane() {
  const files = useFileChanges();
  const openTabType = useSidePane((s) => s.openTabType);
  const sessions = useWorkbench((s) => s.sessions);
  const count = sessions.length;

  return (
    <>
      <PaneSection title={`工作区变更 · ${files.length} 个文件`}>
        {files.length === 0 ? (
          <Empty text="工作区还没有变更。" sub="只有开了结构化 diff 的执行器才会出现在这里。" />
        ) : (
          files.map((f) => (
            <div key={f.path} className="-mx-2 flex items-center gap-2 rounded-btn px-2 py-1.5 hover:bg-line-soft">
              <span className={cn("w-3 shrink-0 font-mono text-caption", CHANGE_COLOR[f.change])} aria-hidden>
                {CHANGE_GLYPH[f.change]}
              </span>
              <button
                onClick={() => openTabType("code-viewer", null, f.path)}
                title="在文件查看器中打开"
                className="min-w-0 flex-1 truncate text-left font-mono text-body-sm text-graphite hover:text-ink"
              >
                {f.path}
              </button>
              <span className="tnum shrink-0 font-mono text-caption">
                <span className="text-gain">+{f.add}</span> <span className="text-loss">−{f.del}</span>
              </span>
            </div>
          ))
        )}
      </PaneSection>

      <PaneSection title="审查范围">
        <p className="text-caption text-graphite">
          跨 {count} 条会话聚合。每条会话各有一页「文件变更」，切会话即切范围 ——
          对齐 ZCode：session 级页签随会话隐藏，不该看到别的会话的 diff。
        </p>
      </PaneSection>
    </>
  );
}

/**
 * 文件查看器 —— 对齐 `openCodeViewerSidePanes`（复数）：一文件一页。
 * 无 subject 时是索引页，列出所有变更过的文件。
 */
function CodeViewerPane({ subject }: { subject: string | null }) {
  const files = useFileChanges();
  const openTabType = useSidePane((s) => s.openTabType);

  if (!subject) {
    return (
      <PaneSection title={`文件索引 · ${files.length}`}>
        {files.length === 0 ? (
          <Empty text="没有可查看的文件。" sub="先跑一次会话，产生 file.diff 之后这里就有内容了。" />
        ) : (
          files.map((f) => (
            <button
              key={f.path}
              onClick={() => openTabType("code-viewer", null, f.path)}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-btn px-2 py-1.5 text-left hover:bg-line-soft"
            >
              <FileCode size={12} className="shrink-0 text-graphite" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{f.path}</span>
              <span className="tnum shrink-0 font-mono text-caption">
                <span className="text-gain">+{f.add}</span> <span className="text-loss">−{f.del}</span>
              </span>
            </button>
          ))
        )}
      </PaneSection>
    );
  }

  const file = files.find((f) => f.path === subject);

  return (
    <PaneSection title={subject}>
      {file ? (
        <>
          <p className="flex items-center gap-2 text-caption text-graphite">
            <span className={cn("font-mono", CHANGE_COLOR[file.change])}>
              {CHANGE_GLYPH[file.change]} {file.path}
            </span>
            <span className="tnum ml-auto font-mono">
              <span className="text-gain">+{file.add}</span> <span className="text-loss">−{file.del}</span>
            </span>
          </p>
          {file.patch ? (
            <pre className="mt-3 overflow-x-auto rounded bg-canvas p-2.5 font-mono text-caption leading-relaxed text-graphite">
              {file.patch}
            </pre>
          ) : (
            <p className="mt-3 text-caption text-ash">
              该执行器只回了行数统计，没回 patch。
              <span className="mt-1 block">patch 字段缺省时按 ZCode 的口径静默降级，不编内容。</span>
            </p>
          )}
        </>
      ) : (
        <Empty text={`没有 ${subject} 的变更记录。`} sub="它可能属于别的会话，去会话级「文件变更」里看。" />
      )}
    </PaneSection>
  );
}

/* ------------------------------------------------------------- 工具 / 开发者工具 */

/** 工具页 —— 汇总用过哪些工具、失败几次 */
function ToolsPane() {
  const timeline = useWorkbench((s) => s.timeline);

  const tools = useMemo(() => {
    const byName = new Map<string, { name: string; count: number; failed: number; last: string }>();
    const nameByCallId = new Map<string, string>();

    for (const { event } of timeline) {
      if (event.type === "tool.started") {
        nameByCallId.set(event.callId, event.toolName);
        const cur = byName.get(event.toolName) ?? { name: event.toolName, count: 0, failed: 0, last: "" };
        cur.count += 1;
        cur.last = event.title;
        byName.set(event.toolName, cur);
      } else if (event.type === "tool.completed" && !event.ok) {
        const name = nameByCallId.get(event.callId);
        if (name) {
          const cur = byName.get(name);
          if (cur) cur.failed += 1;
        }
      }
    }
    return [...byName.values()].sort((a, b) => b.count - a.count);
  }, [timeline]);

  return (
    <PaneSection title={`工具调用 · ${tools.length} 种`}>
      {tools.length === 0 ? (
        <Empty text="还没有工具调用。" sub="跑一次会话，调用记录会实时落进来。" />
      ) : (
        tools.map((t) => (
          <div key={t.name} className="flex items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{t.name}</span>
            <span className="min-w-0 flex-shrink truncate text-caption text-ash">{t.last}</span>
            {t.failed > 0 && (
              <span className="tnum shrink-0 rounded-chip bg-loss/10 px-1.5 text-caption text-loss">失败 {t.failed}</span>
            )}
            <span className="tnum shrink-0 text-caption text-graphite">×{t.count}</span>
          </div>
        ))
      )}
    </PaneSection>
  );
}

/**
 * 开发者工具页 —— 逐条调用流水（对照「工具」页的按名聚合）。
 * 两页分工照 ZCode：一个是统计，一个是控制台。
 */
function DeveloperToolsPane() {
  const timeline = useWorkbench((s) => s.timeline);

  const calls = useMemo(() => {
    const out: { id: number; at: number; name: string; title: string; ok?: boolean; output?: string }[] = [];
    // 按 callId 配对 started/completed。用序号去猜是错的 ——
    // 并发调用时 completed 的到达顺序不保证与 started 一致。
    const byCall = new Map<string, number>();
    for (const { id, at, event } of timeline) {
      if (event.type === "tool.started") {
        byCall.set(event.callId, out.length);
        out.push({ id, at, name: event.toolName, title: event.title });
      } else if (event.type === "tool.completed") {
        const i = byCall.get(event.callId);
        if (i !== undefined) {
          out[i]!.ok = event.ok;
          out[i]!.output = event.output;
        }
      }
    }
    return out;
  }, [timeline]);

  const failed = calls.filter((c) => c.ok === false).length;

  return (
    <>
      <PaneSection title={`调用流水 · ${calls.length} 次`}>
        {calls.length === 0 ? (
          <Empty text="没有调用记录。" sub="这一页是逐条流水；按工具名聚合去「工具」页。" />
        ) : (
          calls.map((c) => (
            <details key={c.id} className="-mx-2 rounded-btn px-2 py-1 hover:bg-line-soft">
              <summary className="flex cursor-pointer items-center gap-2 text-caption">
                <StatusDot ok={c.ok} />
                <span className="tnum shrink-0 text-ash">
                  {new Date(c.at).toLocaleTimeString("zh-CN", { hour12: false })}
                </span>
                <span className="shrink-0 font-mono text-graphite">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-graphite">{c.title}</span>
              </summary>
              {c.output && (
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-caption leading-relaxed text-ash">
                  {c.output}
                </pre>
              )}
            </details>
          ))
        )}
      </PaneSection>

      {calls.length > 0 && (
        <PaneSection title="失败">
          <p className="tnum text-body-sm text-ink">{failed} 次失败 / {calls.length} 次调用</p>
          <p className="mt-1 text-caption text-ash">失败的输出在上方展开对应条目即可看到。</p>
        </PaneSection>
      )}
    </>
  );
}

function StatusDot({ ok }: { ok?: boolean }) {
  if (ok === undefined) return <CircleDot size={12} className="shrink-0 text-teal" aria-label="进行中" />;
  return ok ? (
    <Check size={12} className="shrink-0 text-gain" aria-label="成功" />
  ) : (
    <X size={12} className="shrink-0 text-loss" aria-label="失败" />
  );
}

/* ------------------------------------------------------------- 模型轨迹 */

/** 模型轨迹页 —— 工作区级用量视角。按模型聚合，对照会话级「轨迹」的原始事件流。 */
function ModelTrajectoryPane() {
  const timeline = useWorkbench((s) => s.timeline);

  const byModel = useMemo(() => {
    const map = new Map<string, { model: string; calls: number; input: number; output: number; cost: number }>();
    for (const { event } of timeline) {
      if (event.type !== "usage") continue;
      const cur = map.get(event.model) ?? { model: event.model, calls: 0, input: 0, output: 0, cost: 0 };
      cur.calls += 1;
      cur.input += event.inputTokens;
      cur.output += event.outputTokens;
      cur.cost += event.costUsd;
      map.set(event.model, cur);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost);
  }, [timeline]);

  const total = byModel.reduce(
    (s, m) => ({ input: s.input + m.input, output: s.output + m.output, cost: s.cost + m.cost }),
    { input: 0, output: 0, cost: 0 },
  );

  return (
    <>
      <PaneSection title="工作区用量">
        {byModel.length === 0 ? (
          <Empty text="还没有用量数据。" sub="执行器声明了 usage 能力、跑完一次会话后这里才有数。" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="输入 token" value={fmtNum(total.input)} />
              <Stat label="输出 token" value={fmtNum(total.output)} />
              <Stat label="成本" value={`$${total.cost.toFixed(3)}`} />
            </div>
            <div className="mt-4 space-y-3">
              {byModel.map((m) => (
                <div key={m.model}>
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{m.model}</span>
                    <span className="tnum shrink-0 text-caption text-ash">×{m.calls}</span>
                    <span className="tnum shrink-0 font-mono text-caption">${m.cost.toFixed(3)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-line-soft">
                    <div
                      className="h-full bg-teal"
                      style={{ width: `${total.cost === 0 ? 0 : Math.round((m.cost / total.cost) * 100)}%` }}
                    />
                  </div>
                  <p className="tnum mt-1 font-mono text-caption text-ash">
                    ↑ {fmtNum(m.input)} · ↓ {fmtNum(m.output)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </PaneSection>

      <PaneSection title="口径">
        <p className="text-caption text-graphite">
          按 <code className="font-mono">usage</code> 事件聚合，跨会话累计。
          单条会话的原始事件流在会话级「轨迹」页。
        </p>
      </PaneSection>
    </>
  );
}

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/* ------------------------------------------------------------- 会话级 */

/** 会话级页签只看自己那条会话的事件 —— 作用域不是装饰 */
function useOwnEvents(ownerId: string | null) {
  const timeline = useWorkbench((s) => s.timeline);
  return useMemo(
    () => (ownerId ? timeline.filter((t) => t.event.sessionId === ownerId) : []),
    [timeline, ownerId],
  );
}

function FilesPane({ ownerId }: { ownerId: string | null }) {
  const timeline = useOwnEvents(ownerId);

  const files = useMemo(() => {
    const map = new Map<string, { path: string; add: number; del: number }>();
    for (const { event } of timeline) {
      if (event.type !== "file.diff") continue;
      const cur = map.get(event.path) ?? { path: event.path, add: 0, del: 0 };
      cur.add += event.additions;
      cur.del += event.deletions;
      map.set(event.path, cur);
    }
    return [...map.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
  }, [timeline]);

  const openTabType = useSidePane((s) => s.openTabType);

  return (
    <PaneSection title={`本会话文件变更 · ${files.length}`}>
      {files.length === 0 ? (
        <Empty
          text="本次会话没有文件变更。"
          sub="只有开了结构化 diff 的执行器才会出现在这里；换成不支持的执行器，这一页会一直是空的。"
        />
      ) : (
        files.map((f) => (
          <div key={f.path} className="-mx-2 flex items-center gap-2 rounded-btn px-2 py-1.5 hover:bg-line-soft">
            <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{f.path}</span>
            <button
              onClick={() => openTabType("code-viewer", ownerId, f.path)}
              title="在文件查看器中打开"
              className="shrink-0 rounded px-1 text-caption text-ash hover:bg-line hover:text-ink"
            >
              查看
            </button>
            <span className="tnum shrink-0 font-mono text-caption">
              <span className="text-gain">+{f.add}</span> <span className="text-loss">−{f.del}</span>
            </span>
          </div>
        ))
      )}
    </PaneSection>
  );
}

const STEP_STATUS: Record<PlanStepStatus, { label: string; cls: string; Icon: typeof Circle }> = {
  pending: { label: "待办", cls: "text-ash", Icon: Circle },
  in_progress: { label: "进行中", cls: "text-teal", Icon: CircleDot },
  done: { label: "完成", cls: "text-gain", Icon: Check },
  skipped: { label: "跳过", cls: "text-ash", Icon: Minus },
  blocked: { label: "受阻", cls: "text-loss", Icon: X },
};

/** 计划详情页 —— 对应 ZCode 的 plan-detail，数据源是 plan.* 事件 */
function PlanPane({ ownerId }: { ownerId: string | null }) {
  const timeline = useOwnEvents(ownerId);

  const plan = useMemo(() => {
    let title = "";
    let rationale: string | undefined;
    const steps = new Map<string, PlanStep>();
    let planId = "";
    let decision: "approved" | "rejected" | "edited" | null = null;

    for (const { event } of timeline) {
      if (event.type === "plan.proposed") {
        planId = event.planId;
        title = event.title;
        rationale = event.rationale;
        for (const st of event.steps) steps.set(st.id, { ...st });
      } else if (event.type === "plan.step.updated") {
        const cur = steps.get(event.stepId);
        if (cur) steps.set(event.stepId, { ...cur, status: event.status });
      } else if (event.type === "plan.resolved") {
        decision = event.decision;
      }
    }
    if (!planId) return null;
    return { title, rationale, decision, steps: [...steps.values()] };
  }, [timeline]);

  if (!plan) {
    return (
      <PaneSection title="计划详情">
        <Empty
          text="本会话还没有计划。"
          sub="执行器提出计划时会发 plan.proposed；没有这一步的实现（例如直接改代码）这一页会一直是空的。"
        />
      </PaneSection>
    );
  }

  const done = plan.steps.filter((s) => s.status === "done").length;

  return (
    <PaneSection title="计划">
      <p className="text-body-sm text-ink">{plan.title}</p>
      {plan.rationale && <p className="mt-1 text-caption text-graphite">{plan.rationale}</p>}

      <p className="mt-3 flex items-center gap-2 text-caption">
        <span className="tnum text-graphite">
          {done} / {plan.steps.length} 完成
        </span>
        {plan.decision && (
          <span
            className={cn(
              "rounded-chip px-1.5",
              plan.decision === "approved" ? "bg-teal-tint text-teal" : "bg-loss/10 text-loss",
            )}
          >
            {plan.decision === "approved" ? "已批准" : plan.decision === "rejected" ? "已否决" : "已修改后批准"}
          </span>
        )}
      </p>

      <ol className="mt-3 space-y-1.5">
        {plan.steps.map((s) => {
          const st = STEP_STATUS[s.status];
          const Icon = st.Icon;
          return (
            <li key={s.id} className="flex items-start gap-2">
              <Icon size={12} className={cn("mt-0.5 shrink-0", st.cls)} aria-label={st.label} />
              <span className="min-w-0 flex-1">
                <span className={cn("block text-body-sm", s.status === "done" ? "text-graphite" : "text-ink")}>
                  {s.title}
                </span>
                {s.detail && <span className="mt-0.5 block text-caption text-ash">{s.detail}</span>}
              </span>
              <span className={cn("shrink-0 text-caption", st.cls)}>{st.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-caption text-ash">
        不显示完成度百分比 —— 步骤权重不等，按条数算出来的百分比会骗人。
      </p>
    </PaneSection>
  );
}

/* ------------------------------------------------------------- 轨迹 */

const KIND_LABEL: Record<TrajKind, string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
  plan: "计划",
  permission: "权限",
  subagent: "子代理",
  diff: "变更",
  deliverable: "产出",
};

/** 类型色标。设计系统只许 teal 一个彩色：用户行墨色反白，助手青色浅底，其余灰阶 */
const KIND_CLASS: Record<TrajKind, string> = {
  system: "bg-line-soft text-graphite",
  user: "bg-ink text-canvas",
  assistant: "bg-teal-tint text-teal",
  tool: "bg-line-soft text-graphite",
  plan: "bg-line-soft text-graphite",
  permission: "bg-line-soft text-graphite",
  subagent: "bg-line-soft text-graphite",
  diff: "bg-line-soft text-graphite",
  deliverable: "bg-teal-tint text-teal",
};

/**
 * 轨迹页签 —— 对齐 dsh 的 TrajectoryView（ui-trajectory）。
 *
 * dsh 是「工具栏 → 三泳道时间轴 → 账本表格 + 详情面板」三层；面板宽度内
 * 取其骨架：会话统计（session-stats 投影口径）→ 折叠/搜索工具栏 →
 * Turn 分组账本（轮头带 token/步数/工具直方图，行带类型色标、内联结果、
 * 可展开详情）。时间轴泳道待真实运行时的精确计时接入后再补。
 */
function TracePane({ ownerId }: { ownerId: string | null }) {
  const timeline = useOwnEvents(ownerId);
  const busy = useWorkbench((s) => s.busy);
  const traj = useMemo(() => deriveTrajectory(timeline), [timeline]);
  const stats = traj.stats;

  const [query, setQuery] = useState("");
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const needle = query.trim().toLowerCase();
  const visibleTurns = traj.turns
    .map((t) => ({ ...t, records: t.records.filter((r) => !needle || r.text.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle)) }))
    .filter((t) => t.records.length > 0);

  const toggleTurn = (turn: number) =>
    setCollapsedTurns((s) => {
      const next = new Set(s);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  const toggleAll = () => {
    const allCollapsed = visibleTurns.length > 0 && visibleTurns.every((t) => collapsedTurns.has(t.turn));
    setCollapsedTurns(allCollapsed ? new Set() : new Set(visibleTurns.map((t) => t.turn)));
  };
  const toggleRecord = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PaneSection title="会话统计">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="轮次" value={String(stats.turns)} />
          <Stat label="步数" value={String(stats.steps)} />
          <Stat label="LLM 耗时" value={stats.llmMs > 0 ? formatDuration(stats.llmMs) : "—"} />
          <Stat label="工具耗时" value={stats.toolMs > 0 ? formatDuration(stats.toolMs) : "—"} />
          <Stat label="输出速度" value={stats.tokensPerSecond === null ? "—" : `${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`} />
          <Stat label="tokens" value={trajTokenText(stats.tokens)} />
          <Stat label="成本" value={`$${stats.costUsd.toFixed(3)}`} />
          <Stat label="事件" value={String(stats.eventCount)} />
        </div>
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-caption text-graphite">
            <Activity size={12} className="text-teal" />
            采集中…
          </p>
        )}
      </PaneSection>

      <PaneSection title={`轨迹账本 · ${stats.eventCount} 事件`}>
        {/* 工具栏（dsh TrajectoryToolbar：折叠轮次 + 搜索） */}
        <div className="mb-2 flex items-center gap-1.5">
          <button
            onClick={toggleAll}
            aria-pressed={visibleTurns.length > 0 && visibleTurns.every((t) => collapsedTurns.has(t.turn))}
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink aria-pressed:border-teal-edge aria-pressed:bg-teal-tint aria-pressed:text-ink"
          >
            <ChevronsDownUp size={12} />
            折叠轮次
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索轨迹…"
            aria-label="搜索轨迹"
            className="min-w-0 flex-1 rounded-btn border border-line bg-canvas px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
          />
        </div>

        {visibleTurns.length === 0 ? (
          <Empty
            text={needle ? "没有匹配的轨迹记录。" : "本会话还没有轨迹。"}
            sub={needle ? "换个关键词试试。" : "发一次任务，这里的账本会按轮次折叠出完整因果链。"}
          />
        ) : (
          visibleTurns.map((turn) => {
            const isCollapsed = collapsedTurns.has(turn.turn);
            return (
              <div key={turn.turn} className="mb-2">
                {/* 轮头（dsh TrajectoryTurnHeader：Turn N + token/步数/工具摘要） */}
                <button
                  onClick={() => toggleTurn(turn.turn)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-1.5 rounded-btn bg-rail px-1.5 py-1 text-caption text-graphite hover:text-ink"
                >
                  <ChevronDown size={12} className={cn("shrink-0 transition-transform", isCollapsed && "-rotate-90")} />
                  <span className="shrink-0 font-medium text-ink">Turn {turn.turn}</span>
                  <span className="tnum ml-auto shrink-0 text-ash">
                    {trajTokenText(turn.tokens)} · {turn.steps} 步 · 工具×{turn.toolCalls}
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="mt-0.5 space-y-px">
                    {turn.records.map((r) => {
                      const isOpen = expanded.has(r.id);
                      return (
                        <div key={r.id}>
                          <button
                            onClick={() => r.detail && toggleRecord(r.id)}
                            aria-expanded={r.detail ? isOpen : undefined}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded-btn px-1 py-1 text-left",
                              r.detail ? "hover:bg-line-soft" : "cursor-default",
                            )}
                          >
                            <span className="tnum w-14 shrink-0 text-caption text-ash">{r.clock}</span>
                            <span
                              className={cn(
                                "shrink-0 rounded-chip px-1.5 py-px text-caption leading-4",
                                KIND_CLASS[r.kind],
                                r.isError && "bg-loss/10 text-loss",
                              )}
                            >
                              {r.label}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-caption text-ink">
                              {r.text}
                              {r.result && <span className="text-ash"> → {r.result}</span>}
                            </span>
                            {r.durationMs !== undefined && (
                              <span className="tnum shrink-0 text-caption text-ash">{formatDuration(r.durationMs)}</span>
                            )}
                            {r.detail && (
                              <ChevronDown size={12} className={cn("shrink-0 text-ash", !isOpen && "-rotate-90")} />
                            )}
                          </button>
                          {isOpen && r.detail && (
                            <pre className="mb-1 ml-6 overflow-x-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-caption leading-relaxed text-ash">
                              {r.detail}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </PaneSection>
    </>
  );
}

/* ------------------------------------------------------------- 子代理 */

interface AgentRow {
  id: string;
  role: string;
  runtime: string;
  started: number;
  done?: string;
  ok?: boolean;
}

/** 从事件流归一子代理列表。spawned/finished 靠 childId 配对。 */
function useAgents(ownerId: string | null): readonly AgentRow[] {
  const timeline = useOwnEvents(ownerId);
  return useMemo(() => {
    const map = new Map<string, AgentRow>();
    for (const { event, at } of timeline) {
      if (event.type === "subagent.spawned") {
        map.set(event.childId, { id: event.childId, role: event.role, runtime: event.runtimeId, started: at });
      } else if (event.type === "subagent.finished") {
        const prev = map.get(event.childId);
        if (prev) map.set(event.childId, { ...prev, done: event.summary ?? "已完成", ok: event.ok });
      }
    }
    return [...map.values()].sort((a, b) => b.started - a.started);
  }, [timeline]);
}

function SubagentPane({ ownerId }: { ownerId: string | null }) {
  const agents = useAgents(ownerId);

  return (
    <PaneSection title={`本会话派生的子代理 · ${agents.length}`}>
      {agents.length === 0 && (
        <Empty
          text="本会话没有派生子代理。"
          sub="只有声明了子代理能力的执行器才会出现记录 —— 换成 capabilities.subagents=false 的执行器，这里永远是空的。"
        />
      )}
      {agents.map((a) => (
        <div key={a.id} className="-mx-2 rounded-btn px-2 py-2 hover:bg-line-soft">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-caption",
                a.ok === undefined ? "bg-teal-tint text-teal" : a.ok ? "bg-[#1d3a2c] text-[#5fc99a]" : "bg-loss/10 text-loss",
              )}
              aria-hidden
            >
              {a.role.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{a.role}</span>
            <span className="shrink-0 font-mono text-caption text-ash">{a.runtime}</span>
          </div>
          {a.done ? (
            <p className="mt-1 pl-7 text-caption text-graphite">{a.done}</p>
          ) : (
            <p className="mt-1 pl-7 text-caption text-teal">进行中…</p>
          )}
        </div>
      ))}
    </PaneSection>
  );
}

/**
 * 子代理目录页 —— 对照 ZCode 的 `subagent-directory`：按执行器分组的目录树，
 * 而「子代理」页是扁平的会话列表。一眼看出「这次派活都落在哪几家执行器上」。
 */
function SubagentDirectoryPane({ ownerId }: { ownerId: string | null }) {
  const agents = useAgents(ownerId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const byRuntime = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    for (const a of agents) {
      const list = map.get(a.runtime) ?? [];
      list.push(a);
      map.set(a.runtime, list);
    }
    return [...map.entries()].sort((l, r) => r[1].length - l[1].length);
  }, [agents]);

  return (
    <PaneSection title={`子代理目录 · ${byRuntime.length} 个执行器`}>
      {byRuntime.length === 0 ? (
        <Empty text="目录是空的。" sub="先跑一次声明了子代理能力的会话。" />
      ) : (
        byRuntime.map(([runtime, list]) => {
          const open = expanded[runtime] ?? true;
          return (
            <div key={runtime} className="mb-1">
              <button
                onClick={() => setExpanded((e) => ({ ...e, [runtime]: !open }))}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-btn px-2 py-1 text-left hover:bg-line-soft"
                aria-expanded={open}
              >
                <ChevronDown size={12} className={cn("shrink-0 text-ash transition-transform", !open && "-rotate-90")} aria-hidden />
                <FolderTree size={12} className="shrink-0 text-graphite" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{runtime}</span>
                <span className="tnum shrink-0 text-caption text-ash">{list.length}</span>
              </button>
              {open && (
                <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-line pl-3">
                  {list.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-caption">
                      <StatusDot ok={a.ok} />
                      <span className="min-w-0 flex-1 truncate text-graphite">{a.role}</span>
                      <span className="shrink-0 text-ash">
                        {a.ok === undefined ? "进行中" : a.ok ? "完成" : "失败"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </PaneSection>
  );
}

/* ------------------------------------------------------------- 后台命令 */

/** 后台命令页 —— 只认 shell 类工具调用。展开看输出，常驻挂载保住滚动位置。 */
function BashOutputPane({ ownerId }: { ownerId: string | null }) {
  const timeline = useOwnEvents(ownerId);
  const openTabType = useSidePane((s) => s.openTabType);

  const cmds = useMemo(() => {
    const out: { key: string; callId: string; title: string; at: number; ok?: boolean; output?: string }[] = [];
    const byCall = new Map<string, number>();
    for (const { id, at, event } of timeline) {
      if (event.type === "tool.started" && isShellTool(event.toolName)) {
        byCall.set(event.callId, out.length);
        out.push({ key: `k${id}`, callId: event.callId, title: event.title, at });
      } else if (event.type === "tool.completed") {
        const i = byCall.get(event.callId);
        if (i !== undefined) {
          out[i]!.ok = event.ok;
          out[i]!.output = event.output;
        }
      }
    }
    return out;
  }, [timeline]);

  return (
    <PaneSection title={`后台命令 · ${cmds.length}`}>
      {cmds.length === 0 ? (
        <Empty
          text="本次会话没有跑过 shell 命令。"
          sub="Bash / run_shell / execute_command / terminal.exec 这类工具的调用会进这一页。"
        />
      ) : (
        cmds.map((c) => (
          <details key={c.key} className="-mx-2 rounded-btn px-2 py-1 hover:bg-line-soft">
            <summary className="flex cursor-pointer items-center gap-2 text-caption">
              <StatusDot ok={c.ok} />
              <span className="tnum shrink-0 text-ash">
                {new Date(c.at).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-graphite">{c.title}</span>
            </summary>
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-caption leading-relaxed text-ash">
              {c.output ?? "（没有回传输出）"}
            </pre>
          </details>
        ))
      )}

      <p className="mt-3 text-caption text-ash">
        这一页常驻挂载（keepMounted）—— 面板收起时不卸载，滚动位置与展开状态才不丢。
      </p>

      <button
        onClick={() => openTabType("terminal", ownerId)}
        className="mt-2 rounded-btn px-2 py-1 text-caption text-teal hover:bg-line-soft"
      >
        需要交互式终端？去「终端」页 →
      </button>
    </PaneSection>
  );
}

/**
 * 终端页 —— 真 PTY 还没接。
 * 刻意不做成纯占位：把已发生的 shell 调用列出来，让人知道内容并没有丢，
 * 只是还不能交互。假终端骗人，空占位也骗人。
 */
function TerminalPane() {
  const timeline = useWorkbench((s) => s.timeline);

  const cmds = useMemo(() => {
    const out: { key: string; title: string; ok?: boolean; output?: string }[] = [];
    const byCall = new Map<string, number>();
    for (const { id, event } of timeline) {
      if (event.type === "tool.started" && isShellTool(event.toolName)) {
        byCall.set(event.callId, out.length);
        out.push({ key: `k${id}`, title: event.title });
      } else if (event.type === "tool.completed") {
        const i = byCall.get(event.callId);
        if (i !== undefined) {
          out[i]!.ok = event.ok;
          out[i]!.output = event.output;
        }
      }
    }
    return out;
  }, [timeline]);

  return (
    <>
      <PaneSection title="内建终端">
        <p className="text-body-sm text-ink">还没接真 PTY</p>
        <dl className="mt-3 space-y-2 border-t border-line pt-3">
          <Row label="缺什么" value={NEEDS_RUNTIME.terminal?.needs ?? "—"} />
          <Row label="什么时候接" value={NEEDS_RUNTIME.terminal?.when ?? "—"} />
          <Row label="替代" value="会话树的「后台命令」页可看已发生的命令" />
        </dl>
      </PaneSection>

      <PaneSection title={`已发生的命令 · ${cmds.length}`}>
        {cmds.length === 0 ? (
          <p className="text-body-sm text-ash">还没有 shell 调用记录。</p>
        ) : (
          cmds.map((c) => (
            <div key={c.key} className="flex items-center gap-2 py-1">
              <StatusDot ok={c.ok} />
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-graphite">{c.title}</span>
              {c.output && <span className="min-w-0 flex-shrink truncate text-caption text-ash">{c.output}</span>}
            </div>
          ))
        )}
      </PaneSection>
    </>
  );
}

/* ------------------------------------------------------------- 公共零件 */

/**
 * 徽标从事件流现算，不存进 tab。
 * 面板窄到标签被裁掉时，徽标是「看不见但有事」的唯一提示。
 */
function useTabBadges(ownerId: string | null): ReadonlyMap<SidePaneTabType, number> {
  const timeline = useWorkbench((s) => s.timeline);
  return useMemo(
    () => deriveTabBadges(timeline.map((t) => t.event), ownerId),
    [timeline, ownerId],
  );
}

function Empty({ text, sub }: { text: string; sub?: string }) {
  return (
    <div>
      <p className="text-body-sm text-ash">{text}</p>
      {sub && <p className="mt-1 text-caption text-ash">{sub}</p>}
    </div>
  );
}

function PaneSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-b-0">
      <p className="mb-3 text-body-sm text-ash">{title}</p>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-btn bg-canvas px-2 py-2">
      <p className="tnum text-body font-medium text-ink">{value}</p>
      <p className="mt-0.5 text-caption text-ash">{label}</p>
    </div>
  );
}
