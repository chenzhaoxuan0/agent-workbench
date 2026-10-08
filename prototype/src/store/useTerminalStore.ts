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
  createdAt: number;
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

  /** 新建独立标签页 */
  createTab: (opts?: {
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
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

  // 兼容别名
  createInstance: (opts?: { profileId?: string; cwd?: string; executorId?: string; title?: string }) => string;
  closeInstance: (id: string) => void;
  splitWithNew: (profileId?: string) => string;
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  instances: [],
  groups: [],
  activeGroupId: null,
  activeInstanceId: null,
  maximizedInstanceId: null,
  defaultProfileId: "pwsh",

  createTab: (opts = {}) => {
    const profileId = opts.profileId ?? get().defaultProfileId;
    const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
    const profile: TerminalProfile =
      SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;

    const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = get().instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      opts.title ??
      (opts.executorId
        ? `${opts.executorId} (pwsh)`
        : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: opts.executorId ? opts.executorId : profile.icon,
      cwd: opts.cwd ?? "",
      executorId: opts.executorId,
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

  createInstance: (opts) => get().createTab(opts),
  closeInstance: (id) => get().closePane(id),
  splitWithNew: (profileId) => get().splitPane({ profileId, direction: "horizontal" }),
}));
