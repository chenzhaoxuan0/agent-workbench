/**
 * 轨迹落盘 —— "落盘即轨迹"（docs/06 §五）：每个会话的 RuntimeEvent 打上
 * TraceRecord 时间戳，append-only 写 .waku/traces/<date>.jsonl。
 *
 * TraceRecord 本身没有版本字段（契约冻结，不为此改 events.ts），所以每个文件
 * 第一行写 {"v":1,"format":"trace"} 头——以后格式演进靠文件头升版，行内容不动。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TraceRecord } from "../contract.ts";

const HEADER = JSON.stringify({ v: 1, format: "trace", writtenBy: "agent-workbench-daemon" });

export class TraceSink {
  private cachedDate = "";
  private cachedFile = "";

  constructor(private readonly homeDir: string) {}

  private fileFor(dateKey: string): string {
    if (this.cachedDate !== dateKey || this.cachedFile === "") {
      this.cachedDate = dateKey;
      this.cachedFile = path.join(this.homeDir, "traces", `${dateKey}.jsonl`);
    }
    return this.cachedFile;
  }

  async append(record: TraceRecord): Promise<void> {
    const dateKey = new Date(record.at).toISOString().slice(0, 10);
    const file = this.fileFor(dateKey);
    await mkdir(path.dirname(file), { recursive: true });
    if (!existsSync(file)) {
      await appendFile(file, HEADER + "\n", "utf8");
    }
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  }
}
