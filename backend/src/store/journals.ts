/**
 * append-only 账本（docs/06 §七）—— usage.jsonl / eval_runs.jsonl / compare/history.jsonl
 * 共用同一行写法：一行一事件、追加只写、重置不清。
 * usage 行在 Phase 3 由 host 写入；eval/arena 两本 Phase 6 接手。
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function appendJournal(homeDir: string, name: string, entry: unknown): Promise<void> {
  const file = path.join(homeDir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}
