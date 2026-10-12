/**
 * 心跳 bot —— 常驻的合成 bot（对齐 steward 的 ensureSteward/stewardDefinition 模式），
 * 待办心跳会话的宿主身份：
 *
 * - 住在 <homeDir>/heartbeat/（引擎起心跳会话的工作目录）
 * - AGENTS.md 是它的岗位说明书：决策依据、输出契约、红线。zcode 等执行器在
 *   cwd 原生读 AGENTS.md —— 心跳 agent 的角色设定不靠 prompt 拼接，靠这份文件。
 * - 执行器/模型绑定是**用户数据**（bot 设置页可改），启动引导只补结构不覆盖；
 *   引擎解析心跳执行器的顺序：backlog 配置显式指定 → 本 bot 的主绑定。
 */

import { mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";

export const HEARTBEAT_BOT_ID = "heartbeat";
export const HEARTBEAT_DIRNAME = "heartbeat";

/** 心跳 bot 默认主绑定（用户的 zcode 是订阅制且有配额探针 —— 最适合烧冗余） */
export const HEARTBEAT_DEFAULT_RUNTIME_ID = "zcode";

export function heartbeatBotRoot(homeDir: string): string {
  return path.join(homeDir, HEARTBEAT_DIRNAME);
}

const HEARTBEAT_AGENTS_MD = `# 心跳（Heartbeat）

你是 agent-workbench 的空闲心跳 agent —— 待办（GTD）清单的决策者。

## 你的职责
每个心跳周期你会收到：就绪待办清单 + 各订阅执行器的余量表。
你要决定：挑一条此刻最值得启动的待办，或本轮沉默。

## 决策依据（按优先级）
1. 执行器余量：优先推荐余量充足、且窗口即将重置（不用就浪费）的执行器
2. 任务大小与上次结果：上次失败的看是否值得重试；长期没跑过的优先
3. 用户排序即优先级：清单靠前的优先，除非余量明显不匹配

## 输出契约（铁律）
只输出一个 JSON 对象，不要输出任何其他文字：
{"action":"propose","itemId":编号,"message":"一句话说明为什么现在跑它","suggestedRuntimeId":"执行器id","estimate":"余量够不够的一句话预估"}
或 {"action":"silence","message":"一句话原因"}

## 红线
- 你无权启动任何任务：确认门在用户手里，你只提议
- 拿不准就沉默 —— 沉默零代价，错误的提议打扰用户
`;

/** 确保目录与 AGENTS.md 就位（幂等；AGENTS.md 是用户数据，存在即不覆盖） */
export async function ensureHeartbeatBot(homeDir: string): Promise<{ rootPath: string; created: boolean }> {
  const root = heartbeatBotRoot(homeDir);
  await mkdir(root, { recursive: true });
  const agentsMd = path.join(root, "AGENTS.md");
  let created = false;
  if (!existsSync(agentsMd)) {
    writeFileSync(agentsMd, HEARTBEAT_AGENTS_MD, "utf8");
    created = true;
    log.info("heartbeat bot AGENTS.md seeded", { root });
  }
  return { rootPath: root, created };
}

/** 心跳 bot 的定义（放进注册表就能被 listBots / getBot 认出来） */
export function heartbeatBotDefinition(rootPath: string, runtimeId = HEARTBEAT_DEFAULT_RUNTIME_ID): Record<string, unknown> {
  return {
    id: HEARTBEAT_BOT_ID,
    role: HEARTBEAT_BOT_ID,
    // kind / tags 必填：前端合并守卫与渲染直接读它们（steward 踩过的坑，见 stewardDefinition 注释）
    kind: "bot",
    name: "心跳",
    rootPath,
    synthetic: true,
    tags: [],
    identity: { sourcePath: "AGENTS.md", role: "空闲心跳：挑待办、写提议、不启动" },
    bindings: [{ runtimeId, primary: true }],
    note: "待办（GTD）心跳的宿主 bot。AGENTS.md 是它的岗位说明书；改执行器/模型在 bot 设置页换主绑定即可。",
  };
}

/**
 * 定义的规范形状（幂等比较用）——从定义本身派生排除表，不手列字段
 * （steward 两次栽在「加了新字段忘进比较列表」上，见 index.ts 的 STEWARD_VOLATILE 注释）。
 */
export function heartbeatBotShape(def: Record<string, unknown>): string {
  const volatile = new Set(["updatedAt", "meta", "$meta", "agentsMd", "agentsMdMeta", "revision", "sourcePath", "identity"]);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def).sort()) {
    if (volatile.has(k)) continue;
    out[k] = def[k];
  }
  return JSON.stringify(out);
}
