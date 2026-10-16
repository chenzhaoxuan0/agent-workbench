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

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeHost } from "../src/runtime/host.ts";
import { Store } from "../src/store/db.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import type { ExecutorAdapter, ExecutorModelInfo, ModelSyncOutcome } from "../src/runtime/adapters/types.ts";
import type { RuntimeCapabilities, ModelId, ProbeResult } from "../src/contract.ts";
import type { AdapterSession } from "../src/runtime/adapters/types.ts";

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
/**
 * 新一批适配器实例。
 *
 * 必须是**新实例**：模拟冷启动重放的是「daemon 刚起来、适配器内置清单只有
 * 种子、还没探测过」这个状态。复用上一轮那批实例等于让它带着上一轮的
 * 内存态，测的就不是冷启动了。
 *
 * 第一轮注册和冷启动重放共用这一份工厂 —— 两处各抄一遍 12 个 new 是纯重复，
 * 加执行器时漏抄一处，这个 smoke 就悄悄少测一家。
 */
function freshAdapters(): ExecutorAdapter[] {
  return [
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
}
const adapters: ExecutorAdapter[] = freshAdapters();
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

// ============================================================================
// 冷启动回归 —— 本 smoke 原本**完全没覆盖**的那一段
//
// 原脚本只验「单进程内 syncModels() 真的改了 host.models」：从不重建 host、
// 从不验证任何盘上产物。于是「重新探测过 → 关掉应用 → 重开 → 又变回第一次
// 探测的结果」这个 bug 恰好从它眼皮底下过去了。
//
// 下面用一只假执行器把这段单独钉死，不依赖任何真实 CLI，跑得飞快也跑得稳。
// ============================================================================

const SEED: readonly ExecutorModelInfo[] = [{ id: "seed-only" as ModelId, displayName: "内置种子模型" }];
const LIVE: readonly ExecutorModelInfo[] = [
  { id: "live-a" as ModelId, displayName: "实时模型 A" },
  { id: "live-b" as ModelId, displayName: "实时模型 B" },
];

class FakeAdapter implements ExecutorAdapter {
  readonly id = "fake";
  readonly displayName = "假执行器";
  readonly glyph = "F";
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: false,
    fileDiff: false,
    terminal: false,
    permissions: false,
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: false,
    usage: false,
    multimodal: false,
    streaming: "batch",
    steering: "turn-end",
  };

  constructor(private readonly mode: "live" | "throw") {}

  /** 派发断言用：host 到底把哪个 model 交给了适配器（复审 P0 回归） */
  lastStartModel: ModelId | null | undefined;

  /** 永远只有内置种子 —— 模拟「daemon 刚起来、还没探测过」的原始状态 */
  get models(): readonly ExecutorModelInfo[] {
    return SEED;
  }

  async syncModels(): Promise<ModelSyncOutcome> {
    if (this.mode === "throw") throw new Error("模拟 CLI 不可达");
    return { models: LIVE, source: "live", elapsedMs: 1 };
  }

  async probe(): Promise<ProbeResult> {
    return { state: { status: "ready" }, elapsedMs: 0 };
  }
  async start(req: { model: ModelId | null }): Promise<AdapterSession> {
    this.lastStartModel = req.model;
    const sid = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id: sid as AdapterSession["id"],
      send: async () => {},
      cancel: async () => {},
      resolvePermission: async () => {},
      externalRef: () => null,
    };
  }
  resumeSession(): AdapterSession {
    throw new Error("假执行器不续会话");
  }
  reattach(): AdapterSession {
    throw new Error("假执行器不接回会话");
  }
  async disconnect(): Promise<void> {}
}

const fakeHome = mkdtempSync(join(tmpdir(), `agent-workbench-smoke-models-fake-`));
const fakeStore = new Store(fakeHome);
const fakeGate = new PermissionGate(fakeStore);
const newFakeHost = (mode: "live" | "throw", home = fakeHome): RuntimeHost => {
  const h = new RuntimeHost(() => {}, new TraceSink(join(home, "traces")), home, fakeStore, fakeGate);
  h.register(new FakeAdapter(mode));
  return h;
};

