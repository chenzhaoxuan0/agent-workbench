/**
 * daemon 配置 —— 环境变量覆盖默认值，不搞配置文件（Phase 0 没有第二处部署形态）。
 *
 * 路径解析锚定在本文件位置而不是 cwd：daemon 可能从任意目录被 spawn
 * （冒烟脚本、未来的前端拉起、开机自启），cwd 不可信。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** backend/ 目录的绝对路径（src/ 的上一级） */
export const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(backendRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface DaemonConfig {
  /** 监听地址。默认回环 —— daemon 能 spawn 任意进程，不对外网开门 */
  readonly host: string;
  readonly port: number;
  /** daemon 工作目录：state.db / traces/ / *.jsonl 都落这里（.waku 语义） */
  readonly homeDir: string;
  readonly logLevel: LogLevel;
  readonly version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const rawLevel = env["AGENT_WORKBENCH_LOG_LEVEL"];
  const logLevel =
    rawLevel !== undefined && (LOG_LEVELS as readonly string[]).includes(rawLevel)
      ? (rawLevel as LogLevel)
      : "info";

  return {
    host: env["AGENT_WORKBENCH_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["AGENT_WORKBENCH_PORT"] ?? "5181", 10) || 5181,
    homeDir: env["AGENT_WORKBENCH_HOME"] ?? path.join(backendRoot, ".waku"),
    logLevel,
    version: readVersion(),
  };
}
