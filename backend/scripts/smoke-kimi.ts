/**
 * kimi ACP 适配器冒烟。
 *
 * 两条路径：
 * 1. probe：`kimi --version` ready。
 * 2. headless turn 的**认证闸**：凭据过期/未登录时（本机实测态），session/new 报
 *    -32000 "Authentication required"，适配器必须把它翻译成 executor_auth_required
 *    + `kimi login` 指引，而不是裸协议错误。凭据有效后跑这条会直接走到真实 turn
 *    （与 smoke-hermes 同款断言）。
 *
 * 终端 TUI 直启（executorId="kimi"）单独在 smoke-tui-dst-hermes 里覆盖。
 *
 * 用法：cd backend && npx tsx scripts/smoke-kimi.ts
 */

import { KimiAdapter } from "../src/runtime/adapters/kimi.ts";
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

const probe = await new KimiAdapter().probe();
check("probe ready", probe.state.status === "ready", probe.state);
if (probe.state.status !== "ready") {
  process.exit(1);
}

const adapter = new KimiAdapter();
const events: RuntimeEvent[] = [];

console.log("  .. starting session (model=null → kimi 会话默认)");
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
  const code = (err as { code?: string }).code ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "executor_auth_required" || msg.includes("kimi login")) {
    console.log(`    auth gate (expected when logged out): code=${code}`);
  } else {
    console.error("send failed:", msg);
  }
  events.push({ type: "session.status", sessionId: session.id, status: "failed" } as RuntimeEvent);
});

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "session.status" && (e.status === "idle" || e.status.startsWith("failed")))) break;
  await new Promise((r) => setTimeout(r, 500));
}

const errorEvent = events.find((e) => e.type === "error");
const idleSettled = events.some((e) => e.type === "session.status" && e.status === "idle");
if (idleSettled) {
  // 凭据有效路径：走完一轮真 turn
  const completed = events.find((e) => e.type === "message.completed");
  check("assistant reply collected", completed !== undefined && completed.type === "message.completed" && completed.text.length > 0,
    completed?.type === "message.completed" ? completed.text.slice(0, 120) : undefined);
  const usage = events.find((e) => e.type === "usage");
  check("usage reported (差值出账)", usage !== undefined && usage.type === "usage" && usage.inputTokens >= 0,
    usage?.type === "usage" ? { input: usage.inputTokens, model: usage.model } : undefined);
  check("externalRef = kimi session id", typeof session.externalRef() === "string", session.externalRef());
} else {
  // 登出路径：认证闸必须给出可操作的指引，而不是裸 "Authentication required"
  check("auth gate translated with kimi login hint",
    errorEvent !== undefined && errorEvent.type === "error" && errorEvent.message.includes("kimi login"),
    errorEvent?.type === "error" ? errorEvent.message : undefined);
}

await adapter.disconnect();
console.log(failures === 0 ? "\n  all green" : `\n  ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
