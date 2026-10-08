import { create } from "zustand";

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
  icon: "pwsh" | "powershell" | "cmd" | "wsl" | "bash";
  cwd: string;
  executorId?: string;
  createdAt: number;
}

interface TerminalStoreState {
  instances: TerminalInstanceItem[];
  activeInstanceId: string | null;
  splitInstanceId: string | null;
  /** 默认使用的 Profile ID */
  defaultProfileId: string;

  createInstance: (opts?: {
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
  }) => string;
  closeInstance: (id: string) => void;
  setActiveInstance: (id: string) => void;
  setSplitInstance: (id: string | null) => void;
  splitWithNew: (profileId?: string) => string;
  renameInstance: (id: string, title: string) => void;
  clearAll: () => void;
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  instances: [],
  activeInstanceId: null,
  splitInstanceId: null,
  defaultProfileId: "pwsh",

  createInstance: (opts = {}) => {
    const profileId = opts.profileId ?? get().defaultProfileId;
    const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
    const profile: TerminalProfile =
      SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;
    const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = get().instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      opts.title ??
      (opts.executorId ? `${opts.executorId} (${profile.name})` : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: profile.icon,
      cwd: opts.cwd ?? "",
      executorId: opts.executorId,
      createdAt: Date.now(),
    };

    set((state) => ({
      instances: [...state.instances, newInst],
      activeInstanceId: id,
    }));

    return id;
  },

  closeInstance: (id: string) => {
    set((state) => {
      const idx = state.instances.findIndex((i) => i.id === id);
      if (idx === -1) return state;

      const newInstances = state.instances.filter((i) => i.id !== id);
      let newActiveId = state.activeInstanceId;
      let newSplitId = state.splitInstanceId;

      if (state.activeInstanceId === id) {
        if (newInstances.length > 0) {
          const nextIdx = Math.max(0, idx - 1);
          const target = newInstances[nextIdx] ?? newInstances[0];
          newActiveId = target ? target.id : null;
        } else {
          newActiveId = null;
        }
      }

      if (state.splitInstanceId === id) {
        newSplitId = null;
      }

      return {
        instances: newInstances,
        activeInstanceId: newActiveId,
        splitInstanceId: newSplitId,
      };
    });
  },

  setActiveInstance: (id: string) => {
    set({ activeInstanceId: id });
  },

  setSplitInstance: (id: string | null) => {
    set({ splitInstanceId: id });
  },

  splitWithNew: (profileId?: string) => {
    const currentActive = get().activeInstanceId;
    const currentItem = get().instances.find((i) => i.id === currentActive);
    const newId = get().createInstance({
      profileId: profileId ?? currentItem?.profileId,
      cwd: currentItem?.cwd,
    });
    set({ splitInstanceId: newId });
    return newId;
  },

  renameInstance: (id: string, title: string) => {
    set((state) => ({
      instances: state.instances.map((i) => (i.id === id ? { ...i, title } : i)),
    }));
  },

  clearAll: () => {
    set({ instances: [], activeInstanceId: null, splitInstanceId: null });
  },
}));
