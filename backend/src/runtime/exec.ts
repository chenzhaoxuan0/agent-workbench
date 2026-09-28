/**
 * 执行器可执行文件解析 —— Windows npm shim 的坑在这里一次解决。
 *
 * Node spawn 在 win32 上不能直接跑 .cmd/.bat（CVE-2024-27980 之后强制要求 shell，
 * 而 shell:true 会把用户 prompt 里的引号/中文送进 cmd 转义地狱）。
 * 正确姿势：解析 npm shim 里的真实 node 脚本路径，spawn node + script；
 * 原生 .exe（codex 这类）直接 spawn。
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ResolvedCommand {
  /** 要 spawn 的可执行文件（node.exe 或原生 exe） */
  readonly file: string;
  /** file 之后的固定前缀参数（node 脚本路径） */
  readonly prefixArgs: readonly string[];
  /** 解析方式，日志与排障用 */
  readonly via: "exe" | "npm-shim" | "shim-fallback";
}

const cache = new Map<string, ResolvedCommand>();

async function locateOnPath(name: string): Promise<string[]> {
  const out = process.platform === "win32"
    ? await execFileP("where.exe", [name]).catch(() => ({ stdout: "", stderr: "" }))
    : await execFileP("which", [name]).catch(() => ({ stdout: "", stderr: "" }));
  return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** npm 的 .cmd shim 里藏着真实的 node 调用行。两种形态：
 *  1) "C:\...\node.exe" "C:\...\script.js" %*   （完整路径式）
 *  2) node "C:\...\script.cjs" %*              （裸 node 式，zcode 的 shim 长这样） */
function parseCmdShim(shimPath: string): { node: string; script: string } | null {
  try {
    const text = readFileSync(shimPath, "utf8");
    const full = text.match(/"([^"]*node(?:\.exe)?)"\s+"([^"]+\.(?:c|m)?js)"/i);
    if (full?.[1] && full?.[2]) return { node: full[1], script: full[2] };
    const bare = text.match(/^\s*node(?:\.exe)?\s+"?([^"\r\n]+\.(?:c|m)?js)"?/im);
    if (bare?.[1]) return { node: process.execPath, script: bare[1] };
  } catch {
    // 读不了就走 fallback
  }
  return null;
}

export async function resolveCommand(name: string): Promise<ResolvedCommand> {
  const hit = cache.get(name);
  if (hit) return hit;

  const candidates = await locateOnPath(name);
  if (candidates.length === 0) {
    throw Object.assign(new Error(`executable not found on PATH: ${name}`), { code: "not_installed" });
  }

  let resolved: ResolvedCommand | null = null;
  // .exe 优先（codex 这类原生二进制）
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) {
    resolved = { file: exe, prefixArgs: [], via: "exe" };
  } else {
    const shim = candidates.find((c) => /\.cmd$/i.test(c)) ?? candidates[0];
    if (shim && /\.cmd$/i.test(shim)) {
      const parsed = parseCmdShim(shim);
      if (parsed && existsSync(parsed.script)) {
        resolved = { file: parsed.node, prefixArgs: [parsed.script], via: "npm-shim" };
      } else {
        // shim 解析失败的兜底：过一层 cmd。参数含引号时可能出问题，打日志让人知道。
        resolved = { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", shim], via: "shim-fallback" };
      }
    } else if (shim) {
      resolved = { file: shim, prefixArgs: [], via: "exe" };
    }
  }
  if (resolved === null) {
    throw Object.assign(new Error(`cannot resolve executable: ${name}`), { code: "not_installed" });
  }
  cache.set(name, resolved);
  return resolved;
}

// ---- 行式子进程 ------------------------------------------------------------

export interface SpawnLinesOptions {
  readonly cwd?: string;
  readonly onLine: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  readonly onExit?: (code: number | null) => void;
}

export function spawnLines(cmd: ResolvedCommand, args: readonly string[], opts: SpawnLinesOptions) {
  const child = spawn(cmd.file, [...cmd.prefixArgs, ...args], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // 一次性 CLI：prompt 都在 argv 里，立即关 stdin——
  // 否则 codex 这类会停在「读 stdin / 目录信任确认」上永远不跑（冒烟实证）
  child.stdin?.end();
  createInterface({ input: child.stdout! }).on("line", opts.onLine);
  if (opts.onStderrLine) {
    createInterface({ input: child.stderr! }).on("line", opts.onStderrLine);
  }
  child.on("exit", (code) => opts.onExit?.(code));
  return child;
}

/** 一次性子进程：收集 stdout 全部输出直到退出（版本号探测用），带超时 */
export async function execLines(
  cmd: ResolvedCommand,
  args: readonly string[],
  timeoutMs = 15000,
): Promise<string> {
  const child = spawn(cmd.file, [...cmd.prefixArgs, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`exec timeout after ${timeoutMs}ms`), { code: "probe_timeout" }));
    }, timeoutMs);
    createInterface({ input: child.stdout! }).on("line", (l) => chunks.push(l));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(chunks.join("\n"));
    });
  });
}
