/**
 * LLM judge（GEval 形态）—— 命名指标 + 评分步骤 + 阈值；每次评分是一次真实 LLM 调用。
 *
 * 裁判模型复用 zcode CLI（`zcode -p --json`）：本机没有裸 API key（无
 * OPENAI/ANTHROPIC/DEEPSEEK env），但 zcode 自带可用的 provider 解析 ——
 * 与执行器同一栈，零新增凭据。zcode 不可用 = judge 层整体跳过（返回 ran:false，
 * 绝不计 0 分 —— waku 语义，docs/05 §四）。
 */

import { resolveCommand, spawnLines } from "../runtime/exec.ts";
import { log } from "../log.ts";

export interface JudgeMetric {
  readonly name: string;
  readonly steps: readonly string[];
  readonly threshold: number;
}

export interface JudgeResult {
  readonly ran: boolean;
  readonly score?: number;
  readonly reason?: string;
  readonly skipReason?: string;
}

interface CliJudgeJson {
  response?: string;
  is_error?: boolean;
  result?: string;
}

export async function judgeScore(
  metric: JudgeMetric,
  input: string,
  answer: string,
  timeoutMs = 120_000,
): Promise<JudgeResult> {
  let cmd;
  try {
    cmd = await resolveCommand("zcode");
  } catch {
    return { ran: false, skipReason: "zcode CLI unavailable — judge layer skipped (not scored 0)" };
  }

  const prompt = [
    `你是评估裁判。对【回答】按以下指标打分，0 到 1 之间的小数（阈值 ${metric.threshold}）。`,
    `指标：${metric.name}`,
    "评分步骤：",
    ...metric.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `【输入】${input}`,
    `【回答】${answer}`,
    '只输出一个 JSON 对象：{"score": <0~1 的小数>, "reason": "<一句话理由>"}，不要输出其他内容。',
  ].join("\n");

  const stdout: string[] = [];
  const child = spawnLines(cmd, ["-p", prompt, "--json"], {
    onLine: (line) => stdout.push(line),
    onStderrLine: (line) => log.debug("judge stderr", { line: line.slice(0, 160) }),
  });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  const raw = stdout.join("\n");
  const start = raw.indexOf("{");
  if (start < 0) {
    return { ran: false, skipReason: `judge call produced no JSON (exit ${exitCode})` };
  }
  let parsed: CliJudgeJson;
  try {
    parsed = JSON.parse(raw.slice(start)) as CliJudgeJson;
  } catch {
    return { ran: false, skipReason: "judge call output unparseable" };
  }
  if (parsed.is_error === true) {
    return { ran: false, skipReason: `judge model error: ${(parsed.result ?? "unknown").slice(0, 120)}` };
  }

  // 裁判的回答本体里才有评分 JSON —— 再剥一层
  const answerText = parsed.response ?? "";
  const scoreStart = answerText.indexOf("{");
  if (scoreStart < 0) {
    return { ran: false, skipReason: "judge answer contains no score JSON" };
  }
  try {
    const verdict = JSON.parse(answerText.slice(scoreStart, answerText.lastIndexOf("}") + 1)) as {
      score?: number;
      reason?: string;
    };
    if (typeof verdict.score !== "number" || !Number.isFinite(verdict.score)) {
      return { ran: false, skipReason: "judge score is not a number" };
    }
    return {
      ran: true,
      score: Math.max(0, Math.min(1, verdict.score)),
      reason: verdict.reason ?? "",
    };
  } catch {
    return { ran: false, skipReason: "judge answer JSON unparseable" };
  }
}
