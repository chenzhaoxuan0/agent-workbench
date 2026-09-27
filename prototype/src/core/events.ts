/**
 * 归一化运行时事件。
 *
 * 这是"多家工具平等切换"的技术前提：六家 agent 的原生事件格式完全不同
 * （ACP / JSON-RPC / CBOR 二进制 / 自定义流），如果 UI 直接消费原生事件，
 * 每加一个工具就要改一遍渲染层。
 *
 * 适配器的职责就是把原生事件收敛到这里；UI 只认这一套 union。
 * 新增事件类型 = 改 union + 各适配器补一个 mapper，渲染层不动。
 */

import type { SessionId, UnitId } from "./units.ts";

/**
 * 计划步骤的状态机。
 *
 * 刻意不做「完成度百分比」—— 步骤的权重不等，
 * 用 done/total 算出来的百分比会骗人。ZCode 的 plan-detail 也是逐条列。
 */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: PlanStepStatus;
}

export type RuntimeEvent =
  // ---- 会话生命周期 ----
  | { readonly type: "session.started"; readonly sessionId: SessionId; readonly unitId: UnitId }
  | { readonly type: "session.ended"; readonly sessionId: SessionId; readonly reason: string }
  | { readonly type: "session.status"; readonly sessionId: SessionId; readonly status: string }

  // ---- 消息 ----
  | {
      readonly type: "message.delta";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
    }
  | {
      readonly type: "message.completed";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: "reasoning.delta";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly text: string;
    }

  // ---- 工具调用 ----
  | {
      readonly type: "tool.started";
      readonly sessionId: SessionId;
      readonly callId: string;
      readonly toolName: string;
      readonly title: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool.completed";
      readonly sessionId: SessionId;
      readonly callId: string;
      readonly ok: boolean;
      readonly output?: string;
    }

  // ---- 文件与 diff（项目视图的核心）----
  | {
      readonly type: "file.diff";
      readonly sessionId: SessionId;
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
      readonly patch?: string;
    }
  | {
      readonly type: "file.changed";
      readonly sessionId: SessionId;
      readonly path: string;
      readonly change: "created" | "modified" | "deleted";
    }

  // ---- 权限（沙箱/审批的统一抽象）----
  | {
      readonly type: "permission.requested";
      readonly sessionId: SessionId;
      readonly requestId: string;
      readonly kind: "file_write" | "shell" | "network" | "tool";
      readonly detail: string;
      readonly risk: "low" | "medium" | "high";
    }
  | {
      readonly type: "permission.resolved";
      readonly sessionId: SessionId;
      readonly requestId: string;
      readonly decision: "allow" | "deny" | "always";
    }

  // ---- 子代理 / 编排（任务内组合多 agent）----
  | {
      readonly type: "subagent.spawned";
      readonly sessionId: SessionId;
      readonly childId: string;
      readonly role: string;
      readonly runtimeId: string;
    }
  | {
      readonly type: "subagent.finished";
      readonly sessionId: SessionId;
      readonly childId: string;
      readonly ok: boolean;
      readonly summary?: string;
    }

  // ---- 计划（ZCode 的 plan-detail：agent 提计划 → 用户批 / 改 / 否）----
  | {
      readonly type: "plan.proposed";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly title: string;
      readonly steps: readonly PlanStep[];
      readonly rationale?: string;
    }
  | {
      readonly type: "plan.step.updated";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly stepId: string;
      readonly status: PlanStepStatus;
    }
  | {
      readonly type: "plan.resolved";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly decision: "approved" | "rejected" | "edited";
    }

  // ---- 用量（成本策略可视化）----
  | {
      readonly type: "usage";
      readonly sessionId: SessionId;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
      readonly model: string;
    }

  // ---- 产出 ----
  | {
      readonly type: "deliverable";
      readonly sessionId: SessionId;
      readonly unitId: UnitId;
      readonly title: string;
      readonly kind: "file" | "diff" | "pr" | "report" | "image";
      readonly path?: string;
      readonly url?: string;
    }

  // ---- 错误 ----
  | {
      readonly type: "error";
      readonly sessionId: SessionId;
      readonly message: string;
      readonly recoverable: boolean;
    };

export type RuntimeEventType = RuntimeEvent["type"];

/**
 * 这个工具调用是不是「跑了一条 shell 命令」。
 *
 * 右栏的 bash-output（后台命令）页签只认这类调用。判定放在 core 而不是 UI 里
 * `toolName.includes("bash")`：六家执行器的工具命名各不相同
 * （Bash / run_shell / LocalShell / execute_command / terminal.exec），
 * 口径散到渲染层就必然各家不一。
 *
 * 比较前先去掉分隔符再小写 —— 否则 LocalShell 和 local_shell 得维护两份。
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "bashoutput",
  "runshell",
  "shell",
  "executecommand",
  "runcommand",
  "localshell",
  "powershell",
  "terminal",
  "terminalexec",
]);

export function isShellTool(toolName: string): boolean {
  const n = toolName.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  if (SHELL_TOOL_NAMES.has(n)) return true;
  return n.startsWith("shell") || n.startsWith("bash") || n.startsWith("terminal");
}

// ---------------------------------------------------------------------------
// 轨迹记录 —— eval 闭环的原料
// ---------------------------------------------------------------------------

/**
 * 每条事件打时间戳后落盘，就是"运行时完整过程"的数据源。
 * LLM judge 消费它做回归对比。这一层与 UI 解耦：
 * 即使前端换掉，轨迹格式不变，历史数据继续可用。
 */
export interface TraceRecord {
  readonly seq: number;
  readonly at: number;
  readonly sessionId: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: string;
  readonly event: RuntimeEvent;
  /** 归一化耗时，用于找性能回归 */
  readonly durationMs?: number;
}
