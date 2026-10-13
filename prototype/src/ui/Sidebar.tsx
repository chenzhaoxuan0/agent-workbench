import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlarmClock,
  Bot,
  ChevronLeft,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  ImagePlus,
  ListTodo,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useWorkbench, type ViewMode, type BotWriteGuards } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { useAppearance } from "../store/useAppearance.ts";
import type { AvatarFrame } from "../core/appearance.ts";
import { formatRelative } from "../core/automation.ts";
import { dispatchTerminal, fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import {
  asModelId,
  asRuntimeId,
  asUnitId,
  type UnitId,
  type WorkUnit,
  isResidentUnit,
  isSyntheticUnit,
} from "../core/units.ts";

export { isResidentUnit, isSyntheticUnit };
import { AddBotDialog, type AddBotDraft } from "./AddBotDialog.tsx";
import { ImportBotDialog } from "./ImportBotDialog.tsx";
import { ChannelMark, channelIdentityLabel } from "./ChannelMark.tsx";
import { HistoryDialog, resumeArgsFor } from "./HistoryDialog.tsx";
import { executorIconSrc } from "./executorIcon.ts";
import { RotateCcw } from "lucide-react";
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

const VIEWS: readonly { id: ViewMode; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "bot", icon: Bot },
  { id: "project", label: "项目", icon: FolderGit2 },
];


