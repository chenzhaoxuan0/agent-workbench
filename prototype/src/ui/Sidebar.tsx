import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  Archive,
  Bot,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GripVertical,
  ImagePlus,
  MessageCirclePlus,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Unplug,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectUnitSessions, type ViewMode, type BotWriteGuards } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import {
  asModelId,
  asRuntimeId,
  asUnitId,
  type Session,
  type SessionId,
  type UnitId,
  type WorkUnit,
} from "../core/units.ts";
import { UNAVAILABLE_UNIT } from "../adapters/mock/fixtures.ts";
import { AddBotDialog, type AddBotDraft } from "./AddBotDialog.tsx";
import { ImportBotDialog } from "./ImportBotDialog.tsx";
import { cn } from "./cn.ts";

/**
 * 左侧栏 —— 对齐 ZCode 的 `WorkspaceSidebar` 完整功能集。
 *
 * ## 两条原则，不是冲突的两条
 *
 * 1. **功能不能因为「当前为空」就消失。**
 *    ZCode 里每一项都有对应的 message id，说明它们都是常驻能力：
 *
 *      projectsSection / addProject / noProjects
 *      conversationsSection / newConversation / noConversations
 *      organize / organizeGrouped / viewByWorkspace / organizeChronologicalList
 *      sortBy / sortByUpdated / sortByCreated
 *      toggleArchivedTasks / reorderSection / unavailableLocalDirectory
 *
 *    之前我把这些做成了「有数据才渲染」，于是新增功能在页面上根本看不见。
 *
 *    ⚠ 2026-10-02：任务分组（taskGroup）已从这条清单里**删掉**。
 *    它当时是纯 UI 壳——按钮无 onClick、无 store 状态、无过滤逻辑，
 *    样例数组从没被 import。留着它只是让「常驻可见」这条原则被架空成形式主义。
 *    真要做分组时，数据模型和渲染层一起加回来。
 *
 * 2. **但「不消失」不等于「永久占版面」**（渐进披露，第二批引入）。
 *    区分标准只有一条 —— **用户多久会用到它**：
 *      - 高频（工作单元切换、新建任务）→ 常驻可见；
 *      - 低频偏好（组织方式、排序）→ 收进浮层，当前值带在 title / 折叠行里；
 *      - 低频导航（搜索、出图、自动化）→ 去掉文字留图标，不藏进浮层。
 *
 *    判据是「多久用一次」，不是「功能重不重要」。自动化很重要，
 *    但没人一天点八次自动化 —— 重要性决定它**不能消失**，不决定它要**占多大版面**。
 */

/** ZCode 是 4 种：grouped / workspace / timeline / archived */
type Organize = "grouped" | "workspace" | "timeline" | "archived";
type Sort = "updated" | "created";

const ORGANIZE_OPTIONS: readonly Organize[] = ["grouped", "workspace", "timeline", "archived"];
const ORGANIZE_LABEL: Record<Organize, string> = {
  grouped: "按分组",
  workspace: "按单元",
  timeline: "按时间",
  archived: "含归档",
};

const SORT_OPTIONS: readonly Sort[] = ["updated", "created"];
const SORT_LABEL: Record<Sort, string> = { updated: "按更新", created: "按创建" };

const VIEWS: readonly { id: ViewMode; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "bot", icon: Bot },
  { id: "project", label: "项目", icon: FolderGit2 },
];

const STATUS_DOT: Record<string, string> = {
  idle: "bg-ash",
  running: "bg-teal",
  awaiting_permission: "bg-loss",
  awaiting_input: "bg-line",
  failed: "bg-loss",
  done: "bg-ash",
};

