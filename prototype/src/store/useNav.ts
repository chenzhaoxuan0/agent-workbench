import { create } from "zustand";
import { useShell, type MainView, type SettingsSectionId } from "./useShell.ts";
import { useWorkbench } from "./useWorkbench.ts";
import type { SessionId, UnitId } from "../core/units.ts";

/**
 * 任务导航历史 —— 对齐 ZCode 的 useWorkspaceTaskNavigation。
 *
 * ZCode 把历史栈放在 zustand 里，选择任务时入栈、后退时出栈。
 * 本项目的导航目标是四元组「主视图 + 设置分区 + 工作单元 + 会话」，
 * 前进/后退在它上面走，和浏览器历史同构。
 *
 * 记账用**订阅**而不是改各处 action：selectUnit / selectSession /
 * setMainView / openSettings 各自只管自己的状态变更，
 * 这里统一 diff 出「导航级变化」并入栈 —— action 层零耦合，
 * 以后新增导航入口不用记得调 pushNav。
 */

export interface NavEntry {
  readonly view: MainView;
  readonly settingsSection: SettingsSectionId;
  readonly unitId: string | null;
  readonly sessionId: string | null;
}

interface NavState {
  readonly stack: readonly NavEntry[];
  /** 栈顶指针。-1 表示空栈 */
  readonly index: number;
  back: () => void;
  forward: () => void;
}

export const useNav = create<NavState>((set, get) => ({
  stack: [],
  index: -1,

  back: () => {
    const { stack, index } = get();
    if (index <= 0) return;
    applying = true;
    try {
      applyEntry(stack[index - 1]!);
      set({ index: index - 1 });
    } finally {
      applying = false;
    }
  },

  forward: () => {
    const { stack, index } = get();
    if (index >= stack.length - 1) return;
    applying = true;
    try {
      applyEntry(stack[index + 1]!);
      set({ index: index + 1 });
    } finally {
      applying = false;
    }
  },
}));

export const canNavBack = (s: NavState): boolean => s.index > 0;
export const canNavForward = (s: NavState): boolean => s.index < s.stack.length - 1;

/* ------------------------------------------------------------- 记账 */

/** true 期间（back/forward 正在落地）订阅回调不得入栈，否则历史被打穿 */
let applying = false;

function snapshot(): NavEntry {
  const sh = useShell.getState();
  const wb = useWorkbench.getState();
  return {
    view: sh.mainView,
    settingsSection: sh.settingsSection,
    unitId: wb.activeUnitId,
    sessionId: wb.activeSessionId,
  };
}

function same(a: NavEntry, b: NavEntry): boolean {
  return (
    a.view === b.view &&
    a.settingsSection === b.settingsSection &&
    a.unitId === b.unitId &&
    a.sessionId === b.sessionId
  );
}

/** 入栈并砍掉前进分支（从历史中间跳新地方，老的未来就不作数了） */
function push(entry: NavEntry): void {
  const { stack, index } = useNav.getState();
  const cur = stack[index];
  if (cur && same(cur, entry)) return;
  useNav.setState({ stack: [...stack.slice(0, index + 1), entry], index: index + 1 });
}

/** 把一条历史落地为真实状态。直接写 store —— 与对应 action 的语义完全一致 */
function applyEntry(entry: NavEntry): void {
  useShell.setState({ mainView: entry.view, settingsSection: entry.settingsSection });
  useWorkbench.setState({
    activeUnitId: entry.unitId as UnitId,
    activeSessionId: entry.sessionId as SessionId | null,
  });
}

/**
 * 启动导航记账 + Alt+← / Alt+→ 快捷键。WorkspaceShell 挂载时调用一次。
 * 返回清理函数，与 bindShellShortcuts 同一套约定。
 */
export function bindNavRecorder(): () => void {
  // 首帧快照作为历史起点，保证第一次后退有地方可回
  push(snapshot());

  let last = snapshot();
  const maybePush = () => {
    if (applying) return;
    const cur = snapshot();
    if (same(cur, last)) return;
    last = cur;
    push(cur);
  };

  const onShell = (_s: unknown, prev: { mainView: MainView; settingsSection: SettingsSectionId }) => {
    const s = useShell.getState();
    if (s.mainView !== prev.mainView || s.settingsSection !== prev.settingsSection) maybePush();
  };
  const onWorkbench = (_s: unknown, prev: { activeUnitId: UnitId; activeSessionId: SessionId | null }) => {
    const s = useWorkbench.getState();
    if (s.activeUnitId !== prev.activeUnitId || s.activeSessionId !== prev.activeSessionId) maybePush();
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    // Alt+←/→ 与 ZCode 的 Cmd/Ctrl+[ / ] 同走任务导航历史
    if (e.altKey && !mod) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        useNav.getState().back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        useNav.getState().forward();
      }
      return;
    }
    if (mod && !e.altKey) {
      if (e.key === "[") {
        e.preventDefault();
        useNav.getState().back();
      } else if (e.key === "]") {
        e.preventDefault();
        useNav.getState().forward();
      }
    }
  };

  window.addEventListener("keydown", onKey);
  const unShell = useShell.subscribe(onShell);
  const unWorkbench = useWorkbench.subscribe(onWorkbench);
  return () => {
    window.removeEventListener("keydown", onKey);
    unShell();
    unWorkbench();
  };
}
