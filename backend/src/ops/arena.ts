/**
 * Arena（Phase 6）—— 同一 prompt × N 执行器，各自 throwaway 沙箱，
 * Completion / Quality 双分刻意分开（docs/05 §四）：
 * - Completion 是机械分：出了非空回答 = 1（0.5 = 有工具失败也出了答案）；
 * - Quality 是裁判分：GEval 真 LLM 调用（缺裁判整层跳过）。
 * 一场一行追加 compare/history.jsonl（上限 50 场滚动）。
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeHost } from "../runtime/host.ts";
import type { SessionId } from "../contract.ts";
import { appendJournal } from "../store/journals.ts";
import { judgeScore, type JudgeMetric, type JudgeResult } from "./judge.ts";
import { log } from "../log.ts";

export interface ArenaRequest {
  readonly prompt: string;
  readonly runtimeIds: readonly string[];
  readonly judgeMetric?: JudgeMetric;
  readonly turnTimeoutMs?: number;
}

export interface ArenaContestant {
  readonly runtimeId: string;
  readonly sessionId: string | null;
  readonly completion: number;
  readonly answer: string;
  readonly quality: JudgeResult;
  readonly error?: string;
}

export interface ArenaReport {
  readonly at: number;
  readonly prompt: string;
  readonly contestants: readonly ArenaContestant[];
  readonly judgeRan: boolean;
}

const MAX_ARENA_RUNS = 50;

export class ArenaRunner {
  constructor(
    private readonly host: RuntimeHost,
    private readonly homeDir: string,
  ) {}

  async runMatch(req: ArenaRequest): Promise<ArenaReport> {
    const contestants: ArenaContestant[] = [];

    for (const runtimeId of req.runtimeIds) {
      const sandbox = mkdtempSync(path.join(os.tmpdir(), "awb-arena-"));
      try {
        const session = await this.host.startSession({
          runtimeId,
          unitId: `arena-${runtimeId}` as never,
          unitName: `arena:${new Date().toISOString()}`,
          rootPath: sandbox,
          prompt: req.prompt,
          model: null,
        });
        await this.host.waitForSessionEnd(session.id as SessionId, req.turnTimeoutMs ?? 120_000);
        const events = this.host.sessionEvents(session.id as SessionId);
        let answer = "";
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]!;
          if (ev.type === "message.completed" && ev.text !== "") {
            answer = ev.text;
            break;
          }
        }
        const toolFailed = events.some((ev) => ev.type === "tool.completed" && ev.ok === false);

        // Completion：出了非空回答 1 分；有回答但工具失败 0.5；没回答 0
        const completion = answer === "" ? 0 : toolFailed ? 0.5 : 1;

        let quality: JudgeResult = { ran: false, skipReason: "no judge metric supplied" };
        if (req.judgeMetric !== undefined && answer !== "") {
          quality = await judgeScore(req.judgeMetric, req.prompt, answer);
        }

        contestants.push({ runtimeId, sessionId: session.id, completion, answer, quality });
      } catch (err: unknown) {
        contestants.push({
          runtimeId,
          sessionId: null,
          completion: 0,
          answer: "",
          quality: { ran: false, skipReason: "session failed" },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const report: ArenaReport = {
      at: Date.now(),
      prompt: req.prompt,
      contestants,
      judgeRan: req.judgeMetric !== undefined && contestants.some((c) => c.quality.ran),
    };
    await appendJournal(this.homeDir, "compare/history.jsonl", report, MAX_ARENA_RUNS);
    log.info("arena match finished", {
      contestants: contestants.map((c) => `${c.runtimeId}:C${c.completion}/Q${c.quality.ran ? (c.quality.score ?? 0).toFixed(2) : "skip"}`).join(", "),
    });
    return report;
  }
}
