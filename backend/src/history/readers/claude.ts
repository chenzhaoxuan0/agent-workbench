/**
 * claude reader —— ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
 * 每行：{type:"user"|"assistant"|"summary"|"queue-operation"|…, message?:{role,content},
 *        timestamp, sessionId, cwd?, isSidechain?}
 * 无格式稳定性承诺（内部 transcript），宽容解析。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import {
  collectFiles,
  entriesFromContent,
  fileMtimeMs,
  homeDir,
  isRecord,
  readJsonLines,
  samePath,
  str,
  textOf,
  toMs,
} from "../util.ts";

function mungedToPath(dirName: string): string {
  // C--Users-chenziyu-project → C:\Users\chenziyu\project（claude 的 munge：: 和 \ 都变 -，不可逆，仅近似）
  return dirName.replace(/-/g, "\\").replace(/^([A-Za-z])\\/, "$1:\\");
}

interface ClaudeScan {
  summary: NativeSessionSummary;
  lines: unknown[];
}

function scanAll(limit: number): ClaudeScan[] {
  const root = path.join(homeDir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.endsWith(".jsonl"), 800);
  const out: ClaudeScan[] = [];
  for (const file of files.slice(0, limit)) {
    const lines = readJsonLines(file);
    if (lines.length === 0) continue;
    const sessionId = path.basename(file, ".jsonl");
    const dirName = path.basename(path.dirname(file));
    let title = "";
    let startedAt = 0;
    let updatedAt = 0;
    let count = 0;
    let cwd: string | null = null;
    for (const l of lines) {
      if (!isRecord(l)) continue;
      if (cwd === null) cwd = str(l["cwd"]) ?? null;
      const at = toMs(l["timestamp"]);
      if (at !== undefined) {
        if (startedAt === 0) startedAt = at;
        updatedAt = Math.max(updatedAt, at);
      }
      const type = str(l["type"]);
      if (type !== "user" && type !== "assistant") continue;
      if (l["isSidechain"] === true) continue;
      count++;
      const m = l["message"];
      if (title === "" && type === "user" && isRecord(m)) {
        // 跳过命令回显（<command-name> 等）与系统注入
        const text = textOf(m["content"]).trim();
        if (text !== "" && !text.startsWith("<")) title = text.slice(0, 80);
      }
    }
    if (count === 0) continue;
    out.push({
      summary: {
        executorId: "claude",
        sessionId,
        rootPath: cwd ?? mungedToPath(dirName),
        title: title === "" ? "claude 会话" : title,
        startedAt: startedAt || fileMtimeMs(file),
        updatedAt: updatedAt || startedAt,
        messageCount: count,
        source: file,
      },
      lines,
    });
  }
  return out;
}

export function createClaudeReader(): SessionReader {
  return {
    executorId: "claude",
    async list(rootPath, limit) {
      const all = scanAll(800);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(800).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript = [];
      for (const l of hit.lines) {
        if (!isRecord(l)) continue;
        const type = str(l["type"]);
        const at = toMs(l["timestamp"]);
        if (type !== "user" && type !== "assistant") continue;
        if (l["isSidechain"] === true) continue;
        const m = l["message"];
        if (!isRecord(m)) continue;
        const text = textOf(m["content"]).trim();
        if (type === "user" && (text.startsWith("<command-") || text.startsWith("<local-"))) continue;
        transcript.push(...entriesFromContent(type, m["content"], at));
      }
      return { ...hit.summary, transcript };
    },
  };
}
