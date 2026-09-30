/**
 * daemon 配置 —— 环境变量覆盖默认值，不搞配置文件（Phase 0 没有第二处部署形态）。
 *
 * 路径解析锚定在本文件位置而不是 cwd：daemon 可能从任意目录被 spawn
 * （冒烟脚本、未来的前端拉起、开机自启），cwd 不可信。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  /**
   * 鉴权 token（docs/08 WP-7）：null = 关闭鉴权（AGENT_WORKBENCH_INSECURE=1，冒烟/本机调试）。
   * 默认开启：AGENT_WORKBENCH_TOKEN 显式指定，否则首启生成落盘 <homeDir>/token。
   * 回环客户端经 GET /bootstrap 免鉴权取 token；非回环（手机/局域网）必须自带。
   */
  readonly token: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const rawLevel = env["AGENT_WORKBENCH_LOG_LEVEL"];
  const logLevel =
    rawLevel !== undefined && (LOG_LEVELS as readonly string[]).includes(rawLevel)
      ? (rawLevel as LogLevel)
      : "info";

  const homeDir = env["AGENT_WORKBENCH_HOME"] ?? path.join(backendRoot, ".waku");
  const insecure = env["AGENT_WORKBENCH_INSECURE"] === "1";
  const explicit = env["AGENT_WORKBENCH_TOKEN"];
  let token: string | null;
  if (insecure) {
    token = null;
  } else if (explicit !== undefined && explicit !== "") {
    token = explicit;
  } else {
    // 首启生成落盘；此后随 home 走（state.db 换 home 换 token，隔离成立）
    const tokenFile = path.join(homeDir, "token");
    try {
      token = readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      token = null;
    }
    if (token === null) {
      token = randomUUID().replace(/-/g, "");
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(tokenFile, token + "\n", "utf8");
    }
  }

  return {
    host: env["AGENT_WORKBENCH_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["AGENT_WORKBENCH_PORT"] ?? "5181", 10) || 5181,
    homeDir,
    logLevel,
    version: readVersion(),
    token,
  };
}
