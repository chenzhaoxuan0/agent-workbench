/**
 * Phase 2 验收 —— 终端 PTY（docs/06：node-pty + WS 双向帧，多窗格独立会话，resize 要有）。
 *
 *   自起 daemon → WS 建 PTY（PowerShell）→ 发命令 → 收真实输出
 *   → resize 不崩 → kill 收 exit 帧 → daemon.stop 优雅退出
 *
 * 用法：cd backend && pnpm smoke:phase2
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("no free port"));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

let daemon: ChildProcess | undefined;

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return Promise.resolve(daemon?.exitCode ?? null);
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
    d.kill("SIGTERM");
  });
}

async function waitHealthy(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 等待 */ }
    await sleep(200);
  }
  return false;
}

let ws: WebSocket | null = null;
let wsId = 0;

function wsConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
    const id = `smoke-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

/** 终端输出累积器：按 terminalId 收 data/exit 帧 */
function terminalCollector() {
  const buffers = new Map<string, { data: string; exit: number | null | "pending" }>();
  const listener = (ev: MessageEvent): void => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (frame["type"] !== "terminal") return;
    const id = String(frame["terminalId"]);
    const buf = buffers.get(id) ?? { data: "", exit: "pending" as const };
    if (frame["kind"] === "data") buf.data += String(frame["data"] ?? "");
    if (frame["kind"] === "exit") buf.exit = Number(frame["exitCode"] ?? 0);
    buffers.set(id, buf);
  };
  return {
    buffers,
    attach(): void { ws?.addEventListener("message", listener); },
    detach(): void { ws?.removeEventListener("message", listener); },
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  try {
    check("daemon becomes healthy", await waitHealthy(port));
    await wsConnect(port);

    const workspace = mkdtempSync(path.join(os.tmpdir(), "awb-term-"));
    const collector = terminalCollector();
    collector.attach();

    // 1. 建 PTY（多窗格语义：每个 create 是独立会话）
    const t1 = await call<{ terminalId: string; shell: string }>("terminal.create", { cwd: workspace, cols: 100, rows: 30 });
    check("terminal created", t1.terminalId.startsWith("term_"), t1);

    // 2. 等 shell 提示符出现再发命令
    const buf1 = () => collector.buffers.get(t1.terminalId)?.data ?? "";
    await waitFor(() => buf1().length > 0, "first PTY output");
    await call("terminal.input", { terminalId: t1.terminalId, data: "echo hello-from-pty-42\r" });
    await waitFor(() => buf1().includes("hello-from-pty-42"), "echo output");
    check("real PTY echo round-trip", buf1().includes("hello-from-pty-42"));
    console.log(`         terminal output tail: ${JSON.stringify(buf1().slice(-80))}`);

    // 3. resize 不崩、继续可用
    await call("terminal.resize", { terminalId: t1.terminalId, cols: 120, rows: 40 });
    await call("terminal.input", { terminalId: t1.terminalId, data: "echo after-resize\r" });
    await waitFor(() => buf1().includes("after-resize"), "post-resize output");
    check("resize keeps terminal usable", true);

    // 4. 多窗格：第二条独立 PTY 互不串扰
    const t2 = await call<{ terminalId: string }>("terminal.create", { cwd: workspace, cols: 80, rows: 24 });
    check("second pane is a distinct session", t2.terminalId !== t1.terminalId);
    await call("terminal.input", { terminalId: t2.terminalId, data: "echo pane-two\r" });
    await waitFor(() => (collector.buffers.get(t2.terminalId)?.data ?? "").includes("pane-two"), "pane two output");
    check("panes are independent", !(buf1().includes("pane-two")));

    // 5. kill 收 exit 帧
    await call("terminal.kill", { terminalId: t2.terminalId });
    await waitFor(() => collector.buffers.get(t2.terminalId)?.exit !== "pending", "exit frame");
    check("exit frame delivered", typeof collector.buffers.get(t2.terminalId)?.exit === "number");

    collector.detach();

    // 6. 优雅退出
    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { exitCode = c; break; }
      await sleep(150);
    }
    check("daemon exits 0 after daemon.stop", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase2: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase2: all checks passed — 真实终端（ConPTY）双窗格可用");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase2: crashed", err);
  void stopDaemon();
  process.exit(1);
});
