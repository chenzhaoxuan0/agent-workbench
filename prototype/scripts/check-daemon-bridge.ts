/**
 * 前后端连通性验收 —— 桥的端到端检查（check:* 家族口径）。
 *
 *   自起真 daemon（空闲端口）→ 用 prototype 的 daemon 传输适配器
 *   → adapter.list → probe → events() 消费 → startSession 发真实 prompt
 *   → 断言 message.completed 回复 → exportTrace 非空 → daemon.stop
 *
 * 这条跑的是**前端将要执行的那份代码**（src/adapters/daemon/*），
 * daemon 侧冒烟（backend pnpm smoke:*）跑的是 daemon 自己的 WS 协议 ——
 * 两层都绿 = 前后端连得上、用得起来。
 *
 * 前提：backend 依赖已安装（pnpm --dir ../backend install）。
 * 用法：pnpm --dir prototype check:bridge
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const backendRoot = path.resolve(prototypeRoot, "..", "backend");

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
  daemon = spawn(
    process.execPath,
    ["--import", "tsx", path.join(backendRoot, "src", "index.ts")],
    {
      cwd: backendRoot,
      env: { ...process.env, AGENT_WORKBENCH_PORT: String(port) },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
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
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 等待 */
    }
    await sleep(200);
  }
  return false;
}

async function main(): Promise<void> {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  console.log(`check: starting daemon on ${endpoint}`);
  startDaemon(port);

  try {
    // 动态 import：daemon 起来之后再加载前端桥代码（避免模块级连接竞态）
    const { listDaemonExecutors } = await import("../src/adapters/daemon/client.ts");
    const { createDaemonFactory } = await import("../src/adapters/daemon/adapter.ts");

    check("daemon healthy", await waitHealthy(port));

    const infos = await listDaemonExecutors(endpoint);
    check("adapter.list returns executors", infos.length >= 2, infos.map((i) => i.id));
    check("daemon executor ids present", infos.some((i) => i.id === "zcode") && infos.some((i) => i.id === "codex"));

    const zcode = infos.find((i) => i.id === "zcode");
    if (zcode === undefined) throw new Error("zcode executor missing");
    const factory = createDaemonFactory(zcode, endpoint);
    check("factory declares non-empty models", factory.models.length > 0, factory.models);

    const adapter = await factory.create();
    const probe = await adapter.probe();
    check("probe ready", probe.state.status === "ready", probe.state);

    // 与 store.run() 相同的消费方式：先挂 events() 消费者，再 startSession
    const received: Array<{ type: string; text?: string; sessionId?: string }> = [];
    void (async () => {
      for await (const event of adapter.events()) {
        received.push({ type: event.type, text: event.type === "message.completed" ? event.text : undefined, sessionId: event.sessionId });
      }
    })();

    const workspace = mkdtempSync(path.join(os.tmpdir(), "awb-bridge-ws-"));
    const session = await adapter.startSession({
      unit: {
        id: "bridge-check" as never,
        rootPath: workspace,
        name: "桥接检查",
        kind: "bot" as const,
        bindings: [],
        assets: { agentFiles: [], skillDirs: [] },
        tags: [],
      } as never,
      prompt: "只回答一个数字，不要使用任何工具：2+3=?",
      model: factory.models[0]!,
    });
    check("startSession returns session", session.id.startsWith("sess_"), session);

    // agent loop 语义：turn 完成 ≠ 会话结束，等的是 usage（turn 级完成）
    const waitFor = async (type: string, from: number, timeoutMs = 240000): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = received.findIndex((e, i) => i >= from && e.type === type);
        if (idx >= 0) return idx;
        if (Date.now() > deadline) throw new Error(`timed out waiting ${type} (have: ${received.slice(from).map((e) => e.type).join(",")})`);
        await sleep(300);
      }
    };
    const mark0 = 0;
    await waitFor("session.started", mark0);
    const delta1 = await waitFor("message.delta", mark0);
    const completed1 = await waitFor("message.completed", mark0);
    await waitFor("usage", mark0);
    check("turn 1 streamed and completed", delta1 < completed1, received.map((e) => e.type));
    const reply1 = (received[completed1]?.text ?? "").trim();
    console.log(`         turn 1 reply: ${JSON.stringify(reply1).slice(0, 40)}`);
    check("session stays open after turn (agent loop)", !received.some((e) => e.type === "session.ended"), received.map((e) => e.type));

    // 续聊：同一会话 sendMessage（上下文连续，数学正确即证明）
    const mark1 = received.length;
    await adapter.sendMessage({ sessionId: session.id, text: "把上一个结果再乘以4，只回答一个数字。" });
    const completed2 = await waitFor("message.completed", mark1);
    await waitFor("usage", mark1);
    const reply2 = (received[completed2]?.text ?? "").trim();
    check("turn 2 same-session continuity (math right)", reply2.includes("20"), reply2);
    console.log(`         turn 2 reply: ${JSON.stringify(reply2).slice(0, 40)}`);

    const trace = await adapter.exportTrace(session.id);
    check("exportTrace non-empty", trace.length > 50, trace.length);
    // Windows 上 SIGTERM 送不进子进程（backend 硬结论）——程序化退出走协议
    const { DaemonClient } = await import("../src/adapters/daemon/client.ts");
    await DaemonClient.get(endpoint).rpc("daemon.stop", null, 15000);
    console.log("  (daemon.stop acked)");
    const exitDeadline = Date.now() + 10000;
    while (Date.now() < exitDeadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { console.log("  (self-exited", c, ")"); break; }
      await sleep(200);
    }
    const stopCode = await stopDaemon();
    check("daemon exits 0", stopCode === 0, { stopCode });
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("check: daemon killed");
  }

  if (failures > 0) {
    console.error(`check-daemon-bridge: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("check-daemon-bridge: all checks passed — 前端桥 ↔ 真实 daemon 连通可用");
}

await main().catch((err: unknown) => {
  console.error("check-daemon-bridge: crashed", err);
  void stopDaemon();
  process.exit(1);
});
