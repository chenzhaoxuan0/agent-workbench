/**
 * 记忆系统「生产路径」验收（docs/10 复审）。
 *
 * 存在理由：smoke-memory1~6 **全绿却漏掉了四个阻断级问题**，因为它们只测了
 * 脚手架路径 —— curator 测试注入了生产里根本不传的 `commit`，上限只从 RPC 侧
 * 验而没从注入侧验。本文件专测**生产上真实会走的那些路径**。
 *
 * 逐条对应独立审查抓到的阻断项：
 *   #1 curator 生产路径状态落库 + 报告不说谎
 *   #2 日报窗口期会话不再永久丢失
 *   #3 分发日志写失败不杀掉这一轮对话
 *   #4 2200 上限在 agent 真实写路径上生效（注入侧截断）
 *   #5 注入块过 redact（密钥不进 prompt / 不进库）
 *   #6 daily 的 date 不能穿越路径
 *   #7 遥测前缀里的 _ 不是 LIKE 通配符
 *
 * 用法：cd backend && pnpm smoke:memory7
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeHost } from "../src/runtime/host.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import { MockPermAdapter } from "../src/runtime/adapters/mockperm.ts";
import { Store } from "../src/store/db.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { FileMemoryInjector, truncateToBudget } from "../src/memory/injection.ts";
import { ensureLayout, writeLongTerm, readDaily, MEMORY_TEMPLATE } from "../src/memory/projectMemory.ts";
import { DailyDigest, localDate } from "../src/memory/dailyDigest.ts";
import { runCurator, DEFAULT_CURATOR, MemoryMetaStore, type MemoryMeta, type MemoryState } from "../src/memory/curator.ts";
import { setLogLevel } from "../src/log.ts";
import { asModelId, asUnitId } from "../../prototype/src/core/units.ts";
import type { ScanSource } from "../src/memory/scanner.ts";

setLogLevel("error");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 塞一个不存在的 CLI 名：resolveCommand 立刻失败，curator 的 LLM 审查秒退。 */
const NO_LLM = "definitely-not-a-real-cli-9x7y";
const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory7-"));
const DAY = 86400000;
const now = Date.now();

function meta(p: string, ageDays: number, over: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    path: p, bytes: 120, charUsed: 120, useCount: 3,
    lastUsedAt: now - ageDays * DAY, hitCount: 0, lastHitAt: null,
    state: "active" as MemoryState, pinned: false, createdAt: now - (ageDays + 10) * DAY,
    ...over,
  };
}

