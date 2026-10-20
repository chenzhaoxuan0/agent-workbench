/**
 * zcode reader —— 双源：
 * 列表：~/.zcode/v2/sessions/<workspaceHash>/<taskId>.json（{meta:{taskId,title,workspacePath,
 *        createdAt,updatedAt,status},messages:[{role,content,timestamp,turnIndex}]}，最干净的一家）
 * 兜底：~/.zcode/cli/db/db.sqlite 的 session 表（daemon 既有先例同源）
 * 忽略 .deleted.json（已删会话）。
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { collectFiles, homeDir, isRecord, num, samePath, str } from "../util.ts";

interface ZcodeScan {
  summary: NativeSessionSummary;
  messages: unknown[];
}

function scanAll(limit: number): ZcodeScan[] {
  const root = path.join(homeDir(), ".zcode", "v2", "sessions");
  const out: ZcodeScan[] = [];
  if (existsSync(root)) {
    const files = collectFiles(root, (n) => n.endsWith(".json") && !n.includes("deleted"), 300);
    for (const file of files.slice(0, limit)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!isRecord(raw)) continue;
      const meta = raw["meta"];
      if (!isRecord(meta)) continue;
      const taskId = str(meta["taskId"]) ?? path.basename(file, ".json");
      const messages = Array.isArray(raw["messages"]) ? raw["messages"] : [];
      if (messages.length === 0) continue;
      const startedAt = num(meta["createdAt"]) ?? 0;
      out.push({
        summary: {
          executorId: "zcode",
          sessionId: taskId,
          rootPath: str(meta["workspacePath"]) ?? null,
          title: (str(meta["title"]) ?? "").trim() || "zcode 会话",
          startedAt,
          updatedAt: num(meta["updatedAt"]) ?? startedAt,
          messageCount: messages.length,
          source: file,
        },
        messages,
      });
    }
  }
  out.push(...scanSqlite(limit, new Set(out.map((s) => s.summary.sessionId))));
  return out;
}

/**
 * sqlite 兜底源（~/.zcode/cli/db/db.sqlite 的 session 表）：CLI 近期会话在这里，
 * v2/sessions 的 JSON 只有落盘存档（实测本机 JSON 全是 claude-import 旧档）。
 * 排除已删（time_deleted）与内部 subagent 会话（sess_subagent_*，TUI 恢复用不上
 * 且会污染时间窗匹配）。正文不在此库，read() 对 sqlite-only 会话自然落 null。
 */
function scanSqlite(limit: number, exclude: ReadonlySet<string>): ZcodeScan[] {
  const dbPath = path.join(homeDir(), ".zcode", "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) return [];
  const out: ZcodeScan[] = [];
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, directory, path, title, time_created, time_updated FROM session
         WHERE time_deleted IS NULL AND id NOT LIKE 'sess_subagent_%'
         ORDER BY time_created DESC LIMIT ?`,
      )
      .all(limit) as unknown[];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const sessionId = str(row["id"]);
      if (sessionId === undefined || sessionId === "") continue;
      // 同会话两处都有时 JSON 版带正文，优先；sqlite 只补 JSON 没有的
      if (exclude.has(sessionId)) continue;
      const startedAt = num(row["time_created"]) ?? 0;
      out.push({
        summary: {
          executorId: "zcode",
          sessionId,
          rootPath: str(row["directory"]) ?? str(row["path"]) ?? null,
          title: (str(row["title"]) ?? "").trim(),
          startedAt,
          updatedAt: num(row["time_updated"]) ?? startedAt,
          messageCount: 0,
          source: dbPath,
        },
        messages: [],
      });
    }
  } catch {
    // busy / schema 变化 —— 兜底源静默跳过
  } finally {
    db.close();
  }
  return out;
}

export function createZcodeReader(): SessionReader {
  return {
    executorId: "zcode",
    async list(rootPath, limit) {
      const all = scanAll(300);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(300).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript: NativeTranscriptEntry[] = [];
      for (const m of hit.messages) {
        if (!isRecord(m)) continue;
        const role: "user" | "assistant" = str(m["role"]) === "user" ? "user" : "assistant";
        const raw = m["content"];
        const text = (typeof raw === "string" ? raw : "").trim();
        if (text === "" || text.startsWith("<")) continue;
        transcript.push({ kind: role, text: text.slice(0, 4000), at: num(m["timestamp"]) });
      }
      return { ...hit.summary, transcript };
    },
  };
}
