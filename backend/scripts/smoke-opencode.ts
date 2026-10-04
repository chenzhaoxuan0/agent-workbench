/**
 * opencode ACP 适配器冒烟：直接驱动 OpencodeAdapter 走一轮真 turn。
 *
 * 链路：spawn `opencode acp` → initialize → session/new →（model=null 跟随执行器
 * 默认，跳过 set_config_option）→ session/prompt → session/update 翻译 →
 * stopReason 落定 → usage 差值出账。
 *
 * 模型用 opencode 默认（实测 opencode/big-pickle，OpenCode Zen 免费档），不烧套餐额度。
 * 任何一步失败都以非零码退出。
 *
 * 用法：cd backend && pnpm smoke:opencode
 */

import { OpencodeAdapter } from "../src/runtime/adapters/opencode.ts";
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

const probe = await new OpencodeAdapter().probe();
check("probe ready", probe.state.status === "ready", probe.state);
if (probe.state.status !== "ready") {
  process.exit(1);
}

const adapter = new OpencodeAdapter();
const events: RuntimeEvent[] = [];

console.log("  .. starting session (model=null → 执行器默认)");
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

const deadline = Date.now() + 120_000;
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
check("externalRef = opencode ses_ id", typeof session.externalRef() === "string" && session.externalRef()!.startsWith("ses_"), session.externalRef());

await adapter.disconnect();
console.log(failures === 0 ? "\n  all green" : `\n  ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
