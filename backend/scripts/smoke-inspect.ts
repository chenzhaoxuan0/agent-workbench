/**
 * bot.inspect 冒烟（docs/09 §七 P0-B）——三种老文件夹各字段正确 + 冲突被拦。
 *
 * §八的验收口径原文：「对三种老文件夹（全齐 / 仅 AGENTS.md / 空目录）探测报告各字段
 * 正确；重复与嵌套被拦」。本文件就按这句话写。
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BotRegistry } from "../src/bots/registry.ts";
import { deriveIdentity, suggestId, isIgnored } from "../src/bots/inspect.ts";
import { Store } from "../src/store/db.ts";

const home = await mkdtemp();
const store = new Store(home);
const registry = new BotRegistry(store);

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 200)}` : ""}`);
  }
}

const work = path.join(home, "work");
await mkdir(work, { recursive: true });

// ---- 三种老文件夹 ----
const full = path.join(work, "full-repo");
await mkdir(path.join(full, ".agent-workbench"), { recursive: true });
await mkdir(path.join(full, "skills"), { recursive: true });
await writeFile(
  path.join(full, "AGENTS.md"),
  "# 财报分析师\n\n> 拆解上市公司财报，产出带出处的事实清单\n\n## 边界\n- 不给投资建议\n",
  "utf8",
);
await writeFile(path.join(full, "SOUL.md"), "你是谨慎的分析师。", "utf8");
await writeFile(path.join(full, "MEMORY.md"), "- 用户偏好现金流的看法", "utf8");
await writeFile(path.join(full, "SKILL.md"), "# skill", "utf8");
await writeFile(path.join(full, "CLAUDE.md"), "claude 配置", "utf8");
await writeFile(path.join(full, ".gitignore"), "node_modules\n", "utf8");
await mkdir(path.join(full, ".git"), { recursive: true }); // git 仓库的判据就是它在
await writeFile(path.join(full, ".agent-workbench", "bot.json"), "{}", "utf8"); // 占位，下面会被覆盖

const onlyMd = path.join(work, "only-agents-md");
await mkdir(onlyMd, { recursive: true });
await writeFile(path.join(onlyMd, "AGENTS.md"), "# 写作助手\n\n> 起草与润色长文\n", "utf8");

const empty = path.join(work, "empty-dir");
await mkdir(empty, { recursive: true });

console.log("\n[1] 全齐的老仓库");
let r = (await registry.inspect(full)).report;
ok(r.exists && r.readable, "目录可读");
ok(r.isGitRepo, "识别为 git 仓库（.git 目录存在）", r.isGitRepo);
ok(r.hasAgentsMd, "有 AGENTS.md");
ok(r.hasBotJson, "有 bot.json");
ok(r.derived?.name === "财报分析师", "从 H1 派生 name", r.derived);
ok(r.derived?.role === "拆解上市公司财报，产出带出处的事实清单", "从引言派生 role", r.derived);
ok(r.suggestedId === "bot-finance-analyst" || /^bot-[0-9a-f]{8}$/.test(r.suggestedId), "派生建议 id 非空且稳定", r.suggestedId);
ok(r.assets.hasSoul, "认到 SOUL.md");
ok(r.assets.memoryFile === "MEMORY.md", "认到 MEMORY.md");
ok(r.assets.skillFiles.includes("SKILL.md"), "认到 SKILL.md");
ok(r.assets.skillDirs.includes("skills"), "认到 skills 目录", r.assets.skillDirs);
ok(r.assets.extraAgentFiles.includes("CLAUDE.md"), "其余 md 单独列出让人看见会继承什么", r.assets.extraAgentFiles);
ok(r.security.applicable, "安全检查适用（是 git 仓库）");
ok(r.security.safe === true, "当前无明文密钥 → 判定安全", r.security);

console.log("\n[2] 只有 AGENTS.md 的老文件夹");
r = (await registry.inspect(onlyMd)).report;
ok(r.exists && !r.hasBotJson && r.hasAgentsMd, "认得出「无 bot.json + 有 AGENTS.md」= 认领分支");
ok(r.derived?.name === "写作助手" && r.derived?.role === "起草与润色长文", "派生 name/role", r.derived);
ok(r.security.applicable === false, "非 git 仓库 → 安全检查不适用", r.security);

console.log("\n[3] 空目录");
r = (await registry.inspect(empty)).report;
ok(r.exists && !r.hasAgentsMd && !r.hasBotJson, "认得出「两者皆无」= 脚手架分支");
ok(r.derived === null, "没有 AGENTS.md 就不瞎猜身份", r.derived);

console.log("\n[4] 不存在的目录");
r = (await registry.inspect(path.join(work, "nope"))).report;
ok(r.exists === false, "目录不存在");

console.log("\n[5] 扫描根副作用");
await registry.putBot({ id: "bot-x", rootPath: full, name: "x" } as never);
r = (await registry.inspect(empty)).report;
ok(r.scanRootEffect.willBecomeScanRoot, "父目录会成为扫描根");
ok(r.scanRootEffect.siblingsFound >= 1, "报出同级会连带扫出的 bot 数", r.scanRootEffect);
ok(r.scanRootEffect.warning !== null, "把这个副作用说给用户听", r.scanRootEffect.warning);

console.log("\n[6] 冲突：同路径重复注册被拒");
let rejected = false;
try {
  await registry.putBot({ id: "bot-y", rootPath: full, name: "y" } as never);
} catch (err: unknown) {
  rejected = (err as { code?: string }).code === "root_taken";
}
ok(rejected, "另一个 id 抢同一工作目录 → root_taken");

console.log("\n[7] 冲突：同一 id 原地更新仍允许（那才是保存）");
let sameIdOk = true;
try {
  await registry.putBot({ id: "bot-x", rootPath: full, name: "x2" } as never);
} catch {
  sameIdOk = false;
}
ok(sameIdOk, "同 id 同路径更新通过");

console.log("\n[8] 冲突：嵌套在另一个 bot 内部");
r = (await registry.inspect(path.join(full, "skills"))).report;
ok(r.conflicts.nestedInside?.unitId === "bot-x", "报出嵌套在谁里面", r.conflicts);

console.log("\n[9] git + 密钥：明文渠道凭据且未被 ignore = 不安全");
const leaky = path.join(work, "leaky-repo");
await mkdir(path.join(leaky, ".agent-workbench"), { recursive: true });
await mkdir(path.join(leaky, ".git"), { recursive: true });
await writeFile(path.join(leaky, ".gitignore"), "node_modules\n", "utf8");
await writeFile(
  path.join(leaky, ".agent-workbench", "bot.json"),
  JSON.stringify({
    id: "bot-leak",
    rootPath: leaky,
    name: "leak",
    channels: [{ kind: "feishu", enabled: true, accounts: [{ id: "a", appId: "cli_x", appSecret: "明文密钥" }] }],
  }),
  "utf8",
);
r = (await registry.inspect(leaky)).report;
ok(r.security.safe === false, "判定为不安全", r.security);
ok(r.security.agentWorkbenchIgnored === false, "识别出未被 ignore");
ok(r.security.message.includes("⚠"), "给了硬提示", r.security.message);

console.log("\n[10] 同一仓库改成 SecretRef（env）后就不再是泄漏");
await writeFile(
  path.join(leaky, ".agent-workbench", "bot.json"),
  JSON.stringify({
    id: "bot-leak",
    rootPath: leaky,
    name: "leak",
    channels: [
      { kind: "feishu", enabled: true, accounts: [{ id: "a", appId: "cli_x", appSecret: { source: "env", id: "X" } }] },
    ],
  }),
  "utf8",
);
r = (await registry.inspect(leaky)).report;
ok(r.security.safe === true, "SecretRef 不落盘 → 判定安全", r.security);

console.log("\n[11] 一键补 .gitignore");
ok(await registry.ensureGitignore(leaky).then((x) => x.changed), "第一次追加生效");
ok(!(await registry.ensureGitignore(leaky)).changed, "第二次幂等，不重复写");
ok(isIgnored(await readFileSafe(path.join(leaky, ".gitignore")), ".agent-workbench"), "写进去后被识别为 ignored");

console.log("\n[12] 派生命名与 .gitignore 匹配的纯函数");
ok(deriveIdentity("没有标题也没有引言\n随便一段").name === "", "无 H1 → name 空，不拿别的东西冒充");
ok(deriveIdentity("# 标题\n\n## 小节\n> 引言在小节后").role === "", "引言不在标题紧邻位置 → 不硬取");
ok(suggestId("财报分析师") === suggestId("财报分析师") && suggestId("财报分析师").startsWith("bot-"), "纯中文名也能得到稳定非空 id", suggestId("财报分析师"));
ok(suggestId("财报分析师") !== suggestId("写作助手"), "不同中文名得到不同 id");
ok(isIgnored("build\n", ".agent-workbench") === false, "无关规则不算命中");

store.close();
await rm(home, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);

async function mkdtemp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `aw-inspect-smoke-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
async function readFileSafe(p: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}
