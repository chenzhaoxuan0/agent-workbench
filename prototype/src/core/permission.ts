/**
 * 权限模式 —— composer 左侧常驻的运行期权限档位。
 *
 * 档位集合对齐 Claude Code / Codex / ZCode 的通用约定：
 * 默认询问 / 自动接受编辑 / 只读规划 / 完全放行。
 *
 * 它和权限对话框是**两层**东西，不要混淆：
 * - 权限模式 = 本次运行**预先声明**的默认策略，作用于所有后续请求
 * - 权限对话框 = 单个请求的**具体裁决**，只在需要问的时候出现
 *
 * 模式只改变「什么情况下弹框」，不改变裁决的选项集合 ——
 * 所以模式切到 bypass 之后，对话框就不再出现，而不是变成一个空壳。
 */

export type PermissionMode = "ask" | "acceptEdits" | "plan" | "bypass";

export interface PermissionModeDef {
  readonly id: PermissionMode;
  readonly label: string;
  readonly desc: string;
  /** 该模式下会拦下哪些请求种类 —— 「读」在这里表示会话是否被强制只读 */
  readonly reads: "允许" | "允许" | "拦截" | "允许";
  readonly writes: "询问" | "自动" | "拦截" | "自动";
  readonly shell: "询问" | "询问" | "拦截" | "自动";
  /** bypass 之外都应视为需要显式确认的降权档位，UI 上要给出警示 */
  readonly danger: boolean;
}

export const PERMISSION_MODES: readonly PermissionModeDef[] = [
  {
    id: "plan",
    label: "计划模式",
    desc: "只读规划不改动代码，先摸清方案再动手",
    reads: "允许",
    writes: "拦截",
    shell: "拦截",
    danger: false,
  },
  {
    id: "ask",
    label: "变更确认",
    desc: "写文件、执行命令前逐一请求确认",
    reads: "允许",
    writes: "询问",
    shell: "询问",
    danger: false,
  },
  {
    id: "acceptEdits",
    label: "自主模式",
    desc: "自动接受文件编辑，命令执行仍逐条询问",
    reads: "允许",
    writes: "自动",
    shell: "询问",
    danger: false,
  },
  {
    id: "bypass",
    label: "完全访问",
    desc: "完全放行，不再弹任何授权框，沙箱是唯一防线",
    reads: "允许",
    writes: "自动",
    shell: "自动",
    danger: true,
  },
];

export function getMode(id: PermissionMode): PermissionModeDef {
  return PERMISSION_MODES.find((m) => m.id === id) ?? PERMISSION_MODES[0]!;
}

/** 该模式下这个请求是否还需要弹框 */
export function needsDialog(
  mode: PermissionMode,
  kind: "file_write" | "shell" | "network" | "tool",
): boolean {
  switch (mode) {
    case "bypass":
      return false;
    case "plan":
      return true; // 只读模式下任何写/执行都拦下，必须让人知道
    case "acceptEdits":
      return kind !== "file_write";
    case "ask":
    default:
      return true;
  }
}