export function Sidebar() {
  const units = useWorkbench((s) => s.units);
  const view = useWorkbench((s) => s.view);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const setView = useWorkbench((s) => s.setView);
  const selectUnit = useWorkbench((s) => s.selectUnit);
  const archived = useWorkbench((s) => s.archivedSessions);
  const addUnit = useWorkbench((s) => s.addUnit);
  const mainView = useShell((s) => s.mainView);
  const openSettings = useShell((s) => s.openSettings);

  const [organize, setOrganize] = useState<Organize>("grouped");
  const [sort, setSort] = useState<Sort>("updated");
  const [unitOrder, setUnitOrder] = useState<string[] | null>(null);
  const [dragUnit, setDragUnit] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const selectSession = useWorkbench((s) => s.selectSession);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  // 「添加 bot」的对话框开关在 useShell —— 标题行的 ＋ 和单元区空态两个入口共用
  const addBotOpen = useShell((s) => s.addBotOpen);
  const importBotOpen = useShell((s) => s.importBotOpen);
  const editUnitId = useShell((s) => s.editUnitId);
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const settingsActive = useShell((s) => s.settingsOpen);
  /** 正在编辑的单元；单元被删掉时（daemon 重载等）自动退化成 null，不会开出一个空表单 */
  const editingUnit = useMemo(
    () => (editUnitId ? units.find((u) => u.id === editUnitId) ?? null : null),
    [editUnitId, units],
  );

  // 目录不可用的单元也要列出来（ZCode: unavailableLocalDirectory）
  const allUnits = useMemo<readonly WorkUnit[]>(
    () => [...units, UNAVAILABLE_UNIT],
    [units],
  );

  const visibleUnits = useMemo(() => {
    const list = allUnits.filter((u) => u.kind === view);
    if (!unitOrder) return list;
    return [...list].sort(
      (a, b) => (unitOrder.indexOf(a.id) + 1 || 99) - (unitOrder.indexOf(b.id) + 1 || 99),
    );
  }, [allUnits, view, unitOrder]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-rail">
      {/* 顶部 48px 占位。ZCode 的侧栏顶部是空的拖拽条 —— 品牌 logo 与侧栏开关
          由左上浮层（DesktopTopOverlay）承载，这里不再重复 */}
      <div className="h-12 shrink-0 border-b border-line/60" />

      {/* 顶部动作区：五枚并排图标，全部平铺，不设 ⋯。
          之前「新建任务」占一整行、其余收在第二行，是两段版面；
          现在一行五枚等宽。⌘N / ⌘K 提示挂在 title 上。 */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-0.5">
          <IconNavBtn
            icon={MessageCirclePlus}
            label="新建任务"
            hint="⌘N"
            onClick={() => useShell.getState().newTask()}
          />
          <IconNavBtn
            icon={Search}
            label="搜索"
            hint="⌘K"
            onClick={() => useShell.getState().setCommandOpen(true)}
          />
          <IconNavBtn
            icon={AlarmClock}
            label="自动化"
            active={mainView === "automations"}
            onClick={() => useShell.getState().setMainView("automations")}
          />
          {/* 出图工作台 —— gpt_image_playground 的移植落点（OpenAI 兼容 images API） */}
          <IconNavBtn
            icon={ImagePlus}
            label="出图"
            active={mainView === "image"}
            onClick={() => useShell.getState().setMainView("image")}
          />
          <ArchivedMenu
            sessions={archived}
            onSelectSession={selectSession}
            activeSessionId={activeSessionId}
          />
        </div>
      </div>

      {/* 分区行：身份切换（bot/项目）直接在这行完成 —— 吸收原顶部两个大按钮的职能；
          右侧仍是 organize / sort（ZCode: organize / sortBy / taskViewOptions） */}
      <div className="flex items-center gap-1.5 px-4 pb-2">
        <div className="flex shrink-0 items-center rounded-chip bg-line-soft p-0.5" role="tablist" aria-label="身份视图">
          {VIEWS.map((v) => {
            const active = v.id === view;
            return (
              <button
                key={v.id}
                role="tab"
                aria-selected={active}
                onClick={() => setView(v.id)}
                className={cn(
                  "rounded-chip px-2 py-0.5 text-caption",
                  active ? "bg-canvas font-medium text-ink" : "text-graphite hover:text-ink",
                )}
              >
                {v.label}
              </button>
            );
          })}
        </div>
        <span className="tnum text-caption text-ash">{visibleUnits.length}</span>
        <ViewOptionsMenu
          organize={organize}
          onOrganize={setOrganize}
          sort={sort}
          onSort={setSort}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* 工作单元区（ZCode: projectsSection / reorderSection / addProject）
            「添加」就放在分区标题右侧 —— 它加的正是这一区的内容。
            「可拖拽排序」从常驻文字降级为 title 提示：它是操作说明不是数据。 */}
        <div className="mb-1 flex items-center gap-1 px-2 pt-2">
          <p className="flex-1 text-caption text-ash" title="拖拽单元可调整顺序">
            工作单元
          </p>
          <button
            onClick={() => {
              if (view === "bot") {
                useShell.getState().openAddBot();
              } else {
                addUnit({
                  id: asUnitId(`u-new-${Date.now().toString(36)}`),
                  name: "新工作单元",
                  rootPath: "C:/Users/chenziyu/project/Agent/<待选目录>",
                  kind: "project",
                  bindings: [],
                  assets: { agentFiles: [], skillDirs: [] },
                  tags: ["新建"],
                });
              }
            }}
            aria-label={view === "bot" ? "添加 bot" : "添加项目"}
            title={view === "bot" ? "添加 bot" : "添加项目"}
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <Plus size={12} />
          </button>
          {/* 「添加已有文件夹」——bot 区从创建器变 manager 的入口（docs/09 §七）。
              它不建任何东西，只把一个现成文件夹登记进来，所以配自己的图标而不是复用 ＋：
              两个动作长得一样、后果完全不同。 */}
          {view === "bot" && (
            <button
              onClick={() => useShell.getState().openImportBot()}
              aria-label="添加已有文件夹"
              title="添加已有文件夹 —— 文件夹留在原地，只登记进管理面"
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <FolderOpen size={12} />
            </button>
          )}
        </div>

        {/* 空态当第二个「添加 bot」入口 —— 侧栏那颗按钮收进 ⋯ 之后，
            这里就是最该给出引导的位置，而不是一行灰字。 */}
        {visibleUnits.length === 0 &&
          (view === "bot" ? (
            <button
              onClick={() => useShell.getState().openAddBot()}
              className="flex w-full flex-col items-center gap-1 rounded-input px-3 py-6 text-center hover:bg-line-soft"
            >
              <FolderPlus size={16} className="text-ash" />
              <span className="text-body-sm text-graphite">还没有 bot</span>
              <span className="text-caption text-ash">点一下新建，第一个 bot 从 AGENTS.md 开始</span>
            </button>
          ) : (
            <p className="px-2 py-6 text-center text-body-sm text-ash">还没有项目</p>
          ))}

        {visibleUnits.map((u) => {
          const active = u.id === activeUnitId;
          const unitId = u.id as UnitId;
          return (
            <div
              key={u.id}
              draggable
              onDragStart={() => setDragUnit(u.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragUnit && dragUnit !== unitId) {
                  const order = visibleUnits.map((x) => x.id as string);
                  const from = order.indexOf(dragUnit);
                  const to = order.indexOf(unitId);
                  order.splice(to, 0, ...order.splice(from, 1));
                  setUnitOrder(order);
                }
                setDragUnit(null);
              }}
              className={cn("group/u mb-1 flex items-start", dragUnit === unitId && "opacity-40")}
            >
              <span className="mt-3 shrink-0 cursor-grab text-ash opacity-0 transition group-hover/u:opacity-100" aria-hidden>
                <GripVertical size={12} />
              </span>
              <div className="min-w-0 flex-1">
                <UnitRow
                  unit={u}
                  active={active}
                  onSelect={() => selectUnit(u.id as UnitId)}
                  onOpenSettings={() => useShell.getState().openUnitSettings(u.id as UnitId)}
                  schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                />
                {active && <TaskList unitId={u.id as UnitId} sort={sort} />}
              </div>
            </div>
          );
        })}

      </div>

      {/* 底部：账号 + 设置（ZCode: WorkspaceSidebarFooter —— 账号菜单 + 齿轮，
          搜索/自动化在顶部区，不重复出现） */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-4 py-2.5">
        <div className="relative min-w-0 flex-1">
          <button
            onClick={() => setAccountOpen((o) => !o)}
            aria-expanded={accountOpen}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-btn p-1 -m-1 text-left",
              accountOpen ? "bg-line-soft" : "hover:bg-line-soft",
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-chip bg-teal text-caption font-medium text-white">
              陈
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium text-ink">陈子渔</span>
              <span className="block truncate text-caption text-ash">个人版 · Pro</span>
            </span>
          </button>
          {accountOpen && (
            <>
              <span className="fixed inset-0 z-30" onClick={() => setAccountOpen(false)} aria-hidden />
              <div className="absolute bottom-full left-0 z-40 mb-1.5 w-52 rounded-card border border-line bg-canvas py-1 shadow-subtle">
                {ACCOUNT_ITEMS.map((row) => (
                  <button
                    key={row.label}
                    onClick={() => setAccountOpen(false)}
                    title="原型占位入口"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    {row.label}
                    <span className="ml-auto text-caption text-ash">{row.value}</span>
                  </button>
                ))}
                <div className="mt-1 border-t border-line-soft pt-1">
                  <button
                    onClick={() => setAccountOpen(false)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    <Unplug size={12} />
                    连接使用
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        {/* 连接远端 —— 与设置并排（ZCode 的远程连接入口同位级的图标钮） */}
        <button
          title="连接远端 · 未连接"
          aria-label="连接远端"
          className="shrink-0 rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink"
        >
          <Unplug size={14} />
        </button>
        <button
          onClick={() => openSettings()}
          aria-label="设置"
          title="设置 · ⌘,"
          className={cn(
            "shrink-0 rounded-btn p-1.5",
            settingsActive ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          <Settings size={14} />
        </button>
      </div>

      {/* bot 对话框（AGENTS.md 岗位说明书）—— 新建 / 编辑共用一个组件。
          开关在 useShell：侧栏的 ＋ 和空态卡开新建，单元行的齿轮开编辑。 */}
      {(addBotOpen || editingUnit) && (
        <AddBotDialog
          open
          initial={editingUnit ?? null}
          onClose={() => {
            const sh = useShell.getState();
            if (editingUnit) sh.closeUnitSettings();
            else sh.closeAddBot();
          }}
          onSubmit={async (draft, opts) => {
            const sh = useShell.getState();
            if (editingUnit) {
              // 编辑：保留 id / kind / assets / tags，只换用户能改的那些字段。
              // updateUnit 会 await 并在盘上被改过时抛 conflict —— **不吞掉**，
              // 让对话框弹「覆盖 / 重新加载 / 取消」，静默覆盖就是数据丢失。
              await updateUnit(
                {
                  ...editingUnit,
                  name: draft.name,
                  rootPath: draft.rootPath,
                  identity: {
                    ...editingUnit.identity,
                    role: draft.role,
                    persona: draft.persona || undefined,
                    sourcePath: "AGENTS.md",
                    loadedAt: editingUnit.identity?.loadedAt ?? Date.now(),
                  },
                  // 主执行器没选（daemon 未连接）就落空绑定，run() 里 find 返回 undefined 是安全的
                  bindings: draft.runtimeId
                    ? [
                        {
                          runtimeId: asRuntimeId(draft.runtimeId),
                          modelHint: draft.modelHint ? asModelId(draft.modelHint) : undefined,
                          primary: true,
                        },
                      ]
                    : [],
                  agentsMd: draft.agentsMd,
                  memory: draft.memory,
                  channels: draft.channels,
                },
                opts?.overwrite === true ? {} : guardsOf(editingUnit),
              );
              sh.closeUnitSettings();
            } else {
              // 新建：等写盘结果再关窗。目录不存在 / daemon 没起都该让用户看见，
              // 否则侧栏多一个刷新就没了的"幽灵 bot"。
              await addUnit({
                id: asUnitId(`bot-${Date.now().toString(36)}`),
                rootPath: draft.rootPath,
                name: draft.name,
                kind: "bot",
                identity: {
                  role: draft.role,
                  persona: draft.persona || undefined,
                  sourcePath: "AGENTS.md",
                  loadedAt: Date.now(),
                },
                bindings: draft.runtimeId
                  ? [
                      {
                        runtimeId: asRuntimeId(draft.runtimeId),
                        modelHint: draft.modelHint ? asModelId(draft.modelHint) : undefined,
                        primary: true,
                      },
                    ]
                  : [],
                assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
                agentsMd: draft.agentsMd,
                memory: draft.memory,
                channels: draft.channels,
                tags: ["新建"],
                lastActiveAt: Date.now(),
              });
              sh.closeAddBot();
            }
          }}
        />
      )}
      {/* 导入已有文件夹（docs/09 §七）：只注册，不搬家 */}
      {importBotOpen && (
        <ImportBotDialog
          open
          onClose={() => useShell.getState().closeImportBot()}
          onImported={({ unit }) => {
            // 重新连接分支零写入（bot.json 早就在盘上），要自己并进 state；
            // 认领/脚手架分支 addUnit 已经并过了，别重复
            if (useWorkbench.getState().units.some((u) => u.id === unit.id)) return;
            useWorkbench.setState((s) => ({ units: [...s.units, unit], activeUnitId: unit.id, activeSessionId: null }));
          }}
        />
      )}
    </div>
  );
}

const ACCOUNT_ITEMS: readonly { label: string; value: string }[] = [
  { label: "界面语言", value: "简体中文" },
  { label: "界面主题", value: "浅色" },
];

/**
 * 打开设置页那一刻的盘上真值 → 保存时当乐观锁基线。
 * revision 抓「另一个窗口/别的设备改过 bot.json」，agentsMd hash 抓「用户在 VS Code
 * 里改了 AGENTS.md」。两者任一不符 daemon 就拒写，由对话框让用户选谁赢。
 */
function guardsOf(u: WorkUnit): BotWriteGuards {
  return { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash ?? "" };
}

/* ------------------------------------------------------------- 单元行 */

/**
 * bot 头像的身份色与形状 —— 对齐 GrokBot 的彩色 blob 形态。
 * 颜色是**身份数据**（与执行器徽标的 accent 同类例外），不是 UI 装饰；
 * 由单元名哈希出稳定的「颜色 × 形状」组合，同一个 bot 永远长一样。
 */
const BOT_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#6366f1"];
const BOT_SHAPES = ["rounded-full", "rounded-[38%]", "rounded-2xl"] as const;

function botAvatarStyle(name: string): { color: string; shape: string } {
  const hash = [...name].reduce((a, c) => a + c.codePointAt(0)!, 0);
  return {
    color: BOT_COLORS[hash % BOT_COLORS.length]!,
    shape: BOT_SHAPES[hash % BOT_SHAPES.length]!,
  };
}

/** 最后活动时间：今天显示时刻，昨天显示「昨天」，更早显示日期（GrokBot 的相对语义） */
function lastActivityLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function UnitRow({
  unit,
  active,
  onSelect,
  onOpenSettings,
  schedule,
}: {
  unit: WorkUnit;
  active: boolean;
  onSelect: () => void;
  onOpenSettings: () => void;
  schedule?: string;
}) {
  // ZCode: unavailableLocalDirectory —— 路径不可用要显式说出来，不能当成正常单元
  const unavailable = unit.tags.includes("目录不可用");
  const isBot = unit.kind === "bot";

  // 副标题 = 在行任务（本单元最新会话标题）优先，其次身份角色（GrokBot 的行结构）
  const sessions = useWorkbench((s) => s.sessions);
  const latest = useMemo(
    () =>
      sessions
        .filter((s) => s.unitId === unit.id)
        .reduce<(typeof sessions)[number] | null>((acc, s) => (acc === null || s.startedAt > acc.startedAt ? s : acc), null),
    [sessions, unit.id],
  );
  const subtitle = latest?.title ?? unit.identity?.role ?? "";
  const avatar = botAvatarStyle(unit.name);

  return (
    // 整行是 button，button 里再套 button 是非法 HTML —— 设置入口做成
    // 绝对定位的兄弟节点，和时间戳抢同一个位置、hover 时交叉淡入淡出。
    <div className="group/row relative">
      <button
        onClick={onSelect}
        aria-current={active}
        className={cn(
          "flex w-full items-start gap-3 rounded-input px-3 py-2.5 text-left",
          active ? "bg-teal-tint" : "hover:bg-line-soft",
          unavailable && "opacity-60",
        )}
      >
        {isBot ? (
          /* 彩色 blob 头像 + 双眼（GrokBot 式吉祥物形态），右下角日程角标 */
          <span
            aria-hidden
            className={cn("relative flex h-11 w-11 shrink-0 items-center justify-center", avatar.shape)}
            style={{ background: avatar.color }}
          >
            <span className="mt-0.5 flex gap-1">
              <span className="h-2 w-1 rounded-full bg-white/90" />
              <span className="h-2 w-1 rounded-full bg-white/90" />
            </span>
            {schedule && (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-rail bg-teal"
                title={schedule}
              />
            )}
          </span>
        ) : (
          /* 项目保持方形字母文件夹标 */
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-btn bg-line-soft text-body font-medium text-graphite"
          >
            {unit.name.slice(0, 1)}
          </span>
        )}

        <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-body font-medium text-ink">{unit.name}</span>
            {latest && (
              <span className="tnum ml-auto shrink-0 text-caption text-ash transition-opacity group-hover/row:opacity-0">
                {lastActivityLabel(latest.startedAt)}
              </span>
            )}
          </span>
          <span className="truncate text-body-sm text-graphite">
            {subtitle || <span className="text-ash">{unit.rootPath}</span>}
          </span>
          {unavailable && (
            <span className="mt-0.5 w-fit rounded-chip bg-loss/10 px-1.5 py-0.5 text-caption text-loss">目录不可用</span>
          )}
        </span>
      </button>

      {/* 设置入口 —— 重新打开同一个对话框改 AGENTS.md / 人设 / 主执行器 */}
      <button
        onClick={onOpenSettings}
        aria-label={`${unit.name} 设置`}
        title="设置 —— 改 AGENTS.md、人设、主执行器"
        className="absolute right-2 top-2.5 rounded-btn p-1 text-ash opacity-0 transition hover:bg-line-soft hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <Settings size={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- 会话行 */

function TaskList({ unitId, sort }: { unitId: UnitId; sort: Sort }) {
  const sessions = useWorkbench(useShallow(selectUnitSessions));
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const selectSession = useWorkbench((s) => s.selectSession);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);

  if (activeUnitId !== unitId) return null;

  if (sessions.length === 0) {
    return <p className="px-3 py-2 text-caption text-ash">该工作单元下还没有任务</p>;
  }

  const ordered =
    sort === "created"
      ? sessions.slice().sort((a, b) => a.startedAt - b.startedAt)
      : sessions.slice().sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="mb-1 ml-3 border-l border-line pl-2">
      {ordered.map((s) => (
        <SessionRow
          key={s.id}
          s={s}
          active={s.id === activeSessionId}
          onSelect={() => selectSession(s.id === activeSessionId ? null : s.id)}
        />
      ))}
    </div>
  );
}

function SessionRow({
  s,
  active,
  muted,
  onSelect,
}: {
  s: Session;
  active?: boolean;
  muted?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-current={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left",
        active ? "bg-canvas" : "hover:bg-line-soft",
        muted && "opacity-70",
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[s.status] ?? "bg-ash", s.status === "running" && "animate-pulse")}
        aria-hidden
      />
      <span className={cn("min-w-0 flex-1 truncate text-body-sm", active ? "text-ink" : "text-graphite")}>
        {s.title}
      </span>
      <span className="tnum shrink-0 text-caption text-ash">
        {new Date(s.startedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- 小组件 */

/**
 * 已归档 —— 顶栏第五枚图标钮，点开看归档列表。
 *
 * 为什么它值得一枚常驻按钮而不是折叠行：它是**回溯入口**，而顶栏那一行
 * 本来就是「全局动作」的位置，新建/搜索/自动化/出图都在那。
 *
 * **计数不藏**：非空时右上角挂数字角标。否则用户根本不知道有东西被归档了，
 * 「收进浮层」就变成了「静默藏起来」。
 */
function ArchivedMenu({
  sessions,
  activeSessionId,
  onSelectSession,
}: {
  sessions: readonly Session[];
  activeSessionId: SessionId | null;
  onSelectSession: (id: SessionId | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="已归档"
        title={`已归档 · ${sessions.length} 条`}
        className={cn(
          "relative flex h-7 w-7 items-center justify-center rounded-btn",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <Archive size={14} className="shrink-0" />
        {sessions.length > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink px-1 text-[9px] leading-none font-medium text-canvas"
            aria-hidden
          >
            {sessions.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="已归档"
          className="absolute left-0 top-full z-20 mt-1 max-h-[320px] w-56 overflow-y-auto rounded-card border border-line bg-canvas py-1 shadow-subtle"
        >
          {sessions.length === 0 ? (
            <p className="px-3 py-2 text-body-sm text-ash">归档区为空</p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                role="option"
                aria-selected={s.id === activeSessionId}
                onClick={() => {
                  onSelectSession(s.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
              >
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[s.status] ?? "bg-ash")}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="tnum shrink-0 text-caption text-ash">
                  {new Date(s.startedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 侧栏动作图标钮 —— 搜索 / 自动化 / 出图 共用。
 *
 * 三个入口的共同点：低频但需要**看得见**。所以只去掉文字（title 与
 * aria-label 保留，键盘和读屏用户不受影响），不收进浮层 ——
 * 浮层是给「偶尔才改的偏好」用的，导航入口收进去就等于藏起来了。
 */
function IconNavBtn({
  icon: Icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: typeof Search;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={hint ? `${label} · ${hint}` : label}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-btn",
        active ? "bg-teal-tint text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      <Icon size={14} className="shrink-0" />
    </button>
  );
}

/**
 * 组织方式 / 排序 —— 两项收成一枚 ⚙。
 *
 * 为什么它们配得上浮层、而上面的导航入口不配：
 * 这两个是**纯视图偏好**。用户在一次会话里几乎不改，改了也不影响「能不能
 * 找到东西」；而 4 个选项 × 两组共 6 行文字，正好把「bot | 项目」那一行
 * 挤成一片小字（原来就是 264px 侧栏里最挤的一处）。
 *
 * 当前值不丢：触发器 title 里带「组织方式：X · 排序：Y」，
 * 浮层里两组各带一行小标题，选项打勾。
 */
function ViewOptionsMenu({
  organize,
  onOrganize,
  sort,
  onSort,
}: {
  organize: Organize;
  onOrganize: (v: Organize) => void;
  sort: Sort;
  onSort: (v: Sort) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="组织方式与排序"
        title={`组织方式：${ORGANIZE_LABEL[organize]} · 排序：${SORT_LABEL[sort]}`}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-btn",
          open ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <SlidersHorizontal size={13} className="shrink-0" />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="listbox"
            aria-label="组织方式与排序"
            className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-card border border-line bg-canvas py-1 shadow-subtle"
          >
            <p className="px-3 pt-1 pb-0.5 text-caption text-ash">组织方式</p>
            {ORGANIZE_OPTIONS.map((o) => (
              <button
                key={o}
                role="option"
                aria-selected={o === organize}
                onClick={() => onOrganize(o)}
                className={cn(
                  "block w-full whitespace-nowrap px-3 py-1.5 text-left text-body-sm",
                  o === organize ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft",
                )}
              >
                {ORGANIZE_LABEL[o]}
              </button>
            ))}

            <p className="mt-1 border-t border-line-soft px-3 pt-1.5 pb-0.5 text-caption text-ash">
              排序
            </p>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o}
                role="option"
                aria-selected={o === sort}
                onClick={() => onSort(o)}
                className={cn(
                  "block w-full whitespace-nowrap px-3 py-1.5 text-left text-body-sm",
                  o === sort ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft",
                )}
              >
                {SORT_LABEL[o]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
