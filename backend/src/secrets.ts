/**
 * 密钥解析 —— 全项目统一的「文件为主」约定（用户文档见 README「密钥放在哪」）。
 *
 * 密钥的**唯一真相是 daemon 侧文件**，agent 用 Read/Write 直接改，界面上有配套
 * 编辑面。两层来源，按优先级：
 *
 *   1. 操作系统环境变量（无头/CI 想显式覆盖时用；进程启动时的快照，改了要重启）
 *   2. `<homeDir>/.env` 文件（KEY=VALUE 逐行，# 注释；**每次解析时实时读**，
 *      带_mtime 缓存 —— 改文件立即生效，不用重启 daemon）
 *
 * 引用语法：任何密钥字段的值以 `env:` 开头 = 按上述优先级解析同名变量：
 *   apiKey: "env:MY_IMAGE_KEY"  →  process.env.MY_IMAGE_KEY ?? .env 里的 MY_IMAGE_KEY
 *
 * ⚠ 安全边界（这是与 dotenv 类工具的关键差异）：**绝不把 .env 写进 process.env**。
 * daemon 会 spawn 终端与各家 CLI 子进程，子进程继承环境 —— 一旦注入，全部密钥
 * 就流进每个 agent 的环境里（可能被子进程日志/转储带出去）。所以这里只在
 * 解析的一瞬间读文件，结果不落进程环境。
 *
 * 普通字面量（不以 env: 开头）原样返回 —— 不用引用语法的行为与从前完全一致。
 *
 * 先例：telegram 渠道的 {source:"env"} 引用、dsh 的 apiKeyEnv 凭据引用，同一思想。
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

const ENV_REF_PREFIX = "env:";
const warnedMissing = new Set<string>();

/* --------------------------------------------------------- .env 文件层 */

let secretsHome: string | null = null;

/** daemon 启动时指向配置的家目录（index.ts 在 loadConfig 后调用一次） */
export function setSecretsHome(homeDir: string): void {
  secretsHome = homeDir;
  fileCache = null;
  fileCacheMtimeMs = -1;
}

let fileCache: Map<string, string> | null = null;
let fileCacheMtimeMs = -1;

/** 极简 .env 解析：KEY=VALUE 逐行，空行/# 注释跳过，值剥一层成对引号 */
function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** 读 .env（mtime 未变用缓存；文件不存在/读不了 = 空表，不算错误） */
function readEnvFile(): Map<string, string> {
  if (secretsHome === null) return new Map();
  const file = path.join(secretsHome, ".env");
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (fileCache !== null && mtimeMs === fileCacheMtimeMs) return fileCache;
    fileCache = parseEnvFile(readFileSync(file, "utf8"));
    fileCacheMtimeMs = mtimeMs;
    return fileCache;
  } catch {
    fileCache = new Map();
    fileCacheMtimeMs = -1;
    return fileCache;
  }
}

/* ------------------------------------------------------------- 解析入口 */

export function isEnvRef(value: string): boolean {
  return value.startsWith(ENV_REF_PREFIX);
}

/** `env:NAME` → 系统环境变量 ?? <homeDir>/.env 的同名项；字面量原样返回 */
export function resolveSecret(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!isEnvRef(value)) return value;
  const name = value.slice(ENV_REF_PREFIX.length).trim();
  if (name === "") return "";
  const fromOs = process.env[name] ?? "";
  if (fromOs !== "") return fromOs;
  const fromFile = readEnvFile().get(name) ?? "";
  if (fromFile !== "") return fromFile;
  if (!warnedMissing.has(name)) {
    warnedMissing.add(name);
    log.warn(`secret env ref not set: ${name}（系统环境变量与 <homeDir>/.env 里都没有，该密钥按未配置处理）`);
  }
  return "";
}
