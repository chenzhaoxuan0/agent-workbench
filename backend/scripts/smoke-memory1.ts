/**
 * 记忆系统 WP-1 + WP-2 验收 —— 项目记忆文件层 + 容量纪律（docs/10 §4.1 / §十）。
 *
 *   布局自动创建（MEMORY.md 带模板头 + memory/daily/）
 *   → 写入 / 回读一致
 *   → 超 2200 字符拒绝，且**磁盘内容没变**（关键：拒绝必须发生在写之前）
 *   → 报错文案含当前用量 + 现有条目（可执行，不是干巴巴一句超限）
 *   → 写前备份生效、备份按份数淘汰
 *   → daily 不设上限（按天分片天然有界）
 *   → 原子写不留 .tmp 残留
 *
 * 用法：cd backend && pnpm smoke:memory1
 */

import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureLayout,
  readLongTerm,
  readDaily,
  writeLongTerm,
  writeDaily,
  listDaily,
  resolvePaths,
  scopeId,
  MEMORY_TEMPLATE,
  BACKUP_KEEP,
} from "../src/memory/projectMemory.ts";
import {
  checkCapacity,
  extractEntries,
  buildOverLimitError,
  measure,
  MEMORY_CHAR_LIMIT,
  MEMORY_WARN_RATIO,
} from "../src/memory/limits.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory1-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");

