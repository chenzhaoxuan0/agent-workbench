/**
 * 终端重挂冒烟 —— F5 后 terminal.list 必须带回足够还原标签的元数据与输出回放。
 *
 *   terminal.create（含空 cwd 归一化）→ 产出输出 → 断开 WS（模拟刷新）
 *   → terminal.list 应含该终端，scrollback 里有刚才的输出，元数据齐全
 *   → 对 list 回来的 id 直接 input/resize 仍可用（重挂后可交互）
 *   → kill 后 list 不再含它
 *
 * 用法：cd backend && npx tsx scripts/smoke-terminal-reattach.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        // 必须 close 再放行端口：不关的话本进程一直占着它，daemon 预检必 EADDRINUSE
        srv.close(() => resolve(addr.port));
      } else {
        srv.close();
        reject(new Error("no free port"));
      }
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

let daemon: ChildProcess | undefined;

function startDaemon(port: number, home: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  // daemon.stop RPC 已让 daemon 自走优雅退出；这里只等它，超时才强杀。
  // 一上来就 SIGTERM 会抢在优雅退出前杀掉 tsx 包装进程，把退出码弄丢。
  return new Promise((resolve) => {
    const d = daemon!;
    const timer = setTimeout(() => {
      d.kill("SIGKILL");
      resolve(null);
    }, 8000);
    d.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitHealthy(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 等待 */ }
  }
  return false;
}

interface ListItem {
  terminalId: string;
  shell: string;
  pid: number;
  cwd: string;
  executor: string;
  scrollback: string;
}

let ws: WebSocket | null = null;
let wsId = 0;
const frames: Array<{ terminalId: string; kind: string; data?: string }> = [];

async function connect(port: number): Promise<void> {
  frames.length = 0;
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    ws.on("message", (data: WebSocket.RawData) => {
      const frame = JSON.parse(String(data)) as { type?: string; terminalId?: string; kind?: string; data?: string };
      if (frame["type"] === "terminal" && frame.terminalId !== undefined) {
        frames.push({ terminalId: frame.terminalId, kind: frame.kind ?? "", data: frame.data });
      }
    });
  });
}

function closeWs(): Promise<void> {
  return new Promise((resolve) => {
    if (ws === null) return resolve();
    ws.once("close", () => resolve());
    ws.close();
  });
}

function call<T = unknown>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
    const id = `smoke-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.off("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

/** 等某段输出在 frames 里出现（PTY 输出是异步的） */
async function waitForOutput(needle: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (frames.some((f) => f.data !== undefined && f.data.includes(needle))) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke-term-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 1. 空 cwd（前端无归属 bot 的标签就是空串）必须能起，且归一化到非空目录
    const t = await call<{ terminalId: string; shell: string }>("terminal.create", { cwd: "", cols: 100, rows: 30 });
    check("create with empty cwd works", typeof t.terminalId === "string" && t.terminalId !== "");

    // 2. 产出可辨认的输出
    await call("terminal.input", { terminalId: t.terminalId, data: "echo reattach-marker-42\r" });
    check("pty produced output", await waitForOutput("reattach-marker-42"));

    // 3. 模拟 F5：断开客户端。PTY 必须还活着
    await closeWs();
    await sleep(300);

    // 4. 重连（新「页面」），list 必须带回元数据 + 回放
    await connect(port);
    const list = await call<ListItem[]>("terminal.list", null);
    const mine = list.find((i) => i.terminalId === t.terminalId);
    check("list contains surviving terminal", mine !== undefined, list.map((i) => i.terminalId));
    check("list item has cwd", mine !== undefined && mine.cwd.trim() !== "", mine?.cwd);
    check("list item has executor", mine !== undefined && typeof mine.executor === "string");
    check("scrollback replay contains prior output", mine !== undefined && mine.scrollback.includes("reattach-marker-42"), mine?.scrollback?.slice(-120));

    // 5. 对重挂的终端继续交互
    await call("terminal.resize", { terminalId: t.terminalId, cols: 110, rows: 32 });
    await call("terminal.input", { terminalId: t.terminalId, data: "echo still-alive-7\r" });
    check("reattached terminal still interactive", await waitForOutput("still-alive-7"));

    // 6. kill 后 list 收口
    await call("terminal.kill", { terminalId: t.terminalId });
    await sleep(400);
    const list2 = await call<ListItem[]>("terminal.list", null);
    check("killed terminal gone from list", !list2.some((i) => i.terminalId === t.terminalId));

    await call("daemon.stop", null, 15000);
    const code = await stopDaemon();
    check("daemon exits 0", code === 0, code);
  } finally {
    await stopDaemon();
  }

  if (failures > 0) {
    console.error(`smoke-terminal-reattach: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-terminal-reattach: all checks passed — F5 重挂（list 元数据 + 输出回放 + 存活交互）成立");
}

main().catch((err: unknown) => {
  console.error("smoke-terminal-reattach: crashed", err);
  process.exit(1);
});
