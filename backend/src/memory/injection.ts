/**
 * 上下文注入器 —— 读写通路的实现（docs/10 §4.2 + ADR 0014 / docs/20）。
 *
 * 读：派发前把 manifest 选中的上下文文件拼成 prefix 加在用户消息前 → **任何 CLI 都吃到**，
 *     不依赖它读不读文件（claude 读 CLAUDE.md、codex 读 AGENTS.md、pi 读自己的）。
 * 写：告诉 agent 用它自带的文件工具改 MEMORY.md → **零适配**。
 *
 * 关键取舍：本项目**不做 MCP、不做 memory 工具**。workbench 不拥有工具集，
 * 它把活派给外部进程；让 agent 改文件比给每家 CLI 挂一套工具便宜得多。
 * 代价是约束更宽松（靠 prompt 规则 + 2200 上限 + 备份 + curator 兜底），
 * 这是有意接受的 —— 见 docs/10 §4.2。
 *
 * 注入什么由两层决定（ADR 0014）：
 * - **plan**（新）：host 从 bot.json 的 contextManifest 归一出的布尔矩阵，
 *   AGENTS.md 的 auto 防双注判定已在 host 收口——注入器只认最终布尔。
 * - **scopes**（旧/显式覆盖）：`/mem` 一类的会话级覆盖，只作用于记忆两柱
 *   （semantic/daily）。plan 缺省时退回旧行为（semantic 默认 + STANDING 恒注入）。
 *
 * 冻结快照：**只在 startSession 注入一次**。续聊不重复注入（保住 LLM 前缀缓存，
 * 也符合 hermes 的做法）；切换执行器会开新会话 → 冷启动时自然会重新注入。
 *
 * 节顺序（ADR 0014 D6）：AGENTS（仅兜底）→ SOUL → USER → MEMORY → 当日精炼
 * → STANDING（红线压轴，近因效应）。
 */

import {
  readLongTerm,
  readDaily,
  readStanding,
  readSoul,
  readUser,
  readAgentsMd,
  resolvePaths,
} from "./projectMemory.ts";
import { listCatalogSkills, type CatalogSkillEntry } from "../skills/inventory.ts";
import { localDate } from "./dailyDigest.ts";
import { measure, extractEntries } from "./limits.ts";
import { redact } from "./redact.ts";
import {
  renderRule,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_CLOSE,
  STANDING_BLOCK_OPEN,
  STANDING_BLOCK_CLOSE,
  INJECTION_SEPARATOR,
} from "./ruleTemplate.ts";

export type InjectionScope = "agents" | "soul" | "user" | "semantic" | "daily" | "standing" | "skills";

export interface InjectedPart {
  readonly scope: InjectionScope;
  readonly sourcePath: string;
  readonly chars: number;
}

export interface InjectedPrompt {
  /** 注入后的完整 prompt = block + separator + userText */
  readonly prompt: string;
  /** 注入块本体（不含 userText），分发日志存这份就够还原「它当时知道什么」 */
  readonly block: string;
  /** 结构化清单，供 UI 展示与后续 curator 统计 */
  readonly parts: readonly InjectedPart[];
  /** 注入块总字符数 */
  readonly injectedChars: number;
}

/**
 * 最终注入布尔矩阵（ADR 0014）：host 把 manifest + 执行器原生读取能力归一成这份。
 * 注入器不认识 manifest 三态——auto 的防双注判定不在这里。
 */
export interface ContextInjectPlan {
  /** AGENTS.md 兜底注入（仅执行器不原生读取且未显式关闭时为 true） */
  readonly agentsMd: boolean;
  readonly soul: boolean;
  readonly user: boolean;
  readonly memorySemantic: boolean;
  readonly memoryDaily: boolean;
  readonly memoryStanding: boolean;
  /** 技能目录注入（name + 路径，不注 SKILL.md 全文；名单来自 opts.skills） */
  readonly skills: boolean;
}

/** 技能目录注入预算（docs/20 P4，对齐 openclaw skills.limits 的精神）：超出截断并明示 */
export const SKILLS_IN_PROMPT_MAX = 30;

