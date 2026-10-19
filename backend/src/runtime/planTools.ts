/**
 * todo 工具 → 计划事件的共享映射器（挂在 host 的会话 sink，全执行器生效）。
 *
 * 背景：归一化契约早有 plan.proposed / plan.step.updated / plan.resolved
 * （prototype/src/core/events.ts），但只有 mcode 适配器把原生 plan_update 映射
 * 过来。大多数执行器没有原生「计划帧」，但有等价物——**清单类工具调用**：
 * Claude Code 的 TodoWrite（todos 全量快照）、Codex 的 update_plan（plan 全量
 * 快照）等。这些调用本来就走 tool.started（带原始 input），在 daemon 汇点识别
 * 并合成 plan.proposed，计划面板（右侧栏「计划 / 任务进度」）就从 mcode 独占
 * 变成人人有份，未来新执行器只要工具名进集合就自动覆盖。
 *
 * 语义约定：
 * - 清单类工具每次调用都是**全量快照**（增删改都在列表里）→ 合成一条
 *   plan.proposed、planId 恒为 "todo"（前端对同 planId 的 proposed 做整表替换）。
 * - 不合成 step.updated / resolved：快照语义下没有增量步骤翻转，也没有审批流。
 * - 工具名先归一（去分隔符 + 小写，对齐前端 SHELL_TOOL_NAMES 口径）再匹配；
 *   刻意不收裸 "plan"/"todo"——太泛，误伤面大。
 */

import type { PlanStep, PlanStepStatus, RuntimeEvent } from "../contract.ts";
import type { SessionId } from "../contract.ts";

/** 已知清单类工具（归一名）。新执行器实测工具名后往这里补 */
const TODO_TOOLS: ReadonlySet<string> = new Set([
  "todowrite", // Claude Code（todos: [{content, status, activeForm}]）
  "todoswrite",
  "writetodos",
  "updatetodos",
  "updatetodo",
  "todoupdate",
  "updateplan", // Codex（plan: [{step, status}]）
]);

function normTool(name: string): string {
  return name.replace(/[\s_\-./:]+/g, "").toLowerCase();
}

/** 各家状态词 → 契约五态；认不出的落 pending（宁可保守也不猜） */
function normalizeStatus(raw: unknown): PlanStepStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_\-]+/g, "") : "";
  if (s === "completed" || s === "done") return "done";
  if (s === "inprogress" || s === "current" || s === "active") return "in_progress";
  if (s === "blocked") return "blocked";
  if (s === "skipped" || s === "cancelled" || s === "canceled") return "skipped";
  return "pending";
}

/** 从工具 input 里找清单数组：各家键名不同（todos/plan/steps/items/entries） */
function findList(input: unknown): readonly unknown[] | null {
  if (input === null || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  for (const key of ["todos", "plan", "steps", "items", "entries"]) {
    const v = rec[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/**
 * 识别清单类工具调用 → 合成 plan.proposed。返回 null = 不是清单工具 / 提取
 * 不出任何步骤（空清单不发声：初始化前的空 TodoWrite 没有信息量）。
 */
export function planProposedFromTodoTool(
  sessionId: SessionId,
  toolName: string,
  input: unknown,
): RuntimeEvent | null {
  if (!TODO_TOOLS.has(normTool(toolName))) return null;
  const list = findList(input);
  if (list === null || list.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const title = [e.content, e.step, e.title, e.text, e.name].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (title === undefined) continue;
    steps.push({ id: `t${steps.length}`, title: title.trim(), status: normalizeStatus(e.status) });
  }
  if (steps.length === 0) return null;
  return {
    type: "plan.proposed",
    sessionId,
    planId: "todo",
    title: "任务清单",
    steps,
  };
}
