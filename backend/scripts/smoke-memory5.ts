/**
 * 记忆系统 WP-9 验收 —— curator 状态机（docs/10 §4.7）。
 *
 * 六条纪律逐条验：
 *   永不删除（只归档）· 动手前备份 · pinned 全跳过 · 空闲触发非 cron
 *   首次推迟一整个间隔 · dry-run 不写盘
 * 加上：LLM 审查只提建议不执行、模型编的路径一律丢弃、异常不掀翻 daemon
 *
 * 用法：cd backend && pnpm smoke:memory5
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  planTransitions, shouldRun, runCurator, renderReport, restore, buildReviewPrompt,
  MemoryMetaStore, DEFAULT_CURATOR, type MemoryMeta, type MemoryState, type CuratorConfig,
} from "../src/memory/curator.ts";
import { setLogLevel } from "../src/log.ts";

setLogLevel("error");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory5-"));
const home = path.join(tmp, "home");
const root = path.join(tmp, "project");
mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });

/** 塞一个不存在的 CLI 名：resolveCommand 立刻失败，LLM 审查秒退。 */
const NO_LLM = "definitely-not-a-real-cli-9x7y";

const now = Date.now();
const DAY = 86400000;

function meta(p: string, ageDays: number, over: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    path: p, bytes: 120, charUsed: 120,
    useCount: 3, lastUsedAt: now - ageDays * DAY, hitCount: 0, lastHitAt: null,
    state: "active" as MemoryState, pinned: false, createdAt: now - (ageDays + 10) * DAY,
    ...over,
  };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- [参数]
  console.log("\n[参数] 照搬 hermes");

  check("间隔 7 天", DEFAULT_CURATOR.intervalHours === 168);
  check("需空闲 2 小时", DEFAULT_CURATOR.minIdleHours === 2);
  check("14 天 stale", DEFAULT_CURATOR.staleAfterDays === 14);
  check("30 天归档", DEFAULT_CURATOR.archiveAfterDays === 30);
  check("备份留 5 份", DEFAULT_CURATOR.backupKeep === 5);
  check("默认不是 dry-run", DEFAULT_CURATOR.dryRun === false);

  // ---------------------------------------------------------------- [触发]
  console.log("\n[触发] 空闲触发，不是 cron");

  const fresh: ReturnType<typeof shouldRun> = shouldRun({ lastRunAt: now, lastActivityAt: now, firstRun: false }, now, DEFAULT_CURATOR);
  check("刚跑过不跑", !fresh.run, fresh.reason);

  const busy = shouldRun({ lastRunAt: now - 10 * DAY, lastActivityAt: now - 10 * 60_000, firstRun: false }, now, DEFAULT_CURATOR);
  check("间隔到了但用户没闲 → 不跑", !busy.run && busy.reason.includes("闲置"), busy.reason);

  const okGate = shouldRun({ lastRunAt: now - 10 * DAY, lastActivityAt: now - 5 * 3600_000, firstRun: false }, now, DEFAULT_CURATOR);
  check("间隔到了且空闲 → 跑", okGate.run, okGate.reason);

  const first = shouldRun({ lastRunAt: 0, lastActivityAt: 0, firstRun: true }, now, DEFAULT_CURATOR);
  check("**首次运行推迟一整个间隔**", !first.run && first.reason.includes("推迟"), first.reason);

  // ---------------------------------------------------------------- [阶段 1]
  console.log("\n[阶段 1] 确定性状态流转（不花钱）");

  const metas = [
    meta(path.join(root, "a.md"), 1), // 新鲜
    meta(path.join(root, "b.md"), 20), // stale 区
    meta(path.join(root, "c.md"), 40), // 归档区
    meta(path.join(root, "d.md"), 40, { pinned: true }), // 归档区但上锁
    meta(path.join(root, "e.md"), 40, { state: "archived" }), // 已归档（终态）
    meta(path.join(root, "f.md"), 5, { lastUsedAt: null }), // 从未被注入过
  ];
  const t = planTransitions(metas, now, DEFAULT_CURATOR);
  const byPath = new Map(t.map((x) => [x.path, x]));
  check("新鲜的条目不流转", !byPath.has(path.join(root, "a.md")));
  check("20 天 → stale", byPath.get(path.join(root, "b.md"))?.to === "stale", byPath.get(path.join(root, "b.md")));
  check("40 天 → archived", byPath.get(path.join(root, "c.md"))?.to === "archived");
  check("**pinned 条目被跳过**", !byPath.has(path.join(root, "d.md")));
  check("已归档是终态，不再流转", !byPath.has(path.join(root, "e.md")));
  check("从未注入过的按建档时间算", byPath.get(path.join(root, "f.md")) !== undefined);
  check("流转原因写清了", (byPath.get(path.join(root, "c.md"))?.reason ?? "").includes("天前"));
  check("没有 active→active 的空流转", t.every((x) => x.from !== x.to));

  // ---------------------------------------------------------------- [审查]
  console.log("\n[阶段 2] LLM 审查只提建议");

  const prompt = buildReviewPrompt(metas.filter((m) => !m.pinned));
  check("提示词要求默认 keep", prompt.includes("默认倾向 keep"));
  check("提示词警告不要误删", prompt.includes("误删"));
  check("提示词给出四种动作", ["keep", "merge", "patch", "archive"].every((a) => prompt.includes(a)));
  check("提示词只输出 JSON 数组", prompt.includes("JSON 数组"));

  // ---------------------------------------------------------------- [主流程]
  console.log("\n[主流程] 备份 / dry-run / 不掀翻");

  // 建两个真实文件当条目
  const pA = path.join(root, "a.md");
  const pC = path.join(root, "c.md");
  await (await import("node:fs/promises")).writeFile(pA, "# a\n\n- 条目 A\n", "utf8");
  await (await import("node:fs/promises")).writeFile(pC, "# c\n\n- 条目 C\n", "utf8");

  const store = new MemoryMetaStore();
  store.upsert(meta(pA, 1));
  store.upsert(meta(pC, 40));

  // dry-run：不动盘、不备份
  const dryCfg: CuratorConfig = { ...DEFAULT_CURATOR, dryRun: true };
  const dr = await runCurator(root, { meta: store, homeDir: home, command: NO_LLM }, dryCfg, { now });
  check("dry-run 仍然跑完", dr.ran && dr.dryRun);
  check("dry-run 算出了流转", dr.transitions.length === 1, dr.transitions);
  check("**dry-run 不备份**", dr.backupPath === null);
  check("dry-run 报告标明自己是演练", renderReport(dr, dryCfg).includes("dry-run"));

  // 真跑：备份 + 流转
  const commits: string[] = [];
  const real = await runCurator(
    root,
    {
      meta: store, homeDir: home, command: NO_LLM,
      commit: async (p, a) => { commits.push(`${path.basename(p)}:${a}`); },
    },
    DEFAULT_CURATOR,
    { now },
  );
  check("真跑成功", real.ran);
  check("**动手前先备份**", real.backupPath !== null && existsSync(path.join(real.backupPath!, "manifest.json")), real.backupPath);
  const backupDir = real.backupPath!;
  check("备份里有条目的内容", existsSync(path.join(backupDir, "a.md")) && existsSync(path.join(backupDir, "c.md")));
  check("备份内容是对的", (await readFile(path.join(backupDir, "c.md"), "utf8")).includes("条目 C"));
  check("流转被提交", commits.includes("c.md:archive"), commits);
  check("**新鲜的条目不会被归档**", !commits.includes("a.md:archive"), commits);
  check("LLM 不可用时记 skipReason 而不是失败", real.llmSkipReason !== undefined, real.notes.length);

  // 报告渲染
  const rep = renderReport(real, DEFAULT_CURATOR);
  check("报告含状态流转表", rep.includes("## 状态流转") && rep.includes("| 条目 |"));
  check("报告强调 pinned 与可复原", rep.includes("pinned") && rep.includes("restore"));
  check("报告明确声明 LLM 建议未被执行", rep.includes("一条都没执行"), rep.slice(-300));

  // 复原
  const back = await restore(pC, backupDir);
  check("能从备份复原", back && (await readFile(pC, "utf8")).includes("条目 C"));

  // 备份只留 5 份
  for (let i = 0; i < 8; i++) {
    await runCurator(root, { meta: store, homeDir: home, command: NO_LLM }, DEFAULT_CURATOR, { now: now + i * DAY });
  }
  const kept = readdirSync(path.join(home, "backups", "curator"));
  check(`备份收敛到 ${DEFAULT_CURATOR.backupKeep} 份`, kept.length <= DEFAULT_CURATOR.backupKeep, { kept: kept.length });

  // gate 不满足时直接跳过
  const gated = await runCurator(root, { meta: store, homeDir: home, command: NO_LLM }, DEFAULT_CURATOR, { now, gate: { lastRunAt: now, lastActivityAt: now, firstRun: false } });
  check("gate 不满足 → 跳过且给理由", !gated.ran && gated.skipReason !== undefined, gated.skipReason);

  // 没有条目
  const none = await runCurator(path.join(tmp, "empty"), { meta: new MemoryMetaStore(), homeDir: home, command: NO_LLM }, DEFAULT_CURATOR, { now });
  check("没有条目 → 干净跳过", !none.ran && none.skipReason !== undefined);

  // **永不抛错**：meta.list 抛异常
  const brokenStore = {
    list: () => { throw new Error("遥测表炸了"); },
    get: () => undefined,
    upsert: () => {},
  };
  const broken = await runCurator(root, { meta: brokenStore, homeDir: home, command: NO_LLM }, DEFAULT_CURATOR, { now });
  check("**依赖炸了也不抛错**（不能掀翻 daemon）", broken.ran === false && (broken.skipReason ?? "").includes("异常"), broken.skipReason);

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
