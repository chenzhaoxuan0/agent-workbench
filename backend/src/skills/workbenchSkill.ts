/**
 * 工作台技能（docs/21 P6）—— 随 daemon 分发的官方技能：教任何执行器用 `aw` 驾驶
 * agent-workbench 本身。与 workbench-context 技能（contextSkill.ts）同走 skillSync.ts
 * 版本标记契约：bot init（registry.initWorkspace 路径）时同步进
 * `<rootPath>/.agents/skills/agent-workbench/SKILL.md`（.agents 规范公共库的项目级源，
 * 全执行器可发现），存量 bot 由 `workbench.skill.sync` RPC / 补充 Init 兜底。
 */

import path from "node:path";
import { markerLine, syncCanonicalSkill, type SkillSyncResult } from "./skillSync.ts";

export const WORKBENCH_SKILL_NAME = "agent-workbench";
export const WORKBENCH_SKILL_VERSION = 1;

/** 官方正本——改这里并升 WORKBENCH_SKILL_VERSION，老 bot 的副本会在下次 sync 升级 */
export function workbenchSkillMd(): string {
  return `---
name: ${WORKBENCH_SKILL_NAME}
description: 操作 agent-workbench 工作台本身——用 aw CLI 驱动会话、待办、git、通知、出图等全部操作面。当用户提到「工作台」「别的 bot」「待办」「通知」，或需要跨 bot 协作、查工作台状态时使用。
---

${markerLine(WORKBENCH_SKILL_NAME, WORKBENCH_SKILL_VERSION)}

# agent-workbench —— 驾驶你所在的工作台

你正运行在 agent-workbench 的一台 bot 工作区里（本文件夹）。这台工作台本身
**可以被你操作**：GUI 能做的每件事，你都能用一条命令完成——包括指挥别的 bot。

## 入口（按优先级）

1. \`aw\`（在 PATH 则直接用；\`aw --help\` 看全部命令）
2. curl 兜底（零安装，任何执行器可用）：

\`\`\`bash
TOKEN=$(cat ~/.agent-workbench/token)
curl -s -X POST http://127.0.0.1:5281/rpc -H "x-awb-token: $TOKEN" \\
  -H "content-type: application/json" -d '{"v":1,"method":"health"}'
\`\`\`

## 第一条命令：发现，不背诵

\`\`\`bash
aw methods                 # 160+ 方法的自描述（说明 / 参数形状 / 危险标记），daemon 注册表实时生成
aw methods --domain git    # 按域过滤
\`\`\`

任何操作先查 \`aw methods\`——它永远比任何文档（包括本技能）新。

## 高频动作

\`\`\`bash
aw doctor                                              # 工作台健康自检
aw session chat --bot <id> --text "…" --attach 文件路径  # 指挥另一个 bot 干活（等它回话）
aw call notifications.list --json                      # 你不在时发生了什么（跨端通知事实源）
aw backlog add --goal "…" --unit <id> --root <路径>     # 登记一条待办
aw git status --root <路径>                             # 仓库状态
aw call memory.search --params '{"query":"…"}'         # 检索这台工作台的记忆
aw call image.generate --params '{"profileId":"…","prompt":"…"}'  # 出图（结果落盘回路径）
aw events --session <sid> --follow                      # 实时跟随某个会话的事件流
\`\`\`

## 纪律

- **stdout 只有数据**，诊断走 stderr；\`--json\` 拿机器口径；
  退出码 0 成功 / 2 用法错 / 3 RPC 错 / 4 传输错（daemon 不在或 401）。
- 危险面（daemon.stop、git.push、bot.put…）非交互不拦，\`--yes\` 跳过 TTY 确认。
- token 与 GUI 等权（\`~/.agent-workbench/token\`，\`AGENT_WORKBENCH_HOME\` 可改家）——
  它就是钥匙，别写进日志、别外传。
- 本 SKILL.md 由 daemon 维护（见顶部版本标记行），升级会覆盖；想定制请复制一份改名。

## 什么时候用我

- 用户说「让 XX bot 做…」「看看通知 / 待办」「这台工作台…」
- 你需要跨 bot 协作、查工作台状态、或对其他工作区做 git / 记忆操作
- 你想给用户登记待办、查刚才发生了什么、或发起一次出图
`;
}

export function workbenchSkillPath(rootPath: string): string {
  return path.join(rootPath, ".agents", "skills", WORKBENCH_SKILL_NAME, "SKILL.md");
}

/** 幂等同步（版本标记契约，见 skillSync.ts） */
export async function syncWorkbenchSkill(
  rootPath: string,
  opts: { force?: boolean } = {},
): Promise<SkillSyncResult> {
  const results = await syncCanonicalSkill(
    rootPath,
    { name: WORKBENCH_SKILL_NAME, version: WORKBENCH_SKILL_VERSION, md: workbenchSkillMd() },
    [`.agents/skills/${WORKBENCH_SKILL_NAME}/SKILL.md`],
    opts,
  );
  const r = results[0];
  if (r === undefined) throw new Error("syncCanonicalSkill returned no result for main path");
  return r;
}