async function main(): Promise<void> {
  // ================================================================ #1 curator
  console.log("\n[#1] curator 生产路径：状态真的落库，且不反复算同一条");

  const cHome = path.join(tmp, "cur-home");
  const cRoot = path.join(tmp, "cur-proj");
  mkdirSync(cHome, { recursive: true });
  mkdirSync(cRoot, { recursive: true });
  const store = new MemoryMetaStore();
  store.upsert(meta(path.join(cRoot, "fresh.md"), 1));
  store.upsert(meta(path.join(cRoot, "old.md"), 40));

  // **生产形状**：不传 commit（index.ts / scheduler.ts 就是这么调的）
  const prod1 = await runCurator(cRoot, { meta: store, homeDir: cHome, command: NO_LLM }, DEFAULT_CURATOR, { now });
  check("生产路径算出流转", prod1.transitions.length === 1 && prod1.transitions[0]?.to === "archived", prod1.transitions);
  check("**state 真的落库了**", store.get(path.join(cRoot, "old.md"))?.state === "archived", store.get(path.join(cRoot, "old.md"))?.state);
  check("新鲜的条目保持 active", store.get(path.join(cRoot, "fresh.md"))?.state === "active");

  const prod2 = await runCurator(cRoot, { meta: store, homeDir: cHome, command: NO_LLM }, DEFAULT_CURATOR, { now });
  check("**第二次不再重复算同一条（收敛了）**", prod2.transitions.length === 0, prod2.transitions);

  // dry-run 绝不能落库
  const store2 = new MemoryMetaStore();
  store2.upsert(meta(path.join(cRoot, "old2.md"), 40));
  const dry = await runCurator(cRoot, { meta: store2, homeDir: cHome, command: NO_LLM }, { ...DEFAULT_CURATOR, dryRun: true }, { now });
  check("dry-run 算出了流转", dry.transitions.length === 1);
  check("**dry-run 不落库**（试跑的语义是「只看会发生什么」）", store2.get(path.join(cRoot, "old2.md"))?.state === "active", store2.get(path.join(cRoot, "old2.md"))?.state);

  // 报告不能谎称已应用
  const dryRep = (await import("../src/memory/curator.ts")).renderReport(dry, { ...DEFAULT_CURATOR, dryRun: true });
  check("dry-run 报告明说一条都没执行", dryRep.includes("以上一条都没执行"), dryRep.slice(-160));

  // ================================================================ #4 注入上限
  console.log("\n[#4] 2200 上限在注入侧生效（agent 的真实写路径）");

  const pOver = path.join(tmp, "over-proj");
  mkdirSync(pOver, { recursive: true });
  // **绕过 writeLongTerm 直接写文件** —— 这正是 agent 的真实写路径
  // （它用自带文件工具改 MEMORY.md，完全不经过工作台的 2200 校验）。
  // 用 writeLongTerm 造不出这个状态：它会当场拒绝（那本身是对的，见下面断言）。
  await ensureLayout(pOver);
  const huge = `# 项目记忆\n\n- ${"很长的记忆内容".repeat(900)}\n`;
  writeFileSync(path.join(pOver, "MEMORY.md"), huge, "utf8");
  const overFile = await readFile(path.join(pOver, "MEMORY.md"), "utf8");
  check("夹具确实超限（远大于 2200）", [...overFile].length > 2200 * 2, [...overFile].length);

  // 对照：走工作台 RPC 写同样的内容会被拒（说明上限在那一侧是有效的）
  let rejected = false;
  try {
    await writeLongTerm(path.join(tmp, "over-proj2"), huge, { homeDir: cHome });
  } catch {
    rejected = true;
  }
  check("对照：走工作台写会被拒（上限在 RPC 侧有效）", rejected);

  const inj = new FileMemoryInjector();
  const overInj = await inj.build(pOver, "问题");
  check("超限也注入（不能不注入）", overInj !== null);
  const blockLen = [...(overInj?.block ?? "")].length;
  check("**注入块被截断了**（不再全文进 prompt）", blockLen < [...overFile].length, { block: blockLen, file: [...overFile].length });
  check("截断后仍在可控量级", blockLen < 2200 * 3, blockLen);
  check("截断有显式标记", (overInj?.block ?? "").includes("省略"));
  check("规则文案里说明了已超限", (overInj?.block ?? "").includes("超限"));
  check("**规则文案不再谎称『会拒绝写入』**", !(overInj?.block ?? "").includes("超限会拒绝写入"), "仍写着会拒绝");

  check("truncateToBudget 保留头尾", truncateToBudget("头".repeat(3000), 1000).includes("省略"));
  check("未超限时截断函数是恒等（不误伤）", truncateToBudget("短文本", 2200) === "短文本");

  // ================================================================ #5 注入遮蔽
  console.log("\n[#5] 注入块过 redact");

  const pSec = path.join(tmp, "sec-proj");
  mkdirSync(pSec, { recursive: true });
  await writeLongTerm(pSec, "# 项目记忆\n\n- 部署用的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456\n", { homeDir: cHome });
  const secInj = await inj.build(pSec, "问题");
  check("**注入块里的密钥被遮蔽**", !(secInj?.block ?? "").includes("sk-abcdefghijklmnopqrstuvwxyz123456"), secInj?.block?.slice(0, 200));
  check("遮蔽后仍留前缀便于识别", (secInj?.block ?? "").includes("sk-"));

  // ================================================================ #3 日志写失败
  console.log("\n[#3] 分发日志写失败不杀掉这一轮对话");

  const hHome = path.join(tmp, "host-home");
  const hProj = path.join(tmp, "host-proj");
  mkdirSync(hHome, { recursive: true });
  mkdirSync(hProj, { recursive: true });
  await writeLongTerm(hProj, "# 项目记忆\n\n- 这条用于验证日志写失败不阻断派发\n", { homeDir: hHome });

  const hStore = new Store(hHome);
  const hGate = new PermissionGate(hStore);
  hGate.addRule({ pattern: "mock", decision: "allow" });
  // 注入器正常，但 store 的 insertDispatch 一律炸 —— 模拟 SQLITE_BUSY / 磁盘满
  const realStore = hStore;
  const sabotage = Object.create(realStore) as Store;
  sabotage.insertDispatch = () => { throw new Error("SQLITE_FULL (simulated)"); };
  const host = new RuntimeHost(() => {}, new TraceSink(hHome), hHome, sabotage, hGate, new FileMemoryInjector());
  host.register(new MockPermAdapter());
  const s = await host.startSession({
    runtimeId: "mockperm", unitId: asUnitId("u1"), unitName: "U1", rootPath: hProj,
    prompt: "日志写挂了也必须能干活", model: asModelId("mock-1"), mode: "yolo",
  });
  await sleep(200);
  const asst = host.sessionMessages(s.id as never).find((m) => m.role === "assistant");
  check("**insertDispatch 抛错没有掀翻 startSession**", asst !== undefined, asst?.text?.slice(0, 80));
  check("这一轮对话真的跑完了", (asst?.text ?? "").endsWith("日志写挂了也必须能干活"), asst?.text?.slice(-60));
  check("记忆仍然注入了（模型看到了）", (asst?.text ?? "").includes("日志写失败不阻断派发"), asst?.text?.slice(0, 100));
  hStore.close();

  // ================================================================ #2 日报窗口
  console.log("\n[#2] 日报窗口期会话不再永久丢失");

  const dHome = path.join(tmp, "dig-home");
  const dProj = path.join(tmp, "dig-proj");
  const sessDir = path.join(dHome, ".claude", "projects", "C--dig");
  mkdirSync(dHome, { recursive: true });
  mkdirSync(dProj, { recursive: true });
  mkdirSync(sessDir, { recursive: true });
  const SOURCES: ScanSource[] = [{ cli: "claude", root: path.join(dHome, ".claude", "projects"), maxFieldChars: 2000 }];
  const sessFile = path.join(sessDir, "a.jsonl");
  const row = (t: number, text: string): string =>
    JSON.stringify({ cwd: dProj, sessionId: "s1", message: { content: [{ type: "text", text }] }, timestamp: t });
  writeFileSync(sessFile, row(now - 3600_000, "扫描开始前就已经存在的会话内容，足够长以便通过长度门槛") + "\n", "utf8");

  // 摘要器故意慢，期间追加一条 —— 模拟「用户正聊着，日报正在跑」
  const digest = new DailyDigest(dHome, {
    knownProjects: [dProj], sources: SOURCES,
    summarize: async () => {
      await sleep(400);
      // 此刻追加一条时间戳为「现在」的会话
      const { appendFileSync } = await import("node:fs");
      appendFileSync(sessFile, row(Date.now(), "扫描进行中到达的会话，模拟用户正在聊天时被日报扫过") + "\n", "utf8");
      return "摘要内容";
    },
  });

  const day = localDate();
  const d1 = await digest.run({ date: day });
  check("第一轮跑完", d1.ran, d1);
  // 第二轮：窗口起点 = 第一轮 scanStart，那条「过程中到达」的会话必须还在窗口内
  const d2 = await digest.run({ date: day });
  check("**第二轮仍能扫到它（没被窗口漏掉）**", d2.ran && d2.freshBlocks > 0, d2);

  // ================================================================ #6 日期穿越
  console.log("\n[#6] daily 的 date 不能穿越路径");

  let trav: unknown;
  try {
    await readDaily(dProj, "../../../outside/creds");
  } catch (e) { trav = e; }
  check("穿越型 date 被拒", trav !== undefined && (trav as { code?: string }).code === "bad_params", String((trav as Error)?.message ?? "no throw"));
  check("正常日期不抛错（能读到内容或空）", (await readDaily(dProj, "2026-10-04")).path.endsWith("2026-10-04.md"));

  // ================================================================ #7 LIKE 通配
  console.log("\n[#7] 遥测前缀里的 _ 不是 LIKE 通配符");

  const mStore = new Store(path.join(tmp, "meta-home"));
  const a = "C:/work/my_project";
  const b = "C:/work/myXproject"; // 原本会被 `LIKE 'C:/work/my_project%'` 的 _ 语义漏进来
  mStore.upsertMemoryMeta({ path: `${a}/MEMORY.md`, bytes: 1, charUsed: 1, useCount: 0, lastUsedAt: null, hitCount: 0, lastHitAt: null, state: "active", pinned: false, createdAt: now });
  mStore.upsertMemoryMeta({ path: `${b}/MEMORY.md`, bytes: 1, charUsed: 1, useCount: 0, lastUsedAt: null, hitCount: 0, lastHitAt: null, state: "active", pinned: false, createdAt: now });
  const rows = mStore.listMemoryMeta(a);
  check("**只返回本项目的遥测**", rows.length === 1 && rows[0]?.path === `${a}/MEMORY.md`, rows.map((r) => r.path));
  mStore.close();

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    for (const n of ["cur-home", "host-home"]) {
      try { rmSync(path.join(tmp, n), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(failures === 0 ? 0 : 1);
  });
