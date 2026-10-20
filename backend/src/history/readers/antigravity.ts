/**
 * antigravity reader —— ~/.gemini/antigravity-cli/conversation_summaries.db（SQLite）：
 * conversation_summaries 表一行一会话：conversation_id（即 --conversation 的口径）/
 * title / preview / last_modified_time（RFC3339 字符串，空格分隔 + 7 位小数秒）/
 * workspace_uris（JSON 数组，file:///c:/… 形态）/ last_user_input_time。
 * 会话正文在 conversations/<uuid>.db 的 steps 表里是 protobuf 风格 blob，
 * 本 reader 只做列表（下钻 read 返回 null，原生详情页对这家暂缺——不影响
 * resume 回溯，回溯只需要列表的 id/时间/工作区）。实测采样 2026-10。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import { homeDir, isRecord, samePath, str } from "../util.ts";

function dbPath(): string {
  return path.join(homeDir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
}

/** "2026-07-14 05:53:01.5313905+00:00" → ms（空格分隔 + 超长小数秒，Date.parse 不认） */
function parseAntigravityTime(v: unknown): number {
  const s = str(v);
  if (s === undefined || s === "") return 0;
  const normalized = s.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : 0;
}

/** workspace_uris 的首个 file:// URI → 本地路径（仅用于 samePath 匹配，大小写不敏感） */
function rootPathOfUris(v: unknown): string | null {
  const s = str(v);
  if (s === undefined || s === "") return null;
  let arr: unknown;
  try {
    arr = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    const uri = str(item);
    if (uri === undefined || !uri.startsWith("file://")) continue;
    try {
      const decoded = decodeURIComponent(uri.slice("file://".length)).replace(/^\/(?=[A-Za-z]:[\\/])/, "");
      if (/^[A-Za-z]:[\\/]/.test(decoded)) return decoded;
    } catch {
      /* 裸 % 串 */
    }
  }
  return null;
}

export function createAntigravityReader(): SessionReader {
  return {
    executorId: "antigravity",
    async list(rootPath, limit) {
      const p = dbPath();
      if (!existsSync(p)) return [];
      const db = new DatabaseSync(p, { open: true, readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT conversation_id, title, preview, last_modified_time, workspace_uris, last_user_input_time
             FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`,
          )
          .all(Math.max(limit, 200)) as unknown[];
        const out: NativeSessionSummary[] = [];
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const sessionId = str(row["conversation_id"]);
          if (sessionId === undefined || sessionId === "") continue;
          const root = rootPathOfUris(row["workspace_uris"]);
          if (rootPath !== null && (root === null || !samePath(root, rootPath))) continue;
          const startedAt = parseAntigravityTime(row["last_user_input_time"]) || parseAntigravityTime(row["last_modified_time"]);
          out.push({
            executorId: "antigravity",
            sessionId,
            rootPath: root,
            title: (str(row["title"]) ?? str(row["preview"]) ?? "").trim(),
            startedAt,
            updatedAt: parseAntigravityTime(row["last_modified_time"]) || startedAt,
            messageCount: 0,
            source: p,
          });
          if (out.length >= limit) break;
        }
        return out;
      } finally {
        db.close();
      }
    },
    async read(): Promise<NativeSessionDetail | null> {
      // 正文在每会话独立 db 的 protobuf blob 里，解析成本高且格式无稳定性承诺 ——
      // 列表面（与 resume 回溯）不需要它，先不实现下钻
      return null;
    },
  };
}