export interface ContextInjectorOptions {
  /** 注入矩阵。缺省 = 无 manifest 的调用方，注入器退回 legacy 行为 */
  readonly plan?: ContextInjectPlan;
  /**
   * 显式覆盖（/mem）：只替换记忆两柱 semantic/daily 的选择，
   * 不影响 AGENTS/SOUL/USER。plan 缺省时这就是 legacy 的 scopes 语义。
   */
  readonly scopes?: readonly ("semantic" | "daily" | "procedural")[];
  /** 每 bot 技能绑定（ADR 0014 D8）：plan.skills 时过滤目录名单；缺省 = all */
  readonly skills?: { readonly enabled: "all" | readonly string[] };
  /** 指定 daily 的日期，缺省为当天 localDate() */
  readonly dailyDate?: string;
  /** 每日摘要字符上限截断保护（防止当天日报过长，例如默认 4000 字符） */
  readonly dailyLimit?: number;
}

/** host.ts 只认这个接口，不依赖 memory 模块的具体实现（保持依赖方向单一）。 */
export interface ContextInjector {
  build(rootPath: string, userText: string, opts?: ContextInjectorOptions): Promise<InjectedPrompt | null>;
}

/**
 * 默认注入器。构造时拿 homeDir（USER.md 全局层住在那里，与项目文件夹无关）。
 *
 * 返回 null = 不注入。什么时候会 null：
 * - manifest 全关且无任何可注入内容（裸跑是合法状态）
 * - 请求的文件全都不存在/是空模板（注入一堆规则不划算）
 */
export class FileMemoryInjector implements ContextInjector {
  constructor(private readonly homeDir: string = "") {}

