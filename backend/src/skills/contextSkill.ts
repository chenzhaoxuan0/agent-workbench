/**
 * 工作区记忆技能（docs/20 渐进式上下文Skill化）：教执行器按需检索本工作区的
 * MEMORY.md / memory/daily / STANDING.md，替代首轮全量注入。与 agent-workbench 技能
 * （workbenchSkill.ts）同走 skillSync.ts 版本标记契约——都是 bot init 的基础能力，
 * 存量 bot 由 workbench.skill.sync / 补充 Init 兜底升级。
 *
 * 迁移注记：v1 之前由 registry.initWorkspace 的 ensureFile 种下（无版本标记、双写
 * skills/ 与 .agents/skills/）。v1 起带标记行；无标记但内容与 LEGACY 一致的旧副本
 * 视同 daemon 所有可升级，改过的当用户自建不碰。skills/ 旧位降级为兼容位（只升存量
 * 不新建），规范位只有 .agents/skills/。
 */

import { markerLine, syncCanonicalSkill, type SkillSyncResult } from "./skillSync.ts";

export const WORKSPACE_CONTEXT_SKILL_NAME = "workbench-context";
export const WORKSPACE_CONTEXT_SKILL_VERSION = 1;

/** 无标记时代的旧正本（registry.initWorkspace 内联原文）——迁移认领的比对基准 */
export const LEGACY_CONTEXT_SKILL_MD = [
  "---",
  "name: workbench-context",
  'description: "检索本工作空间的长期事实记忆 (MEMORY.md)、日常碎片日志 (memory/daily/) 以及安全红线 (STANDING.md)。当遇到不确定的项目背景、历史决策或需要调取历史备忘时主动调用。"',
  "---",
  "",
  "# 工作空间上下文与记忆检索工具",
  "",
  "本工作空间包含以下事实归档文件，你可以使用常规文件读取工具按需查看：",
  "1. `MEMORY.md`：项目级长期事实、技术选型与关键共识（位于工作区根目录）。",
  "2. `memory/daily/YYYY-MM-DD.md`：历史日常工作日志与对话提炼碎片。",
  "3. `STANDING.md`：当前项目不可打破的安全约束与常驻红线。",
  "",
  "**使用准则**：",
  "- 仅在用户问题涉及过往决策、特定历史背景或显式要求查阅记忆时读取对应文件。",
  "- 避免一次性读取全部文件，根据问题日期或关键字按需精准读取。",
  "",
].join("\n");

/** 官方正本——改这里并升 WORKSPACE_CONTEXT_SKILL_VERSION，老副本会在下次 sync 升级 */
export function contextSkillMd(): string {
  return [
    "---",
    "name: " + WORKSPACE_CONTEXT_SKILL_NAME,
    'description: "检索本工作空间的长期事实记忆 (MEMORY.md)、日常碎片日志 (memory/daily/) 以及安全红线 (STANDING.md)。当遇到不确定的项目背景、历史决策或需要调取历史备忘时主动调用。"',
    "---",
    "",
    markerLine(WORKSPACE_CONTEXT_SKILL_NAME, WORKSPACE_CONTEXT_SKILL_VERSION),
    "",
    "# 工作空间上下文与记忆检索工具",
    "",
    "本工作空间包含以下事实归档文件，你可以使用常规文件读取工具按需查看：",
    "1. `MEMORY.md`：项目级长期事实、技术选型与关键共识（位于工作区根目录）。",
    "2. `memory/daily/YYYY-MM-DD.md`：历史日常工作日志与对话提炼碎片。",
    "3. `STANDING.md`：当前项目不可打破的安全约束与常驻红线。",
    "",
    "**使用准则**：",
    "- 仅在用户问题涉及过往决策、特定历史背景或显式要求查阅记忆时读取对应文件。",
    "- 避免一次性读取全部文件，根据问题日期或关键字按需精准读取。",
    "",
  ].join("\n");
}

/** 规范位（.agents/skills/）在前，skills/ 旧位为兼容位（只升存量不新建） */
export const CONTEXT_SKILL_REL_PATHS = [
  ".agents/skills/workbench-context/SKILL.md",
  "skills/workbench-context/SKILL.md",
] as const;

/** 幂等同步（版本标记契约，见文件头） */
export async function syncContextSkill(
  rootPath: string,
  opts: { force?: boolean } = {},
): Promise<SkillSyncResult[]> {
  return syncCanonicalSkill(
    rootPath,
    {
      name: WORKSPACE_CONTEXT_SKILL_NAME,
      version: WORKSPACE_CONTEXT_SKILL_VERSION,
      md: contextSkillMd(),
      legacyMd: LEGACY_CONTEXT_SKILL_MD,
    },
    CONTEXT_SKILL_REL_PATHS,
    opts,
  );
}
