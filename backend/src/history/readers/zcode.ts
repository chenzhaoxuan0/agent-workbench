/**
 * zcode reader —— 双源：
 * 列表：~/.zcode/v2/sessions/<workspaceHash>/<taskId>.json（{meta:{taskId,title,workspacePath,
 *        createdAt,updatedAt,status},messages:[{role,content,timestamp,turnIndex}]}，最干净的一家）
 * 兜底：~/.zcode/cli/db/db.sqlite 的 session 表（daemon 既有先例同源）
 * 忽略 .deleted.json（已删会话）。
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { collectFiles, homeDir, isRecord, num, samePath, str } from "../util.ts";

interface ZcodeScan {
  summary: NativeSessionSummary;
  messages: unknown[];
}

function scanAll(limit: number): ZcodeScan[] {
  const root = path.join(homeDir(), ".zcode", "v2", "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.endsWith(".json") && !n.includes("deleted"), 300);
  const out: ZcodeScan[] = [];
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
