/**
 * 共享 Chrome（接管模式）的发现与拉起 —— docs/14 §2.3。
 *
 * 生命周期口径：
 * - 端口从 9333 起探测（Chrome Fleet 社区惯例段），选定的端口持久化进
 *   browser-control.json，playwright 条目与 dsh 注入因此跨重启稳定；
 * - 启动前先打 /json/version 健康检查：上一代 daemon 崩溃留下的 Chrome 还活着
 *   就直接收编（adopt），避免「同 profile 二次启动被旧进程吞掉后子进程秒退」
 *   的 Chrome 单实例委派陷阱；
 * - 停止走 taskkill /T /F（Windows 上杀进程树——Chrome 的子进程不杀干净会
 *   占住 profile 锁）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { join } from "node:path";
import { log } from "../log.ts";

/** 默认调试端口基址（被占则上浮，最多试 7 个） */
export const SHARED_CHROME_BASE_PORT = 9333;
const PORT_TRIES = 7;

export interface ChromiumCandidate {
  readonly executable: string;
  readonly kind: "chrome" | "edge";
}

/** 系统浏览器发现：Chrome 优先，Edge 兜底（Windows 每机必有，Chromium 系都能 CDP） */
export function findChromium(preferred: "chrome" | "msedge"): ChromiumCandidate | null {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const la = process.env["LOCALAPPDATA"] ?? "";
  const chrome = [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    ...(la !== "" ? [join(la, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ];
  const edge = [
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ...(la !== "" ? [join(la, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
  ];
  const prefer: readonly ("chrome" | "edge")[] = preferred === "chrome" ? ["chrome", "edge"] : ["edge", "chrome"];
  const pools: Record<"chrome" | "edge", string[]> = { chrome, edge };
  for (const kind of prefer) {
    for (const p of pools[kind]) if (existsSync(p)) return { executable: p, kind };
  }
  return null;
}

/** CDP 健康检查：端口上是不是一个活的调试端点 */
export async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 预定一个空闲 TCP 端口（listen(0) 拿系统分配，随即关掉——有极小的抢占窗口，可接受） */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** 从基址起找一个没被监听的端口 */
export async function pickSharedPort(): Promise<number> {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = SHARED_CHROME_BASE_PORT + i;
    if (!(await portInUse(port))) return port;
  }
  return reservePort();
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
  });
}

export interface SharedChromeHandle {
  readonly child: ChildProcess | null; // adopt 时为 null
  readonly port: number;
  readonly executable: string;
  readonly kind: "chrome" | "edge";
}

/**
 * 拉起共享 Chrome（或收编存量实例）。user-data-dir 由调用方传入（daemon 家目录下）。
 * 返回 null = 找不到可执行文件。
 */
export async function launchSharedChrome(
  preferred: "chrome" | "msedge",
  userDataDir: string,
  preferPort: number | undefined,
): Promise<SharedChromeHandle | { error: string }> {
  const candidate = findChromium(preferred);
  if (candidate === null) {
    return { error: "找不到 Chrome / Edge 可执行文件（未安装或路径非标准）" };
  }
  let port = preferPort ?? (await pickSharedPort());
  if (await cdpAlive(port)) {
    // 收编存量（上一代 daemon 崩溃残留 / 用户手动同参数启动）
    log.info("shared chrome adopted on existing debug port", { port });
    return { child: null, port, executable: candidate.executable, kind: candidate.kind };
  }
  if (await portInUse(port)) port = await pickSharedPort();

  const child = spawn(
    candidate.executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session=false",
    ],
    { stdio: "ignore", detached: false, windowsHide: false },
  );
  // Chrome 单实例委派：若同 profile 已有进程，新进程会把命令行交给旧进程后立刻退出。
  // 我们启动前已确认端口无人监听，正常路径不会走到这；防御性记录退出码。
  child.once("exit", (code) => {
    log.info("shared chrome process exited", { code });
  });
  // 等调试端口就绪（Chrome 起得慢，最多 8s）
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    if (await cdpAlive(port)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(await cdpAlive(port))) {
    killTree(child.pid);
    return { error: "共享 Chrome 启动后调试端口未就绪（8s 内 /json/version 无响应）" };
  }
  return { child, port, executable: candidate.executable, kind: candidate.kind };
}

/** Windows 杀进程树；非 Windows 或无 pid 静默放过 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
}