async function main(): Promise<void> {
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });

  console.log("\n[WP-1] 布局与读写");

  // 场景 1：项目无 MEMORY.md → 自动创建且带模板头
  const p = await ensureLayout(project);
  check("memory/daily/ 已创建", existsSync(p.dailyDir));
  const created = await readLongTerm(project);
  check("MEMORY.md 已自动创建", created.exists);
  check("内容等于模板头", created.content === MEMORY_TEMPLATE);
  check("路径落在项目文件夹内", created.path === path.join(project, "MEMORY.md"));
  check("daily 在 memory/ 下", p.dailyDir === path.join(project, "memory", "daily"));

  // 幂等：再调一次不覆盖已有内容
  await writeFile(p.memoryMd, "- 已有一条记忆\n", "utf8");
  await ensureLayout(project);
  const afterEnsure = await readLongTerm(project);
  check("ensureLayout 幂等（不覆盖已有内容）", afterEnsure.content === "- 已有一条记忆\n");

  // 写入 / 回读一致
  const body = "- 这个仓库用 pnpm，不用 npm\n- 网络有 TUN 代理，github 需挂 127.0.0.1:7897\n";
  const w1 = await writeLongTerm(project, body, { homeDir: home });
  check("写入成功", w1.chars === measure(body));
  const r1 = await readLongTerm(project);
  check("回读一致", r1.content === body);
  check("回读报出正确字符数", r1.chars === measure(body));

  console.log("\n[WP-2] 容量纪律");

  // 上限常量对齐 hermes
  check("上限 = 2200 字符", MEMORY_CHAR_LIMIT === 2200);
  check("提醒阈值 = 80%", MEMORY_WARN_RATIO === 0.8);

  // 80% 提醒 —— 用精确边界值，不用估的
  const atThreshold = "x".repeat(Math.floor(MEMORY_CHAR_LIMIT * MEMORY_WARN_RATIO)); // 1760
  const justBelow = "x".repeat(atThreshold.length - 1); // 1759
  check("正好 80% 触发提醒", checkCapacity("", atThreshold).nearLimit);
  check("差一个字符不触发提醒", !checkCapacity("", justBelow).nearLimit);
  check("达到阈值仍算 ok（提醒不是拒绝）", checkCapacity("", atThreshold).ok);

  // 场景 3：超限拒绝，且磁盘不变
  const before = (await readLongTerm(project)).content;
  const tooBig = "- " + "超".repeat(MEMORY_CHAR_LIMIT) + "\n";
  let thrown: (Error & { code?: string; entries?: string[] }) | undefined;
  try {
    await writeLongTerm(project, tooBig, { homeDir: home });
  } catch (err: unknown) {
    thrown = err as Error & { code?: string; entries?: string[] };
  }
  check("超限抛出错误", thrown !== undefined);
  check("错误码 = memory_over_limit", thrown?.code === "memory_over_limit");
  const after = (await readLongTerm(project)).content;
  check("**拒绝后磁盘内容未变**（拒绝发生在写之前）", after === before);

  // 报错文案可执行：含当前用量、现有条目
  const msg = thrown?.message ?? "";
  check("文案含当前用量/上限", msg.includes(`/${MEMORY_CHAR_LIMIT} 字符`));
  check("文案含现有条目", msg.includes("这个仓库用 pnpm"));
  check("错误对象带 entries 便于程序化处理", Array.isArray(thrown?.entries) && thrown!.entries.length === 2);
  // 工厂本身只构造不抛（调用点负责 throw）
  const built = buildOverLimitError(body, tooBig);
  check("buildOverLimitError 只构造不抛", built instanceof Error && !Array.isArray(built));
  check("工厂产出的错误码正确", (built as Error & { code?: string }).code === "memory_over_limit");

  // extractEntries 只取条目，不吃注释和标题
  const entries = extractEntries("# 项目记忆\n\n<!-- 注释 -->\n\n- 甲\n- 乙\n\n普通段落\n");
  check("extractEntries 只认 '- ' 开头", entries.length === 2 && entries[0] === "甲" && entries[1] === "乙");

  // checkCapacity 边界
  check("正好等于上限算 ok", checkCapacity("", "x".repeat(MEMORY_CHAR_LIMIT)).ok);
  check("超一个字符算超限", !checkCapacity("", "x".repeat(MEMORY_CHAR_LIMIT + 1)).ok);

  console.log("\n[WP-1] 备份与 daily");

  // 写前备份：第二次写应产生备份，内容是第一次的
  const w2 = await writeLongTerm(project, body + "- 第三条\n", { homeDir: home });
  check("第二次写产生备份", w2.backupPath !== null && existsSync(w2.backupPath!));
  check("备份内容是覆盖前的版本", readFileSync(w2.backupPath!, "utf8") === body);
  const bdir = path.join(home, "backups", scopeId(project));
  check("备份按 scopeId 分目录", existsSync(bdir));
  check("scopeId 稳定且短", scopeId(project) === scopeId(project) && scopeId(project).length === 12);
  check("不同项目 scopeId 不同", scopeId(project) !== scopeId(path.join(tmp, "other")));

  // 首次创建不产生备份（没有旧内容可备）
  const freshProject = path.join(tmp, "fresh");
  await mkdir(freshProject, { recursive: true });
  const wFresh = await writeLongTerm(freshProject, "- 新项目\n", { homeDir: home });
  check("首次写入不产生备份", wFresh.backupPath === null);

  // 场景 9 前置：daily 按天分片、不设上限
  const bigDaily = "- 当天流水\n".repeat(600); // 远大于 2200
  const wd = await writeDaily(project, "2026-10-04", bigDaily, { homeDir: home });
  check("daily 超过 2200 也能写（不设上限）", wd.chars > MEMORY_CHAR_LIMIT);
  const rd = await readDaily(project, "2026-10-04");
  check("daily 回读一致", rd.content === bigDaily);
  check("daily limit 为 Infinity", rd.limit === Number.POSITIVE_INFINITY);
  check("daily 不触发上限提醒", wd.nearLimit === false);

  await writeDaily(project, "2026-10-03", "- 前一天\n", { homeDir: home });
  const days = await listDaily(project);
  check("daily 可列举且倒序", days[0] === "2026-10-04.md" && days[1] === "2026-10-03.md", days);
  check("不存在时读回空而非抛错", (await readDaily(project, "1999-01-01")).content === "");

  console.log("\n[WP-1] 原子写与备份淘汰");

  // 原子写不留 tmp 残留
  const residue = readdirSync(project).filter((n) => n.includes(".tmp-"));
  check("项目目录无 .tmp 残留", residue.length === 0, residue);

  // 备份份数淘汰
  for (let i = 0; i < BACKUP_KEEP + 5; i++) {
    await writeLongTerm(project, body + `- 第 ${i} 次\n`, { homeDir: home });
  }
  const kept = readdirSync(bdir).filter((n) => n.endsWith(".md"));
  check(`备份不超过 ${BACKUP_KEEP} 份`, kept.length <= BACKUP_KEEP, { kept: kept.length });

  // resolvePaths 形状
  const rp = resolvePaths(project);
  check("resolvePaths 根正确", rp.root === project && rp.memoryMd === path.join(project, "MEMORY.md"));

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(failures === 0 ? 0 : 1);
  });
