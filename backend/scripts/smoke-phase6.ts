/**
 * Phase 6 验收 —— Ops 真执行（docs/06：确定性 0/1 断言 + judge 真 LLM 调用 +
 * gate 落 eval_runs.jsonl + Arena 落 compare/history.jsonl，均 50 条滚动）。
 *
 *   确定性 eval（mockperm：工具事件确定性触发）
 *     → 正例（expect_tool 命中）+ 负例（expect_tool 不命中）→ 1/2 → FAIL 落账本
 *   正例单独再跑 → 100% → PASS
 *   → 带 judge 指标跑一次（真 zcode LLM 调用；不可用则整层跳过而非 0 分）
 *   → Arena 同题 × [mockperm] → Completion 机械分 + compare/history.jsonl
 *
 * 用法：cd backend && pnpm smoke:phase6
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 400));
  }
}

let daemon: ChildProcess | undefined;

function startDaemon(port: number, home: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
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

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 300000): Promise<T> {
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

function readJsonl(home: string, name: string): unknown[] {
  const file = path.join(home, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke6-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 预放行（mockperm 每轮发权限请求）
    await fetch(`http://127.0.0.1:${port}/api/permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "mock_tool", decision: "allow" }),
    });

    // 1. 混合 dataset：正例命中 + 负例不命中 → 1/2 → FAIL
    const mixed = await call<{ verdict: string; deterministic: { passed: number; total: number } }>("ops.evalRun", {
      datasetName: "mixed",
      runtimeId: "mockperm",
      rows: [
        { id: "pos", input: "做正事", expect_tool: "mock_tool" },
        { id: "neg", input: "做别的事", expect_tool: "definitely_not_this_tool" },
      ],
      turnTimeoutMs: 30000,
    });
    check("mixed dataset scores 1/2", mixed.deterministic.passed === 1 && mixed.deterministic.total === 2, mixed);
    check("mixed gate verdict FAIL", mixed.verdict === "FAIL", mixed);

    // 2. 正例 dataset → 100% → PASS（judge 缺省 = 只跑确定性）
    const positive = await call<{ verdict: string; deterministic: { passed: number; total: number } }>("ops.evalRun", {
      datasetName: "positive",
      runtimeId: "mockperm",
      rows: [{ id: "pos", input: "做正事", expect_tool: "mock_tool", expect_in_args: "正事" }],
      turnTimeoutMs: 30000,
    });
    check("positive dataset 100%", positive.deterministic.passed === 1 && positive.verdict === "PASS", positive);

    // 3. 带 judge 指标（真 zcode LLM 调用；不可用则 judge.ran=false 且 PASS 不受 0 分污染）
    const judged = await call<{ verdict: string; judge: { ran: boolean; results: Array<{ result: { ran: boolean; score?: number; skipReason?: string } }> } }>("ops.evalRun", {
      datasetName: "judged",
      runtimeId: "mockperm",
      rows: [{ id: "j1", input: "回答一句话", expect_tool: "mock_tool" }],
      judgeMetrics: [{ name: "回答质量", steps: ["回答是否切题", "回答是否有意义"], threshold: 0.6 }],
      turnTimeoutMs: 30000,
    }, 300000);
    check("judge layer present", judged.judge.results.length === 1, judged.judge);
    if (judged.judge.ran) {
      const score = judged.judge.results[0]?.result.score ?? -1;
      check("judge real score in [0,1]", score >= 0 && score <= 1, judged.judge.results);
      console.log(`         judge score: ${score}`);
    } else {
      check("judge skipped gracefully (not scored 0)", (judged.judge.results[0]?.result.skipReason ?? "").length > 0, judged.judge);
      console.log("         judge skipped:", judged.judge.results[0]?.result.skipReason);
    }

    // 4. 账本：eval_runs.jsonl 三行，verdict 序列 FAIL/PASS/*
    const gateLines = readJsonl(home, "eval_runs.jsonl");
    check("eval_runs.jsonl has 3 gate records", gateLines.length === 3, gateLines.length);

    // 5. Arena：同题 × mockperm → Completion 1 + 账本一行
    const arenaRes = await call<{ contestants: Array<{ runtimeId: string; completion: number; answer: string }> }>("ops.arenaRun", {
      prompt: "用一句话回答：天空为什么是蓝的？",
      runtimeIds: ["mockperm"],
      turnTimeoutMs: 30000,
    });
    const c = arenaRes.contestants[0];
    check("arena contestant completed", c !== undefined && c.completion === 1 && c.answer !== "", arenaRes);
    const arenaLines = readJsonl(home, "compare/history.jsonl");
    check("compare/history.jsonl has the match", arenaLines.length === 1, arenaLines.length);

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const cc = daemon?.exitCode;
      if (cc !== null && cc !== undefined) { exitCode = cc; break; }
      await sleep(150);
    }
    check("daemon exits 0", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase6: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase6: all checks passed — Ops 真执行（确定性/judge/gate/Arena）成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase6: crashed", err);
  void stopDaemon();
  process.exit(1);
});
