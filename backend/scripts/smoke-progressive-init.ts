/**
 * 渐进式上下文、Skill 规范、工作区初始化与软删除完整闭环冒烟测试
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasSubstantiveContent } from "../../prototype/src/core/units.ts";
import { BotRegistry } from "../src/bots/registry.ts";
import { FileMemoryInjector } from "../src/memory/injection.ts";
import { LEGACY_CONTEXT_SKILL_MD, syncContextSkill } from "../src/skills/contextSkill.ts";
import { workbenchSkillMd } from "../src/skills/workbenchSkill.ts";
import type { Store } from "../src/store/db.ts";

function fakeStore(): Store {
  const kv = new Map<string, string>();
  return {
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => {
      kv.set(k, v);
    },
  } as unknown as Store;
}

let failed = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

async function main() {
  console.log("[1] hasSubstantiveContent (空文件与注释检测)");
  ok(hasSubstantiveContent(null) === false, "null 为空");
  ok(hasSubstantiveContent(undefined) === false, "undefined 为空");
  ok(hasSubstantiveContent("   \n\t  ") === false, "纯空白为空");
  ok(hasSubstantiveContent("<!-- 仅有注释 -->") === false, "仅 HTML 注释为空");
  ok(hasSubstantiveContent("# 标题\n<!-- 注释 -->\n") === false, "标题+HTML注释为空");
  ok(hasSubstantiveContent("# 标题\n（还没写岗位说明书）") === false, "标题+未命名占位符为空");
  ok(hasSubstantiveContent("# SOUL\n\n- 必须用中文回答\n- 严谨") === true, "真实人设正文为非空");
  ok(hasSubstantiveContent("严禁 rm -rf /") === true, "红线文字为非空");

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aw-prog-smoke-"));
  const homeDir = path.join(tmpRoot, "home");
  const botDir = path.join(tmpRoot, "workspace-a");
  await mkdir(homeDir, { recursive: true });
  await mkdir(botDir, { recursive: true });

  try {
    console.log("[2] BotRegistry initWorkspace & 软删除");
    const store = fakeStore();
    const registry = new BotRegistry(store);

    // 2.1 补充 Init 机制：目录骨架 + 官方技能 ×2（MD 正文不落骨架——未经编辑不占工作区）
    const initRes = await registry.initWorkspace(botDir);
    ok(initRes.created.includes(".agent-workbench"), "创建了 .agent-workbench 目录");
    ok(!existsSync(path.join(botDir, "MEMORY.md")), "MEMORY.md 未落骨架（未经编辑不落盘）");
    ok(!existsSync(path.join(botDir, "STANDING.md")), "STANDING.md 未落骨架");
    ok(!existsSync(path.join(botDir, "SOUL.md")), "SOUL.md 未落骨架");
    ok(existsSync(path.join(botDir, ".agents", "skills", "workbench-context", "SKILL.md")), "官方记忆技能落在 .agents/skills/ 规范位");
    ok(existsSync(path.join(botDir, ".agents", "skills", "agent-workbench", "SKILL.md")), "官方驾驶技能同样随 init 落盘（基础能力一体）");
    ok(!existsSync(path.join(botDir, "skills", "workbench-context")), "skills/ 旧位不再新建（兼容位只升存量）");

    // 检查 SKILL.md 内容包含渐进式披露规范与版本标记
    const skillContent = await readFile(path.join(botDir, ".agents", "skills", "workbench-context", "SKILL.md"), "utf8");
    ok(skillContent.includes("workbench-context-skill: v1") && skillContent.includes("MEMORY.md"), "SKILL.md 带版本标记且包含工作区上下文规范说明");

    // 2.1b 迁移判定（无标记时代的副本）：
    //     内容 = 旧正本 → daemon 所有可认领升级；改过的 → 用户自建不碰
    const migrateDir = path.join(tmpRoot, "migrate");
    await mkdir(path.join(migrateDir, ".agents", "skills", "workbench-context"), { recursive: true });
    await mkdir(path.join(migrateDir, "skills", "workbench-context"), { recursive: true });
    const agentsPos = path.join(migrateDir, ".agents", "skills", "workbench-context", "SKILL.md");
    const compatPos = path.join(migrateDir, "skills", "workbench-context", "SKILL.md");
    await writeFile(agentsPos, LEGACY_CONTEXT_SKILL_MD, "utf8");
    await writeFile(compatPos, "我的私改记忆技能\n", "utf8");
    const migrated = await syncContextSkill(migrateDir);
    const migratedAgents = await readFile(agentsPos, "utf8");
    const migratedCompat = await readFile(compatPos, "utf8");
    ok(migrated.some((r) => r.path === agentsPos && r.status === "updated"), "无标记旧正本被认领升级（updated）");
    ok(migratedAgents.includes("workbench-context-skill: v1"), "升级后的规范位带版本标记");
    ok(migrated.some((r) => r.path === compatPos && r.status === "skipped-foreign"), "改过的兼容位副本视为用户自建（skipped-foreign）");
    ok(migratedCompat === "我的私改记忆技能\n", "用户改写的内容一字不动");

    // 2.2 幂等性：第二次 init 不覆盖已有内容（MD 是用户手写的，init 只碰目录与技能）
    await writeFile(path.join(botDir, "SOUL.md"), "我是专属私人助手，风格幽默。", "utf8");
    await registry.initWorkspace(botDir);
    const preservedSoul = await readFile(path.join(botDir, "SOUL.md"), "utf8");
    ok(preservedSoul === "我是专属私人助手，风格幽默。", "二次 init 绝不覆盖已有正文");

    // 2.3 注册 Bot（不带 AGENTS 正文 → 不落占位文件；写内容才落盘）
    await registry.putBot({
      id: "bot-1",
      name: "Bot One",
      rootPath: botDir,
    });
    ok(!existsSync(path.join(botDir, "AGENTS.md")), "putBot 未带正文时不写 AGENTS.md 占位（未经编辑不落盘）");
    const botsBefore = await registry.listBots();
    ok(botsBefore.some((b) => b.id === "bot-1"), "Bot 成功注册并列出");

    // 2.4 注销（软删除）：项目源码与 MD 文件 100% 保留
    await registry.unregisterBot("bot-1");
    const botsAfter = await registry.listBots();
    ok(!botsAfter.some((b) => b.id === "bot-1"), "注销后默认 listBots 不再显示该 Bot");
    const botsIncludingUnreg = await registry.listBots({ includeUnregistered: true });
    ok(botsIncludingUnreg.some((b) => b.id === "bot-1" && b.unregistered === true), "加 includeUnregistered 可以查出已被软删除");
    ok(existsSync(path.join(botDir, "SOUL.md")), "注销后本地磁盘 SOUL.md 完整保留");
    ok(existsSync(path.join(botDir, ".agents", "skills", "workbench-context", "SKILL.md")), "注销后官方技能完整保留");

    // 2.5 恢复：重新认领/导入相同路径时，自动移除 unregistered 标记恢复
    await registry.putBot({
      id: "bot-1",
      name: "Bot One",
      rootPath: botDir,
    });
    const botsRestored = await registry.listBots();
    ok(botsRestored.some((b) => b.id === "bot-1" && b.unregistered !== true), "重新保存/认领后成功恢复");

    console.log("[3] FileMemoryInjector 实质空文件跳过 & customPrompt 注入");
    const injector = new FileMemoryInjector(homeDir);

    // 3.1 当 SOUL.md 有实质内容时，注入
    const injWithSoul = await injector.build(botDir, "你好", {
      plan: { soul: true, agentsMd: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
    });
    ok(injWithSoul !== null && injWithSoul.block.includes("我是专属私人助手，风格幽默。"), "非空 SOUL.md 正常注入");

    // 3.2 当 SOUL.md 清空成仅有注释或空标题时，实质空文件自动跳过（0 Token 注入）
    await writeFile(path.join(botDir, "SOUL.md"), "# SOUL\n\n<!-- 请在此输入人设 -->\n\n", "utf8");
    const injEmptySoul = await injector.build(botDir, "你好", {
      plan: { soul: true, agentsMd: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
    });
    ok(injEmptySoul === null, "实质为空的 SOUL.md 强制 0 注入（返回 null）");

    // 3.3 customPrompt 工作区提示词注入
    const injCustom = await injector.build(botDir, "帮我分析代码", {
      plan: { soul: false, agentsMd: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
      customPrompt: "优先以中文简短答复，并在需要时通过 workbench-context skill 查看记忆。",
    });
    ok(injCustom !== null && injCustom.block.includes("workbench-context skill"), "自定义工作区提示词作为 custom 节正确注入");

    // 3.4 customPrompt 为空白或占位符时跳过
    const injCustomEmpty = await injector.build(botDir, "帮我分析代码", {
      plan: { soul: false, agentsMd: false, user: false, memorySemantic: false, memoryDaily: false, memoryStanding: false, skills: false },
      customPrompt: "   <!-- 留空 -->  \n",
    });
    ok(injCustomEmpty === null, "实质为空的 customPrompt 跳过注入");

  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\n所有测试全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
