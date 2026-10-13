/**
 * hermes reader —— ~/.hermes/state.db（SQLite + FTS5；HERMES_HOME 可改根）
 * 表语义公开（website/docs/developer-guide/session-storage.md），但列名随版本演进：
 * 运行时 PRAGMA table_info 自省，按列名习惯映射（session_id/role/content/timestamp/title…）。
 * 只读打开；WAL 并发下读失败即返回空（fail-open，不阻塞其它 reader 的结果）。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import { entriesFromContent, homeDir, samePath } from "../util.ts";

function hermesRoot(): string {
  return process.env["HERMES_HOME"] ?? path.join(homeDir(), ".hermes");
}

function pick(cols: readonly string[], ...candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (cols.includes(c)) return c;
  }
  return null;
}

interface HermesSession {
  summary: NativeSessionSummary;
  rows: readonly Record<string, unknown>[];
}

function scanAll(limit: number): HermesSession[] {
  const dbPath = path.join(hermesRoot(), "state.db");
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    return [];
  }
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name?: unknown }[];
    const names = tables.map((t) => (typeof t["name"] === "string" ? t["name"] : "")).filter(Boolean);
    const msgTable = names.find((n) => n.includes("message")) ?? null;
    if (msgTable === null) return [];
    const mCols = (db.prepare(`PRAGMA table_info(${msgTable})`).all() as { name?: unknown }[]).map((c) =>
      typeof c["name"] === "string" ? c["name"] : "",
    );
    const cSession = pick(mCols, "session_id", "sessionId");
    const cRole = pick(mCols, "role", "speaker");
    const cContent = pick(mCols, "content", "text", "message");
    const cTime = pick(mCols, "timestamp", "created_at", "time");
    if (cSession === null || cContent === null) return [];

    // 会话表（标题）：可选
    let cTitle: string | null = null;
    let cCwd: string | null = null;
    let cCreated: string | null = null;
    let cUpdated: string | null = null;
    const sessTable = names.find((n) => n !== msgTable && n.includes("session"));
    if (sessTable !== undefined) {
      const sCols = (db.prepare(`PRAGMA table_info(${sessTable})`).all() as { name?: unknown }[]).map((c) =>
        typeof c["name"] === "string" ? c["name"] : "",
      );
      const sId = pick(sCols, "id", "session_id", "sessionId");
      if (sId !== null) {
        cTitle = pick(sCols, "title", "name", "summary");
        cCwd = pick(sCols, "cwd", "workspace", "working_dir", "root_path");
        cCreated = pick(sCols, "created_at", "timestamp", "start_time");
        cUpdated = pick(sCols, "updated_at", "last_active", "last_message_at");
        const sessRows = db.prepare(`SELECT * FROM ${sessTable} LIMIT 500`).all() as Record<string, unknown>[];
        const byId = new Map<string, Record<string, unknown>>();
        for (const r of sessRows) {
          const id = r[sId];
          if (typeof id === "string" || typeof id === "number") byId.set(String(id), r);
        }
        // 按 session 聚合消息
        const allRows = db.prepare(`SELECT * FROM ${msgTable} LIMIT 5000`).all() as Record<string, unknown>[];
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const r of allRows) {
          const sid = r[cSession];
          if (sid === undefined) continue;
          const key = String(sid);
          const arr = groups.get(key) ?? [];
          arr.push(r);
          groups.set(key, arr);
        }
        const out: HermesSession[] = [];
        for (const [sid, rows] of groups) {
          const meta = byId.get(sid);
          const title = meta !== undefined && cTitle !== null ? String(meta[cTitle] ?? "") : "";
          const cwd = meta !== undefined && cCwd !== null ? String(meta[cCwd] ?? "") : null;
          const created = meta !== undefined && cCreated !== null ? Number(meta[cCreated]) || 0 : 0;
          const updated = meta !== undefined && cUpdated !== null ? Number(meta[cUpdated]) || created : created;
          let firstUser = "";
          for (const r of rows) {
            if (cRole !== null && String(r[cRole] ?? "") === "user") {
              const t = String(r[cContent] ?? "");
              if (t.trim() !== "" && !t.trim().startsWith("<")) {
                firstUser = t.trim().slice(0, 80);
                break;
              }
            }
          }
          out.push({
            summary: {
              executorId: "hermes",
              sessionId: sid,
              rootPath: cwd !== null && cwd !== "" ? cwd : null,
              title: title.trim() !== "" ? title.trim().slice(0, 80) : firstUser === "" ? "hermes 会话" : firstUser,
              startedAt: created,
              updatedAt: updated || created,
              messageCount: rows.length,
              source: `${dbPath}#${msgTable}`,
            },
            rows,
          });
        }
        return out
          .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
          .slice(0, limit);
      }
    }
    return [];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function createHermesReader(): SessionReader {
  return {
    executorId: "hermes",
    async list(rootPath, limit) {
      const all = scanAll(limit);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered.map((s) => s.summary).slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(500).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript = [];
      for (const r of hit.rows) {
        const role = String(r["role"] ?? r["speaker"] ?? "assistant");
        if (role !== "user" && role !== "assistant") continue;
        for (const e of entriesFromContent(role as "user" | "assistant", r["content"] ?? r["text"] ?? r["message"])) {
          if (e.kind === "user" && e.text.trim().startsWith("<")) continue;
          transcript.push(e);
        }
      }
      return { ...hit.summary, transcript };
    },
  };
}
