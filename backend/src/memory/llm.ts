/**
 * 轻量模型调用 —— 给后台任务用的一次性 LLM 询问（docs/10 §4.5）。
 *
 * 现已支持可配置的执行引擎 (GuardianRunner) 与模型 (model)。
 * - zcode: 走 `zcode -p <prompt> --json [--model <model>]`
 * - claude: 走 `claude -p <prompt> [--model <model>]`
 * - codex: 走 `codex exec <prompt> [-m <model>]`
 * - pi: 走 `pi -p <prompt> --no-session [--model <model>]`
 * - mcode / custom: 走对应 CLI 参数或自定义命令
 *
 * CLI 不可用 = 任务跳过，绝不编造内容。
 */

import { resolveCommand, spawnLines } from "../runtime/exec.ts";
import { log } from "../log.ts";
import type { GuardianRunner, MemoryGuardianConfig } from "./guardianConfig.ts";

export interface AskResult {
  readonly ok: boolean;
  readonly text: string;
  readonly skipReason?: string;
}

export interface AskModelOptions {
  readonly runner?: GuardianRunner;
  readonly command?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

interface ZcodeJson {
  response?: string;
  is_error?: boolean;
  result?: string;
}

function resolveCliInvocation(opts: AskModelOptions): { bin: string; args: (prompt: string) => string[] } {
  const runner = opts.runner ?? (opts.command ? "custom" : "zcode");
  const model = opts.model?.trim();

  switch (runner) {
    case "claude":
      return {
        bin: "claude",
        args: (prompt) => ["-p", prompt, ...(model ? ["--model", model] : [])],
      };
    case "codex":
      return {
        bin: "codex",
        args: (prompt) => ["exec", prompt, ...(model ? ["-m", model] : [])],
      };
    case "pi":
      return {
        bin: "pi",
        args: (prompt) => ["-p", prompt, "--no-session", ...(model ? ["--model", model] : [])],
      };
    case "custom":
      return {
        bin: opts.command ?? "zcode",
        args: (prompt) => ["-p", prompt, ...(model ? ["--model", model] : [])],
      };
    case "mcode":
      return {
        bin: "mcode",
        args: (prompt) => ["-p", prompt, ...(model ? ["--model", model] : [])],
      };
    case "zcode":
    default:
      return {
        bin: "zcode",
        args: (prompt) => ["-p", prompt, "--json", ...(model ? ["--model", model] : [])],
      };
  }
}

export async function askModel(
  prompt: string,
  opts: AskModelOptions | Partial<MemoryGuardianConfig> = {},
): Promise<AskResult> {
  const invocation = resolveCliInvocation(opts);
  let cmd;
  try {
    cmd = await resolveCommand(invocation.bin);
  } catch {
    return { ok: false, text: "", skipReason: `${invocation.bin} CLI 不可用 — 跳过（不编造内容）` };
  }

  const args = invocation.args(prompt);
  const stdout: string[] = [];
  const child = spawnLines(cmd, args, {
    onLine: (l) => stdout.push(l),
    onStderrLine: (l) => log.debug("askModel stderr", { bin: invocation.bin, line: l.slice(0, 160) }),
  });

  let killTimer: NodeJS.Timeout | undefined;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timedOut = new Promise<null>((resolve) => {
    killTimer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    killTimer.unref();
  });

  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const exitCode = await Promise.race([exited, timedOut]);
  clearTimeout(killTimer);

  if (exitCode === null) {
    return { ok: false, text: "", skipReason: `${invocation.bin} 调用超时（${Math.round(timeoutMs / 1000)}s）` };
  }

  const raw = stdout.join("\n").trim();
  if (raw === "") return { ok: false, text: "", skipReason: `${invocation.bin} 返回空（exit ${exitCode}）` };

  // zcode 输出通常为 JSON 结构：{ response: "...", is_error: false }
  if (invocation.bin === "zcode") {
    const start = raw.indexOf("{");
    if (start >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(start)) as ZcodeJson;
        if (parsed.is_error === true) {
          return { ok: false, text: "", skipReason: `模型报错：${(parsed.result ?? "未知").slice(0, 120)}` };
        }
        const text = (parsed.response ?? parsed.result ?? "").trim();
        if (text === "") return { ok: false, text: "", skipReason: `${invocation.bin} JSON 回复为空` };
        return { ok: true, text };
      } catch {
        // 解析失败则回退到文本
      }
    }
  }

  // 其他 CLI（claude / codex / pi 等）通常直接将结果打印在 stdout
  return { ok: true, text: raw };
}
