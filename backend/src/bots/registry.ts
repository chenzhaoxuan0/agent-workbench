/**
 * Bot 注册表（docs/08 WP-5）—— bot 定义的唯一落盘形态：<rootPath>/.agent-workbench/bot.json。
 *
 * "文件即数据库"哲学的 daemon 侧兑现：daemon 扫描已知根目录即可得全部 bot 的完整定义
 * （身份/文件夹/loop 绑定/记忆/渠道），浏览器关掉也照常 cron 与 IM。
 * 前端只是编辑器 + 写穿缓存（localStorage 五键的接替者）。
 *
 * 形态决策（docs/08 分工底稿）：独立隐藏清单文件，不是 AGENTS.md frontmatter——
 * AGENTS.md 是给人看的岗位说明书（units.ts 头注释的承诺不破），机器配置不混进人读的文件。
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";
import { inspectDirectory, appendGitignore, type InspectReport } from "./inspect.ts";
import { normalizeContextManifest, hasSubstantiveContent } from "../../../prototype/src/core/units.ts";

const ROOTS_KEY = "bot_roots";
const BOT_DIR = ".agent-workbench";
const BOT_FILE = "bot.json";
/** 岗位说明书的规范文件名（相对 rootPath）。bot.json 只存指针，内容住这个文件。 */
const AGENTS_FILE = "AGENTS.md";
/** 人设的规范文件名（ADR 0014 D5，与 AGENTS.md 同构：正文住文件，bot.json 不留副本）。 */
const SOUL_FILE = "SOUL.md";

/**
 * 最小占位 AGENTS.md（ADR 0011：AGENTS.md 从必填降级为可选增强）。
 * 创建时没给内容就静默落这份——文件即数据库不破：规矩文件的落点始终在单元自己
 * 文件夹里，内容克制到一句话，等用户想清楚再回来补。
 */
function placeholderAgentsMd(name: string): string {
  return `# ${name}\n\n（这是 ${name} 的 AGENTS.md——bot 的规矩文件。现在先空着，想清楚要它遵守什么时再回来补。）\n`;
}

/** bot.json 的行形态 = WorkUnit 的可持久化子集（松散类型：文件是手可编辑的） */
export type BotDefinition = Record<string, unknown> & {
  id?: string;
  rootPath?: string;
  name?: string;
};

/** 岗位说明书文件的当前状态。listBots 挂在每个定义上返回（字段名 $meta，前端剥离）。 */
export interface AgentsFileMeta {
  /** 绝对路径——设置页要显示它，用户才知道"在 VS Code 里改哪个文件" */
  path: string;
  relPath: string;
  /** sha256 前 16 hex；乐观锁的比对基准 */
  hash: string;
  mtimeMs: number;
  bytes: number;
}

export interface BotMeta {
  /** bot.json 里的自增版本号。老文件没有 → 0。 */
  revision: number;
  /** 本进程最后写入该定义的 epoch ms；0 = 非本进程写的（老文件/手改） */
  updatedAt: number;
  /** null = 定义里既无 sourcePath 也无内联 agentsMd（纯身份 bot） */
  agentsMd: AgentsFileMeta | null;
  /** null = 没有 SOUL.md（裸 bot，人设未建）。ADR 0014。 */
  soulMd: AgentsFileMeta | null;
  /** 内联残留：老 bot.json 把正文塞在 agentsMd 字段里，尚未落盘为文件 */
  inlineAgentsMd: boolean;
}

