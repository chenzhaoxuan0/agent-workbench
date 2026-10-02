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

const ROOTS_KEY = "bot_roots";
const BOT_DIR = ".agent-workbench";
const BOT_FILE = "bot.json";
/** 岗位说明书的规范文件名（相对 rootPath）。bot.json 只存指针，内容住这个文件。 */
const AGENTS_FILE = "AGENTS.md";

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
  /** 内联残留：老 bot.json 把正文塞在 agentsMd 字段里，尚未落盘为文件 */
  inlineAgentsMd: boolean;
}

/** 外部修改检测抛这个：携带当前盘上真值，前端拿它弹「覆盖 / 重新加载 / 取消」 */
export class BotConflictError extends Error {
  readonly code = "conflict";
  /** 随 error.data 过线，前端据此指名是哪个文件变了 */
  readonly data: { reason: "revision" | "agents_md"; current: { revision: number; agentsMd: AgentsFileMeta | null } };
  constructor(
    readonly unitId: string,
    reason: "revision" | "agents_md",
    current: { revision: number; agentsMd: AgentsFileMeta | null },
  ) {
    super(`bot ${unitId}: ${reason} changed on disk since it was read`);
    this.name = "BotConflictError";
    this.data = { reason, current };
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
   */
  async putBot(
    unit: BotDefinition,
    opts: { ifRevision?: number; ifAgentsMdHash?: string } = {},
  ): Promise<{ path: string; revision: number }> {
    if (typeof unit.id !== "string" || unit.id === "") throw Object.assign(new Error("bot.id required"), { code: "bad_params" });
    if (typeof unit.rootPath !== "string" || unit.rootPath === "") throw Object.assign(new Error("bot.rootPath required"), { code: "bad_params" });
    if (typeof unit.name !== "string" || unit.name === "") throw Object.assign(new Error("bot.name required"), { code: "bad_params" });
    const root = path.resolve(unit.rootPath);
    if (!existsSync(root)) throw Object.assign(new Error(`rootPath not found: ${root}`), { code: "root_not_found" });

    const dir = path.join(root, BOT_DIR);
    const file = path.join(dir, BOT_FILE);
    const prev = await this.readFileDef(file);
    const currentRevision = typeof prev?.revision === "number" ? prev.revision : 0;
    const agentsAbs = path.join(root, AGENTS_FILE);
    const currentAgents = await readAgentsMeta(agentsAbs, AGENTS_FILE);

    if (opts.ifRevision !== undefined && opts.ifRevision !== currentRevision) {
      throw new BotConflictError(unit.id, "revision", { revision: currentRevision, agentsMd: currentAgents });
    }
    if (opts.ifAgentsMdHash !== undefined && opts.ifAgentsMdHash !== (currentAgents?.hash ?? "")) {
      throw new BotConflictError(unit.id, "agents_md", { revision: currentRevision, agentsMd: currentAgents });
    }

    // 1) 岗位说明书落盘（原子：先写 .tmp 再 rename，避免半截文件被 listBots 读到）
    const nextAgents = typeof unit.agentsMd === "string" ? unit.agentsMd : null;
    let agentsRel: string;
    if (nextAgents !== null) {
      const tmp = `${agentsAbs}.tmp`;
      await writeFile(tmp, nextAgents, "utf8");
      await rename(tmp, agentsAbs);
      agentsRel = AGENTS_FILE;
    } else {
      // 没带 agentsMd 的写（渠道开关等局部更新）不许顺手清掉已有文件
      agentsRel = sourcePathOf(prev ?? unit) ?? (currentAgents !== null ? AGENTS_FILE : "");
    }

    // 2) 组装 bot.json：去掉 agentsMd 正文，换成 sourcePath 指针 + 自增版本
    const out: BotDefinition = { ...unit };
    delete out.agentsMd;
    delete out.updatedAt;
    if (agentsRel !== "") {
      const identity = (out.identity ?? {}) as Record<string, unknown>;
      out.identity = { ...identity, sourcePath: agentsRel };
    }
    out.revision = currentRevision + 1;
    out.updatedAt = Date.now();

    await mkdir(dir, { recursive: true });
    const tmpFile = `${file}.tmp`;
    await writeFile(tmpFile, JSON.stringify(out, null, 2) + "\n", "utf8");
    await rename(tmpFile, file);

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

  private async readFileDef(file: string): Promise<BotDefinition | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as BotDefinition;
    } catch {
      return null;
    }
  }

  // ---- 读 ----

  /**
   * 扫描全部根目录的深度一层子目录，收集 .agent-workbench/bot.json（按 id 去重，后写覆盖先写）。
   *
   * 无任何内存缓存——每次调用都重扫盘，所以「在 VS Code 改完 AGENTS.md，重开 agent-workbench
   * 就看到新内容」是天然成立的，不需要额外的失效机制。hydrate 在这里做：读到
   * identity.sourcePath 就把 <rootPath>/<sourcePath> 的正文读进 agentsMd。
   */
  async listBots(): Promise<BotDefinition[]> {
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

    const meta: BotMeta = {
      revision: typeof def.revision === "number" ? def.revision : 0,
      updatedAt: typeof def.updatedAt === "number" ? def.updatedAt : 0,
      agentsMd,
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
