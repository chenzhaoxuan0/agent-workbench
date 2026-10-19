/**
 * planTools 映射器契约自检（纯函数直跑，不依赖 daemon）。
 * 跑法：npx tsx scripts/check-plan-tools.ts
 */
import { planProposedFromTodoTool } from "../src/runtime/planTools.ts";
import { asSessionId } from "../../prototype/src/core/units.ts";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${label}`);
  }
}

const SID = asSessionId("1");

// Claude TodoWrite 全量快照（分隔符/大小写变体也应命中）
const claude = planProposedFromTodoTool(SID, "TodoWrite", {
  todos: [
    { content: "读需求", status: "completed" },
    { content: "写实现", status: "in_progress" },
    { content: "补测试", status: "pending" },
  ],
});
const claudeProposed = claude !== null && claude.type === "plan.proposed" ? claude : null;
assert(claudeProposed !== null, "TodoWrite 识别并合成 plan.proposed");
assert(claudeProposed!.planId === "todo" && claudeProposed!.steps.length === 3, "合成快照三步、planId 恒定");
assert(claudeProposed!.steps[0]!.status === "done" && claudeProposed!.steps[1]!.status === "in_progress", "状态词归一（completed/done、in_progress）");

// 工具名变体：update_plan（Codex 的键是 plan，条目键是 step）
const codex = planProposedFromTodoTool(SID, "update_plan", {
  plan: [
    { step: "调研", status: "completed" },
    { step: "落地", status: "pending" },
  ],
});
const codexProposed = codex !== null && codex.type === "plan.proposed" ? codex : null;
assert(codexProposed !== null && codexProposed.steps[0]!.title === "调研", "update_plan 命中 plan/step 键形态");
assert(planProposedFromTodoTool(SID, "Update-Todos", { todos: [{ content: "a", status: "done" }] }) !== null, "分隔符/大小写变体命中");

// 重复快照幂等：同输入再合成一条等价事件（前端按同 planId 整表替换）
const again = planProposedFromTodoTool(SID, "TodoWrite", {
  todos: [{ content: "读需求", status: "completed" }],
});
assert(again !== null && again.type === "plan.proposed" && again.steps.length === 1, "后续快照原样合成（替换语义交给前端）");

// 输入容错：JSON 字符串与直接数组兼容
const jsonStr = planProposedFromTodoTool(
  SID,
  "TodoWrite",
  JSON.stringify({ todos: [{ content: "JSON 序列化入参", status: "in_progress" }] }),
);
assert(jsonStr !== null && jsonStr.type === "plan.proposed" && jsonStr.steps[0]!.title === "JSON 序列化入参", "支持 JSON 字符串 input");

const directArr = planProposedFromTodoTool(
  SID,
  "TodoWrite",
  [{ content: "直接数组入参", status: "completed" }],
);
assert(directArr !== null && directArr.type === "plan.proposed" && directArr.steps[0]!.status === "done", "支持直接数组 input");

// 非清单工具 / 空清单 / 提取不出步骤 → null
assert(planProposedFromTodoTool(SID, "bash", { command: "ls" }) === null, "普通工具不合成");
assert(planProposedFromTodoTool(SID, "plan", { anything: 1 }) === null, "裸 plan 不识别（防误伤）");
assert(planProposedFromTodoTool(SID, "TodoWrite", { todos: [] }) === null, "空清单不发声");
assert(planProposedFromTodoTool(SID, "TodoWrite", { todos: [42, null, "x"] }) === null, "提取不出任何步骤 → null");
assert(planProposedFromTodoTool(SID, "TodoWrite", null) === null, "input 为 null 不炸");

// 状态词兜底：认不出的落 pending
const odd = planProposedFromTodoTool(SID, "TodoWrite", { todos: [{ content: "x", status: "weird_state" }] });
assert(odd !== null && odd.type === "plan.proposed" && odd.steps[0]!.status === "pending", "未知状态词保守落 pending");

console.log(`\nplanTools 契约：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