export function Sidebar() {
  const units = useWorkbench((s) => s.units);
  const view = useWorkbench((s) => s.view);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const setView = useWorkbench((s) => s.setView);
  const selectUnit = useWorkbench((s) => s.selectUnit);
  /** 历史子列表的手风琴态：整个 bot 行可点，一次只展开一个（null = 全收起） */
  const [historyUnitId, setHistoryUnitId] = useState<string | null>(null);
  const addUnit = useWorkbench((s) => s.addUnit);
  const mainView = useShell((s) => s.mainView);

  const [unitOrder, setUnitOrder] = useState<string[] | null>(null);
  const [dragUnit, setDragUnit] = useState<string | null>(null);
  /** 拖拽悬停的分区（常驻/普通）——drop zone 高亮用 */
  const [zoneHover, setZoneHover] = useState<"resident" | "normal" | null>(null);
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

  const allUnits = units;

  // 常驻 / 普通两节：常驻节顺序跟定义走（总管最前）；普通节保持既有
  // steward 置顶习惯（历史 unitOrder 可能引用它）+ 用户拖拽排序
  const { residentUnits, normalUnits } = useMemo(() => {
    const residents: WorkUnit[] = [];
    const normals: WorkUnit[] = [];
    for (const u of allUnits) (isResidentUnit(u) ? residents : normals).push(u);
    const stewardFirst = (list: WorkUnit[]): WorkUnit[] =>
      [...list].sort((a, b) => {
        const as = a.id === "steward" || (a.tags ?? []).includes("steward");
        const bs = b.id === "steward" || (b.tags ?? []).includes("steward");
        return as === bs ? 0 : as ? -1 : 1;
      });
    const orderedNormals = unitOrder
      ? stewardFirst(normals).sort(
          (a, b) => (unitOrder.indexOf(a.id) + 1 || 99) - (unitOrder.indexOf(b.id) + 1 || 99),
        )
      : stewardFirst(normals);
    return { residentUnits: stewardFirst(residents), normalUnits: orderedNormals };
  }, [allUnits, unitOrder]);

  /** 拖进常驻区：普通 bot 升为常驻（resident 写穿 bot.json，冲突由 updateUnit 回滚并抛） */
  const makeResident = (u: WorkUnit): void => {
    void updateUnit({ ...u, resident: true }, guardsOf(u)).catch((err: unknown) =>
      console.warn("[Sidebar] 拖入常驻失败（盘上已被外部修改？重新进入后再试）", err),
    );
  };

  /** 移出常驻区：取消常驻（resident: false 写穿 bot.json） */
  const makeNormal = (u: WorkUnit): void => {
    void updateUnit({ ...u, resident: false }, guardsOf(u)).catch((err: unknown) =>
      console.warn("[Sidebar] 取消常驻失败（盘上已被外部修改？重新进入后再试）", err),
    );
  };

  const onDropZone = (zone: "resident" | "normal"): void => {
    const id = dragUnit;
    setZoneHover(null);
    setDragUnit(null);
    if (id === null) return;
    const u = allUnits.find((x) => x.id === id);
    if (u === undefined) return;
    if (zone === "resident" && !isResidentUnit(u)) makeResident(u);
    if (zone === "normal" && isResidentUnit(u)) makeNormal(u);
    // 普通 bot 落普通区 = 区内排序，由行级 onDrop 处理，这里不重复
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-rail">
      {/* 顶部 48px 区域：在出图/自动化时顶掉 A 标渲染返回工作台；在正常对话时渲染 A 图标与全局独立动作 */}
      {mainView !== "chat" ? (
        <div className="flex h-12 shrink-0 items-center border-b border-line/60 px-2.5">
          <button
            onClick={() => useShell.getState().setMainView("chat")}
            className="flex h-8 w-full items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 text-body-sm font-medium text-teal transition hover:bg-teal/15"
          >
            <ChevronLeft size={14} />
            <span>返回工作台</span>
          </button>
        </div>
      ) : (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line/60 px-2.5">
          {/* 侧栏开关：新品牌 icon ↔ 收起图标 hover 变形 */}
          <button
            onClick={() => useShell.getState().toggleSidebar()}
            aria-label="收起侧栏"
            title="收起侧栏 · ⌘B"
            className="group relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <img
              src="/icon.png"
              alt="A"
              className="h-5 w-5 rounded-sm object-cover transition-opacity duration-150 group-hover:opacity-0"
            />
            <PanelLeftClose
              size={14}
              className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
          </button>

          {/* 全局动作区：新建会话 / 搜索 / 自动化 / 出图 */}
          <div className="flex items-center gap-0.5">
            <IconNavBtn
              icon={Search}
              label="搜索"
              hint="⌘K"
              onClick={() => useShell.getState().setCommandOpen(true)}
            />
            <IconNavBtn
              icon={AlarmClock}
              label="自动化"
              onClick={() => useShell.getState().setMainView("automations")}
            />
            <IconNavBtn
              icon={ListTodo}
              label="待办"
              onClick={() => useShell.getState().setMainView("backlog")}
            />
            <IconNavBtn
              icon={ImagePlus}
              label="出图"
              onClick={() => useShell.getState().setMainView("image")}
            />
            <IconNavBtn
              icon={Settings}
              label="设置"
              hint="⌘,"
              active={settingsActive}
              onClick={() => useShell.getState().openSettings()}
            />
          </div>
        </div>
      )}

      {/* Agent 智能体列表标题行 —— h-9 与右侧终端工具栏同高，横向对齐 */}
      <div className="flex h-9 shrink-0 items-center justify-between px-2.5">
        <div className="flex items-center gap-1 min-w-0">
          <Bot size={13} className="text-teal shrink-0" />
          <span className="text-caption font-medium text-ink truncate">Agent</span>
          <span className="tnum text-[11px] text-ash shrink-0">({allUnits.length})</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => useShell.getState().openImportBot()}
            aria-label="认领已有目录"
            title="认领已有目录为 Agent（文件夹留在原地，自动探测 AGENTS.md）"
            className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <FolderOpen size={11} />
            <span>认领</span>
          </button>
          <button
            onClick={() => useShell.getState().openAddBot()}
            aria-label="新建 Agent"
            title="新建 Agent"
            className="flex items-center gap-0.5 rounded-btn bg-ink px-1.5 py-0.5 text-caption font-medium text-canvas hover:opacity-90 active:scale-95 transition"
          >
            <Plus size={11} />
            <span>新建</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* 空态引导卡 */}
        {allUnits.length === 0 && (
          <button
            onClick={() => useShell.getState().openAddBot()}
            className="flex w-full flex-col items-center gap-1.5 rounded-input border border-dashed border-line px-3 py-6 text-center hover:bg-line-soft"
          >
            <FolderPlus size={18} className="text-ash" />
            <span className="text-body-sm font-medium text-graphite">还没有 Agent</span>
            <span className="text-caption text-ash">新建第一个 Agent，从 AGENTS.md 岗位说明书开始</span>
          </button>
        )}

        {/* 常驻节：总管/心跳/用户拖入的后台服务型 bot。整节是「升为常驻」的 drop zone */}
        {residentUnits.length > 0 && (
          <section
            aria-label="常驻 Agent"
            onDragOver={(e) => {
              e.preventDefault();
              if (dragUnit !== null) setZoneHover("resident");
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setZoneHover((z) => (z === "resident" ? null : z));
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDropZone("resident");
            }}
            className={cn(
              "rounded-input transition-colors",
              zoneHover === "resident" && dragUnit !== null && "bg-teal-tint/50 ring-1 ring-inset ring-teal/40",
            )}
          >
            {zoneHover === "resident" && dragUnit !== null && (
              <p className="px-1.5 pb-0.5 pt-1 text-[10px] text-teal">松手设为常驻</p>
            )}
            {residentUnits.map((u) => {
              const active = u.id === activeUnitId;
              const isSynthetic = isSyntheticUnit(u);
              return (
                <div
                  key={u.id}
                  draggable
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement).closest("button, a, input, [data-no-drag]")) {
                      e.preventDefault();
                      return;
                    }
                    setDragUnit(u.id);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={() => {
                    setDragUnit(null);
                    setZoneHover(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDropZone("resident");
                  }}
                  className={cn("mb-1", dragUnit === u.id && "opacity-40")}
                >
                  <UnitRow
                    unit={u}
                    active={active}
                    onSelect={() => selectUnit(u.id as UnitId)}
                    onOpenSettings={() => useShell.getState().openUnitSettings(u.id as UnitId)}
                    onToggleResident={() => makeNormal(u)}
                    isResident={true}
                    schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                    historyOpen={historyUnitId === u.id}
                    onToggleHistory={() => setHistoryUnitId(historyUnitId === u.id ? null : u.id)}
                  />
                </div>
              );
            })}
          </section>
        )}

        {/* 分割线：常驻与普通 bot 的分界 */}
        {residentUnits.length > 0 && normalUnits.length > 0 && (
          <div className="my-2 flex items-center gap-2 px-1" aria-hidden>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {/* 普通节：既是常驻 bot 的「取消常驻」drop zone，区内行间拖拽排序照旧 */}
        <section
          aria-label="Agent 列表"
          onDragOver={(e) => {
            e.preventDefault();
            const dragged = allUnits.find((x) => x.id === dragUnit);
            if (dragUnit !== null && isResidentUnit(dragged) && !isSyntheticUnit(dragged)) {
              setZoneHover("normal");
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setZoneHover((z) => (z === "normal" ? null : z));
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDropZone("normal");
          }}
          className={cn(
            "min-h-16 rounded-input transition-colors",
            zoneHover === "normal" && dragUnit !== null && "bg-teal-tint/50 ring-1 ring-inset ring-teal/40",
          )}
        >
          {zoneHover === "normal" && dragUnit !== null && (
            <p className="px-1.5 pb-0.5 pt-1 text-[10px] text-teal">松手取消常驻</p>
          )}
          {normalUnits.map((u) => {
            const active = u.id === activeUnitId;
            const unitId = u.id as UnitId;
            return (
              <div
                key={u.id}
                draggable
                onDragStart={(e) => {
                  if ((e.target as HTMLElement).closest("button, a, input, [data-no-drag]")) {
                    e.preventDefault();
                    return;
                  }
                  setDragUnit(u.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                // 拖到列表空白处 / 按 Esc 取消时不会触发 drop：
                // 没有 onDragEnd 的话 dragUnit 一直留着，那一行会永久停在 opacity-40
                onDragEnd={() => {
                  setDragUnit(null);
                  setZoneHover(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragUnit && dragUnit !== unitId) {
                    const order = normalUnits.map((x) => x.id as string);
                    const from = order.indexOf(dragUnit);
                    if (from < 0) {
                      // 拖的是常驻 bot：落到普通区某行上，降级为普通 bot
                      onDropZone("normal");
                      return;
                    }
                    const to = order.indexOf(unitId);
                    order.splice(to, 0, ...order.splice(from, 1));
                    setUnitOrder(order);
                  }
                  setDragUnit(null);
                  setZoneHover(null);
                }}
                className={cn("group/u mb-1", dragUnit === u.id && "opacity-40")}
              >
                <UnitRow
                  unit={u}
                  active={active}
                  onSelect={() => selectUnit(u.id as UnitId)}
                  onOpenSettings={() => useShell.getState().openUnitSettings(u.id as UnitId)}
                  onToggleResident={() => makeResident(u)}
                  isResident={false}
                  schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                  historyOpen={historyUnitId === u.id}
                  onToggleHistory={() => setHistoryUnitId(historyUnitId === u.id ? null : u.id)}
                />
              </div>
            );
          })}
        </section>
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
                  resident: draft.resident,
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
                  avatar: draft.avatar,
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
                resident: draft.resident ?? false,
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
                avatar: draft.avatar,
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
            useWorkbench.setState((s) => ({ units: [...s.units, unit], activeUnitId: unit.id }));
          }}
        />
      )}
    </div>
  );
}

