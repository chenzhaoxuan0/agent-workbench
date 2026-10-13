/**
 * codex reader —— ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl
 * 每行 RolloutLine：{timestamp, ordinal?, type:"session_meta"|"response_item"|"turn_context"|"compacted"|…,
 *                    payload:{…}}
 * session_meta.payload: {session_id, cwd, timestamp, source}
 * response_item.payload (ResponseItem): {type:"message",role,content:[{type:"input_text"|"output_text",text}]}
 *   | {type:"reasoning",summary|content} | {type:"function_call",name,arguments}
 *   | {type:"function_call_output",output}
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import {
  collectFiles,
  fileMtimeMs,
  homeDir,
  isRecord,
  readJsonLines,
  samePath,
  str,
  textOf,
  toMs,
} from "../util.ts";

interface CodexScan {
  summary: NativeSessionSummary;
  lines: unknown[];
}

function threadIdFromName(name: string): string {
  // rollout-2026-05-08T02-08-59-019e03a0-efcc-7412-be3a-1c588dd146c6.jsonl → 取 ISO 之后的 uuid
  const base = name.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  const m = base.match(/T[\d-]+-(.+)$/);
  return m?.[1] ?? base;
}

function scanAll(limit: number): CodexScan[] {
  const root = path.join(homeDir(), ".codex", "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"), 500);
  const out: CodexScan[] = [];
  for (const file of files.slice(0, limit)) {
    const lines = readJsonLines(file);
    if (lines.length === 0) continue;
    const meta = lines.find((l) => isRecord(l) && str(l["type"]) === "session_meta");
    const metaP = isRecord(meta) && isRecord(meta["payload"]) ? meta["payload"] : undefined;
    const sessionId = str(metaP?.["session_id"]) ?? threadIdFromName(path.basename(file));
    const cwd = str(metaP?.["cwd"]) ?? null;
    let startedAt = toMs(metaP?.["timestamp"]) ?? 0;
    let updatedAt = 0;
    let title = "";
    let count = 0;
    for (const l of lines) {
      if (!isRecord(l)) continue;
      const at = toMs(l["timestamp"]);
      if (at !== undefined) {
        if (startedAt === 0) startedAt = at;
        updatedAt = Math.max(updatedAt, at);
      }
      const t = str(l["type"]);
      if (t !== "response_item" && t !== "event_msg") continue;
      const p = l["payload"];
      if (!isRecord(p)) continue;
      const pt = str(p["type"]);
        if (pt === "message") {
          count++;
          if (title === "" && str(p["role"]) === "user") {
            const text = textOf(p["content"]).trim();
            // 跳过 < 注入块与 # 开头的指令块
            if (text !== "" && !text.startsWith("<") && !text.startsWith("# ")) title = text.slice(0, 80);
          }
        } else if (pt === "function_call") {
        count++;
      }
    }
    if (count === 0) continue;
    out.push({
      summary: {
        executorId: "codex",
        sessionId,
        rootPath: cwd,
        title: title === "" ? "codex 会话" : title,
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

export function createCodexReader(): SessionReader {
  return {
    executorId: "codex",
    async list(rootPath, limit) {
      const all = scanAll(500);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(500).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript: NativeTranscriptEntry[] = [];
      for (const l of hit.lines) {
        if (!isRecord(l)) continue;
        const at = toMs(l["timestamp"]);
        if (str(l["type"]) !== "response_item") continue;
        const p = l["payload"];
        if (!isRecord(p)) continue;
        const pt = str(p["type"]);
        if (pt === "message") {
          const roleRaw = str(p["role"]) ?? "assistant";
          // developer/system 是注入块（skills_instructions 等）的载体，不进转录
          if (roleRaw !== "user" && roleRaw !== "assistant") continue;
          const role = roleRaw;
          const parts = Array.isArray(p["content"]) ? p["content"] : [];
          const text = parts
            // user 消息里混的 environment_context 等注入块以 "<" 开头，按块丢弃
            .filter(
              (x) => !(role === "user" && isRecord(x) && typeof x["text"] === "string" && (x["text"] as string).trimStart().startsWith("<")),
            )
            .map((x) => (isRecord(x) && typeof x["text"] === "string" ? x["text"] : ""))
            .join("")
            .trim();
          if (text !== "") transcript.push({ kind: role, text, at });
        } else if (pt === "reasoning") {
          const t = (Array.isArray(p["summary"]) ? textOf(p["summary"]) : str(p["content"]) ?? "").trim();
          if (t !== "") transcript.push({ kind: "thinking", text: t.slice(0, 2000), at });
        } else if (pt === "function_call") {
          transcript.push({
            kind: "tool",
            toolName: str(p["name"]) ?? "tool",
            text: (str(p["arguments"]) ?? "").slice(0, 400),
            at,
          });
        } else if (pt === "function_call_output") {
          transcript.push({
            kind: "tool",
            toolName: "输出",
            text: (str(p["output"]) ?? textOf(p["output"])).slice(0, 2000),
            at,
          });
        } else if (pt === "local_shell_call" || pt === "custom_tool_call") {
          transcript.push({ kind: "tool", toolName: pt, text: JSON.stringify(p["action"] ?? p["input"] ?? "").slice(0, 400), at });
        }
      }
      return { ...hit.summary, transcript };
    },
  };
}
