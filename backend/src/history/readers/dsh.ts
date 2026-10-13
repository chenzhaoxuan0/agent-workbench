/**
 * dsh reader —— $DSH_HOME/sessions/--<normalized-cwd>--/<sessionId>/session.v3.jsonl(.zstd)
 * 首行 session 头：{type:"session",version:3,id,createdAt,cwd,...}；后续记录类型未文档化，
 * 按 role/content 习惯防御提取。zstd 帧用 Node 24 内置 zlib 解。
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
  looseRoleContent,
  num,
  readJsonLines,
  samePath,
  str,
} from "../util.ts";

interface DshScan {
  summary: NativeSessionSummary;
  lines: unknown[];
}

function dshHome(): string {
  return process.env["DSH_HOME"] ?? path.join(homeDir(), ".dsh");
}

function scanAll(limit: number): DshScan[] {
  const root = path.join(dshHome(), "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.startsWith("session.v3.jsonl"), 300);
  const out: DshScan[] = [];
  for (const file of files.slice(0, limit)) {
    const lines = readJsonLines(file);
    if (lines.length === 0) continue;
    const head = lines[0]!;
    if (!isRecord(head) || str(head["type"]) !== "session") continue;
    const sessionId = str(head["id"]) ?? path.basename(path.dirname(file));
    const cwd = str(head["cwd"]) ?? null;
    const startedAt = num(head["createdAt"]) ?? 0;
    let title = "";
    let count = 0;
    for (const l of lines.slice(1)) {
      if (!isRecord(l)) continue;
      const rc = looseRoleContent(l);
      if (rc !== null) count++;
      if (title === "") {
        const r = str(l["role"]) ?? (isRecord(l["message"]) ? str(l["message"]["role"]) : undefined);
        const text = typeof (rc?.content) === "string" ? rc!.content : "";
        if (r === "user" && text.trim() !== "" && !text.trim().startsWith("<")) title = text.trim().slice(0, 80);
      }
    }
    out.push({
      summary: {
        executorId: "dsh",
        sessionId,
        rootPath: cwd,
        title: title === "" ? "dsh 会话" : title,
        startedAt: startedAt || fileMtimeMs(file),
        updatedAt: fileMtimeMs(file),
        messageCount: count,
        source: file,
      },
      lines,
    });
  }
  return out;
}

export function createDshReader(): SessionReader {
  return {
    executorId: "dsh",
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
      const transcript = [];
      for (const l of hit.lines.slice(1)) {
        if (!isRecord(l)) continue;
        const rc = looseRoleContent(l);
        if (rc === null) continue;
        const role = rc.role === "user" ? "user" : "assistant";
        for (const e of entriesFromContent(role, rc.content)) {
          if (e.kind === "user" && e.text.trim().startsWith("<")) continue;
          transcript.push(e);
        }
      }
      return { ...hit.summary, transcript };
    },
  };
}
