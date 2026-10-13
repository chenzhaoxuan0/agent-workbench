/**
 * mcode reader —— ~/.minimax/v2/sessions/YYYY/MM/DD/HH-mm-ss-ms-session_<b64>/
 * 目录：manifest.json（schemaVersion/sessionId/createdAtMs/updatedAtMs/source/layout/paths）+ messages.jsonl
 *   （{message_id,turn_id,message:{role,content:[{type:"text",text}]}}）
 * 列表标题与 cwd 优先走 ~/.minimax/v2/sqlite/runtime-state.sqlite 的 local_runtime_sessions
 *   （workspace_dir/title，与 daemon 既有的 resolveNativeTerminalSession 同源），
 *   sqlite 缺席时回落 manifest（cwd 未知、标题取首条 user 消息）。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import { collectFiles, entriesFromContent, homeDir, isRecord, readJsonLines, str } from "../util.ts";

interface McodeScan {
  summary: NativeSessionSummary;
  messagesFile: string;
}

function indexRows(): Map<string, { title: string; cwd: string | null; createdAt: number; updatedAt: number }> {
  const out = new Map<string, { title: string; cwd: string | null; createdAt: number; updatedAt: number }>();
  const dbPath = path.join(homeDir(), ".minimax", "v2", "sqlite", "runtime-state.sqlite");
  if (!existsSync(dbPath)) return out;
  try {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms
           FROM local_runtime_sessions`,
        )
        .all() as Record<string, unknown>[];
      for (const r of rows) {
        const id = str(r["session_id"]);
        if (id === undefined) continue;
        out.set(id, {
          title: (str(r["title"]) ?? "").trim(),
          cwd: str(r["workspace_dir"]) ?? null,
          createdAt: Number(r["created_at_ms"]) || 0,
          updatedAt: Number(r["updated_at_ms"]) || 0,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    /* sqlite 坏/锁住：回落 manifest */
  }
  return out;
}

function scanAll(limit: number): McodeScan[] {
  const root = path.join(homeDir(), ".minimax", "v2", "sessions");
  if (!existsSync(root)) return [];
  const manifests = collectFiles(root, (n) => n === "manifest.json", 600);
  const index = indexRows();
  const out: McodeScan[] = [];
  for (const mf of manifests.slice(0, limit)) {
    const lines = readJsonLines(mf);
    const m = lines[0];
    if (!isRecord(m)) continue;
    const sessionId = str(m["sessionId"]);
    if (sessionId === undefined) continue;
    const dir = path.dirname(mf);
    const messagesFile = path.join(dir, "messages.jsonl");
    if (!existsSync(messagesFile)) continue;
    const msgLines = readJsonLines(messagesFile);
    let title = "";
    let count = 0;
    for (const l of msgLines) {
      if (!isRecord(l)) continue;
      const msg = l["message"];
      if (!isRecord(msg)) continue;
      count++;
      if (title === "" && str(msg["role"]) === "user") {
        const raw = msg["content"];
        const text = (typeof raw === "string" ? raw : JSON.stringify(raw) ?? "").trim();
        if (text !== "" && !text.startsWith("<")) title = text.slice(0, 80);
      }
    }
    if (count === 0) continue;
    const idx = index.get(sessionId);
    const createdAt = Number(m["createdAtMs"]) || idx?.createdAt || 0;
    out.push({
      summary: {
        executorId: "mcode",
        sessionId,
        rootPath: idx?.cwd ?? null,
        title: idx !== undefined && idx.title !== "" ? idx.title.slice(0, 80) : title === "" ? "mcode 会话" : title,
        startedAt: createdAt,
        updatedAt: Number(m["updatedAtMs"]) || idx?.updatedAt || createdAt,
        messageCount: count,
        source: dir,
      },
      messagesFile,
    });
  }
  return out;
}

export function createMcodeReader(): SessionReader {
  return {
    executorId: "mcode",
    async list(rootPath, limit) {
      const all = scanAll(600);
      // 无 sqlite 索引时 cwd 为 null → rootPath 过滤下不可见（宁可少列不错列）
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && s.summary.rootPath.toLowerCase() === rootPath.toLowerCase());
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(600).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript = [];
      for (const l of readJsonLines(hit.messagesFile)) {
        if (!isRecord(l)) continue;
        const msg = l["message"];
        if (!isRecord(msg)) continue;
        const role = str(msg["role"]);
        if (role === "user" || role === "assistant") {
          const entries = entriesFromContent(role, msg["content"]);
          // mcode 会把系统注入塞进 user 消息：过滤 < 开头的大块
          for (const e of entries) {
            if (e.kind === "user" && e.text.trim().startsWith("<system")) continue;
            transcript.push(e);
          }
        }
      }
      return { ...hit.summary, transcript };
    },
  };
}