/**
 * 打开设置页那一刻的盘上真值 → 保存时当乐观锁基线。
 * revision 抓「另一个窗口/别的设备改过 bot.json」，agentsMd hash 抓「用户在 VS Code
 * 里改了 AGENTS.md」。两者任一不符 daemon 就拒写，由对话框让用户选谁赢。
 */
function guardsOf(u: WorkUnit): BotWriteGuards {
  return { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash };
}

/* ------------------------------------------------------------- 单元行 */

/**
 * bot 头像的身份色 —— 颜色是**身份数据**（与执行器徽标的 accent 同类例外），
 * 不是 UI 装饰；由单元名哈希出稳定颜色，同一个 bot 永远长一样。
 * 外框**全员统一**（圆角档=正圆，方形档=无圆角），个性化交给自定义头像本身。
 */
const BOT_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#6366f1"];

export function botAvatarStyle(name: string, frame: AvatarFrame = "rounded"): { color: string; shape: string } {
  const hash = [...name].reduce((a, c) => a + c.codePointAt(0)!, 0);
  return {
    color: BOT_COLORS[hash % BOT_COLORS.length]!,
    shape: frame === "square" ? "rounded-none" : "rounded-full",
  };
}

function UnitRow({
  unit,
  active,
  onSelect,
  onOpenSettings,
  onToggleResident,
  isResident,
  schedule,
  historyOpen,
  onToggleHistory,
}: {
  unit: WorkUnit;
  active: boolean;
  onSelect: () => void;
  onOpenSettings: () => void;
  onToggleResident?: () => void;
  isResident?: boolean;
  schedule?: string;
  /** 行下历史子列表是否展开（手风琴：Sidebar 持有，一次只开一个） */
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const isSynthetic = isSyntheticUnit(unit);
  const units = useWorkbench((s) => s.units);
  /** 历史详情弹窗（子列表条目点开看对话用；focusKey 预展开点进来的那条） */
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyFocus, setHistoryFocus] = useState<string | undefined>(undefined);
  const [histEntries, setHistEntries] = useState<readonly UnitHistoryEntry[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  /** 历史列表分页：每轮显示 6 条，超过 6 条折叠成「更多」 */
  const [visibleCount, setVisibleCount] = useState(6);

  useEffect(() => {
    if (!historyOpen) setVisibleCount(6);
  }, [historyOpen]);

  // 展开时拉最近执行记录，且**开着期间保持实时**：派发终端的 created/exit 帧、
  // 会话起止事件都会改写历史（新条目出现 / 状态收口），命中即去抖重拉；
  // 30s 轮询兜底覆盖其余路径（如待办状态迁移、别处触发的派发）。
  useEffect(() => {
    if (!historyOpen) return;
    let alive = true;
    const load = (): void => {
      if (!alive) return;
      setHistErr(null);
      void fetchUnitHistory(unit.id, 100)
        .then((list) => {
          if (alive) setHistEntries(list);
        })
        .catch((e: unknown) => {
          if (alive) setHistErr(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = (): void => {
      if (!alive) return;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(load, 300);
    };
    const poll = setInterval(load, 30_000);
    const cleanupFns: Array<() => void> = [];
    void (async () => {
      const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      if (!alive) return;
      const client = DaemonClient.get(defaultDaemonEndpoint());
      const unsubFrame = client.onTerminalFrame((f) => {
        if (f.kind === "created" || f.kind === "exit") scheduleLoad();
      });
      const unsubEvent = client.onEvent((e) => {
        if (e.type === "session.started" || e.type === "session.ended") scheduleLoad();
      });
      cleanupFns.push(() => {
        unsubFrame();
        unsubEvent();
      });
    })();
    return () => {
      alive = false;
      clearInterval(poll);
      if (debounce !== null) clearTimeout(debounce);
      for (const fn of cleanupFns) fn();
    };
  }, [historyOpen, unit.id]);
  // ZCode: unavailableLocalDirectory —— 路径不可用要显式说出来，不能当成正常单元
  // **兜底 ?? []**：bot.json 是手可编辑的（见 useWorkbench 的合并守卫注释），
  // 一个字段缺失不该让整个界面白屏。管家 bot 一度就因为没写 tags 把整页搞崩了。
  const unavailable = (unit.tags ?? []).includes("目录不可用");
  // 只数启用的渠道：声明了但停用的不算「找得到我」
  // 飞书要**逐账号**画标记——一个 bot 可以挂几个飞书机器人，合并成一个图标
  // 就又回到「看不出是哪个」了
  const enabledChannels = (unit.channels ?? [])
    .filter((c) => c.enabled === true)
    .map((c) => ({
      kind: c.kind,
      label: c.kind === "feishu" ? "飞书" : c.kind === "telegram" ? "Telegram" : c.kind === "webhook" ? "Webhook" : c.kind,
      profiles:
        c.kind === "feishu"
          ? (c.accounts ?? []).map((a) => (a.profile ?? "").trim()).filter((p) => p !== "")
          : ([] as readonly string[]),
    }));
  // 「哪个 bot 接的是哪个飞书机器人」——头像 + 应用名。这是这枚标记存在的全部理由
  const identities = useWorkbench((s) => s.channelIdentity);
  const isBot = unit.kind === "bot";

  // 副标题：身份角色，缺省回落到路径
  const subtitle = unit.identity?.role ?? "";
  const avatarFrame = useAppearance((st) => st.avatarFrame);
  const avatar = botAvatarStyle(unit.name, avatarFrame);

  return (
    // 整行是 button，button 里再套 button 是非法 HTML —— 设置入口做成
    // 绝对定位的兄弟节点，和时间戳抢同一个位置、hover 时交叉淡入淡出。
    <div className="group/row relative">
      <button
        onClick={() => {
          onSelect();
          onToggleHistory();
        }}
        aria-current={active}
        aria-expanded={historyOpen}
        title={`${unit.name} —— 点击选中并${historyOpen ? "收起" : "展开"}历史会话`}
        className={cn(
          "flex w-full items-start gap-2 rounded-input px-2 py-1.5 text-left",
          active ? "bg-teal-tint" : "hover:bg-line-soft",
          unavailable && "opacity-60",
        )}
      >
        {isBot ? (
          /* 自定义头像优先；缺省是彩色底 + 双眼（GrokBot 式吉祥物形态），右下角日程角标 */
          <span
            aria-hidden
            className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden", avatar.shape)}
            style={unit.avatar ? undefined : { background: avatar.color }}
          >
            {unit.avatar ? (
              <img src={unit.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="mt-0.5 flex gap-0.5">
                <span className="h-1.5 w-0.5 rounded-full bg-white/90" />
                <span className="h-1.5 w-0.5 rounded-full bg-white/90" />
              </span>
            )}
            {schedule && (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-rail bg-teal"
                title={schedule}
              />
            )}
          </span>
        ) : (
          /* 项目保持方形字母文件夹标 */
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-line-soft text-body-sm font-medium text-graphite"
          >
            {unit.name.slice(0, 1)}
          </span>
        )}

        <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-body-sm font-medium text-ink">{unit.name}</span>
            {/* 渠道徽标 */}
            {enabledChannels.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10px] text-ash"
                title={enabledChannels
                  .map((c) => {
                    if (c.profiles.length === 0) return `已接渠道：${c.label}`;
                    return c.profiles
                      .map((p) => channelIdentityLabel(c.label, identities[p], p))
                      .join("；");
                  })
                  .join("；")}
              >
                {enabledChannels.map((c, ci) =>
                  c.profiles.length === 0 ? (
                    <ChannelMark key={`${c.kind}-${ci}`} kind={c.kind} label={c.label} />
                  ) : (
                    c.profiles.map((p, pi) => (
                      <ChannelMark
                        key={`${c.kind}-${ci}-${pi}`}
                        kind={c.kind}
                        identity={identities[p]}
                        label={channelIdentityLabel(c.label, identities[p], p)}
                      />
                    ))
                  ),
                )}
              </span>
            )}
          </span>
          <span className="truncate text-[11px] text-graphite">
            {subtitle || <span className="text-ash">{unit.rootPath}</span>}
          </span>
          {unavailable && (
            <span className="mt-0.5 w-fit rounded-chip bg-loss/10 px-1 py-0.2 text-[10px] text-loss">目录不可用</span>
          )}
        </span>
      </button>

      {/* 历史子列表：bot 行下的可折叠执行时间轴（最近若干条，点条目进对话详情） */}
      {historyOpen && (
        <div data-no-drag draggable={false} onMouseDown={(e) => e.stopPropagation()} className="ml-6 space-y-px border-l border-line-soft py-1 pl-2">
          {histErr !== null && <p className="px-1.5 py-1 text-[10px] text-loss">读取失败：{histErr}</p>}
          {histEntries === null && histErr === null && <p className="px-1.5 py-1 text-[10px] text-ash">加载中…</p>}
          {histEntries !== null && histEntries.length === 0 && (
            <p className="px-1.5 py-1 text-[10px] text-ash">还没有执行记录 —— 自动化、待办或会话跑过之后出现在这里</p>
          )}
          {histEntries?.slice(0, visibleCount).map((e) => {
            const args = resumeArgsFor(e.runtimeId, e.resumeRef);
            const self = units.find((u) => u.id === unit.id);
            return (
              <HistoryListRow
                key={e.key}
                entry={e}
                onOpenDetail={() => {
                  setHistoryFocus(e.key);
                  setHistoryDialogOpen(true);
                }}
                {...(args !== null && self !== undefined
                  ? {
                      onResume: () => {
                        useWorkbench.getState().selectUnit(asUnitId(unit.id));
                        void dispatchTerminal({
                          unitId: unit.id,
                          unitName: self.name,
                          rootPath: self.rootPath,
                          runtimeId: e.runtimeId,
                          args,
                        }).catch((err: unknown) => console.error("[Sidebar] TUI 恢复失败:", err));
                      },
                    }
                  : {})}
              />
            );
          })}
          {histEntries !== null && histEntries.length > visibleCount && (
            <button
              type="button"
              data-no-drag
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                setVisibleCount((v) => v + 6);
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-btn px-1.5 py-1 text-left text-[10px] text-ash transition hover:bg-line-soft hover:text-graphite"
            >
              <span>更多（展开后 {Math.min(6, histEntries.length - visibleCount)} 条…）</span>
              <span className="text-[9px] text-ash/70">剩余 {histEntries.length - visibleCount} 条</span>
            </button>
          )}
          {histEntries !== null && histEntries.length > 6 && histEntries.length <= visibleCount && (
            <button
              type="button"
              data-no-drag
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                setHistoryFocus(undefined);
                setHistoryDialogOpen(true);
              }}
              className="w-full cursor-pointer rounded-btn px-1.5 py-1 text-left text-[10px] text-ash hover:bg-line-soft hover:text-graphite"
            >
              查看完整历史对话详情 →
            </button>
          )}
        </div>
      )}

      {/* 悬浮快捷操作：常驻 / 设置（历史切换整行可点，不占这里；打开目录统一走头部的工作区路径弹层） */}
      <div
        data-no-drag
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-btn bg-canvas/95 p-0.5 shadow-xs opacity-0 backdrop-blur-xs transition hover:opacity-100 focus-within:opacity-100 group-hover/row:opacity-100 cursor-default"
      >
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (onToggleResident) onToggleResident();
          }}
          aria-label={
            isResident
              ? `取消 ${unit.name} 常驻`
              : `设为 ${unit.name} 常驻`
          }
          title={
            isResident
              ? "取消常驻（移回下方列表）"
              : "设为常驻（固定在顶部）"
          }
          className={cn(
            "rounded-btn p-1 transition cursor-pointer active:scale-90",
            isResident
              ? "text-teal hover:bg-teal-tint/60"
              : "text-ash hover:bg-line-soft hover:text-ink",
          )}
        >
          <Pin
            size={12}
            className={cn(isResident && "fill-teal text-teal rotate-45")}
          />
        </button>
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          aria-label={`${unit.name} 设置`}
          title="设置 —— 改 AGENTS.md、人设、主执行器"
          className="cursor-pointer rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
        >
          <Settings size={12} />
        </button>
      </div>

      {historyDialogOpen && (
        <HistoryDialog unitId={unit.id} unitName={unit.name} focusKey={historyFocus} onClose={() => setHistoryDialogOpen(false)} />
      )}
    </div>
  );
}