  async build(rootPath: string, userText: string, opts?: ContextInjectorOptions): Promise<InjectedPrompt | null> {
    const paths = resolvePaths(rootPath);
    const plan = opts?.plan;
    const scopes = opts?.scopes;
    // 三层判定（ADR 0014）：
    // 1. scopes 显式给了（/mem 会话级覆盖）→ **替换**记忆两柱的选择（legacy 同语义）；
    // 2. plan 在（bot.json 的 contextManifest 归一）→ 矩阵说了算；
    // 3. 都不在 → 旧行为：semantic 默认注入、STANDING 存在即注入，其余不注。
    const explicitScopes = scopes !== undefined;
    const wantSemantic = explicitScopes
      ? scopesIncludes(scopes, "semantic")
      : plan !== undefined
        ? plan.memorySemantic
        : true;
    const wantDaily = explicitScopes
      ? scopesIncludes(scopes, "daily")
      : plan !== undefined
        ? plan.memoryDaily
        : false;
    const wantStanding = plan !== undefined ? plan.memoryStanding : true;
    const wantAgents = plan?.agentsMd === true;
    const wantSoul = plan?.soul === true;
    const wantUser = plan?.user === true && this.homeDir !== "";
    const wantSkills = plan?.skills === true;

    const parts: InjectedPart[] = [];
    const sections: string[] = [];

    // 0. 岗位说明书兜底（ADR 0014 D4：仅执行器不原生读取 AGENTS.md 时）。
    // 原生读取每轮新鲜生效，优于这里的冻结快照——auto 已经在 host 判过「不注」。
    if (wantAgents) {
      try {
        const agents = await readAgentsMd(rootPath);
        if (agents.exists && agents.content.trim() !== "") {
          const over = agents.chars > agents.limit;
          const body = over ? truncateToBudget(agents.content, agents.limit, "AGENTS.md") : agents.content.trim();
          sections.push(
            [
              "### 岗位说明书（AGENTS.md · 工作台注入）",
              "",
              "以下是该 bot 的 AGENTS.md 内容（只读载入）：",
              "",
              body,
            ].join("\n"),
          );
          parts.push({ scope: "agents", sourcePath: agents.path, chars: agents.chars });
        }
      } catch {
        // 读失败不阻断其余注入
      }
    }

    // 1. 人设（SOUL.md，用户维护，只读注入）
    if (wantSoul) {
      try {
        const soul = await readSoul(rootPath);
        if (soul.exists && soul.content.trim() !== "") {
          const over = soul.chars > soul.limit;
          const body = over ? truncateToBudget(soul.content, soul.limit, "SOUL.md") : soul.content.trim();
          sections.push(
            [
              "### 人设（SOUL.md · 只读）",
              "",
              "以下是这个 bot 的人设与主动人格提示词（由用户维护，只读载入，不要修改该文件）：",
              "",
              body,
            ].join("\n"),
          );
          parts.push({ scope: "soul", sourcePath: soul.path, chars: soul.chars });
        }
      } catch {
        // 同上：单节失败不拖死整块
      }
    }

    // 2. 关于用户（USER.md，全局层，逐 bot 开关）
    if (wantUser) {
      try {
        const user = await readUser(this.homeDir);
        if (user.exists && user.content.trim() !== "") {
          const over = user.chars > user.limit;
          const body = over ? truncateToBudget(user.content, user.limit, "USER.md") : user.content.trim();
          sections.push(
            [
              "### 关于用户（USER.md · 只读）",
              "",
              "以下是关于用户本人的常驻信息（作息、偏好、环境；由用户维护，只读载入）：",
              "",
              body,
            ].join("\n"),
          );
          parts.push({ scope: "user", sourcePath: user.path, chars: user.chars });
        }
      } catch {
        // 同上
      }
    }

    // 3. 语义记忆（长期事实：MEMORY.md，上限 2200 字符）
    if (wantSemantic) {
      const file = await readLongTerm(rootPath);
      // 模板刚建出来、还没有任何真实记忆 → 不注入（避免每轮白烧规则 token）
      if (file.exists && hasRealEntries(file.content)) {
        const over = file.chars > file.limit;
        const entries = extractEntries(file.content);
        const body = over ? truncateToBudget(file.content, file.limit) : file.content.trim();

        const rule = renderRule({
          memoryPath: paths.memoryMd,
          used: file.chars,
          nearLimit: file.chars / file.limit >= 0.8,
          over,
          keptEntries: entries.length,
        });

        const semanticSection = [
          rule,
          "",
          over ? "以下是 MEMORY.md 的内容（**已截断**）：" : "以下是 MEMORY.md 的当前内容：",
          "",
          body,
        ].join("\n");

        sections.push(semanticSection);
        parts.push({ scope: "semantic", sourcePath: paths.memoryMd, chars: file.chars });
      }
    }

    // 4. 当日会话精炼提取（按天分片：memory/daily/YYYY-MM-DD.md，只读参考）
    if (wantDaily) {
      const date = opts?.dailyDate ?? localDate();
      try {
        const dailyFile = await readDaily(rootPath, date);
        if (dailyFile.exists && dailyFile.content.trim().length > 0) {
          const limit = opts?.dailyLimit ?? 4000;
          const over = dailyFile.chars > limit;
          const body = over ? truncateToBudget(dailyFile.content, limit, "当日精炼") : dailyFile.content.trim();

          const dailySection = [
            `### 当日会话精炼（${date}）`,
            "",
            "以下是该项目当天的会话精炼与关键结论（自动提取，只读参考）：",
            "",
            body,
          ].join("\n");

          sections.push(dailySection);
          parts.push({ scope: "daily", sourcePath: dailyFile.path, chars: dailyFile.chars });
        }
      } catch {
        // 日期不合法或读取失败时不阻断其他记忆注入
      }
    }

    // 5. 技能目录（ADR 0014 D8）：openclaw 式目录注入——name + 路径，不注 SKILL.md
    // 全文，agent 需要时用文件工具按需读。名单过滤 = bot.json 的 skills 绑定。
    if (wantSkills) {
      try {
        const binding = opts?.skills?.enabled ?? "all";
        const all = listCatalogSkills(rootPath);
        const picked = binding === "all" ? all : all.filter((s) => (binding as readonly string[]).includes(s.dirName));
        if (picked.length > 0) {
          const over = picked.length > SKILLS_IN_PROMPT_MAX;
          const list = over ? picked.slice(0, SKILLS_IN_PROMPT_MAX) : picked;
          const lines = list.map((s) => renderCatalogLine(s));
          if (over) {
            lines.push(`…（共 ${picked.length} 个，受注入预算截断为前 ${SKILLS_IN_PROMPT_MAX} 个；完整清单见工作台技能页）`);
          }
          const section = [
            "### 可用技能（目录 · 按需读取）",
            "",
            "以下是这个 bot 可用的技能目录。需要某项能力时，先用文件工具读取对应路径下的 SKILL.md 获取完整用法，再动手：",
            "",
            lines.join("\n"),
          ].join("\n");
          sections.push(section);
          // sourcePath 如实记目录条数（chars 与其他 scope 同口径 = 渲染段字符数）
          parts.push({ scope: "skills", sourcePath: `${rootPath}（技能目录 ${picked.length} 项）`, chars: measure(section) });
        }
      } catch {
        // 目录枚举失败不阻断其他注入
      }
    }

    // 6. 常驻指令（红线与安全约束：STANDING.md，上限 1000 字符，只读禁令）。
    // 压轴（ADR 0014 D6）：利用近因效应强化红线遵守。
    if (wantStanding) {
      try {
        const standing = await readStanding(rootPath);
        if (standing.exists && hasRealEntries(standing.content)) {
          const over = standing.chars > standing.limit;
          const body = over ? truncateToBudget(standing.content, standing.limit, "STANDING.md") : standing.content.trim();
          const standingSection = [
            STANDING_BLOCK_OPEN,
            "以下是当前项目的不可打破之常驻指令与红线（只读载入，严禁修改）：",
            "",
            body,
            STANDING_BLOCK_CLOSE,
          ].join("\n");
          sections.push(standingSection);
          parts.push({ scope: "standing", sourcePath: paths.standingMd, chars: standing.chars });
        }
      } catch {
        // STANDING.md 读取失败不阻断后续记忆注入
      }
    }

    if (sections.length === 0 || parts.length === 0) return null;

    const block = [
      MEMORY_BLOCK_OPEN,
      "",
      sections.join("\n\n---\n\n"),
      "",
      MEMORY_BLOCK_CLOSE,
    ].join("\n");

    return {
      prompt: `${block}${INJECTION_SEPARATOR}${userText}`,
      // 注入块会整块落进 dispatches 表、还会经 memory.dispatches 原样返回 ——
      // MEMORY.md 里若粘了密钥，不遮蔽就是明文进库、进 RPC 响应（review 抓到的阻断项）
      block: redact(block),
      parts,
      injectedChars: measure(block),
    };
  }
}

