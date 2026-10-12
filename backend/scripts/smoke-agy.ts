/**
 * agy（Antigravity）执行器适配器冒烟测试。
 *
 * 验证：
 * 1. probe: agy --version 可达，状态 ready。
 * 2. syncModels: 动态同步模型列表。
 * 3. headless turn: 运行一轮基础问答并验证事件流与终态。
 *
 * 用法：cd backend && npx tsx scripts/smoke-agy.ts
 */

import { AgyAdapter } from "../src/runtime/adapters/agy.ts";
import type { RuntimeEvent } from "../src/contract.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
  }
}

const adapter = new AgyAdapter();
const probe = await adapter.probe();
check("probe ready", probe.state.status === "ready", probe.state);
if (probe.state.status !== "ready") {
  console.error("agy probe failed:", probe.state);
  process.exit(1);
}

const syncedModels = await adapter.syncModels();
check("models declared & synced", syncedModels.length > 0, { count: syncedModels.length, sample: syncedModels[0]?.id });

const events: RuntimeEvent[] = [];
console.log("  .. starting session with prompt: 'Respond with just the word pong'");

const session = await adapter.start(
  {
    unitId: "unit_smoke" as never,
    unitName: "smoke",
    rootPath: process.cwd(),
    prompt: "Respond with just the word pong",
    model: null,
  },
  (event) => {
    events.push(event);
    if (event.type === "session.ref") console.log(`    ref: ${event.ref}`);
    if (event.type === "message.delta") process.stdout.write(`    delta: ${event.text}\n`);
    if (event.type === "tool.started") console.log(`    tool: ${event.toolName}`);
    if (event.type === "error") console.log(`    error: ${event.message}`);
  },
);

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "session.status" && (e.status === "idle" || e.status.startsWith("failed")))) break;
  await new Promise((r) => setTimeout(r, 500));
}

const idleSettled = events.some((e) => e.type === "session.status" && e.status === "idle");
check("turn settled to idle", idleSettled);

const completed = events.find((e) => e.type === "message.completed");
check(
  "assistant reply collected",
  completed !== undefined && completed.type === "message.completed" && completed.text.length > 0,
  completed?.type === "message.completed" ? completed.text.trim() : undefined,
);

const usage = events.find((e) => e.type === "usage");
check(
  "usage reported",
  usage !== undefined && usage.type === "usage" && usage.inputTokens >= 0,
  usage?.type === "usage" ? { input: usage.inputTokens, output: usage.outputTokens } : undefined,
);

const ref = session.externalRef();
check("externalRef = agy conversation id", typeof ref === "string" && ref.length > 0, ref);

await adapter.disconnect();
console.log(failures === 0 ? "\n  all green" : `\n  ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