/** 历史子列表的单行：状态点 + 类型 + 标题 + 相对时间；点开进对话详情弹窗。
 *  可恢复的条目（zcode/claude/codex 后台会话）行尾带 ⟲ 图标，点击即在 TUI 重现。 */
function HistoryListRow({
  entry,
  onOpenDetail,
  onResume,
}: {
  entry: UnitHistoryEntry;
  onOpenDetail: () => void;
  onResume?: () => void;
}): ReactElement {
  const kindLabel = entry.kind === "automation" ? "定时" : entry.kind === "backlog" ? "待办" : entry.kind === "manual" ? "手动" : "会话";
  const dot =
    entry.status === "failed"
      ? "bg-loss"
      : entry.status === "running"
        ? "bg-blue-500 animate-pulse"
        : entry.status === "skipped"
          ? "bg-ash"
          : "bg-gain";
  const iconSrc = executorIconSrc(entry.runtimeId);
  const bareExec = entry.runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");

  return (
    <button
      type="button"
      data-no-drag
      draggable={false}
      onClick={onOpenDetail}
      title={`${kindLabel} · ${entry.runtimeId}${entry.launchMode === "terminal" ? " · TUI" : " · 后台"}${entry.detail !== null && entry.detail !== "" ? `\n${entry.detail}` : ""}\n${entry.title}\n点击查看对话详情`}
      className="group/hrow flex w-full cursor-pointer items-center gap-1.5 rounded-btn px-1.5 py-1 text-left transition hover:bg-line-soft"
    >
      {/* 执行器图标：有官方 logo 显示品牌图片，无则显示 2 字母徽标 */}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title={`执行器：${entry.runtimeId}`}>
        {iconSrc ? (
          <img src={iconSrc} alt={entry.runtimeId} className="h-3.5 w-3.5 object-contain" />
        ) : (
          <span className="flex h-3 w-3 items-center justify-center rounded-[2px] bg-line-soft text-[8px] font-semibold uppercase text-ash">
            {bareExec.slice(0, 2)}
          </span>
        )}
      </span>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="shrink-0 text-[10px] text-ash">{kindLabel}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-graphite">{entry.title}</span>
      <span className="shrink-0 text-[10px] text-ash">{formatRelative(entry.startedAt)}</span>
      {onResume !== undefined && (
        <span
          role="button"
          tabIndex={0}
          data-no-drag
          onClick={(ev) => {
            ev.stopPropagation();
            onResume();
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.stopPropagation();
              onResume();
            }
          }}
          title={`在 TUI 中重现这段会话（${entry.runtimeId} resume）`}
          className="shrink-0 cursor-pointer rounded p-0.5 text-ash opacity-0 transition hover:bg-teal-tint hover:text-teal group-hover/hrow:opacity-100"
        >
          <RotateCcw size={10} />
        </span>
      )}
    </button>
  );
}


/* ------------------------------------------------------------- 小组件 */


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

