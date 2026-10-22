/**
 * Context Manifest 冒烟（docs/20 验收自查 + ADR 0014）：
 *
 *   纯函数级验证注入矩阵的真实行为，不起 daemon：
 *   1. normalizeContextManifest：存量归一（整节缺失 = LEGACY）vs 字段级缺省（= false）
 *   2. FileMemoryInjector：
 *      a. 全关（裸跑）→ null（零注入是合法结果）
 *      b. legacy 无 plan → semantic 默认注入 + STANDING 存在即注入
 *      c. plan 全开 → 六节齐全且顺序 AGENTS→SOUL→USER→MEMORY→daily→STANDING
 *      d. /mem 显式覆盖（scopes）只替换记忆两柱，soul/user 不受影响
 *      e. 空模板文件不注入（占位行不算真实记忆）
 *   3. BotRegistry.putBot：persona 迁移物化为 SOUL.md + 剥离 persona；hydrate 归一 manifest
 *
 * 用法：cd backend && pnpm smoke:context
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeContextManifest,
  LEGACY_CONTEXT_MANIFEST,
  resolveAgentsMdInjection,
} from "../../prototype/src/core/units.ts";
import { FileMemoryInjector } from "../src/memory/injection.ts";
import { writeUser } from "../src/memory/projectMemory.ts";
import { BotRegistry } from "../src/bots/registry.ts";
import type { Store } from "../src/store/db.ts";

let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// kv 内存桩：BotRegistry 只用 kvGet/kvSet（扫描根目录清单）
function fakeStore(): Store {
  const kv = new Map<string, string>();
  return {
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => void kv.set(k, v),
  } as unknown as Store;
}

async function main(): Promise<void> {
  // ---- 1. 归一语义 --------------------------------------------------------
  console.log("[1] normalizeContextManifest");
  const legacy = normalizeContextManifest(undefined);
  ok(
    legacy.memorySemantic === false && legacy.memoryStanding === false && legacy.soul === false && legacy.agentsMd === "auto",
    "整节缺失 = 全关（2026-10-22 定夺：默认注入一律 0，取消存量兼容 seeding）",
  );
  const malformed = normalizeContextManifest("garbage");
  ok(malformed.memorySemantic === false, "畸形节同样归全关");
  const bare = normalizeContextManifest({});
  ok(bare.soul === false && bare.user === false && bare.memorySemantic === false && bare.agentsMd === "auto", "节存在但字段缺 = 同一全关语义（agentsMd=auto）");
  const explicit = normalizeContextManifest({ soul: true, agentsMd: "on", memoryDaily: 1 });
  ok(explicit.soul === true && explicit.agentsMd === "on" && explicit.memoryDaily === false, "脏值字段归 false，合法值保留");

  // ---- auto 判定 ----------------------------------------------------------
  console.log("[2] resolveAgentsMdInjection");
  ok(resolveAgentsMdInjection("auto", true) === false, "auto + 原生读取 → 不注入（防双注）");
  ok(resolveAgentsMdInjection("auto", false) === true, "auto + 未声明 → 工作台兜底注入");
  ok(resolveAgentsMdInjection("on", true) === true, "on 强制注入");
  ok(resolveAgentsMdInjection("off", false) === false, "off 永不注入");

  // ---- 3. 注入器 ----------------------------------------------------------
  const tmp = await mkdtemp(path.join(tmpdir(), "aw-ctx-"));
  const home = await mkdtemp(path.join(tmpdir(), "aw-home-"));
  try {
    await writeFile(path.join(tmp, "AGENTS.md"), "# 岗位\n\n- 只用中文回复\n", "utf8");
    await writeFile(path.join(tmp, "SOUL.md"), "你是仓库管家，语气克制。", "utf8");
    await writeFile(path.join(tmp, "MEMORY.md"), "# 项目记忆\n\n- 部署用 pnpm，别用 npm\n", "utf8");
    await writeFile(path.join(tmp, "STANDING.md"), "# Standing\n\n- 禁止 rm -rf\n", "utf8");
    await mkdir(path.join(tmp, "memory", "daily"), { recursive: true });
    // localDate() 是本地时区日期，toISOString 是 UTC —— 两边在傍晚会差一天，必须同源
    const { localDate } = await import("../src/memory/dailyDigest.ts");
    await writeFile(path.join(tmp, "memory", "daily", `${localDate()}.md`), "- 今天修好了登录超时", "utf8");
    await writeUser(home, "- 用户在东八区，深夜别发通知\n");

    const injector = new FileMemoryInjector(home);

    console.log("[3] FileMemoryInjector");
    // 3a. 裸跑
    const bareRun = await injector.build(tmp, "干活", {
      plan: { agentsMd: false, soul: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
    });
    ok(bareRun === null, "全关 → 零注入（null）");

    // 3b. legacy（无 plan 无 scopes）→ semantic + standing
    const legacyRun = await injector.build(tmp, "干活");
    const legacyScopes = (legacyRun?.parts ?? []).map((p) => p.scope);
    ok(legacyScopes.join(",") === "semantic,standing", `legacy 默认 = semantic+standing（实际 ${legacyScopes}）`);

    // 3c. 全开 → 六节 + 顺序
    const full = await injector.build(tmp, "干活", {
      plan: { agentsMd: true, soul: true, user: true, memorySemantic: true, memoryDaily: true, memoryStanding: true, skills: false },
    });
    const scopes = (full?.parts ?? []).map((p) => p.scope);
    ok(scopes.join(",") === "agents,soul,user,semantic,daily,standing", `全开六节且顺序正确（实际 ${scopes}）`);
    ok((full?.block.indexOf("岗位说明书") ?? -1) < (full?.block.indexOf("人设") ?? -1), "AGENTS 兜底节在 SOUL 之前");
    ok((full?.block.lastIndexOf("常驻指令") ?? -1) > (full?.block.indexOf("MEMORY.md 的当前内容") ?? -1), "STANDING 红线压轴");

    // 3d. scopes 覆盖只换记忆两柱
    const overridden = await injector.build(tmp, "干活", {
      plan: { agentsMd: false, soul: true, user: true, memorySemantic: true, memoryDaily: true, memoryStanding: true, skills: false },
      scopes: ["daily"],
    });
    const oScopes = (overridden?.parts ?? []).map((p) => p.scope);
    ok(oScopes.join(",") === "soul,user,daily,standing", `/mem 覆盖替换记忆两柱、soul/user 不动（实际 ${oScopes}）`);

    // 3e. 空模板不注入
    const emptyDir = await mkdtemp(path.join(tmpdir(), "aw-empty-"));
    try {
      await writeFile(path.join(emptyDir, "MEMORY.md"), "# 项目记忆\n\n- （把项目级事实写在这里：约定、环境、教训。每行一条。）\n", "utf8");
      const emptyRun = await injector.build(emptyDir, "干活", {
        plan: { agentsMd: false, soul: false, user: false, memorySemantic: true, memoryDaily: false, memoryStanding: false, skills: false },
      });
      ok(emptyRun === null, "只有模板占位的 MEMORY.md 不注入");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }

    // 3f. 技能目录注入：项目级技能源 + 名单过滤（ADR 0014 D8）
    const skillDir = path.join(tmp, ".agents", "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: Demo Skill\ndescription: 演示\n---\n\n用法……\n", "utf8");
    const skillsAll = await injector.build(tmp, "干活", {
      plan: { agentsMd: false, soul: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: true },
    });
    ok(
      (skillsAll?.parts ?? []).some((p) => p.scope === "skills") === true && (skillsAll?.block.includes("Demo Skill") ?? false),
      "plan.skills → 注入目录（含项目级技能源，name + 路径）",
    );
    const skillsFiltered = await injector.build(tmp, "干活", {
      plan: { agentsMd: false, soul: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: true },
      skills: { enabled: ["not-a-skill"] },
    });
    ok(skillsFiltered === null, "名单外技能被过滤（目录节为空则整块为 null）");
    const skillsOff = await injector.build(tmp, "干活", {
      plan: { agentsMd: false, soul: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
    });
    ok(skillsOff === null, "skills 关 → 不注入目录");

    // ---- 4. registry：persona 迁移 + manifest 归一 -------------------------
    console.log("[4] BotRegistry.putBot / hydrate");
    const store = fakeStore();
    const reg = new BotRegistry(store);
    const botRoot = path.join(home, "bot-a");
    await mkdir(path.join(botRoot, ".agent-workbench"), { recursive: true });
    await reg.putBot(
      {
        id: "bot-a",
        rootPath: botRoot,
        name: "A",
        identity: { role: "管家", persona: "语气克制。", sourcePath: "AGENTS.md", loadedAt: 1 },
      },
      { createRoot: true },
    );
    const soulOnDisk = await readFile(path.join(botRoot, "SOUL.md"), "utf8");
    ok(soulOnDisk === "语气克制。", "persona 物化为 SOUL.md");
    const stored = JSON.parse(await readFile(path.join(botRoot, ".agent-workbench", "bot.json"), "utf8")) as Record<string, unknown>;
    ok((stored.identity as { persona?: unknown }).persona === undefined, "persona 字段从 bot.json 剥离");

    // hydrate：老 bot.json 无 contextManifest → 存量语义
    await reg.putBot({ id: "bot-a", rootPath: botRoot, name: "A", soulMd: "语气克制。" });
    const hydrated = await reg.getBot("bot-a");
    const hm = normalizeContextManifest(hydrated?.contextManifest);
    ok(hm.memorySemantic === false && hm.agentsMd === "auto", "存量 bot hydrate 同样归全关（无 manifest 节 = 裸跑）");
    ok(typeof hydrated?.soulMd === "string" && hydrated.soulMd.includes("语气克制"), "hydrate 读回 SOUL.md 正文");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
