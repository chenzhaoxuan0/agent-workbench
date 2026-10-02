import { create } from "zustand";
import { useWorkbench } from "./useWorkbench.ts";
import type { UnitId } from "../core/units.ts";

/**
 * 外壳状态 —— 和业务状态（工作单元 / 会话 / 事件流）分离。
 *
 * 布局结构对齐 ZCode 的 WorkspaceShellLayout：
 * - 侧栏 264px 起，可拖拽，宽度持久化到 localStorage
 *   （ZCode 用的是同一个键名思路：zcode:workspace-shell:sidebar-width-px）
 * - 右栏是**标签页面板**，不是固定详情栏
 * - 底部终端面板可开关
 * - 命令中心 Cmd/Ctrl+K
 */

/**
 * 主视图 —— 对齐 ZCode 的 WorkspaceMainView（app-shell/types.ts）。
 *
 * ZCode 只有 chat / automations / plugin-store 三种主视图：
 * - 设置页**不是主视图**，是全屏覆盖层（WorkspaceSettingsLayer：absolute inset-0，
 *   shell 压暗不卸载），所以这里用 settingsOpen 布尔而不是 "settings" 视图；
 * - 搜索**也不是主视图**，是 ⌘K 命令中心浮层（CommandCenterDialog）。
 * - image（出图工作台）是本项目的扩展：与自动化同级的独立功能视图
 *   （gpt_image_playground 的移植落点）。
 */
export type MainView = "chat" | "automations" | "image";

/**
 * 会话内视图 —— 对齐 dsh 的 view-selection（ConversationSession tabs）。
 * - chat / trajectory：同一个会话的两种读法，composer 都保持在底部；
 * - terminal：全屏终端页签（与底部 dock 终端同组件不同实例），
 *   大屏下全屏使用各 provider CLI 的 TUI；
 * - ops：LLM-Ops 仪表盘（对齐 waku dashboard 的 Ops 页签）。
 * 后两者占据整个会话视口且**不渲染 composer**——它们不是会话的另一种读法。
 */
export type ConversationView = "chat" | "terminal" | "trajectory" | "ops";

/** 设置分区 id，集合对齐 ZCode 的 SettingsSectionId */
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "models"
  | "image"
  | "shortcuts"
  | "skills"
  | "memory"
  | "hooks"
  | "permissions"
  | "usage"
  | "trace";

export type SettingsGroupId = "basics" | "agentCapabilities" | "dataAndStats";

export interface SettingsSectionDef {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly desc: string;
  readonly groupId: SettingsGroupId;
  /** 图标 key，交给渲染层映射，避免状态层依赖 react 图标 */
  readonly icon: string;
}

/** 分组定义，顺序即侧栏显示顺序 */
export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; title: string }[] = [
  { id: "basics", title: "基础" },
  { id: "agentCapabilities", title: "Agent 能力" },
  { id: "dataAndStats", title: "数据与统计" },
];

/**
 * 分区清单 —— 结构照搬 ZCode 的 BASE_SETTINGS_SECTIONS，
 * 但内容按本项目的实际资产重排：
 * 「执行器」进基础设置（六家工具是一等公民，必须显眼）
 * **「自动化」不在此列表** —— 它是独立主视图（见 MainView 注释）
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: "general", title: "通用", desc: "工作区、启动行为、语言", groupId: "basics", icon: "settings" },
  { id: "appearance", title: "外观", desc: "主题、字号、动效", groupId: "basics", icon: "palette" },
  { id: "models", title: "执行器与模型", desc: "执行器实例、供应商与每个 CLI 的模型清单", groupId: "basics", icon: "brain" },
  { id: "shortcuts", title: "快捷键", desc: "全局与工作区级键位", groupId: "basics", icon: "keyboard" },

  { id: "skills", title: "技能", desc: "SKILL.md 目录，跨工具共享", groupId: "agentCapabilities", icon: "wand" },
  { id: "memory", title: "记忆", desc: "语义事实 / 情节事件 / 程序性技能 三层记忆（对齐 waku）", groupId: "agentCapabilities", icon: "brain" },
  { id: "image", title: "出图", desc: "图像供应商 profile 管理（gpt_image_playground 字段全集）", groupId: "agentCapabilities", icon: "image" },
  { id: "hooks", title: "钩子", desc: "工具调用前后触发的自定义脚本", groupId: "agentCapabilities", icon: "anchor" },
  { id: "permissions", title: "权限", desc: "默认审批策略与信任范围", groupId: "agentCapabilities", icon: "shield" },

  { id: "usage", title: "用量", desc: "按执行器与工作单元的消耗统计", groupId: "dataAndStats", icon: "chart" },
  { id: "trace", title: "轨迹", desc: "运行轨迹存储位置与导出", groupId: "dataAndStats", icon: "history" },
];

// ---------------------------------------------------------------------------
// 右栏标签页已迁至 store/useSidePane.ts（契约在 core/sidepane.ts）
// 这里不再保留任何 tab 状态，避免两处实现分叉。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const WIDTH_KEY = "agent-workbench:sidebar-width-px";
const SIDEBAR_DEFAULT = 264;
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX_RATIO = 0.5;

/** 对话区过窄时自动收起（对齐 ZCode 的 360 / 480 阈值思路） */
const AUTO_COLLAPSE_SIDEBAR_PX = 360;
const AUTO_COLLAPSE_SIDE_PANE_PX = 480;

function readWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(SIDEBAR_MIN, Math.round(n)) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function persistWidth(w: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

interface ShellState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  terminalOpen: boolean;
  terminalHeight: number;

  commandOpen: boolean;
  mainView: MainView;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  /** 新建 bot 对话框（AGENTS.md 岗位说明书）。放 store 而不是 Sidebar 局部状态：
   *  「添加 bot」的按钮收进了侧栏 ⋯ 之后，单元区的空态要能当第二个入口，
   *  两处共用一个开关。 */
  addBotOpen: boolean;
  /** 正在编辑的单元 id —— 非 null 时同一个对话框切到「保存」模式并预填该 bot。
   *  和 addBotOpen 二选一：新建 / 编辑共用一个对话框组件，不开第二份表单状态。 */
  editUnitId: UnitId | null;
  /** 会话内视图（dsh view-selection：对话 / 轨迹 / Ops 与 Chat 并列的页签） */
  conversationView: ConversationView;

  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalHeight: (h: number) => void;

  setMainView: (v: MainView) => void;
  /** 打开设置覆盖层（ZCode 的 WorkspaceSettingsLayer），可直落某个分区 */
  openSettings: (section?: SettingsSectionId) => void;
  /** 关闭设置覆盖层。对齐 ZCode：退出设置统一回到 chat 主视图 */
  closeSettings: () => void;
  /** 新建任务：回 chat 主视图并清空草稿（对齐 ZCode 的 newTask，⌘N） */
  newTask: () => void;
  setConversationView: (v: ConversationView) => void;

  setCommandOpen: (open: boolean) => void;
  openAddBot: () => void;
  closeAddBot: () => void;
  openUnitSettings: (id: UnitId) => void;
  closeUnitSettings: () => void;
}

export const useShell = create<ShellState>((set, get) => ({
  sidebarWidth: readWidth(),
  sidebarCollapsed: false,
  terminalOpen: false,
  terminalHeight: 30,

  commandOpen: false,
  mainView: "chat",
  settingsOpen: false,
  settingsSection: "general",
  conversationView: "chat",
  addBotOpen: false,
  editUnitId: null,

  setMainView: (mainView) => set({ mainView }),

  openSettings: (section) =>
    set((s) => ({
      settingsOpen: true,
      settingsSection: section ?? s.settingsSection,
    })),

  closeSettings: () => set({ settingsOpen: false, mainView: "chat" }),

  newTask: () => {
    set({ mainView: "chat" });
    useWorkbench.getState().setDraft("");
  },

  setConversationView: (conversationView) => set({ conversationView }),

  setSidebarWidth: (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.round(w));
    set({ sidebarWidth: clamped });
    persistWidth(clamped);
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalHeight: (terminalHeight) => set({ terminalHeight }),

  setCommandOpen: (commandOpen) => set({ commandOpen }),

  openAddBot: () => set({ addBotOpen: true, editUnitId: null }),
  closeAddBot: () => set({ addBotOpen: false }),
  openUnitSettings: (editUnitId) => set({ editUnitId, addBotOpen: false }),
  closeUnitSettings: () => set({ editUnitId: null }),
}));

// ---------------------------------------------------------------------------
// 全局快捷键（对齐 ZCode 的命令中心习惯）
// ---------------------------------------------------------------------------

export function bindShellShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const shell = useShell.getState();
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      shell.setCommandOpen(!shell.commandOpen);
      return;
    }
    // 搜索也是命令中心（ZCode 没有独立搜索视图，⌘F 并入同一入口）
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      shell.setCommandOpen(true);
      return;
    }
    // ZCode：toggleSidebar 默认 Cmd/Ctrl+B
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      shell.toggleSidebar();
      return;
    }
    // ZCode：newTask 默认 Cmd/Ctrl+N（浏览器可能吞掉，能拦则拦）
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      shell.newTask();
      return;
    }
    // ZCode：openSettings 默认 Cmd/Ctrl+,
    if (mod && e.key === ",") {
      e.preventDefault();
      shell.openSettings();
      return;
    }
    if (e.key === "Escape") {
      const s = useShell.getState();
      if (s.commandOpen) s.setCommandOpen(false);
      else if (s.addBotOpen) s.closeAddBot();
      else if (s.editUnitId !== null) s.closeUnitSettings();
      else if (s.settingsOpen) s.closeSettings();
      return;
    }
    if (mod && e.key === "`") {
      e.preventDefault();
      useShell.getState().toggleTerminal();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** 供 ResizablePanel onLayout 计算：视口宽度换算最大侧栏宽 */
export function maxSidebarWidth(containerWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.round(containerWidth * SIDEBAR_MAX_RATIO));
}

export { AUTO_COLLAPSE_SIDEBAR_PX, AUTO_COLLAPSE_SIDE_PANE_PX, SIDEBAR_DEFAULT, SIDEBAR_MIN };
