/**
 * append-only 账本（docs/06 §七）—— usage.jsonl / eval_runs.jsonl / compare/history.jsonl
 * 共用同一行写法：一行一事件、追加只写、重置不清。
 * usage 行在 Phase 3 由 host 写入；eval/arena 两本 Phase 6 接手。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function appendJournal(homeDir: string, name: string, entry: unknown, cap?: number): Promise<void> {
  const file = path.join(homeDir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  // 容量上限滚动（docs/06 §七：MAX_GATE_RUNS=50 / MAX_ARENA_RUNS=50 / MAX_USAGE=4000）
  if (cap !== undefined) {
    const raw = await readFile(file, "utf8").catch(() => "");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > cap) {
      await writeFile(file, lines.slice(lines.length - cap).join("\n") + "\n", "utf8");
    }
  }
}
