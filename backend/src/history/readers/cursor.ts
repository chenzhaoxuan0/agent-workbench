/**
 * cursor / cursor-agent reader —— ~/.cursor/chats/<workspaceHash>/<conversationUuid>/meta.json：
 * {schemaVersion, createdAtMs, updatedAtMs, cwd, hasConversation}。
 * conversation uuid 即 `cursor --resume <id>` 的口径；meta 不存标题（标题留空，
 * 回溯与列表按时间/工作区匹配不受影响）。正文不落盘在这个目录（hasConversation
 * 为 true 时 payload 在 CLI 自己的运行态里），下钻 read 返回 null。
 * 同一份存储注册两个 executorId（cursor 与 cursor-agent 是同一 CLI 的新旧名）。
 * 实测采样 2026-10。
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import { collectFiles, homeDir, isRecord, num, samePath, str } from "../util.ts";

interface CursorScan {
  summary: NativeSessionSummary;
}

function scanAll(limit: number): CursorScan[] {
  const root = path.join(homeDir(), ".cursor", "chats");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n === "meta.json", 300);
  const out: CursorScan[] = [];
  for (const file of files.slice(0, limit)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    // 会话 id = meta.json 所在目录名（<conversationUuid>）
    const sessionId = path.basename(path.dirname(file));
    if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) continue;
    const startedAt = num(raw["createdAtMs"]) ?? 0;
    out.push({
      summary: {
        executorId: "cursor",
        sessionId,
        rootPath: str(raw["cwd"]) ?? null,
        title: "",
        startedAt,
        updatedAt: num(raw["updatedAtMs"]) ?? startedAt,
        messageCount: 0,
        source: file,
      },
    });
  }
  return out;
}

export function createCursorReader(executorId: "cursor" | "cursor-agent" = "cursor"): SessionReader {
  return {
    executorId,
    async list(rootPath, limit) {
      const all = scanAll(300).map((s) => ({ ...s.summary, executorId }));
      const filtered = rootPath === null ? all : all.filter((s) => s.rootPath !== null && samePath(s.rootPath, rootPath));
      return filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    },
    async read(): Promise<NativeSessionDetail | null> {
      // 正文不在这个存储里（meta 只记 cwd/时间），下钻暂缺 —— 不影响 resume 回溯
      return null;
    },
  };
}
