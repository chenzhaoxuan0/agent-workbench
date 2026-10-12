import { create } from "zustand";
import { terminalSessionRegistry } from "./TerminalSessionManager.ts";

export type SplitDirection = "horizontal" | "vertical"; // horizontal = 左右 (row), vertical = 上下 (col)

export type LayoutNode =
  | {
      type: "leaf";
      instanceId: string;
    }
  | {
      type: "branch";
      id: string;
      direction: SplitDirection;
      first: LayoutNode;
      second: LayoutNode;
      ratio: number; // 0.1 ~ 0.9, 默认 0.5
    };

export interface TerminalProfile {
  id: string;
  name: string;
  shell: string;
  icon: "pwsh" | "powershell" | "cmd" | "wsl" | "bash";
  args?: string[];
}

export const SUPPORTED_TERMINAL_PROFILES: TerminalProfile[] = [
  { id: "pwsh", name: "PowerShell 7", shell: "pwsh.exe", icon: "pwsh" },
  { id: "powershell", name: "Windows PowerShell", shell: "powershell.exe", icon: "powershell" },
  { id: "cmd", name: "Command Prompt", shell: "cmd.exe", icon: "cmd" },
  { id: "wsl", name: "WSL (Linux)", shell: "wsl.exe", icon: "wsl" },
  { id: "bash", name: "Git Bash", shell: "bash.exe", icon: "bash" },
];

export interface TerminalInstanceItem {
  id: string;
  title: string;
  shell: string;
  profileId: string;
  icon: string;
  cwd: string;
  executorId?: string;
  /** 所属 bot（终端跟随 bot：切换 bot 时激活它的专属标签页） */
  unitId?: string;
  createdAt: number;
  /** 重挂（F5 找回 daemon 存活 PTY）时的一次性回放快照；新建标签没有它 */
  attachScrollback?: string;
  /** 来自重挂 —— 背后是活进程，不是占位标签，不许被「换 bot 专属标签」的启发式顺手关掉 */
  reattached?: boolean;
}

export interface TerminalTabGroup {
  id: string;
  title?: string;
  rootLayout: LayoutNode;
}

/** 递归获取树中所有 leaf 的 instanceId */
export function collectLeafIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.instanceId];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/** 递归拆分指定 leaf */
export function splitTreeNode(
  node: LayoutNode,
  targetId: string,
  newId: string,
  direction: SplitDirection,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.instanceId === targetId) {
      return {
        type: "branch",
        id: `br_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`,
        direction,
        first: { type: "leaf", instanceId: targetId },
        second: { type: "leaf", instanceId: newId },
        ratio: 0.5,
      };
    }
    return node;
  }
  return {
    ...node,
    first: splitTreeNode(node.first, targetId, newId, direction),
    second: splitTreeNode(node.second, targetId, newId, direction),
  };
}

/** 递归移除指定 leaf，兄弟节点自动提升填补空间 */
export function removeTreeNode(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.type === "leaf") {
    return node.instanceId === targetId ? null : node;
  }
  const newFirst = removeTreeNode(node.first, targetId);
  const newSecond = removeTreeNode(node.second, targetId);
  if (!newFirst && !newSecond) return null;
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;
  return {
    ...node,
    first: newFirst,
    second: newSecond,
  };
}

/** 递归更新分屏比例 */
export function updateTreeRatio(
  node: LayoutNode,
  branchId: string,
  ratio: number,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === branchId) {
    return { ...node, ratio };
  }
  return {
    ...node,
    first: updateTreeRatio(node.first, branchId, ratio),
    second: updateTreeRatio(node.second, branchId, ratio),
  };
}

interface TerminalStoreState {
  instances: TerminalInstanceItem[];
  groups: TerminalTabGroup[];
  activeGroupId: string | null;
  activeInstanceId: string | null;
  maximizedInstanceId: string | null;
  defaultProfileId: string;
  /** 首载重挂是否已尝试过（无论找没找到）—— 空态自动建标签必须等它，否则抢占重挂 */
  reattachDone: boolean;
  /** 终端启动 Antigravity 时是否默认携带 --dangerously-skip-permissions 免审批 */
  agyDefaultYolo: boolean;
  setAgyDefaultYolo: (val: boolean) => void;

  /** 新建独立标签页 */
  createTab: (opts?: {
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
    unitId?: string;
  }) => string;

  /** 自由拆分当前窗格（支持任意嵌套左右 / 上下分屏） */
  splitPane: (opts?: {
    targetInstanceId?: string;
    direction?: SplitDirection;
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
  }) => string;

  /** 关闭单个窗格（若为标签页内最后一个窗格，则连带关闭标签页） */
  closePane: (instanceId: string) => void;

  /** 关闭整个标签页组 */
  closeTab: (groupId: string) => void;

