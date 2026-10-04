/**
 * 轻量模型调用 —— 给后台任务用的一次性 LLM 询问（docs/10 §4.5）。
 *
 * 刻意**不复用** ops/judge.ts 的裁判通道：那是评分路径，有阈值、返回 ran/skip
 * 语义、且被 eval 依赖，动它风险不划算。这里只要「问一句话拿一段文本」，
 * 30 行独立实现更清楚。
 *
 * 与 judge 同样的现实约束：本机没有裸 API key，但 zcode CLI 自带 provider 解析，
 * 所以仍走 `zcode -p --json`。**CLI 不可用 = 任务跳过，绝不编造内容。**
 */

import { resolveCommand, spawnLines } from "../runtime/exec.ts";
import { log } from "../log.ts";

export interface AskResult {
  readonly ok: boolean;
  readonly text: string;
  readonly skipReason?: string;
}

interface ZcodeJson {
  response?: string;
  is_error?: boolean;
  result?: string;
}

export async function askModel(
  prompt: string,
  opts: { command?: string; timeoutMs?: number } = {},
): Promise<AskResult> {
  const bin = opts.command ?? "zcode";
  let cmd;
  try {
    cmd = await resolveCommand(bin);
  } catch {
    return { ok: false, text: "", skipReason: `${bin} CLI 不可用 — 跳过（不编造内容）` };
  }

  const stdout: string[] = [];
  const child = spawnLines(cmd, ["-p", prompt, "--json"], {
    onLine: (l) => stdout.push(l),
    onStderrLine: (l) => log.debug("askModel stderr", { line: l.slice(0, 160) }),
  });

  // 超时定时器**必须清**：Promise.race 输的一方不会自动取消，不清的话它会一直
  // armed 到超时（curator 那条是 600s），白占 event loop 句柄，还拖住进程退出。
  // unref 则保证它自己不会成为「让进程活着的理由」。
  let killTimer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    killTimer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, opts.timeoutMs ?? 180_000);
    killTimer.unref();
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const exitCode = await Promise.race([exited, timedOut]);
  clearTimeout(killTimer);
  if (exitCode === null) {
    return { ok: false, text: "", skipReason: `${bin} 调用超时` };
  }

  const raw = stdout.join("\n");
  const start = raw.indexOf("{");
  if (start < 0) return { ok: false, text: "", skipReason: `${bin} 未产出 JSON（exit ${exitCode}）` };
  let parsed: ZcodeJson;
  try {
    parsed = JSON.parse(raw.slice(start)) as ZcodeJson;
  } catch {
    return { ok: false, text: "", skipReason: `${bin} 产出不可解析` };
  }
  if (parsed.is_error === true) {
    return { ok: false, text: "", skipReason: `模型报错：${(parsed.result ?? "未知").slice(0, 120)}` };
  }
  const text = (parsed.response ?? "").trim();
  if (text === "") return { ok: false, text: "", skipReason: `${bin} 返回空` };
  return { ok: true, text };
}