/** 外部修改检测抛这个：携带当前盘上真值，前端拿它弹「覆盖 / 重新加载 / 取消」 */
export class BotConflictError extends Error {
  readonly code = "conflict";
  /** 随 error.data 过线，前端据此指名是哪个文件变了 */
  readonly data: {
    reason: "revision" | "agents_md" | "soul_md";
    current: { revision: number; agentsMd: AgentsFileMeta | null; soulMd: AgentsFileMeta | null };
  };
  constructor(
    readonly unitId: string,
    reason: "revision" | "agents_md" | "soul_md",
    current: { revision: number; agentsMd: AgentsFileMeta | null; soulMd?: AgentsFileMeta | null },
  ) {
    super(`bot ${unitId}: ${reason} changed on disk since it was read`);
    this.name = "BotConflictError";
    this.data = { reason, current: { ...current, soulMd: current.soulMd ?? null } };
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

async function readAgentsMeta(abs: string, rel: string): Promise<AgentsFileMeta | null> {
  try {
    const s = await stat(abs);
    const content = await readFile(abs, "utf8");
    return { path: abs, relPath: rel, hash: hashOf(content), mtimeMs: s.mtimeMs, bytes: Buffer.byteLength(content, "utf8") };
  } catch {
    return null;
  }
}

/** 取 identity.sourcePath；只接受不含 `..` 的相对路径，防手改 bot.json 时越界读写 */
function sourcePathOf(def: BotDefinition): string | null {
  const identity = def.identity as { sourcePath?: unknown } | undefined;
  const rel = identity?.sourcePath;
  if (typeof rel !== "string" || rel === "") return null;
  if (path.isAbsolute(rel)) return null;
  const norm = path.normalize(rel);
  if (norm === ".." || norm.startsWith(`..${path.sep}`)) return null;
  return norm;
}

export class BotRegistry {
  constructor(private readonly store: Store) {}

  // ---- 根目录 ----

  /** 已登记的扫描根目录（kv 持久化） */
  roots(): string[] {
    const raw = this.store.kvGet(ROOTS_KEY);
    if (raw === undefined) return [];
    try {
      const arr = JSON.parse(raw) as unknown;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  addRoot(dir: string): void {
    const norm = path.resolve(dir);
    const roots = this.roots();
    if (roots.includes(norm)) return;
    this.store.kvSet(ROOTS_KEY, JSON.stringify([...roots, norm]));
    log.info("bot root added", { dir: norm });
  }

  // ---- 自动安置（ADR 0011 第 4 条）----

  /**
   * 新建流的默认安置位置：<homeDir>/bots 下一个不冲突的建议目录。
   * 幂等建出默认根并登记为扫描根——零门槛新建（用户不动输入框）落位的 bot
   * 天然在 listBots 的扫描范围内；putBot 落笔时也会把 rootPath 的父目录再登记
   * 一次（幂等），两条路径都闭环。
   */
  async defaultPlacement(homeDir: string): Promise<{ defaultRoot: string; suggestedPath: string }> {
    const base = path.join(homeDir, "bots");
    await mkdir(base, { recursive: true });
    this.addRoot(base);
    let name = "bot";
    for (let i = 2; i < 50 && existsSync(path.join(base, name)); i++) name = `bot-${i}`;
    if (existsSync(path.join(base, name))) name = `bot-${Date.now().toString(36)}`;
    const suggestedPath = path.join(base, name);
    log.info("default placement resolved", { defaultRoot: base, suggestedPath });
    return { defaultRoot: base, suggestedPath };
  }

  // ---- 写 ----

  /**
   * 写一个 bot 的定义到 <rootPath>/.agent-workbench/bot.json，并把 rootPath 的
   * 父目录登记为扫描根（这样扫描与写入天然闭环，无需前端另调 roots.add）。
   *
   * **AGENTS.md 指针化**：unit.agentsMd 的正文落到 <rootPath>/AGENTS.md，bot.json 只留
   * `identity.sourcePath`。这是「文件夹即 bot」能成立的前提——用户在 VS Code 里改那个
   * 文件，daemon 重启后 listBots 重新 hydrate 就能看到；反过来设置页保存也直接落到同一个
   * 文件，两边永远是同一份。以前正文躺在 bot.json 里，改文件夹里的文件没有任何效果。
   *
   * **乐观锁**：opts.ifRevision 比对 bot.json 自增版本号（抓 UI 侧并发），
   * opts.ifAgentsMdHash 比对 AGENTS.md 内容 hash（抓用户在这期间改了文件）。
   * 任一不符抛 BotConflictError，不覆盖盘上真值。
   *
   * **opts.createRoot**（自动安置，ADR 0011）：rootPath 不存在时幂等创建而非报错——
   * 新建流的唯一必填交互是文件夹，预填的默认位置本来就不存在，daemon 落位时建出来。
   * 只对显式声明的调用方开（新建），编辑/导入仍报 root_not_found 抓手误路径。
   *
   * **AGENTS.md 可选**：正文为空或缺省、且盘上还没有这个文件时，静默写一份最小占位
   * （见 placeholderAgentsMd）；盘上已有文件则不碰——局部更新（渠道开关等）不许顺手清掉。
   */
  async putBot(
    unit: BotDefinition,
    opts: { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string; createRoot?: boolean } = {},
  ): Promise<{ path: string; revision: number }> {
    if (typeof unit.id !== "string" || unit.id === "") throw Object.assign(new Error("bot.id required"), { code: "bad_params" });
    if (typeof unit.rootPath !== "string" || unit.rootPath === "") throw Object.assign(new Error("bot.rootPath required"), { code: "bad_params" });
    if (typeof unit.name !== "string" || unit.name === "") throw Object.assign(new Error("bot.name required"), { code: "bad_params" });
    const root = path.resolve(unit.rootPath);
    if (!existsSync(root)) {
      if (opts.createRoot !== true) throw Object.assign(new Error(`rootPath not found: ${root}`), { code: "root_not_found" });
      await mkdir(root, { recursive: true });
      log.info("bot root created (auto-placement)", { root });
    }

    // docs/09 §七.4：同路径重复注册拒绝。允许「同一 id 原地更新」（那才是保存），
    // 但不允许 A bot 和 B bot 抢同一个工作目录——它们会互相覆写 bot.json。
    const all = await this.listBots();
    const clash = all.find((b) => b.id !== unit.id && typeof b.rootPath === "string" && path.resolve(b.rootPath) === root);
    if (clash !== undefined) {
      throw Object.assign(
        new Error(`rootPath already registered by bot "${String(clash.id)}" (${String(clash.name)})`),
        { code: "root_taken", unitId: String(clash.id ?? "") },
      );
    }
    // 嵌套不拒绝（子目录做独立 bot 是合法用法），但必须说清楚扫描语义
    const container = all.find(
      (b) => typeof b.rootPath === "string" && path.resolve(b.rootPath) !== root && root.startsWith(path.resolve(b.rootPath) + path.sep),
    );
    if (container !== undefined) {
      log.warn("bot rootPath nested inside another bot's root — both are registered", {
        id: unit.id,
        root,
        inside: String(container.id),
      });
    }

    const dir = path.join(root, BOT_DIR);
    const file = path.join(dir, BOT_FILE);
    const prev = await this.readFileDef(file);
    const currentRevision = typeof prev?.revision === "number" ? prev.revision : 0;
    const agentsAbs = path.join(root, AGENTS_FILE);
    const currentAgents = await readAgentsMeta(agentsAbs, AGENTS_FILE);
    const soulAbs = path.join(root, SOUL_FILE);
    const currentSoul = await readAgentsMeta(soulAbs, SOUL_FILE);

    if (opts.ifRevision !== undefined && opts.ifRevision !== currentRevision) {
      throw new BotConflictError(unit.id, "revision", { revision: currentRevision, agentsMd: currentAgents, soulMd: currentSoul });
    }
    if (opts.ifAgentsMdHash !== undefined && opts.ifAgentsMdHash !== (currentAgents?.hash ?? "")) {
      throw new BotConflictError(unit.id, "agents_md", { revision: currentRevision, agentsMd: currentAgents, soulMd: currentSoul });
    }
    if (opts.ifSoulMdHash !== undefined && opts.ifSoulMdHash !== (currentSoul?.hash ?? "")) {
      throw new BotConflictError(unit.id, "soul_md", { revision: currentRevision, agentsMd: currentAgents, soulMd: currentSoul });
    }

    // 1) 岗位说明书落盘（原子：先写 .tmp 再 rename，避免半截文件被 listBots 读到）
    const nextAgents = typeof unit.agentsMd === "string" ? unit.agentsMd : null;
    let agentsRel: string;
    const writeAgentsAtomic = async (content: string): Promise<void> => {
      const tmp = `${agentsAbs}.tmp`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, agentsAbs);
    };
    if (nextAgents !== null && nextAgents.trim() !== "") {
      await writeAgentsAtomic(nextAgents);
      agentsRel = AGENTS_FILE;
    } else if (currentAgents === null) {
      const prevRel = sourcePathOf(prev ?? unit);
      if (prevRel !== null && prevRel !== AGENTS_FILE) {
        // 老定义指着自定义文件：维持既有语义（不擅自改指 AGENTS.md，也不补占位）
        agentsRel = prevRel;
      } else {
        // 没带正文（或全空白）、盘上也没有规范文件：静默补最小占位（ADR 0011 第 1 条）。
        // 覆盖创建与「指针在、规范文件没了」的修复保存两种情形——文件即数据库不破，
        // 规矩文件的落点始终在单元自己的文件夹里。
        await writeAgentsAtomic(placeholderAgentsMd(String(unit.name)));
        agentsRel = AGENTS_FILE;
        log.info("agents placeholder written", { root });
      }
    } else {
      // 带了空正文但盘上已有文件：不碰它。局部更新不许顺手清掉已有文件。
      // 已知取舍：编辑模式清空 AGENTS.md 正文保存＝「不再主动维护」而非「删除」，
      // 盘上文件保留、重开对话框旧文复现——删文件是破坏性动作，不静默执行。
      agentsRel = sourcePathOf(prev ?? unit) ?? (currentAgents !== null ? AGENTS_FILE : "");
    }

    // 1.5) 人设落盘（ADR 0014 D5）：unit.soulMd 正文 → <rootPath>/SOUL.md，原子写。
    // 与 AGENTS.md 同一套取舍：空正文但盘上已有文件不碰（局部更新不许顺手清掉）；
    // 老定义的 identity.persona 首次保存时物化为 SOUL.md（迁移一次性完成，
    // 之后 persona 字段从 bot.json 剥离）。
    const writeSoulAtomic = async (content: string): Promise<void> => {
      const tmp = `${soulAbs}.tmp`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, soulAbs);
    };
    const legacyPersona = typeof (unit.identity as { persona?: unknown } | undefined)?.persona === "string"
      ? String((unit.identity as { persona?: string }).persona)
      : "";
    let soulWritten = false;
    const nextSoul = typeof unit.soulMd === "string" ? unit.soulMd : "";
    if (nextSoul.trim() !== "") {
      await writeSoulAtomic(nextSoul);
      soulWritten = true;
    } else if (legacyPersona.trim() !== "") {
      const soulRaw = currentSoul !== null ? await readFile(soulAbs, "utf8").catch(() => "") : "";
      if (currentSoul === null || !hasSubstantiveContent(soulRaw)) {
        await writeSoulAtomic(legacyPersona);
        soulWritten = true;
        log.info("persona materialized into SOUL.md", { root });
      }
    }

    // 2) 组装 bot.json：去掉 agentsMd/soulMd 正文与派生 $meta，换成 sourcePath 指针 + 自增版本
    const out: BotDefinition = { ...unit };
    delete out.agentsMd;
    delete out.soulMd;
    delete out.$meta;
    delete out.updatedAt;
    // persona 已物化（或盘上本来就有 SOUL.md）→ 从定义里剥离，bot.json 不再携带
    if (soulWritten || currentSoul !== null) {
      const identity = (out.identity ?? {}) as Record<string, unknown>;
      if ("persona" in identity) {
        const { persona: _drop, ...rest } = identity;
        out.identity = rest;
      }
    }
    if (agentsRel !== "") {
      const identity = (out.identity ?? {}) as Record<string, unknown>;
      out.identity = { ...identity, sourcePath: agentsRel };
    }
    // 重建或保存时，如果之前被注销过，自动恢复注销标记
    if (unit.unregistered !== true) {
      delete out.unregistered;
    }
    out.revision = currentRevision + 1;
    out.updatedAt = Date.now();

    await mkdir(dir, { recursive: true });
    const tmpFile = `${file}.tmp`;
    await writeFile(tmpFile, JSON.stringify(out, null, 2) + "\n", "utf8");
    await rename(tmpFile, file);

    // 3) 自动初始化/补齐标准工作区技能与目录（幂等，绝不覆盖已有正文）
    await this.initWorkspace(root);

    const parent = path.dirname(root);
    if (!this.roots().includes(parent) && parent !== root) this.addRoot(parent);
    else if (parent === root) {
      // 评审 P3：rootPath 是盘符/文件系统根时无法登记扫描根（扫描一层子目录语义不适配）——
      // 定义已落盘但永远扫不到，必须把话说在日志里
      log.warn("bot at filesystem root is not scannable — move it into a subdirectory", { root });
    }
    log.info("bot definition written", { id: unit.id, path: file, revision: out.revision, agentsMd: agentsRel });
    return { path: file, revision: out.revision as number };
  }

  /**
   * 初始化/补齐工作区目录与标准技能（幂等）。
   *
   * 补齐：
   * 1. .agent-workbench/
   * 2. memory/daily/
   * 3. skills/workbench-context/SKILL.md 与 .agents/skills/workbench-context/SKILL.md（各 CLI 通用上下文查询工具）
   * 4. 6 大核心 MD 骨架文件（缺失才补，已有正文绝不覆盖）
   */
  async initWorkspace(rootPath: string): Promise<{ created: string[]; existed: string[] }> {
    const root = path.resolve(rootPath);
    if (!existsSync(root)) {
      await mkdir(root, { recursive: true });
    }
    const created: string[] = [];
    const existed: string[] = [];

    const ensureDir = async (relDir: string): Promise<void> => {
      const full = path.join(root, relDir);
      const posix = relDir.replaceAll("\\", "/");
      if (!existsSync(full)) {
        await mkdir(full, { recursive: true });
        created.push(posix);
      } else {
        existed.push(posix);
      }
    };

    const ensureFile = async (relFile: string, content: string): Promise<void> => {
      const full = path.join(root, relFile);
      const posix = relFile.replaceAll("\\", "/");
      if (!existsSync(full)) {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
        created.push(posix);
      } else {
        existed.push(posix);
      }
    };

    await ensureDir(BOT_DIR);
    await ensureDir(path.join("memory", "daily"));
    await ensureDir(path.join(".agents", "skills", "workbench-context"));
    await ensureDir(path.join("skills", "workbench-context"));

    const skillContent = [
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

    await ensureFile(path.join(".agents", "skills", "workbench-context", "SKILL.md"), skillContent);
    await ensureFile(path.join("skills", "workbench-context", "SKILL.md"), skillContent);

    // 核心 MD 骨架文件（若缺失才创建，绝不覆盖已有正文）
    await ensureFile("MEMORY.md", `# 项目记忆\n\n<!-- 项目级长期事实与技术决策 -->\n- （把项目级事实写在这里…）\n`);
    await ensureFile("STANDING.md", `# 常驻红线\n\n<!-- 不可打破的常驻指令与安全约束 -->\n`);
    await ensureFile("SOUL.md", `# 人设\n\n<!-- 这个 bot 的语气、风格与行为准则 -->\n`);

    return { created, existed };
  }

  /**
   * 软删除/注销 Bot（仅从工作台列表移除注册，不删除磁盘项目文件和代码）。
   */
  async unregisterBot(id: string): Promise<{ ok: boolean; path: string }> {
    const all = await this.listBots({ includeUnregistered: true });
    const target = all.find((b) => b.id === id);
    if (!target || typeof target.rootPath !== "string") {
      throw Object.assign(new Error(`bot "${id}" not found`), { code: "not_found" });
    }
    const file = path.join(path.resolve(target.rootPath), BOT_DIR, BOT_FILE);
    if (!existsSync(file)) {
      throw Object.assign(new Error(`bot "${id}" definition file not found`), { code: "not_found" });
    }
    const def = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    def.unregistered = true;
    def.revision = (typeof def.revision === "number" ? def.revision : 0) + 1;
    def.updatedAt = Date.now();
    await writeFile(file, JSON.stringify(def, null, 2) + "\n", "utf8");
    log.info("bot unregistered (workspace files preserved)", { id, root: target.rootPath });
    return { ok: true, path: file };
  }

  private async readFileDef(file: string): Promise<BotDefinition | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as BotDefinition;
    } catch {
      return null;
    }
  }

  // ---- 探测（纯读）----

  /**
   * 目录探测报告。导入对话框三分支全靠它决定，且**一个字节都不写**。
   * 细节见 bots/inspect.ts。
   */
  async inspect(rootPath: string): Promise<{ report: InspectReport; existing: BotDefinition | null }> {
    return inspectDirectory(rootPath, { knownBots: await this.listBots() });
  }

  /** 往目标仓库的 .gitignore 追加 .agent-workbench/（幂等）。bot.json 里有渠道密钥时这是必须项 */
  async ensureGitignore(rootPath: string): Promise<{ changed: boolean }> {
    return { changed: await appendGitignore(path.resolve(rootPath)) };
  }

  // ---- 读 ----

  /**
   * 扫描全部根目录的深度一层子目录，收集 .agent-workbench/bot.json（按 id 去重，后写覆盖先写）。
   *
   * 无任何内存缓存——每次调用都重扫盘，所以「在 VS Code 改完 AGENTS.md，重开 agent-workbench
   * 就看到新内容」是天然成立的，不需要额外的失效机制。hydrate 在这里做：读到
   * identity.sourcePath 就把 <rootPath>/<sourcePath> 的正文读进 agentsMd。
   */
  async listBots(opts?: { includeUnregistered?: boolean }): Promise<BotDefinition[]> {
    const byId = new Map<string, BotDefinition>();
    for (const rootDir of this.roots()) {
      if (!existsSync(rootDir)) continue;
      let children: string[];
      try {
        children = await readdir(rootDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isDirectory()).map((e) => e.name));
      } catch {
        continue;
      }
      for (const child of children) {
        const file = path.join(rootDir, child, BOT_DIR, BOT_FILE);
        if (!existsSync(file)) continue;
        try {
          const def = JSON.parse(await readFile(file, "utf8")) as BotDefinition;
          if (typeof def.id === "string" && def.id !== "") {
            if (def.unregistered === true && opts?.includeUnregistered !== true) {
              continue;
            }
            // 评审 P2：channels 形状容错——非数组的脏字段归一为缺省，渠道网关按"无渠道"处理
            if (def.channels !== undefined && !Array.isArray(def.channels)) {
              log.warn("bot channels malformed, ignored", { file });
              delete def.channels;
            }
            byId.set(def.id, await this.hydrate(def));
          }
        } catch (err: unknown) {
          log.warn("bot definition unreadable", { file, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return [...byId.values()];
  }

  /**
   * 把 AGENTS.md 的正文读进 agentsMd，并挂上 $meta（版本号 + 文件 hash/mtime/路径）。
   *
   * 三种降级，任何一种都不许抛——单份畸形定义不该拖死整个扫描：
   * 1. 有 sourcePath 且文件在 → 读进来
   * 2. 有 sourcePath 但文件不在 → agentsMd 留空，meta.agentsMd = null（设置页显示"文件缺失"）
   * 3. 老 bot.json 内联了 agentsMd → 直接沿用，meta.inlineAgentsMd = true（下次保存自动迁移成文件）
   */
  private async hydrate(def: BotDefinition): Promise<BotDefinition> {
    const out: BotDefinition = { ...def };
    const root = typeof def.rootPath === "string" ? def.rootPath : "";
    const rel = sourcePathOf(def);
    let agentsMd: AgentsFileMeta | null = null;
    const inline = typeof def.agentsMd === "string" && def.agentsMd !== "";

    if (rel !== null && root !== "") {
      const abs = path.resolve(root, rel);
      agentsMd = await readAgentsMeta(abs, rel);
      if (agentsMd !== null) {
        try {
          out.agentsMd = await readFile(abs, "utf8");
        } catch {
          agentsMd = null;
        }
      } else {
        delete out.agentsMd; // 指针在、文件没了：留空比留旧正文诚实
      }
    } else if (inline) {
      out.agentsMd = def.agentsMd; // 内联残留，原样带回
    }

    // SOUL.md hydrate（ADR 0014 D5）：文件优先；老定义的 identity.persona 以 soulMd
    // 兜底展示（$meta.soulMd = null 表示文件还没建，首次保存即物化为 SOUL.md）。
    let soulMd: AgentsFileMeta | null = null;
    if (root !== "") {
      const soulAbs = path.resolve(root, SOUL_FILE);
      soulMd = await readAgentsMeta(soulAbs, SOUL_FILE);
      if (soulMd !== null) {
        try {
          out.soulMd = await readFile(soulAbs, "utf8");
        } catch {
          soulMd = null;
          delete out.soulMd;
        }
      } else {
        delete out.soulMd;
        const persona = (def.identity as { persona?: unknown } | undefined)?.persona;
        if (typeof persona === "string" && persona.trim() !== "") out.soulMd = persona;
      }
    }

    // 上下文清单读时归一（ADR 0014）：整节缺失/畸形 = 存量语义（LEGACY），
    // 字段级缺失 = 显式 false。归一值随下次保存自然落盘。
    out.contextManifest = normalizeContextManifest(def.contextManifest);

    const meta: BotMeta = {
      revision: typeof def.revision === "number" ? def.revision : 0,
      updatedAt: typeof def.updatedAt === "number" ? def.updatedAt : 0,
      agentsMd,
      soulMd,
      inlineAgentsMd: rel === null && inline,
    };
    out.$meta = meta;
    return out;
  }

  /** 读单个 bot（找不到返回 undefined） */
  async getBot(unitId: string): Promise<BotDefinition | undefined> {
    const all = await this.listBots();
    return all.find((b) => b.id === unitId);
  }
}