  /** 设置当前活跃标签组 */
  setActiveGroup: (groupId: string) => void;

  /** 设置当前聚焦的窗格实例 */
  setActiveInstance: (instanceId: string) => void;

  /** 调整分屏分割线比例 */
  setBranchRatio: (branchId: string, ratio: number) => void;

  /** 最大化 / 还原窗格 */
  toggleMaximize: (instanceId?: string) => void;

  /** 重命名实例 */
  renameInstance: (instanceId: string, title: string) => void;

  /** 重命名标签页 */
  renameTab: (groupId: string, title: string) => void;

  /** 全部清空销毁 */
  clearAll: () => void;

  /**
   * F5 重挂：把 daemon 里还活着的 PTY 找回来（terminal.list），逐个还原成标签。
   * 没有它，刷新一次就积累一批孤儿进程 —— 界面上再也关不掉，直到手杀 daemon。
   */
  reattachFromDaemon: () => Promise<void>;

  // 兼容别名
  createInstance: (opts?: { profileId?: string; cwd?: string; executorId?: string; title?: string }) => string;
  closeInstance: (id: string) => void;
  splitWithNew: (profileId?: string) => string;
}

const TERMINAL_PREFS_KEY = "agent-workbench:terminal-prefs";

function readTerminalPrefs(): { agyDefaultYolo: boolean } {
  if (typeof window === "undefined") return { agyDefaultYolo: false };
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFS_KEY);
    if (!raw) return { agyDefaultYolo: false };
    const parsed = JSON.parse(raw);
    return { agyDefaultYolo: Boolean(parsed.agyDefaultYolo) };
  } catch {
    return { agyDefaultYolo: false };
  }
}

