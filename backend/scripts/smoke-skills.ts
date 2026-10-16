/**
 * 技能矩阵后端冒烟 —— buildSkillsInventory / setSkillDisabled / copySkill。
 *
 * 全程只用临时目录里的**项目级技能源**（rootPath 注入），不动真实家目录。
 * 矩阵视图的搬运/复制语义此前零自动化覆盖（review 实证），这里是回归护栏：
 * 改坏 .disabled/ 搬运、跨源复制、从 .disabled/ 复制（38475f5 新增）都会被抓。
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsInventory, copySkill, setSkillDisabled } from "../src/skills/inventory.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

function errCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const tmp = join(tmpdir(), `agent-workbench-smoke-skills-${Date.now()}`);
const agentsDir = join(tmp, ".agents", "skills");
const zcodeDir = join(tmp, ".zcode", "skills");
const piDir = join(tmp, ".pi", "skills");

try {
  mkdirSync(join(agentsDir, "alpha"), { recursive: true });
  writeFileSync(
    join(agentsDir, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: 冒烟技能\n---\n\n正文\n",
    "utf8",
  );
  mkdirSync(zcodeDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });

  console.log("\n【1】清单：项目级源带技能出现，含 readers");
  const inv1 = buildSkillsInventory(tmp, (id) => id);
  const g1 = inv1.groups.find((g) => g.dir === agentsDir);
  check("项目级 .agents 源在清单里", g1 !== undefined, { groups: inv1.groups.map((g) => g.dir) });
  check("alpha 在源里且未停用", g1?.skills.some((s) => s.dirName === "alpha" && !s.disabled) === true);
  check("readers 是全执行器（.agents 公共库口径）", (g1?.readers.length ?? 0) >= 10, { readers: g1?.readers.map((r) => r.id) });
  check("空源不出现", inv1.groups.every((g) => g.skills.length > 0));

  console.log("\n【2】停用：搬进 .disabled/，清单标 disabled");
  const toggle = setSkillDisabled(agentsDir, "alpha", true, tmp);
  check("停用返回受影响执行器", toggle.readers.length >= 10);
  check("物理上搬进了 .disabled/", !existsSync(join(agentsDir, "alpha")) && existsSync(join(agentsDir, ".disabled", "alpha", "SKILL.md")));
  const inv2 = buildSkillsInventory(tmp, (id) => id);
  const g2 = inv2.groups.find((g) => g.dir === agentsDir);
  check("清单里 alpha 标记 disabled", g2?.skills.some((s) => s.dirName === "alpha" && s.disabled) === true);
  check("重复停用报 missing_skill（启用位已无此文件夹）", errCode(() => setSkillDisabled(agentsDir, "alpha", true, tmp)) === "missing_skill");

  console.log("\n【3】复制：从 .disabled/ 里的技能也能复制到别的源（38475f5 修复）");
  copySkill(agentsDir, "alpha", zcodeDir, tmp);
  check("复制落在目标源启用位", existsSync(join(zcodeDir, "alpha", "SKILL.md")));
  check("内容原样", readFileSync(join(zcodeDir, "alpha", "SKILL.md"), "utf8").includes("冒烟技能"));
  check("目标已有同名（含 .disabled 里）报 conflict", errCode(() => copySkill(agentsDir, "alpha", zcodeDir, tmp)) === "conflict");
  check("源不被搬走（复制不是移动）", existsSync(join(agentsDir, ".disabled", "alpha")));

  console.log("\n【4】恢复：搬出 .disabled/；停用期间同名新建要报 conflict");
  setSkillDisabled(agentsDir, "alpha", false, tmp);
  check("恢复到启用位", existsSync(join(agentsDir, "alpha", "SKILL.md")));
  setSkillDisabled(agentsDir, "alpha", true, tmp);
  mkdirSync(join(agentsDir, "alpha"), { recursive: true });
  writeFileSync(join(agentsDir, "alpha", "SKILL.md"), "---\nname: alpha-new\n---\n", "utf8");
  check("停用期间新建同名 → 恢复报 conflict（不覆盖）", errCode(() => setSkillDisabled(agentsDir, "alpha", false, tmp)) === "conflict");

  console.log("\n【5】护栏：未知源 / 脏 dirName / 只读源 / 单技能形态");
  check("未知源报 unknown_source", errCode(() => setSkillDisabled(join(tmp, "not-a-source"), "alpha", true, tmp)) === "unknown_source");
  check("带路径分隔符的 dirName 报 bad_params", errCode(() => setSkillDisabled(agentsDir, "../evil", true, tmp)) === "bad_params");
  check("copySkill 未知源报 unknown_source", errCode(() => copySkill(agentsDir, "alpha", join(tmp, "not-a-source"), tmp)) === "unknown_source");
  // 只读源：agy 内置目录是静态注册表里的只读源（目录在不在盘上都会先撞 read_only 检查，不动盘）
  check("只读源报 read_only_source", errCode(() => setSkillDisabled(join(homedir(), ".gemini", "antigravity-ide", "builtin", "skills"), "x", true, undefined)) === "read_only_source");
  // 单技能形态：SKILL.md 直挂源目录
  writeFileSync(join(piDir, "SKILL.md"), "---\nname: single\n---\n", "utf8");
  check("单技能形态不可开关", errCode(() => setSkillDisabled(piDir, "SKILL.md", true, tmp)) === "single_form_source");
  check("单技能形态不可作为复制目标", errCode(() => copySkill(agentsDir, "alpha", piDir, tmp)) === "single_form_source");
  const invPi = buildSkillsInventory(tmp, (id) => id);
  const gPi = invPi.groups.find((g) => g.dir === piDir);
  check("单技能形态在清单里标 singleForm", gPi?.skills.some((s) => s.singleForm === true) === true);
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄残留不置败：临时目录系统自清 */
  }
}

console.log(failures === 0 ? "\nsmoke-skills: ALL GREEN" : `\nsmoke-skills: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
