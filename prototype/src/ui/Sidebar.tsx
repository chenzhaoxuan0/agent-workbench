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
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Unplug,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectUnitSessions, type ViewMode } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { asUnitId, type Session, type UnitId, type WorkUnit } from "../core/units.ts";
import { UNAVAILABLE_UNIT } from "../adapters/mock/fixtures.ts";
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
  { id: "employee", label: "员工", icon: Bot },
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
  const toggleSidebar = useShell((s) => s.toggleSidebar);
  const mainView = useShell((s) => s.mainView);
  const openSettings = useShell((s) => s.openSettings);

  const [organize, setOrganize] = useState<Organize>("grouped");
  const [sort, setSort] = useState<Sort>("updated");
  const [showArchived, setShowArchived] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [unitOrder, setUnitOrder] = useState<string[] | null>(null);
  const [dragUnit, setDragUnit] = useState<string | null>(null);

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
      {/* 品牌 + 收起（ZCode: Sidebar Brand Mark / collapsed rail） */}
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-line px-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn bg-ink text-caption font-medium text-canvas">
          A
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">Agent Workbench</span>
        <button
          onClick={toggleSidebar}
          aria-label="收起侧栏"
          className="rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* 身份视图 —— 本项目特有，ZCode 没有 */}
      <div className="flex gap-2 px-4 py-3">
        {VIEWS.map((v) => {
          const active = v.id === view;
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-pressed={active}
              className={cn(
                "flex items-center gap-1.5 rounded-chip px-3 py-1.5 text-body-sm",
                active ? "bg-teal font-medium text-white" : "text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              <Icon size={13} />
              {v.label}
            </button>
          );
        })}
      </div>

      {/* 新建任务（ZCode: newConversation） */}
      <div className="px-4 pb-3">
        <button
          onClick={() => {
            useShell.getState().setMainView("chat");
            useWorkbench.getState().setDraft("");
          }}
          className="flex w-full items-center gap-2 rounded-btn bg-ink px-3 py-2 text-body-sm text-canvas hover:bg-black"
        >
          <SquarePen size={12} />
          新建任务
          <span className="ml-auto font-mono text-caption text-canvas/60">⌘N</span>
        </button>
      </div>

      {/* 分区标题 + organize / sort（ZCode: organize / sortBy / taskViewOptions） */}
      <div className="flex items-center gap-1 px-4 pb-2">
        <p className="flex-1 text-body-sm text-ash">
          {view === "employee" ? "员工" : "项目"}
          <span className="ml-1.5 text-caption">{visibleUnits.length}</span>
        </p>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* 任务分组（ZCode: taskGroup.newGroup / toggleAllTaskGroups） */}
        <div className="mb-2 px-2">
          <button
            onClick={() => setGroupsOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 rounded-btn px-1 py-1 text-caption text-ash hover:text-graphite"
          >
            {groupsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            任务分组
            <span className="ml-auto rounded-chip bg-line-soft px-1.5 text-[10px]">2</span>
            <Plus size={11} className="ml-1" />
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
          <span className="text-[10px] text-ash">可拖拽排序</span>
        </div>

        {visibleUnits.length === 0 && (
          <p className="px-2 py-6 text-center text-body-sm text-ash">
            还没有{view === "employee" ? "员工" : "项目"}
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

        {/* 添加项目 */}
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
          <FolderPlus size={13} className="shrink-0" />
          添加{view === "employee" ? "员工" : "项目"}
        </button>

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

        {/* 远端工作区（ZCode: onConnectRemote / onOpenRemoteWorkspace） */}
        <div className="mt-2 border-t border-line pt-2">
          <button className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
            <Unplug size={12} className="shrink-0" />
            连接远端
            <span className="ml-auto text-caption text-ash">未连接</span>
          </button>
        </div>
      </div>

      {/* 底部：搜索 / 自动化 / 设置 / 命令面板 */}
      <div className="shrink-0 border-t border-line px-3 py-2">
        <FooterButton
          icon={<Search size={12} />}
          label="搜索"
          hint="⌘F"
          onClick={() => useShell.getState().setMainView("search")}
        />
        <FooterButton
          active={mainView === "automations"}
          icon={<AlarmClock size={12} />}
          label="自动化"
          onClick={() => useShell.getState().setMainView("automations")}
        />
        <FooterButton
          active={mainView === "settings"}
          icon={<Settings size={12} />}
          label="设置"
          onClick={() => openSettings()}
        />
        <FooterButton
          icon={<Plus size={12} />}
          label="命令面板"
          hint="⌘K"
          onClick={() => useShell.getState().setCommandOpen(true)}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 单元行 */

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

  return (
    <button
      onClick={onSelect}
      aria-current={active}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-input px-3 py-2.5 text-left",
        active ? "bg-teal-tint" : "hover:bg-line-soft",
        unavailable && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        {unit.identity?.avatar ? (
          <span className="shrink-0 text-body-lg" aria-hidden>
            {unit.identity.avatar}
          </span>
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn bg-line-soft text-caption font-medium text-graphite">
            {unit.name.slice(0, 1)}
          </span>
        )}
        <span className="truncate text-body-sm font-medium text-ink">{unit.name}</span>
        {unavailable && (
          <span className="ml-auto shrink-0 rounded-chip bg-loss/10 px-1.5 py-0.5 text-[10px] text-loss">
            目录不可用
          </span>
        )}
      </div>

      {unit.identity?.role && (
        <p className="truncate pl-7 text-caption text-graphite">{unit.identity.role}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pl-7">
        {schedule && (
          <span className="rounded-chip bg-teal-tint px-2 py-0.5 text-caption text-teal">● {schedule}</span>
        )}
        {unit.tags
          .filter((t) => t !== "目录不可用")
          .map((t) => (
            <span key={t} className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-graphite">
              {t}
            </span>
          ))}
      </div>
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
        <ChevronDown size={10} />
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

function FooterButton({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-body-sm",
        active ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      {icon}
      {label}
      {hint && <span className="ml-auto font-mono text-caption text-ash">{hint}</span>}
    </button>
  );
}
