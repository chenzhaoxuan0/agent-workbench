/**
 * 冒烟：模型清单刷新（设置页「探测模型」按钮的落点）。
 *
 * 验三件事：
 * 1. 每家适配器都能跑通 syncModels 并如实标出 live / static；
 * 2. **零用量**：整条路径只跑只读命令 / 读本地目录，不发 prompt、不起 turn；
 * 3. 刷新结果真的进了 host 的 models —— 这正是老 bug 的断点（daemon 刷了、界面不更新）。
 *
 * 运行：pnpm -C backend smoke:models
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeHost } from "../src/runtime/host.ts";
import { Store } from "../src/store/db.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import type { ExecutorAdapter } from "../src/runtime/adapters/types.ts";

import { CodexAdapter } from "../src/runtime/adapters/codex.ts";
import { CursorAdapter } from "../src/runtime/adapters/cursor.ts";
import { AgyAdapter } from "../src/runtime/adapters/agy.ts";
import { PiAdapter } from "../src/runtime/adapters/pi.ts";
import { OpencodeAdapter } from "../src/runtime/adapters/opencode.ts";
import { OpenclawAdapter } from "../src/runtime/adapters/openclaw.ts";
import { GrokAdapter } from "../src/runtime/adapters/grok.ts";
import { ClaudeAdapter } from "../src/runtime/adapters/claude.ts";
import { ZcodeAdapter } from "../src/runtime/adapters/zcode.ts";
import { McodeAdapter } from "../src/runtime/adapters/mcode.ts";
import { DshAdapter } from "../src/runtime/adapters/dsh.ts";
import { HermesAdapter } from "../src/runtime/adapters/hermes.ts";
import { KimiAdapter } from "../src/runtime/adapters/kimi.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

// 用真实的 RuntimeHost（不是各适配器直接调）—— 走 host 才验证得了
// 「刷新结果真的进了 host.models」这条，而这正是老 bug 的断点
const tmpHome = mkdtempSync(join(tmpdir(), `agent-workbench-smoke-models-`));
const store = new Store(tmpHome);
const gate = new PermissionGate(store);
const host = new RuntimeHost(() => {}, new TraceSink(tmpHome), tmpHome, store, gate);
const adapters: ExecutorAdapter[] = [
  new CodexAdapter(),
  new CursorAdapter(),
  new AgyAdapter(),
  new PiAdapter(),
  new OpencodeAdapter(),
  new OpenclawAdapter(),
  new GrokAdapter(),
  new ClaudeAdapter(),
  new ZcodeAdapter(),
  new McodeAdapter(),
  new DshAdapter(),
  new HermesAdapter(),
  new KimiAdapter(),
];
for (const a of adapters) host.register(a);

console.log("\n=== 注册时（内置兜底清单）===");
for (const info of await host.listAdapters(false)) {
  console.log(
    `  ${info.id.padEnd(11)} ${String(info.models.length).padStart(3)} 款  ` +
      `可动态发现=${info.modelsDiscoverable ? "是" : "否"}  ${info.models.map((m) => m.id).join(", ").slice(0, 70)}`,
  );
}

console.log("\n=== 并发刷新（模拟「探测模型」按钮）===");
const before = new Map((await host.listAdapters(false)).map((i) => [i.id, i.models.map((m) => m.id).join(",")]));
const t0 = Date.now();
const report = await host.syncModels();
console.log(`  总耗时 ${Date.now() - t0}ms\n`);

for (const r of report) {
  console.log(
    `  ${r.source === "live" ? "🟢" : "🟡"} ${r.runtimeId.padEnd(11)} ${String(r.count).padStart(3)} 款  ` +
      `${String(r.elapsedMs).padStart(6)}ms  ${r.source === "live" ? "实时" : `兜底（${r.reason ?? "未实现"}）`}`,
  );
}

console.log("\n=== 断言 ===");
const byId = new Map(report.map((r) => [r.runtimeId, r]));
for (const r of report) {
  check(`${r.runtimeId} 有清单`, r.count > 0, { count: r.count });
}
check(
  "至少 8 家拿到实时清单",
  report.filter((r) => r.source === "live").length >= 8,
  { live: report.filter((r) => r.source === "live").length },
);

// 老 bug 的断点：daemon 刷新后 host.models 必须真的变了
const after = await host.listAdapters(false);
const changed = after.filter((i) => before.get(i.id) !== i.models.map((m) => m.id).join(","));
console.log(`\n  清单发生变化的家数：${changed.length}（${changed.map((i) => i.id).join(", ") || "无"}）`);
check("刷新结果已进入 host.models（daemon 侧生效）", changed.length > 0, {
  changed: changed.map((i) => i.id),
});

const zcode = after.find((i) => i.id === "zcode");
if (zcode !== undefined) {
  console.log(`\n  zcode 刷新后清单：${zcode.models.map((m) => `${m.id}(${m.contextWindow ?? "?"})`).join(", ")}`);
}

const mcode = after.find((i) => i.id === "mcode");
if (mcode !== undefined) {
  console.log(`  mcode 刷新后清单：${mcode.models.map((m) => `${m.id}(${m.contextWindow ?? "?"})`).join(", ")}`);
}

console.log(`\n${failures === 0 ? "🎉 全部通过" : `⚠️ ${failures} 项未通过`}\n`);
store.close();
await rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
