/**
 * Phase 4 验收 —— 权限闸（docs/06：挂起 → REST 决策 → 放行/拒绝；always 落规则表）。
 *
 *   mockperm 会话（每轮必发 permission.requested 并挂起）
 *   → REST resolve(decision=always) → 放行 + 规则落库
 *   → 第二轮：规则自动放行（无人参与）
 *   → REST 追加 deny 规则（新规则优先）→ 第三轮自动拒绝
 *
 * 用法：cd backend && pnpm smoke:phase4
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
const eventLog: Array<Record<string, unknown>> = [];

async function connect(port: number): Promise<void> {
  eventLog.length = 0;
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["type"] === "event") { const e = frame["event"] as Record<string, unknown>; eventLog.push(e); console.log("  EVT", String(e["type"])); }
      else if (frame["type"] !== undefined) console.log("  FRAME", String(frame["type"]));
    });
  });
}

function call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
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

function rest<T>(port: number, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const json = (await res.json()) as T & { ok?: boolean; error?: { message?: string } };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error?.message ?? ""}`);
    return json;
  });
}

async function waitForEvent(type: string, fromIndex: number, timeoutMs = 20000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = eventLog.findIndex((e, i) => i >= fromIndex && e["type"] === type);
    if (idx >= 0) return idx;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type} (have: ${eventLog.slice(fromIndex).map((e) => String(e["type"])).join(",")})`);
    await sleep(100);
  }
}

async function main(): Promise<void> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "awb-smoke4-"));
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port, home);

  try {
    check("daemon healthy", await waitHealthy(port));
    await connect(port);

    // 第一轮：session.start 的 prompt 即首轮（受理即返回，fire-and-forget）——
    // mockperm 毫秒级跑完，事件可能先于 rpc 响应到达，所以 mark 从 0 起算，
    // 断言一律按事件内容过滤而非下标窗口。
    const s = await call<{ id: string }>("session.start", {
      runtimeId: "mockperm",
      unitId: "smoke-gate",
      unitName: "Phase 4 冒烟",
      rootPath: home,
      prompt: "需要审批的操作 A",
      model: "mock-1",
    });
    const reqIdx = await waitForEvent("permission.requested", 0);
    const requested = eventLog[reqIdx] as { requestId?: string };
    check("permission requested and pending", typeof requested.requestId === "string", requested);
    await sleep(600); // 给自动规则留 600ms 证明它「没有」自动放行（首次无规则）
    check("no auto-resolve before rule exists", !eventLog.some((e) => e["type"] === "permission.resolved"));

    const resolveRes = await rest<{ resolved: boolean }>(port, "POST", "/api/permissions/resolve", {
      sessionId: s.id,
      requestId: requested.requestId,
      decision: "always",
    });
    check("REST resolve(always) ok", resolveRes.resolved === true, resolveRes);
    await waitForEvent("message.completed", 0);
    check("turn 1 completed after always", true);

    const rules = await rest<{ rules: Array<{ id: number; pattern: string; decision: string }> }>(port, "GET", "/api/permissions/rules");
    check("always persisted a rule", rules.rules.some((r) => r.pattern === "mock_tool" && r.decision === "allow"), rules.rules);

    // 第二轮：规则自动放行（无 REST 参与）
    const mark2 = eventLog.length;
    await call("session.send", { sessionId: s.id, text: "操作 B" });
    const req2 = await waitForEvent("permission.requested", mark2);
    const resolvedIdx = await waitForEvent("permission.resolved", mark2);
    const resolved = eventLog[resolvedIdx] as { decision?: string };
    check("rule auto-resolved second request", resolved.decision === "allow", resolved);
    await waitForEvent("session.ended", resolvedIdx);
    check("turn 2 completed without human", true);

    // 第三轮：新 deny 规则优先（id 倒序），自动拒绝
    await rest(port, "POST", "/api/permissions/rules", { pattern: "mock_tool", decision: "deny" });
    const mark3 = eventLog.length;
    await call("session.send", { sessionId: s.id, text: "操作 C" });
    const resolved3Idx = await waitForEvent("permission.resolved", mark3);
    const resolved3 = eventLog[resolved3Idx] as { decision?: string };
    check("newer deny rule wins", resolved3.decision === "deny", resolved3);

    // 清理规则（DELETE 端点）
    const firstRule = rules.rules[0];
    const del = await rest<{ deleted: boolean }>(port, "DELETE", `/api/permissions/rules?id=${firstRule?.id ?? 0}`);
    check("rule delete works", del.deleted === true, del);

    await call("daemon.stop", null, 15000);
    let exitCode: number | null | "timeout" = "timeout";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const c = daemon?.exitCode;
      if (c !== null && c !== undefined) { exitCode = c; break; }
      await sleep(150);
    }
    check("daemon exits 0", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) console.error("smoke: daemon killed");
  }

  if (failures > 0) {
    console.error(`smoke-phase4: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke-phase4: all checks passed — 权限闸（挂起/REST 决策/always 规则/自动放行拒绝）成立");
}

await main().catch((err: unknown) => {
  console.error("smoke-phase4: crashed", err);
  void stopDaemon();
  process.exit(1);
});
