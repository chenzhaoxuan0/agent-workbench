/**
 * openclaw reader —— ~/.openclaw/agents/main/agent/openclaw-agent.sqlite（SQLite，WAL）：
 * - session_windows 表：session_id / started_at / ended_at / status / display_name（ms）
 *   （session_id 即 `openclaw agent --session-id` 的口径；多 agent 部署只读 main）
 * - transcript_events 表：session_id / seq / event_json ——
 *   type:"session" 事件带 cwd（列表的 rootPath 从这取），type:"message" 事件带
 *   message.role / message.content（read() 的转录源；event_zstd 列有值时为压缩帧，
 *   宽容跳过）。实测采样 2026-10。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { entriesFromContent, homeDir, isRecord, num, samePath, str } from "../util.ts";

function dbPath(): string {
  return path.join(homeDir(), ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
}

interface WindowRow {
  session_id: string;
  started_at: number | null;
  ended_at: number | null;
  status: string | null;
  display_name: string | null;
}

function openDb(): DatabaseSync | null {
  const p = dbPath();
  if (!existsSync(p)) return null;
  return new DatabaseSync(p, { open: true, readOnly: true });
}

/** 取会话首帧 session 事件里的 cwd（seq 从 0 找前几帧，找不到返回 null） */
function cwdOf(db: DatabaseSync, sessionId: string): string | null {
  const rows = db
    .prepare(`SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 5`)
    .all(sessionId) as unknown[];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(str(row["event_json"]) ?? "");
    } catch {
      continue;
    }
    if (isRecord(ev) && str(ev["type"]) === "session") {
      const cwd = str(ev["cwd"]);
      if (cwd !== undefined && cwd !== "") return cwd;
    }
  }
  return null;
}

export function createOpenclawReader(): SessionReader {
  return {
    executorId: "openclaw",
    async list(rootPath, limit) {
      const db = openDb();
      if (db === null) return [];
      try {
        const rows = db
          .prepare(
            `SELECT session_id, started_at, ended_at, status, display_name FROM session_windows
             ORDER BY started_at DESC LIMIT ?`,
          )
          .all(Math.max(limit, 200)) as unknown[];
        const out: NativeSessionSummary[] = [];
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const sessionId = str(row["session_id"]);
          if (sessionId === undefined || sessionId === "") continue;
          const startedAt = num(row["started_at"]) ?? 0;
          const summary: NativeSessionSummary = {
            executorId: "openclaw",
            sessionId,
            // cwd 在 transcript 的 session 首帧里 —— rootPath 过滤开着才花这个查询
            rootPath: rootPath === null ? null : cwdOf(db, sessionId),
            title: (str(row["display_name"]) ?? "").trim(),
            startedAt,
            updatedAt: num(row["ended_at"]) ?? startedAt,
            messageCount: 0,
            source: dbPath(),
          };
          if (rootPath !== null && (summary.rootPath === null || !samePath(summary.rootPath, rootPath))) continue;
          out.push(summary);
          if (out.length >= limit) break;
        }
        return out;
      } finally {
        db.close();
      }
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const db = openDb();
      if (db === null) return null;
      try {
        const hit = db
          .prepare(`SELECT session_id, started_at, ended_at, display_name FROM session_windows WHERE session_id = ?`)
          .get(sessionId);
        if (!isRecord(hit)) return null;
        const startedAt = num(hit["started_at"]) ?? 0;
        const summary: NativeSessionSummary = {
          executorId: "openclaw",
          sessionId: str(hit["session_id"]) ?? sessionId,
          rootPath: cwdOf(db, sessionId),
          title: (str(hit["display_name"]) ?? "").trim(),
          startedAt,
          updatedAt: num(hit["ended_at"]) ?? startedAt,
          messageCount: 0,
          source: dbPath(),
        };
        const events = db
          .prepare(`SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC`)
          .all(sessionId) as unknown[];
        const transcript: NativeTranscriptEntry[] = [];
        for (const row of events) {
          if (!isRecord(row)) continue;
          let ev: unknown;
          try {
            ev = JSON.parse(str(row["event_json"]) ?? "");
          } catch {
            continue;
          }
          if (!isRecord(ev) || str(ev["type"]) !== "message") continue;
          const message = ev["message"];
          if (!isRecord(message)) continue;
          const role = str(message["role"]) === "user" ? "user" : "assistant";
          for (const entry of entriesFromContent(role, message["content"], num(message["timestamp"]))) {
            if (entry.text.trim() === "") continue;
            transcript.push({ ...entry, text: entry.text.slice(0, 4000) });
          }
        }
        return { ...summary, messageCount: transcript.length, transcript };
      } finally {
        db.close();
      }
    },
  };
}
