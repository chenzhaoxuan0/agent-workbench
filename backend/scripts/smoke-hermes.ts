/**
 * hermes ACP 适配器冒烟：直接驱动 HermesAdapter 走一轮真 turn。
 *
 * 链路：spawn `hermes acp` → initialize → session/new（模型清单随会话下发并刷新
 * 适配器 _models）→（model=null 跟随会话默认，跳过 set_model）→ session/prompt →
 * session/update 翻译 → stopReason 落定 → usage 差值出账。
 *
 * 模型用 hermes 会话默认（本机实测 minimax-cn:MiniMax-M3），一轮 "只回复 ok"
 * 的 token 消耗可忽略。任何一步失败都以非零码退出。
 *
 * 用法：cd backend && npx tsx scripts/smoke-hermes.ts
 */

import { HermesAdapter } from "../src/runtime/adapters/hermes.ts";
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

const prober = new HermesAdapter();
const probe = await prober.probe();
check("probe ready", probe.state.status === "ready", probe.state);
if (probe.state.status !== "ready") {
  process.exit(1);
}

const before = prober.models.length;
const adapter = new HermesAdapter();
const events: RuntimeEvent[] = [];

console.log("  .. starting session (model=null → hermes 会话默认)");
const session = await adapter.start(
  { unitId: "unit_smoke" as never, unitName: "smoke", rootPath: process.cwd(), prompt: "hi", model: null },
  (event) => {
    events.push(event);
    if (event.type === "message.delta") process.stdout.write(`    delta: ${event.text.slice(0, 60)}\n`);
    if (event.type === "tool.started") console.log(`    tool: ${event.toolName}`);
    if (event.type === "error") console.log(`    error: ${event.message}`);
  },
);

session.send("只回复两个字母：ok").catch((err: unknown) => {
  console.error("send failed:", err instanceof Error ? err.message : String(err));
  failures += 1;
});

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "session.status" && e.status === "idle")) break;
  if (events.some((e) => e.type === "session.status" && e.status.startsWith("failed"))) break;
  await new Promise((r) => setTimeout(r, 500));
}

check("turn settled (idle)", events.some((e) => e.type === "session.status" && e.status === "idle"));
const completed = events.find((e) => e.type === "message.completed");
check("assistant reply collected", completed !== undefined && completed.type === "message.completed" && completed.text.length > 0,
  completed?.type === "message.completed" ? completed.text.slice(0, 120) : undefined);
const usage = events.find((e) => e.type === "usage");
check("usage reported (差值出账)", usage !== undefined && usage.type === "usage" && usage.inputTokens >= 0,
  usage?.type === "usage" ? { input: usage.inputTokens, cost: usage.costUsd, model: usage.model } : undefined);
const ref = session.externalRef();
check("externalRef = hermes UUID", typeof ref === "string" && /^[0-9a-f-]{36}$/i.test(ref ?? ""), ref);
check("models synced from session/new", adapter.models.length >= before, { before, after: adapter.models.length });

await adapter.disconnect();
console.log(failures === 0 ? "\n  all green" : `\n  ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