console.log("\n=== 冷启动回归：假执行器（不依赖真实 CLI）===");

// 第一轮：探测成功 → models-cache.json 应当落盘
const h1 = newFakeHost("live");
const r1 = (await h1.syncModels())[0]!;
check("首轮探测拿到实时清单", r1.source === "live" && r1.count === 2, { source: r1.source, count: r1.count });
check("首轮没有兜底标记", r1.cachedAt === undefined);
check("models-cache.json 已落盘", existsSync(join(fakeHome, "models-cache.json")));

// 本进程刚探成功的那一份**不是兜底**：界面该显示「· 实时」而不是
// 「· 来自上次探测 0 秒前」。这条曾经真的错过 —— listAdapters 只看
// 「缓存里有没有」，于是实时成功后仍把最新结果说成旧的。
const listed1 = (await h1.listAdapters(false))[0]!;
check("本进程实时探成功后不带兜底标记", listed1.modelsCachedAt === undefined, {
  modelsCachedAt: listed1.modelsCachedAt,
});
check("实时成功后清单仍是那 2 款", listed1.models.length === 2);

// 第二轮：**重建 host**（= 重启 daemon），适配器退回到只有种子的状态，探测又失败
const h2 = newFakeHost("throw");
const listed2 = (await h2.listAdapters(false))[0]!;
check("重启后清单仍是实时结果，不是内置种子", listed2.models.length === 2, {
  models: listed2.models.map((m) => m.id),
});
check("重启后带上了兜底时间标记", typeof listed2.modelsCachedAt === "number");

const r2 = (await h2.syncModels())[0]!;
check("探测失败时 source 如实为 static", r2.source === "static", { source: r2.source, reason: r2.reason });
check("探测失败时沿用兜底清单（2 款，不是 1 款种子）", r2.count === 2, { count: r2.count });
check("探测失败时带 cachedAt，界面据此显示「来自上次探测」", typeof r2.cachedAt === "number");
check(
  "失败原因里写明沿用了上次结果",
  typeof r2.reason === "string" && r2.reason.includes("沿用上次探测结果"),
  { reason: r2.reason },
);

// 派发回归（复审 P0）：冷启动后（适配器只有种子、盘上有缓存）用缓存内的模型
// 派发，host 不得把它静默换成种子第一档 —— 展示面（listAdapters 吐缓存）与
// 派发面（resolveModelFor 的判定清单）必须同源。这条 bug 的样子：界面选的是
// live-b，发出去实际跑的是 seed-only（还可能是全家最贵的旗舰档），用户毫无感知。
{
  const fakeDispatch = new FakeAdapter("throw");
  const h2b = new RuntimeHost(() => {}, new TraceSink(join(fakeHome, "traces-dispatch")), fakeHome, fakeStore, fakeGate);
  h2b.register(fakeDispatch);
  const s = await h2b.startSession({
    runtimeId: "fake",
    unitId: "unit-smoke" as Parameters<typeof h2b.startSession>[0]["unitId"],
    unitName: "smoke",
    rootPath: fakeHome,
    prompt: "派发回归",
    model: "live-b" as ModelId,
  });
  check(
    "冷启动后派发缓存内模型不被换成种子第一档",
    s.modelActual === "live-b" && fakeDispatch.lastStartModel === "live-b",
    { modelActual: s.modelActual, adapterGot: fakeDispatch.lastStartModel },
  );
}

// 反向对照：**没有**缓存文件的全新 home，只能退回种子 —— 证明上面确实是缓存在起作用
const bareHome = mkdtempSync(join(tmpdir(), `agent-workbench-smoke-models-bare-`));
const h3 = new RuntimeHost(() => {}, new TraceSink(join(bareHome, "traces")), bareHome, fakeStore, fakeGate);
h3.register(new FakeAdapter("throw"));
const listed3 = (await h3.listAdapters(false))[0]!;
check("对照组：空 home 下退回内置种子清单", listed3.models.length === 1 && listed3.models[0]?.id === "seed-only", {
  models: listed3.models.map((m) => m.id),
});
check("对照组：空 home 下没有兜底时间标记", listed3.modelsCachedAt === undefined);

