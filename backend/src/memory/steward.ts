/**
 * 总管 bot 与检索权限（docs/10 §4.6 / §七）。
 *
 * 用户的原始判断（2026-10-04）：
 * > 「全局的 part 全局记忆经常导致 A 项目出现 B 项目的记忆，会导致我对 agent 非常不信任」
 *
 * 所以**默认关**。管家是唯一默认开检索的角色；其他 bot 要搜必须显式开。
 *
 * 铁律：**搜到 ≠ 注入**（红线 6）。
 * 检索结果永远只出现在「谁主动查」的那一次响应里，**不会**被写进
 * 项目 bot 的 prompt prefix。结构上已经保证了：注入器只读
 * `<rootPath>/MEMORY.md`（`FileMemoryInjector.build` 只接一个 rootPath），
 * 跨项目的东西没有任何一条通路能流进项目的上下文。
 * 本文件的存在只是为了**在权限入口再钉一道**，别让后人写出绕过的路。
 */

import path from "node:path";
import { log } from "../log.ts";
import { search, loadContext, type SearchOptions, type SearchResult } from "./search.ts";
import { ensureLayout, readLongTerm, listDaily, readDaily } from "./projectMemory.ts";
import type { ScanSource } from "./scanner.ts";

/** 管家 bot 的固定 id 与目录名。 */
export const STEWARD_ID = "steward";
export const STEWARD_DIRNAME = "steward";

export type BotRole = "steward" | "normal";

/** 管家自己就在工作台 home 下面，不占用户任何项目文件夹。 */
export function stewardRoot(homeDir: string): string {
  return path.join(homeDir, STEWARD_DIRNAME);
}

/**
 * 从 bot 定义里读出角色与检索开关。
 * 两个字段都缺省 = 普通 bot = **没有跨项目检索权**。
 */
export function authorityOf(def: Record<string, unknown> | null | undefined): { role: BotRole; crossSearch: boolean } {
  if (def === null || def === undefined) return { role: "normal", crossSearch: false };
  const role: BotRole = def["role"] === STEWARD_ID ? "steward" : "normal";
  const crossSearch = def["crossSearch"] === true;
  return { role, crossSearch };
}

export function canCrossSearch(def: Record<string, unknown> | null | undefined): boolean {
  const a = authorityOf(def);
  return a.role === "steward" || a.crossSearch;
}

export class CrossSearchDenied extends Error {
  constructor(botId: string) {
    super(
      `bot「${botId}」没有跨项目检索权。默认关闭是有意为之：` +
        `全局记忆曾经导致 A 项目里冒出 B 项目的记忆，直接摧毁对 agent 的信任。` +
        `要开请在 bot 定义里设 crossSearch: true，或改问管家 bot。`,
    );
    Object.assign(this, { code: "cross_search_denied" });
  }
}

/** 初始化时确保管家 bot 就位（幂等）。 */
export async function ensureSteward(homeDir: string): Promise<{ rootPath: string; created: boolean }> {
  const root = stewardRoot(homeDir);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  const before = await readLongTerm(root);
  await ensureLayout(root);
  if (!before.exists) log.info("steward bot created", { root });
  return { rootPath: root, created: !before.exists };
}

/** 管家的 bot 定义。放进注册表就能被 listBots / getBot 认出来。 */
export function stewardDefinition(rootPath: string): Record<string, unknown> {
  return {
    id: STEWARD_ID,
    role: STEWARD_ID,
    name: "总管",
    rootPath,
    crossSearch: true,
    synthetic: true,
    note: "跨项目检索的唯一默认入口。项目记忆不进它的注入块，检索结果只出现在它主动查的那一轮。",
  };
}

export interface StewardSearchOptions extends Omit<SearchOptions, "query"> {
  readonly query: string;
  /** 要附上命中处的上下文 */
  readonly withContext?: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
}

export interface StewardSearchHit {
  readonly cli: string;
  readonly at: string;
  readonly project: string | null;
  readonly sessionId: string | null;
  readonly srcPath: string;
  readonly lineNo: number;
  readonly score: number;
  readonly text: string;
  readonly context: readonly string[];
}

export interface StewardSearchResponse {
  readonly query: string;
  readonly hits: StewardSearchHit[];
  readonly scannedBlocks: number;
  readonly elapsedMs: number;
  readonly byCli: Record<string, number>;
  /** 搜索范围被 pathHint 收窄过（前端可以提示"只搜了 X"） */
  readonly scoped: boolean;
}

/**
 * 管家的跨会话追溯搜索。**权限在这一层钉死**。
 * 调用方必须传 bot 定义；没权限直接抛，不给「悄悄返回空」的机会。
 */
export async function stewardSearch(
  requester: Record<string, unknown> | null | undefined,
  opts: StewardSearchOptions,
): Promise<StewardSearchResponse> {
  const botId = typeof requester?.["id"] === "string" ? (requester["id"] as string) : "(未知)";
  if (!canCrossSearch(requester)) throw new CrossSearchDenied(botId);

  const r: SearchResult = await search(opts);
  const withCtx = opts.withContext === true;
  const hits: StewardSearchHit[] = [];
  for (const h of r.hits) {
    const context =
      withCtx && h.score > 0
        ? await loadContext(h.block.srcPath, h.block.lineNo, {
            before: opts.contextBefore ?? 1,
            after: opts.contextAfter ?? 1,
          })
        : [];
    hits.push({
      cli: h.block.cli,
      at: new Date(h.block.ts).toISOString(),
      project: h.block.cwd ?? null,
      sessionId: h.block.sessionId ?? null,
      srcPath: h.block.srcPath,
      lineNo: h.block.lineNo,
      score: Number(h.score.toFixed(4)),
      text: h.block.text,
      context,
    });
  }
  return {
    query: opts.query,
    hits,
    scannedBlocks: r.scannedBlocks,
    elapsedMs: r.elapsedMs,
    byCli: r.byCli,
    scoped: typeof opts.pathHint === "string" && opts.pathHint !== "",
  };
}

/** 管家的「近况」：最近几天的日报清单。 */
export async function stewardRecent(homeDir: string, limit = 7): Promise<Array<{ date: string; chars: number; content: string }>> {
  const root = stewardRoot(homeDir);
  const names = (await listDaily(root)).slice(0, limit);
  const out: Array<{ date: string; chars: number; content: string }> = [];
  for (const n of names) {
    const date = n.replace(/\.md$/, "");
    const f = await readDaily(root, date);
    out.push({ date, chars: f.chars, content: f.content });
  }
  return out;
}

export type { ScanSource };
