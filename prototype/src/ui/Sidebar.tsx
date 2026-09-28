import { useMemo, useState } from "react";
import {
  AlarmClock,
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderPlus,
  GripVertical,
  MessageCirclePlus,
  Plus,
  Search,
  Settings,
  Unplug,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectUnitSessions, type ViewMode } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { asRuntimeId, asUnitId, type Session, type UnitId, type WorkUnit } from "../core/units.ts";
import { UNAVAILABLE_UNIT } from "../adapters/mock/fixtures.ts";
import { AddBotDialog, type AddBotDraft } from "./AddBotDialog.tsx";
import { cn } from "./cn.ts";

/**
 * 左侧栏 —— 对齐 ZCode 的 `WorkspaceSidebar` 完整功能集。
 *
 * 本轮的核心原则：**功能不能因为「当前为空」就消失。**
 * ZCode 里每一项都有对应的 message id，说明它们都是常驻能力：
 *
 *   projectsSection / addProject / noProjects
 *   conversationsSection / newConversation / noConversations
 *   organize / organizeGrouped / viewByWorkspace / organizeChronologicalList
 *   sortBy / sortByUpdated / sortByCreated
 *   toggleArchivedTasks / taskGroup.newGroup / toggleAllTaskGroups
 *   reorderSection / unavailableLocalDirectory
 *
 * 之前我把这些做成了「有数据才渲染」，于是新增功能在页面上根本看不见。
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
  const [showArchived, setShowArchived] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [unitOrder, setUnitOrder] = useState<string[] | null>(null);
  const [dragUnit, setDragUnit] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [addBotOpen, setAddBotOpen] = useState(false);
  const settingsActive = useShell((s) => s.settingsOpen);

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

      {/* 顶部动作区 —— 对齐 ZCode 侧栏顶部：新建任务 → 搜索 → 自动化（无品牌行按钮）
          NewTaskButtonGroup 是 ghost 行而非实心按钮 */}
      <div className="flex flex-col gap-0.5 px-4 pb-2">
        <button
          onClick={() => useShell.getState().newTask()}
          className="flex h-8 w-full items-center gap-2 rounded-btn px-2.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <MessageCirclePlus size={14} className="shrink-0" />
          新建任务
          <span className="ml-auto font-mono text-caption text-ash">⌘N</span>
        </button>
        <button
          onClick={() => useShell.getState().setCommandOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-btn px-2.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <Search size={14} className="shrink-0" />
          搜索
          <span className="ml-auto font-mono text-caption text-ash">⌘K</span>
        </button>
        <button
          onClick={() => useShell.getState().setMainView("automations")}
          aria-pressed={mainView === "automations"}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-btn px-2.5 text-body-sm",
            mainView === "automations"
              ? "bg-teal-tint font-medium text-ink"
              : "text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          <AlarmClock size={14} className="shrink-0" />
          自动化
        </button>
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
        <div className="ml-auto flex items-center gap-1">
          <MenuButton
            label={ORGANIZE_LABEL[organize]}
            title="组织方式"
            options={ORGANIZE_OPTIONS}
            labels={ORGANIZE_LABEL}
            onChange={(v) => setOrganize(v as Organize)}
          />
          <MenuButton
            label={SORT_LABEL[sort]}
            title="排序"
            options={SORT_OPTIONS}
            labels={SORT_LABEL}
            onChange={(v) => setSort(v as Sort)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* 任务分组（ZCode: taskGroup.newGroup / toggleAllTaskGroups） */}
        <div className="mb-2 px-2">
          <button
            onClick={() => setGroupsOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 rounded-btn px-1 py-1 text-caption text-ash hover:text-graphite"
          >
            {groupsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            任务分组
            <span className="ml-auto rounded-chip bg-line-soft px-1.5 text-caption">2</span>
            <Plus size={12} className="ml-1" />
          </button>
          {groupsOpen && (
            <div className="mt-0.5 space-y-0.5">
              {[
                { name: "写作", color: "#016a71" },
                { name: "巡检", color: "#A855F7" },
              ].map((g) => (
                <button
                  key={g.name}
                  className="flex w-full items-center gap-2 rounded-btn px-2 py-1 text-left text-caption text-graphite hover:bg-line-soft"
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: g.color }} aria-hidden />
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 工作单元区（ZCode: projectsSection / reorderSection / addProject） */}
        <div className="mb-1 flex items-center gap-1 px-2">
          <p className="flex-1 text-caption text-ash">工作单元</p>
          <span className="text-caption text-ash">可拖拽排序</span>
        </div>

        {visibleUnits.length === 0 && (
          <p className="px-2 py-6 text-center text-body-sm text-ash">
            还没有{view === "bot" ? "bot" : "项目"}
          </p>
        )}

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
                  schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                />
                {active && <TaskList unitId={u.id as UnitId} sort={sort} />}
              </div>
            </div>
          );
        })}

        {/* 添加入口：bot 走高度自定义的创建对话框（核心是 AGENTS.md 岗位说明书）；
            项目保持快速新建 */}
        {view === "bot" ? (
          <button
            onClick={() => setAddBotOpen(true)}
            className="mt-1 flex w-full items-center gap-2 rounded-btn px-2 py-2 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <FolderPlus size={12} className="shrink-0" />
            添加bot
          </button>
        ) : (
          <button
            onClick={() =>
              addUnit({
                id: asUnitId(`u-new-${Date.now().toString(36)}`),
                name: "新工作单元",
                rootPath: "C:/Users/chenziyu/project/Agent/<待选目录>",
                kind: view,
                bindings: [],
                assets: { agentFiles: [], skillDirs: [] },
                tags: ["新建"],
              })
            }
            className="mt-1 flex w-full items-center gap-2 rounded-btn px-2 py-2 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <FolderPlus size={12} className="shrink-0" />
            添加项目
          </button>
        )}

        {/* 归档任务（ZCode: toggleArchivedTasks） */}
        <div className="mt-4 border-t border-line pt-2">
          <button
            onClick={() => setShowArchived((o) => !o)}
            aria-pressed={showArchived}
            className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <Archive size={12} className="shrink-0" />
            已归档
            <span className="tnum ml-auto rounded-chip bg-line-soft px-1.5 text-caption">
              {archived.length}
            </span>
            {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {showArchived &&
            (archived.length === 0 ? (
              <p className="px-2 py-2 text-caption text-ash">归档区为空</p>
            ) : (
              archived.map((s) => <SessionRow key={s.id} s={s} muted />)
            ))}
        </div>
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

      {/* 新建 bot 对话框（AGENTS.md 岗位说明书） */}
      {addBotOpen && (
        <AddBotDialog
          open
          onClose={() => setAddBotOpen(false)}
          onCreate={(draft) => {
            addUnit({
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
              bindings: [
                {
                  runtimeId: asRuntimeId(draft.runtimeId),
                  modelHint: (draft.modelHint ?? undefined) as Parameters<typeof addUnit>[0]["bindings"][number]["modelHint"],
                  primary: true,
                },
              ],
              assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
              agentsMd: draft.agentsMd,
              memory: draft.memory,
              tags: ["新建"],
              lastActiveAt: Date.now(),
            });
            setAddBotOpen(false);
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
  schedule,
}: {
  unit: WorkUnit;
  active: boolean;
  onSelect: () => void;
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
            <span className="tnum ml-auto shrink-0 text-caption text-ash">{lastActivityLabel(latest.startedAt)}</span>
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

function MenuButton({
  label,
  title,
  options,
  labels,
  onChange,
}: {
  label: string;
  title: string;
  options: readonly string[];
  labels: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-expanded={open}
        className="flex items-center gap-0.5 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
      >
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-20 mt-1 min-w-[112px] overflow-hidden rounded-btn border border-line bg-canvas py-0.5">
            {options.map((o) => (
              <button
                key={o}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full whitespace-nowrap px-3 py-1.5 text-left text-body-sm",
                  o === label ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft",
                )}
              >
                {labels[o]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
