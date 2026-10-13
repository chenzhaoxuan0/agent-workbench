/**
 * pi reader —— ~/.pi/agent/sessions/<encoded-cwd>/<ISO>_<uuid>.jsonl
 * 格式（pi 文档化，SessionManager 的 FileEntry）：
 *   {type:"session",version,id,timestamp,cwd}
 *   {type:"message",id,parentId,timestamp,message:{role,content}}
 *   {type:"compaction",...} {type:"model_change",...} …
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import {
  collectFiles,
  entriesFromContent,
  fileMtimeMs,
  homeDir,
  isRecord,
  readJsonLines,
  samePath,
  str,
  toMs,
} from "../util.ts";

interface PiScan {
  summary: NativeSessionSummary;
  lines: unknown[];
}

function scanAll(limit: number): PiScan[] {
  const root = path.join(homeDir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.endsWith(".jsonl"), 500);
  const out: PiScan[] = [];
  for (const file of files.slice(0, limit)) {
    const lines = readJsonLines(file);
    if (lines.length === 0) continue;
    const head = lines[0]!;
    if (!isRecord(head) || str(head["type"]) !== "session") continue;
    const id = str(head["id"]) ?? path.basename(file);
    const cwd = str(head["cwd"]) ?? null;
    const startedAt = toMs(head["timestamp"]) ?? fileMtimeMs(file);
    // 标题 = 首条 user 消息前 80 字；updatedAt = 末条时间戳
    let title = "";
    let updatedAt = startedAt;
    let count = 0;
    for (const l of lines) {
      if (!isRecord(l)) continue;
      const t = toMs(l["timestamp"]);
      if (t !== undefined) updatedAt = Math.max(updatedAt, t);
      if (str(l["type"]) === "message") {
        count++;
        const m = l["message"];
        if (title === "" && isRecord(m) && str(m["role"]) === "user") {
          const text = typeof m["content"] === "string" ? str(m["content"]) ?? "" : "";
          if (text.trim() !== "") title = text.trim().slice(0, 80);
        }
      }
    }
    out.push({
      summary: {
        executorId: "pi",
        sessionId: id,
        rootPath: cwd,
        title: title === "" ? "pi 会话" : title,
        startedAt,
        updatedAt,
        messageCount: count,
        source: file,
      },
      lines,
    });
  }
  return out;
}

export function createPiReader(): SessionReader {
  return {
    executorId: "pi",
    async list(rootPath, limit) {
      const all = scanAll(600);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(600).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript: NativeTranscriptEntry[] = [];
      for (const l of hit.lines) {
        if (!isRecord(l)) continue;
        const type = str(l["type"]);
        const at = toMs(l["timestamp"]);
        if (type === "message") {
          const m = l["message"];
          if (!isRecord(m)) continue;
          const role = str(m["role"]);
          if (role === "user" || role === "assistant") {
            transcript.push(...entriesFromContent(role, m["content"], at));
          } else if (role === "toolResult") {
            const raw = m["content"];
            const text = (typeof raw === "string" ? raw : JSON.stringify(raw) ?? "").slice(0, 2000);
            transcript.push({ kind: "tool", toolName: str(m["toolName"]) ?? "tool", text, at });
          }
        } else if (type === "compaction") {
          transcript.push({ kind: "compaction", text: str(l["summary"]) ?? "上下文压缩点", at });
        }
      }
      return { ...hit.summary, transcript };
    },
  };
}