// ⚠ 这条曾经真的漏过：预置一份**内容相同但很旧**的缓存，再实时探一次。
// 若 putModelCache 只按「内容变了没」早退，fromDisk 就一直是 true，于是
//   ① listAdapters 报出一个陈旧时间戳 → 界面刚实时探到却挂「来自上次探测 1 小时前」；
//   ② 前端拿这个标记当「本轮不是实时」的判据 → 跳过失效模型对齐，
//      清单稳定的执行器（大多数执行器大多数时候都稳定）永远检测不到模型下线。
// 也就是说：整个「只在 live 时才认定失效」的机制会被静默关掉，而且界面上看不出来。
{
  const staleHome = mkdtempSync(join(tmpdir(), `agent-workbench-smoke-models-stale-`));
  writeFileSync(
    join(staleHome, "models-cache.json"),
    JSON.stringify({
      fake: { models: LIVE.map((m) => ({ ...m })), at: Date.now() - 3_600_000 }, // 一小时前
    }),
    "utf8",
  );
  const h4b = new RuntimeHost(() => {}, new TraceSink(join(staleHome, "traces")), staleHome, fakeStore, fakeGate);
  h4b.register(new FakeAdapter("live"));

  const staleListed = (await h4b.listAdapters(false))[0]!;
  check("预置旧缓存时确实标了兜底", typeof staleListed.modelsCachedAt === "number", {
    cachedAt: staleListed.modelsCachedAt,
  });

  await h4b.syncModels(); // 内容与缓存完全一致的实时探测
  const refreshed = (await h4b.listAdapters(false))[0]!;
  check("内容相同的实时探测后，不再被标成兜底", refreshed.modelsCachedAt === undefined, {
    cachedAt: refreshed.modelsCachedAt,
  });
  check("实时探测后清单仍是那 2 款", refreshed.models.length === 2);

  const onDisk = JSON.parse(readFileSync(join(staleHome, "models-cache.json"), "utf8")) as Record<
    string,
    { at: number }
  >;
  check(
    "磁盘上的 at 被刷新成本次验证时刻（不是留着一小时前）",
    typeof onDisk.fake?.at === "number" && onDisk.fake.at > Date.now() - 60_000,
    { at: onDisk.fake?.at },
  );
  await rm(staleHome, { recursive: true, force: true }).catch(() => undefined);
}

console.log("\n=== 冷启动回归：真实执行器（重建 host 后与首轮探测一致）===");
const h4 = new RuntimeHost(() => {}, new TraceSink(join(tmpHome, "traces2")), tmpHome, store, gate);
for (const a of freshAdapters()) h4.register(a);
const relisted = await h4.listAdapters(false);
const round1 = new Map(after.map((i) => [i.id, i.models.map((m) => m.id).join(",")]));
const drifted = relisted.filter((i) => round1.get(i.id) !== i.models.map((m) => m.id).join(","));
check("重启后各家清单与首轮实时探测完全一致", drifted.length === 0, {
  drifted: drifted.map((i) => `${i.id}: ${round1.get(i.id)?.split(",").length} → ${i.models.length}`),
});
const cachedMarked = relisted.filter((i) => i.modelsCachedAt !== undefined).length;
// 判据用**相对量**而不是「≥8 家」这种魔数：换台机器、装了几个 CLI 都会让绝对值漂。
// 要验的是「凡是首轮真探到的，重启后都带着兜底标记」这条对应关系，不是具体家数。
const liveIds = report.filter((r) => r.source === "live").map((r) => r.runtimeId);
const liveButUnmarked = liveIds.filter((id) => relisted.find((i) => i.id === id)?.modelsCachedAt === undefined);
console.log(`  ${relisted.length} 家中 ${cachedMarked} 家带「来自上次探测」标记（首轮 live 的有 ${liveIds.length} 家）`);
check("凡是首轮真探到的，重启后都带兜底标记", liveButUnmarked.length === 0, { liveButUnmarked });

fakeStore.close();
await rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
await rm(bareHome, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n${failures === 0 ? "🎉 全部通过" : `⚠️ ${failures} 项未通过`}\n`);
store.close();
await rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
