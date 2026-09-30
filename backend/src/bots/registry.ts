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

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

const ROOTS_KEY = "bot_roots";
const BOT_DIR = ".agent-workbench";
const BOT_FILE = "bot.json";

/** bot.json 的行形态 = WorkUnit 的可持久化子集（松散类型：文件是手可编辑的） */
export type BotDefinition = Record<string, unknown> & {
  id?: string;
  rootPath?: string;
  name?: string;
};

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
   */
  async putBot(unit: BotDefinition): Promise<{ path: string }> {
    if (typeof unit.id !== "string" || unit.id === "") throw Object.assign(new Error("bot.id required"), { code: "bad_params" });
    if (typeof unit.rootPath !== "string" || unit.rootPath === "") throw Object.assign(new Error("bot.rootPath required"), { code: "bad_params" });
    if (typeof unit.name !== "string" || unit.name === "") throw Object.assign(new Error("bot.name required"), { code: "bad_params" });
    const root = path.resolve(unit.rootPath);
    if (!existsSync(root)) throw Object.assign(new Error(`rootPath not found: ${root}`), { code: "root_not_found" });

    const dir = path.join(root, BOT_DIR);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, BOT_FILE);
    await writeFile(file, JSON.stringify(unit, null, 2) + "\n", "utf8");

    const parent = path.dirname(root);
    if (!this.roots().includes(parent) && parent !== root) this.addRoot(parent);
    else if (parent === root) {
      // 评审 P3：rootPath 是盘符/文件系统根时无法登记扫描根（扫描一层子目录语义不适配）——
      // 定义已落盘但永远扫不到，必须把话说在日志里
      log.warn("bot at filesystem root is not scannable — move it into a subdirectory", { root });
    }
    log.info("bot definition written", { id: unit.id, path: file });
    return { path: file };
  }

  // ---- 读 ----

  /** 扫描全部根目录的深度一层子目录，收集 .agent-workbench/bot.json（按 id 去重，后写覆盖先写） */
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
          const raw = await readFile(file, "utf8");
          const def = JSON.parse(raw) as BotDefinition;
          if (typeof def.id === "string" && def.id !== "") {
            // 评审 P2：channels 形状容错——非数组的脏字段归一为缺省，渠道网关按"无渠道"处理
            if (def.channels !== undefined && !Array.isArray(def.channels)) {
              log.warn("bot channels malformed, ignored", { file });
              delete def.channels;
            }
            byId.set(def.id, def);
          }
        } catch (err: unknown) {
          log.warn("bot definition unreadable", { file, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return [...byId.values()];
  }

  /** 读单个 bot（找不到返回 undefined） */
  async getBot(unitId: string): Promise<BotDefinition | undefined> {
    const all = await this.listBots();
    return all.find((b) => b.id === unitId);
  }
}