function scopesIncludes(scopes: readonly string[] | undefined, name: "semantic" | "daily"): boolean {
  return Array.isArray(scopes) && scopes.includes(name);
}

/** 一条技能目录行：`- name — <path>`（openclaw skill-prompt-catalog 同款形状） */
function renderCatalogLine(s: CatalogSkillEntry): string {
  return `- ${s.name} — ${s.path}`;
}

/**
 * 超限时保留到预算内。**优先留尾部**（新写的通常在后面），并加一句显式截断标记，
 * 让模型知道「还有内容没给它」，而不是以为自己看到了全部。
 *
 * `label` 是给模型看的「谁超限了」：长期记忆与当日精炼共用一个函数，
 * 写死 MEMORY.md 会让「当日精炼被截断」被读成「MEMORY.md 超限了」，
 * 模型于是跑去整合一个其实没超限的文件。
 */
export function truncateToBudget(content: string, limit: number, label = "MEMORY.md"): string {
  // 放得下就原样返回：不该凭空插一句「省略 0 字符」（第一版有这个瑕疵）
  if (content.length <= limit) return content;
  // 4/6 分：尾部（新内容）多留一点 —— 与上面那句「优先留尾部」对齐
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const keepTail = content.slice(Math.max(0, content.length - tail));
  const keepHead = content.slice(0, Math.max(0, head));
  const omitted = Math.max(0, content.length - keepHead.length - keepTail.length);
  return [
    keepHead.trimEnd(),
    `\n…（中间省略 ${omitted} 字符：${label} 已超上限 ${limit}，需要整合）…\n`,
    keepTail.trimStart(),
  ].join("\n");
}

/**
 * 有没有「真实记忆」。
 * 模板本身是：`# 项目记忆` + 一行 HTML 注释 + 一行占位 `- （把项目级事实写在这里…）`。
 * 那行占位是 `- ` 开头，不能被当成真实条目 —— 否则新建的文件夹会被判成「有记忆」。
 */
export function hasRealEntries(content: string): boolean {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && l.length > 2)
    .filter((l) => !/^-\s*[（(]/.test(l)) // 排除模板占位行
    .length > 0;
}
