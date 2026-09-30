/**
 * 轨迹落盘 —— "落盘即轨迹"（docs/06 §五）：每个会话的 RuntimeEvent 打上
 * TraceRecord 时间戳，append-only 写 .waku/traces/<date>.jsonl。
 *
 * TraceRecord 本身没有版本字段（契约冻结，不为此改 events.ts），所以每个文件
 * 第一行写 {"v":1,"format":"trace"} 头——以后格式演进靠文件头升版，行内容不动。
 */

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SessionId, TraceRecord } from "../contract.ts";

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

  /**
   * 读回一个会话的完整轨迹（WP-3：exportTrace 以落盘账本为准，事件环只是热缓存）。
   * 跨日期文件升序拼接，NDJSON 输出（每行一个 TraceRecord，不含文件头行）；
   * afterSeq > 0 时只返回 seq 大于它的行（断线补拉的游标）。
   */
  async readSessionNdjson(sessionId: SessionId, afterSeq = 0): Promise<string> {
    const dir = path.join(this.homeDir, "traces");
    if (!existsSync(dir)) return "";
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    const out: string[] = [];
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line === "" || !line.startsWith("{")) continue; // 首行是 {"v":1,"format":"trace"} 头
        try {
          const rec = JSON.parse(line) as TraceRecord;
          if (rec.sessionId === sessionId && rec.seq > afterSeq) out.push(line);
        } catch {
          // 坏行跳过：账本容错读
        }
      }
    }
    return out.length > 0 ? out.join("\n") + "\n" : "";
  }
}