function persistTerminalPrefs(prefs: { agyDefaultYolo: boolean }): void {
  try {
    window.localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

const initialTerminalPrefs = readTerminalPrefs();

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  instances: [],
  groups: [],
  activeGroupId: null,
  activeInstanceId: null,
  maximizedInstanceId: null,
  defaultProfileId: "pwsh",
  reattachDone: false,
  agyDefaultYolo: initialTerminalPrefs.agyDefaultYolo,

  setAgyDefaultYolo: (val: boolean) => {
    set({ agyDefaultYolo: val });
    persistTerminalPrefs({ agyDefaultYolo: val });
  },

  createTab: (opts = {}) => {
    const profileId = opts.profileId ?? get().defaultProfileId;
    const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
    const profile: TerminalProfile =
      SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;

    let finalExecutorId = opts.executorId;
    let finalTitle = opts.title;

    // 当用户未显式指定 yolo 且全局偏好配置了 agy 默认走 yolo 时，直启 agy:yolo
    if (
      (finalExecutorId === "agy" || finalExecutorId === "antigravity") &&
      get().agyDefaultYolo
    ) {
      finalExecutorId = "agy:yolo";
      if (!finalTitle) finalTitle = "Antigravity (YOLO)";
    }

    const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = get().instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      finalTitle ??
      (finalExecutorId
        ? finalExecutorId.endsWith(":yolo")
          ? `${finalExecutorId.replace(/:yolo$/, "")} (YOLO)`
          : `${finalExecutorId} (pwsh)`
        : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: finalExecutorId ? finalExecutorId : profile.icon,
      cwd: opts.cwd ?? "",
      executorId: finalExecutorId,
      unitId: opts.unitId,
      createdAt: Date.now(),
    };

    const groupId = `group_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
    const newGroup: TerminalTabGroup = {
      id: groupId,
      title,
      rootLayout: { type: "leaf", instanceId: id },
    };

    set((state) => ({
      instances: [...state.instances, newInst],
      groups: [...state.groups, newGroup],
      activeGroupId: groupId,
      activeInstanceId: id,
    }));

    return id;
  },

  splitPane: (opts = {}) => {
    const { activeInstanceId, activeGroupId, groups, instances } = get();
    const targetId = opts.targetInstanceId ?? activeInstanceId ?? instances[0]?.id;
    if (!targetId) {
      return get().createTab(opts);
    }

    // 找到包含该 targetId 的标签组
    const group = groups.find((g) => collectLeafIds(g.rootLayout).includes(targetId)) ??
      groups.find((g) => g.id === activeGroupId) ??
      groups[0];

    if (!group) {
      return get().createTab(opts);
    }

    const targetInst = instances.find((i) => i.id === targetId);
    const profileId = opts.profileId ?? targetInst?.profileId ?? get().defaultProfileId;
    const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
    const profile: TerminalProfile =
      SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;

    const newId = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      opts.title ??
      (opts.executorId
        ? `${opts.executorId} (pwsh)`
        : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id: newId,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: opts.executorId ? opts.executorId : profile.icon,
      cwd: opts.cwd ?? targetInst?.cwd ?? "",
      executorId: opts.executorId,
      createdAt: Date.now(),
    };

    const direction: SplitDirection = opts.direction ?? "horizontal";
    const updatedLayout = splitTreeNode(group.rootLayout, targetId, newId, direction);

    set((state) => ({
      instances: [...state.instances, newInst],
      groups: state.groups.map((g) =>
        g.id === group.id ? { ...g, rootLayout: updatedLayout } : g,
      ),
      activeGroupId: group.id,
      activeInstanceId: newId,
      maximizedInstanceId: null, // 拆分时自动解除最大化
    }));

    return newId;
  },

  closePane: (instanceId: string) => {
    terminalSessionRegistry.dispose(instanceId);

    set((state) => {
      const group = state.groups.find((g) =>
        collectLeafIds(g.rootLayout).includes(instanceId),
      );
      if (!group) {
        return {
          instances: state.instances.filter((i) => i.id !== instanceId),
        };
      }

      const updatedLayout = removeTreeNode(group.rootLayout, instanceId);
      const newInstances = state.instances.filter((i) => i.id !== instanceId);

      let newGroups = state.groups;
      let newActiveGroupId = state.activeGroupId;
      let newActiveInstanceId = state.activeInstanceId;

      if (!updatedLayout) {
        // 该组已无任何窗格，关闭整个组
        const gIdx = state.groups.findIndex((g) => g.id === group.id);
        newGroups = state.groups.filter((g) => g.id !== group.id);
        if (state.activeGroupId === group.id) {
          if (newGroups.length > 0) {
            const nextIdx = Math.max(0, gIdx - 1);
            newActiveGroupId = newGroups[nextIdx]?.id ?? null;
            const remainingLeaves = collectLeafIds(newGroups[nextIdx]?.rootLayout ?? null);
            newActiveInstanceId = remainingLeaves[0] ?? null;
          } else {
            newActiveGroupId = null;
            newActiveInstanceId = null;
          }
        }
      } else {
        // 更新组内布局树
        newGroups = state.groups.map((g) =>
          g.id === group.id ? { ...g, rootLayout: updatedLayout } : g,
        );
        if (state.activeInstanceId === instanceId) {
          const remainingLeaves = collectLeafIds(updatedLayout);
          newActiveInstanceId = remainingLeaves[0] ?? null;
        }
      }

      return {
        instances: newInstances,
        groups: newGroups,
        activeGroupId: newActiveGroupId,
        activeInstanceId: newActiveInstanceId,
        maximizedInstanceId:
          state.maximizedInstanceId === instanceId ? null : state.maximizedInstanceId,
      };
    });
  },

  closeTab: (groupId: string) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;

    const leafIds = collectLeafIds(group.rootLayout);
    leafIds.forEach((id) => terminalSessionRegistry.dispose(id));

    set((state) => {
      const gIdx = state.groups.findIndex((g) => g.id === groupId);
      const newGroups = state.groups.filter((g) => g.id !== groupId);
      const newInstances = state.instances.filter((i) => !leafIds.includes(i.id));

      let newActiveGroupId = state.activeGroupId;
      let newActiveInstanceId = state.activeInstanceId;

      if (state.activeGroupId === groupId) {
        if (newGroups.length > 0) {
          const nextIdx = Math.max(0, gIdx - 1);
          newActiveGroupId = newGroups[nextIdx]?.id ?? null;
          const remainingLeaves = collectLeafIds(newGroups[nextIdx]?.rootLayout ?? null);
          newActiveInstanceId = remainingLeaves[0] ?? null;
        } else {
          newActiveGroupId = null;
          newActiveInstanceId = null;
        }
      }

      return {
        instances: newInstances,
        groups: newGroups,
        activeGroupId: newActiveGroupId,
        activeInstanceId: newActiveInstanceId,
      };
    });
  },

  setActiveGroup: (groupId: string) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    const leaves = collectLeafIds(group.rootLayout);
    set({
      activeGroupId: groupId,
      activeInstanceId: leaves[0] ?? null,
      maximizedInstanceId: null,
    });
  },

  setActiveInstance: (instanceId: string) => {
    const group = get().groups.find((g) =>
      collectLeafIds(g.rootLayout).includes(instanceId),
    );
    set({
      activeInstanceId: instanceId,
      activeGroupId: group ? group.id : get().activeGroupId,
    });
  },

  setBranchRatio: (branchId: string, ratio: number) => {
    const clamped = Math.max(0.1, Math.min(0.9, ratio));
    set((state) => ({
      groups: state.groups.map((g) => ({
        ...g,
        rootLayout: updateTreeRatio(g.rootLayout, branchId, clamped),
      })),
    }));
  },

  toggleMaximize: (instanceId?: string) => {
    const target = instanceId ?? get().activeInstanceId;
    set((state) => ({
      maximizedInstanceId:
        state.maximizedInstanceId === target ? null : (target ?? null),
    }));
  },

  renameInstance: (instanceId: string, title: string) => {
    set((state) => ({
      instances: state.instances.map((i) =>
        i.id === instanceId ? { ...i, title } : i,
      ),
    }));
  },

  renameTab: (groupId: string, title: string) => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, title } : g)),
    }));
  },

  clearAll: () => {
    terminalSessionRegistry.disposeAll();
    set({
      instances: [],
      groups: [],
      activeGroupId: null,
      activeInstanceId: null,
      maximizedInstanceId: null,
    });
  },

  reattachFromDaemon: async () => {
    // 用户这次会话已经建过标签就不动 —— 重挂只在首载跑一次
    if (get().instances.length > 0 || get().reattachDone) {
      set({ reattachDone: true });
      return;
    }
    let list: Array<{ terminalId: string; shell: string; cwd: string; executor: string; unitId?: string; scrollback?: string }>;
    let client: { rpc: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T> } | null = null;
    try {
      const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      client = DaemonClient.get(defaultDaemonEndpoint());
      list = await client.rpc<typeof list>("terminal.list", null, 10000);
    } catch {
      set({ reattachDone: true }); // daemon 没起：放行空态自动建标签
      return;
    }
    if (get().instances.length > 0 || get().reattachDone) {
      set({ reattachDone: true });
      return;
    }
    if (list.length === 0) {
      set({ reattachDone: true });
      return;
    }

    const { useWorkbench } = await import("./useWorkbench.ts");
    const units = useWorkbench.getState().units;

    const shellToProfile = (shell: string): string => {
      const s = shell.toLowerCase();
      if (s.includes("pwsh")) return "pwsh";
      if (s.includes("powershell")) return "powershell";
      if (s.includes("cmd")) return "cmd";
      if (s.includes("wsl")) return "wsl";
      if (s.includes("bash")) return "bash";
      return "pwsh";
    };

    const instances: TerminalInstanceItem[] = [];
    const groups: TerminalTabGroup[] = [];
    const seenUnitIds = new Set<string>();

    for (const t of list) {
      // 匹配 Bot：优先用终端记录的 unitId，兜底用工作目录匹配
      let targetUnitId = t.unitId;
      if (!targetUnitId && t.cwd) {
        const matched = units.find((u) => u.rootPath && u.rootPath === t.cwd);
        if (matched) targetUnitId = matched.id;
      }

      // 同一个 Bot 仅保留一个主终端；多余的孤儿旧进程在后台直接清理，杜绝重复累积
      if (targetUnitId) {
        if (seenUnitIds.has(targetUnitId)) {
          void client.rpc("terminal.kill", { terminalId: t.terminalId }).catch(() => {});
          continue;
        }
        seenUnitIds.add(targetUnitId);
      }

      const isShell = t.executor === "shell" || t.executor === undefined || t.executor === "";
      const profileId = shellToProfile(t.shell);
      const profile = SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId);

      const bot = targetUnitId ? units.find((u) => u.id === targetUnitId) : undefined;
      let title: string;
      if (bot) {
        const execName = t.executor && t.executor !== "shell" ? t.executor : "终端";
        title = `${bot.name} · ${execName} (TUI)`;
      } else if (isShell) {
        title = profile?.name ?? "终端";
      } else {
        title = t.executor ?? "终端";
      }

      instances.push({
        id: t.terminalId,
        title,
        shell: t.shell,
        profileId,
        icon: isShell ? (profile?.icon ?? "pwsh") : t.executor,
        cwd: t.cwd,
        executorId: isShell ? undefined : t.executor,
        unitId: targetUnitId,
        createdAt: Date.now(),
        attachScrollback: t.scrollback,
        reattached: true,
      });
      groups.push({
        id: `group_${t.terminalId}`,
        rootLayout: { type: "leaf", instanceId: t.terminalId },
      });
    }

    const activeUnitId = useWorkbench.getState().activeUnitId;
    const initialActiveInst = activeUnitId
      ? instances.find((i) => i.unitId === activeUnitId) ?? instances[0]
      : instances[0];
    const initialActiveGroup = initialActiveInst
      ? groups.find((g) => collectLeafIds(g.rootLayout).includes(initialActiveInst.id)) ?? groups[0]
      : groups[0];

    set({
      instances,
      groups,
      activeGroupId: initialActiveGroup?.id ?? null,
      activeInstanceId: initialActiveInst?.id ?? null,
      reattachDone: true,
    });
  },

  createInstance: (opts) => get().createTab(opts),
  closeInstance: (id) => get().closePane(id),
  splitWithNew: (profileId) => get().splitPane({ profileId, direction: "horizontal" }),
}));
