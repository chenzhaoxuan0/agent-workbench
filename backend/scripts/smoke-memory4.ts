/**
 * 记忆系统 WP-6 + WP-7 验收 —— 每日总结任务 + 总管 bot 与检索权限（docs/10 §4.5 / §4.6）。
 *
 * [日报] 增量 / 幂等 / 失败不阻塞 / 归属解析不了就不写 / dryRun
 * [管家] 默认开检索、其他 bot 默认关、开关有效、初始化幂等
 * [红线6] **搜到 ≠ 注入** —— 跨项目检索结果流不进项目 bot 的 prompt
 *
 * 用法：cd backend && pnpm smoke:memory4
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DailyDigest, localDate, renderDaily, buildSummaryPrompt } from "../src/memory/dailyDigest.ts";
import {
  ensureSteward, stewardRoot, stewardDefinition, authorityOf, canCrossSearch,
  CrossSearchDenied, stewardSearch, STEWARD_ID, stewardRecent,
} from "../src/memory/steward.ts";
import { FileMemoryInjector } from "../src/memory/injection.ts";
import { ensureLayout, writeLongTerm, readLongTerm, readDaily } from "../src/memory/projectMemory.ts";
import { setLogLevel } from "../src/log.ts";
import type { ScanSource } from "../src/memory/scanner.ts";
import type { ScannedBlock } from "../src/memory/scanner.ts";

setLogLevel("error");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory4-"));
const home = path.join(tmp, "home");
const proj = path.join(tmp, "project-demo");
const sessRoot = path.join(tmp, "home", ".claude", "projects", "C--demo");
const SOURCES: ScanSource[] = [{ cli: "claude", root: sessRoot, maxFieldChars: 2000 }];

mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(sessRoot, { recursive: true });

// 造一天的会话：cwd 指向 proj
const now = Date.now();
writeFileSync(
  path.join(sessRoot, "s.jsonl"),
  [
    { cwd: proj, sessionId: "s1", message: { content: [{ type: "text", text: "今天把记忆系统接进了 host.ts，注入点定在 startSession。" }] }, timestamp: now - 3600_000 },
    { cwd: proj, sessionId: "s1", message: { content: [{ type: "text", text: "踩了个坑：续聊不能重复注入，否则前缀缓存会碎掉。" }] }, timestamp: now - 1800_000 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  "utf8",
);
// 另一条 cwd 解析不出来的会话（不该被写进任何项目）
writeFileSync(
  path.join(sessRoot, "unknown.jsonl"),
  JSON.stringify({ sessionId: "s2", message: { content: [{ type: "text", text: "这条没有 cwd 字段，不该被写进任何项目。" }] }, timestamp: now - 900_000 }) + "\n",
  "utf8",
);

async function main(): Promise<void> {
  const today = localDate();

  // ---------------------------------------------------------------- [日报]
  console.log("\n[日报] 每日总结任务");

  let called = 0;
  const digest = new DailyDigest(home, {
    knownProjects: [proj],
    sources: SOURCES,
    summarize: async (blocks) => {
      called++;
      return `## 结论\n- 记忆系统接进 host.ts，注入点定在 startSession（${blocks.length} 块）\n- 续聊不重复注入是硬要求`;
    },
  });

  const r1 = await digest.run({ date: today });
  check("第一次跑成功", r1.ran, r1);
  check("摘要器被调用", called === 1, called);
  check("日报写进项目文件夹", r1.wrote.some((w) => w === path.join(proj, "memory", "daily", `${today}.md`)), r1.wrote);
  check("无 cwd 的会话没被写进任何项目", r1.wrote.length === 1, r1.wrote);
  const body = (await readDaily(proj, today)).content;
  check("日报含标题与项目名", body.includes(`# ${today} 会话摘要`) && body.includes("project-demo"));
  check("日报含摘要正文", body.includes("注入点定在 startSession"));
  check("台账已落盘", existsSync(path.join(home, "digest-state.json")));

  // 幂等：force 重扫（无 force 时第二次本来就无事可做，那是增量而不是幂等）
  const r2 = await digest.run({ date: today, force: true });
  check("同日 force 重跑整份重写（不追加）", r2.ran && !readFileSync(path.join(proj, "memory", "daily", `${today}.md`), "utf8").includes(today + today), r2);
  const body2 = (await readDaily(proj, today)).content;
  check("重跑后内容长度不变（无重复段）", body2.length === body.length, { a: body.length, b: body2.length });

  // 增量：窗口起点 = 上一轮的 scanStart，所以**允许少量重叠**（这是修掉
  // 「窗口期会话永久丢失」后的正确语义）。日报是整份重写，重叠无害 ——
  // 要断言的是「不丢」和「不重复」，不是「第二次扫不到东西」。
  const r3 = await digest.run({ date: today });
  check("无 force 时窗口落在上一轮起点（不丢会话）", r3.ran && r3.freshBlocks > 0, r3);
  const body3 = (await readDaily(proj, today)).content;
  check("**重叠重跑后日报内容仍与首次一致（不重复累加）**", body3 === body, { a: body.length, b: body3.length });

  // force：无视台账重扫
  const r4 = await digest.run({ date: today, force: true });
  check("force 能无视台账重扫", r4.ran && r4.freshBlocks > 0, r4);

  // dryRun：只报不写（knownProjects 必须真的匹配 fixture 的 cwd）
  {
    const before = (await readDaily(proj, today)).content;
    const d5 = new DailyDigest(path.join(tmp, "home-dry"), {
      knownProjects: [proj], sources: SOURCES, summarize: async () => "dry-run 不会写盘的内容",
    });
    const dr = await d5.run({ date: today, dryRun: true, force: true });
    check("dryRun 标记将要写的路径", dr.wrote.length === 1, dr);
    check("**dryRun 不改磁盘**", (await readDaily(proj, today)).content === before);
    check("dryRun 不落台账", !existsSync(path.join(tmp, "home-dry", "digest-state.json")));
  }

  // 失败不阻塞：摘要器抛错
  {
    const boom = new DailyDigest(path.join(tmp, "home-boom"), {
      knownProjects: [proj], sources: SOURCES,
      summarize: async () => { throw new Error("摘要器炸了"); },
    });
    const br = await boom.run({ date: today, force: true });
    check("摘要器抛错不往上抛", br.error === undefined, br);
    check("摘要器抛错 → 记进 skipped", br.skipped.some((s) => s.reason.includes("摘要器")), br.skipped);
    check("摘要器抛错不影响已写的其他项目", existsSync(path.join(proj, "memory", "daily", `${today}.md`)));
  }

  // 没有可归属的会话时干净退出
  {
    const d3 = new DailyDigest(path.join(tmp, "home-none"), { knownProjects: [], sources: SOURCES });
    const nr = await d3.run({ date: today, force: true });
    check("无可归属会话 → 干净跳过", nr.ran === false && nr.skipReason !== undefined, nr);
  }

  // 提示词里必须写清「不要写流水账」
  check("摘要提示词要求只留值得留的", buildSummaryPrompt("X", { date: today, project: proj }).includes("不要写"));
  check("renderDaily 标注自动生成", renderDaily({ date: today, project: proj, summary: "s", blockCount: 1, clis: ["claude"] }).includes("自动生成"));

  // ---------------------------------------------------------------- [管家]
  console.log("\n[管家] 权限模型");

  const none = authorityOf(undefined);
  check("无定义 → 普通 bot + 检索关", none.role === "normal" && none.crossSearch === false);
  const normal = authorityOf({ id: "b1" });
  check("普通 bot 默认没有检索权", !canCrossSearch(normal));
  const opt = authorityOf({ id: "b1", crossSearch: true });
  check("显式开开关后可以检索", canCrossSearch(opt));
  const stewardDef = stewardDefinition(stewardRoot(home));
  check("管家默认有检索权", canCrossSearch(stewardDef));
  check("管家角色识别正确", authorityOf(stewardDef).role === "steward");
  check("管家 id 固定", STEWARD_ID === "steward");

  // 初始化幂等
  const s1 = await ensureSteward(home);
  const s2 = await ensureSteward(home);
  check("ensureSteward 幂等", s1.rootPath === s2.rootPath && s2.created === false);
  check("管家有自己的 MEMORY.md", existsSync(path.join(stewardRoot(home), "MEMORY.md")));
  check("管家目录在工作台 home 下、不占用户项目", stewardRoot(home).startsWith(home));

  // 权限在入口钉死
  let denied: unknown;
  try {
    await stewardSearch({ id: "normal-bot" }, { query: "记忆", sources: SOURCES });
  } catch (e) {
    denied = e;
  }
  check("**无权 bot 搜索直接抛错**", denied instanceof CrossSearchDenied);
  check("报错说明了为什么默认关", (denied as Error).message.includes("信任"));
  check("报错给出了两条出路", (denied as Error).message.includes("crossSearch") && (denied as Error).message.includes("管家"));

  // 有权能搜
  const ok = await stewardSearch(stewardDef, { query: "记忆", sources: SOURCES, limit: 5 });
  check("管家能搜到东西", ok.hits.length > 0, { n: ok.hits.length, byCli: ok.byCli });
  check("结果带完整归属", ok.hits.every((h) => h.cli !== "" && h.at !== "" && h.srcPath !== "" && h.lineNo > 0));
  check("project 字段来自 cwd", ok.hits.some((h) => h.project !== null));
  check("scoped 标记存在", typeof ok.scoped === "boolean");

  // 开关打开的普通 bot 也能搜
  const ok2 = await stewardSearch({ id: "b1", crossSearch: true }, { query: "记忆", sources: SOURCES, limit: 3 });
  check("开开关的普通 bot 能搜", ok2.hits.length > 0);

  // withContext
  const withCtx = await stewardSearch(stewardDef, { query: "注入", sources: SOURCES, limit: 2, withContext: true });
  check("withContext 能翻出上下文", withCtx.hits.some((h) => h.context.length > 0));

  // ---------------------------------------------------------------- [红线 6]
  console.log("\n[红线 6] 搜到 ≠ 注入");

  // A 项目的记忆
  await writeLongTerm(proj, "# 项目记忆\n\n- A 项目的秘密：这个仓库用 pnpm 不用 npm\n", { homeDir: home });
  // B 项目的记忆（模拟"另一个项目"）
  // 标记必须绝对独特 —— 规则模板的示例句里就有 pnpm / vitest / npm 这类词
  // （上一轮就是拿 "vitest" 当标记，撞上模板自己，误报了两次）
  const B_MARK = "ZQXB7749";
  const projB = path.join(tmp, "project-b");
  mkdirSync(projB, { recursive: true });
  await writeLongTerm(projB, `# 项目记忆\n\n- B 项目的秘密标记：${B_MARK}\n`, { homeDir: home });

  const inj = new FileMemoryInjector();
  const injectedA = await inj.build(proj, "帮我看下依赖");
  const injectedB = await inj.build(projB, "B 的问题");
  check("A 的注入块含 A 自己的记忆", (injectedA?.block ?? "").includes("pnpm"));
  check("B 的注入块含 B 自己的记忆", (injectedB?.block ?? "").includes(B_MARK));
  check("**A 的注入块不含 B 的记忆**", !(injectedA?.block ?? "").includes(B_MARK));

  // 就算把检索结果直接递进来，也不能被拼进注入块
  const searchResultText = ok.hits.map((h) => h.text).join("\n");
  const inj2 = await inj.build(proj, searchResultText);
  check("检索结果作为用户输入时，注入块仍只含本项目记忆", (inj2?.block ?? "").includes("pnpm") && !(inj2?.block ?? "").includes(B_MARK));
  check("注入块体量与检索结果无关（检索永不进记忆）", (inj2?.block.length ?? 0) <= (injectedA?.block.length ?? 0) + 80, { inj2: inj2?.block.length, inj1: injectedA?.block.length });

  // 管家自己的记忆也不会被塞进 A
  check("管家记忆不进 A", !(injectedA?.block ?? "").includes("steward"));

  // stewardRecent
  const recent = await stewardRecent(home, 5);
  check("stewardRecent 读管家日报（当前为空也算正常）", Array.isArray(recent));

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(failures === 0 ? 0 : 1);
  });
