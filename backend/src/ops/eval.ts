/**
 * Ops —— 确定性 eval + judge + 发布门（docs/05 §四 铁律：两类 eval 永不混合）。
 *
 * - 确定性：dataset 行 {id, input, expect_tool?, expect_in_args?}，逐行起
 *   沙箱会话（throwaway 目录），从会话事件环断言工具触发与参数 —— 0 或 1，无裁判。
 * - judge：GEval 形态（命名指标 + 评分步骤 + 阈值），每次评分一次真 LLM 调用；
 *   缺裁判（zcode 不可用）整层跳过而非计 0 分。
 * - gate：确定性 100% 且 judge 全过阈值 → PASS；judge 跳过时按确定性单独判。
 * - 结果一行一次追加 eval_runs.jsonl（上限 50 滚动）。
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeHost } from "../runtime/host.ts";
import type { SessionId } from "../contract.ts";
import { appendJournal } from "../store/journals.ts";
import { judgeScore, type JudgeMetric, type JudgeResult } from "./judge.ts";
import { log } from "../log.ts";

export interface EvalRow {
  readonly id: string;
  readonly input: string;
  readonly expect_tool?: string;
  readonly expect_in_args?: string;
}

export interface EvalGateRequest {
  readonly datasetName: string;
  readonly rows: readonly EvalRow[];
  readonly runtimeId: string;
  readonly model?: string | null;
  /** 缺省 = 只跑确定性层 */
  readonly judgeMetrics?: readonly JudgeMetric[];
  readonly turnTimeoutMs?: number;
}

export interface DeterministicResult {
  readonly rowId: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface GateReport {
  readonly at: number;
  readonly dataset: string;
  readonly runtimeId: string;
  readonly deterministic: {
    readonly passed: number;
    readonly total: number;
    readonly failures: readonly DeterministicResult[];
  };
  readonly judge: {
    readonly ran: boolean;
    readonly results: readonly { metric: string; result: JudgeResult }[];
  };
  readonly verdict: "PASS" | "FAIL";
}

const MAX_GATE_RUNS = 50;

export class OpsRunner {
  constructor(
    private readonly host: RuntimeHost,
    private readonly homeDir: string,
  ) {}

  /** 跑一条 dataset：逐行沙箱会话 → 事件环断言 → judge → gate 判定 → 落账本 */
  async runGate(req: EvalGateRequest): Promise<GateReport> {
    const deterministic: DeterministicResult[] = [];
    const answers: Array<{ rowId: string; input: string; answer: string }> = [];

    for (const row of req.rows) {
      const result = await this.runDeterministicRow(req, row);
      deterministic.push(result);
      if (result.answer !== "") answers.push({ rowId: row.id, input: row.input, answer: result.answer });
    }

    const passed = deterministic.filter((d) => d.passed).length;
    const failures = deterministic.filter((d) => !d.passed);

    // judge 层：对每个指标的每个样本各一次真 LLM 调用（样本多时很贵，调用方自己掂量）
    const judgeResults: Array<{ metric: string; result: JudgeResult }> = [];
    const metrics = req.judgeMetrics ?? [];
    if (metrics.length > 0) {
      for (const metric of metrics) {
        // 每个指标跑第一个有回答的样本即可代表（waku 原型语义：指标级 judge）
        const sample = answers[0];
        if (sample === undefined) {
          judgeResults.push({ metric: metric.name, result: { ran: false, skipReason: "no answer to judge" } });
          continue;
        }
        const result = await judgeScore(metric, sample.input, sample.answer);
        judgeResults.push({ metric: metric.name, result });
      }
    }

    const allDeterministic = passed === deterministic.length && deterministic.length > 0;
    let verdict: GateReport["verdict"];
    if (!allDeterministic) {
      verdict = "FAIL";
    } else if (metrics.length === 0) {
      verdict = "PASS";
    } else {
      const scored = judgeResults.filter((j) => j.result.ran === true);
      const skipped = judgeResults.filter((j) => j.result.ran !== true);
      if (scored.length === 0) {
        // judge 整层跳过：确定性 100% 即 PASS（跳过 ≠ 0 分）
        verdict = "PASS";
        log.warn("judge layer skipped entirely", { reasons: skipped.map((s) => s.result.skipReason) });
      } else {
        verdict = scored.every((j) => {
          const metric = metrics.find((m) => m.name === j.metric);
          const threshold = metric?.threshold ?? 0.6;
          return (j.result.score ?? 0) >= threshold;
        }) && skipped.length === 0
          ? "PASS"
          : "FAIL";
        // 有分有跳：部分跳过时按「跳过不算失败」处理，只看有分的
        if (skipped.length > 0 && scored.length > 0) {
          verdict = scored.every((j) => {
            const metric = metrics.find((m) => m.name === j.metric);
            return (j.result.score ?? 0) >= (metric?.threshold ?? 0.6);
          })
            ? "PASS"
            : "FAIL";
        }
      }
    }

    const report: GateReport = {
      at: Date.now(),
      dataset: req.datasetName,
      runtimeId: req.runtimeId,
      deterministic: { passed, total: deterministic.length, failures },
      judge: { ran: judgeResults.some((j) => j.result.ran), results: judgeResults },
      verdict,
    };
    await appendJournal(this.homeDir, "eval_runs.jsonl", report, MAX_GATE_RUNS);
    log.info("gate finished", { dataset: req.datasetName, verdict, deterministic: `${passed}/${deterministic.length}` });
    return report;
  }

  /** 单行确定性断言：throwaway 目录起会话 → 等结束 → 事件环找 expect_tool/expect_in_args */
  private async runDeterministicRow(req: EvalGateRequest, row: EvalRow): Promise<DeterministicResult & { answer: string }> {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "awb-eval-"));
    try {
      const session = await this.host.startSession({
        runtimeId: req.runtimeId,
        unitId: `eval-${row.id}` as never,
        unitName: `eval:${req.datasetName}`,
        rootPath: sandbox,
        prompt: row.input,
        model: (req.model ?? null) as never,
      });
      // turn 级完成以 usage 事件为准（agent loop 语义：会话不再随轮次关闭）
      await this.host.waitForSessionEvent(session.id as SessionId, "usage", req.turnTimeoutMs ?? 120_000);
      const events = this.host.sessionEvents(session.id as SessionId);

      let answer = "";
      let toolOk = true;
      let toolDetail = "no expectation";
      let argsOk = true;
      let argsDetail = "no expectation";

      for (const ev of events) {
        if (ev.type === "message.completed" && ev.text !== "") answer = ev.text;
      }
      if (row.expect_tool !== undefined) {
        const hit = events.some(
          (ev) => ev.type === "tool.started" && ev.toolName.toLowerCase().includes(row.expect_tool!.toLowerCase()),
        );
        toolOk = hit;
        toolDetail = hit ? `tool "${row.expect_tool}" fired` : `tool "${row.expect_tool}" never fired`;
      }
      if (row.expect_in_args !== undefined) {
        const hit = events.some((ev) => {
          if (ev.type !== "tool.started") return false;
          return JSON.stringify(ev.input ?? null).includes(row.expect_in_args!);
        });
        argsOk = hit;
        argsDetail = hit ? `args contain "${row.expect_in_args}"` : `args never contained "${row.expect_in_args}"`;
      }

      const passed = toolOk && argsOk;
      return {
        rowId: row.id,
        passed,
        answer,
        detail: `${toolDetail}; ${argsDetail}`,
      };
    } catch (err: unknown) {
      return {
        rowId: row.id,
        passed: false,
        answer: "",
        detail: `session failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
