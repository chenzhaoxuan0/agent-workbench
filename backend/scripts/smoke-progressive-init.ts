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

    // 2.1 补充 Init 机制
    const initRes = await registry.initWorkspace(botDir);
    ok(initRes.created.includes(".agent-workbench"), "创建了 .agent-workbench 目录");
    ok(initRes.created.includes("skills/workbench-context/SKILL.md"), "创建了 skills/workbench-context/SKILL.md");
    ok(initRes.created.includes(".agents/skills/workbench-context/SKILL.md"), "创建了 .agents/skills/workbench-context/SKILL.md 软链/镜像");
    ok(initRes.created.includes("MEMORY.md"), "创建了 MEMORY.md");
    ok(initRes.created.includes("STANDING.md"), "创建了 STANDING.md");
    ok(initRes.created.includes("SOUL.md"), "创建了 SOUL.md");

    // 检查 SKILL.md 内容包含渐进式披露规范
    const skillContent = await readFile(path.join(botDir, "skills", "workbench-context", "SKILL.md"), "utf8");
    ok(skillContent.includes("workbench-context") && skillContent.includes("MEMORY.md"), "SKILL.md 包含工作区上下文规范说明");

    // 2.2 幂等性：第二次 init 不覆盖已有内容
    await writeFile(path.join(botDir, "SOUL.md"), "我是专属私人助手，风格幽默。", "utf8");
    const initRes2 = await registry.initWorkspace(botDir);
    ok(initRes2.existed.includes("SOUL.md"), "第二次 init 识别到 SOUL.md 已存在");
    const preservedSoul = await readFile(path.join(botDir, "SOUL.md"), "utf8");
    ok(preservedSoul === "我是专属私人助手，风格幽默。", "二次 init 绝不覆盖已有正文");

    // 2.3 注册 Bot
    await registry.putBot({
      id: "bot-1",
      name: "Bot One",
      rootPath: botDir,
    });
    const botsBefore = await registry.listBots();
    ok(botsBefore.some((b) => b.id === "bot-1"), "Bot 成功注册并列出");

    // 2.4 注销（软删除）：项目源码与 MD 文件 100% 保留
    await registry.unregisterBot("bot-1");
    const botsAfter = await registry.listBots();
    ok(!botsAfter.some((b) => b.id === "bot-1"), "注销后默认 listBots 不再显示该 Bot");
    const botsIncludingUnreg = await registry.listBots({ includeUnregistered: true });
    ok(botsIncludingUnreg.some((b) => b.id === "bot-1" && b.unregistered === true), "加 includeUnregistered 可以查出已被软删除");
    ok(existsSync(path.join(botDir, "SOUL.md")), "注销后本地磁盘 SOUL.md 完整保留");
    ok(existsSync(path.join(botDir, "MEMORY.md")), "注销后本地磁盘 MEMORY.md 完整保留");

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
