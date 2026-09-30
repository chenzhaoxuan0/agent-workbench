/**
 * Phase 8 验收 —— 事件流可靠性（docs/08 WP-2/WP-3）。
 *
 *   WS-A 建会话收事件（断言帧带 seq 且单调）
 *   → A 断线；WS-B 放行权限让 turn 跑完（事件只进 B）
 *   → A 重连带 lastSeq 调 session.events.since
 *   → 断言补拉无缺口无重叠；session.trace 落盘账本可读且带 seq
 *
 * 用法：cd backend && pnpm smoke:phase8
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
      srv.close(() => resolve(addr !== null && typeof addr === "object" ? addr.port : 0));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

interface Frame {
  v?: number;
  type?: string;
  seq?: number;
  event?: { type?: string; sessionId?: string };
  id?: string | null;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** 一个带事件收集的 WS 客户端视图 */
function makeClient(port: number): {
  socket: WebSocket;
  events: Array<{ seq?: number; type?: string }>;
  call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  open: () => Promise<void>;
  close: () => void;
} {
  const events: Array<{ seq?: number; type?: string }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let seqCounter = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (ev) => {
    let f: Frame;
    try {
      f = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (f.type === "event" && f.event?.type) {
      events.push({ seq: f.seq, type: f.event.type });
      return;
    }
    if (typeof f.id === "string") {
      const p = pending.get(f.id);
      if (!p) return;
      pending.delete(f.id);
      if (f.ok === true) p.resolve(f.result);
      else p.reject(new Error(f.error?.message ?? "rpc failed"));
    }
  });
  return {
    socket,
    events,
    open: () =>
      new Promise<void>((res, rej) => {
        socket.addEventListener("open", () => res(), { once: true });
        socket.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      }),
    call: <T,>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = `c-${++seqCounter}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v as T); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        socket.send(JSON.stringify({ v: 1, id, method, params }));
      }),
    close: () => socket.close(),
  };
}

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), "awb-phase8-"));
let daemon: ChildProcess | undefined;
daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
  cwd: backendRoot,
  env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
    up = true;
    break;
  } catch {
    await sleep(400);
  }
}
if (!up) {
  console.log("  FAIL daemon did not come up");
  process.exit(1);
}

try {
  // ---- 1. WS-A 建会话，帧带 seq 且单调 ----
  const a = makeClient(port);
  await a.open();
  const s = await a.call<{ id: string }>("session.start", {
    runtimeId: "mockperm",
    unitId: "u-p8",
    unitName: "phase8",
    rootPath: backendRoot,
    prompt: "操作 A",
    model: "mock-1",
    mode: "build",
  });
  check("session started", typeof s.id === "string");
  await sleep(800);
  const aSeen = a.events.slice();
  check("A 收到事件且帧带 seq", aSeen.length > 0 && aSeen.every((e) => typeof e.seq === "number"), aSeen);
  const seqs = aSeen.map((e) => e.seq as number);
  const monotonic = seqs.every((v, i) => i === 0 || v > (seqs[i - 1] as number));
  check("seq 单调递增", monotonic, seqs);
  const lastSeqA = seqs.at(-1) as number;

  // ---- 2. A 断线；B 放行让 turn 跑完（live 事件只进 B） ----
  a.close();
  await sleep(300);
  const b = makeClient(port);
  await b.open();
  // 从落盘账本找挂起请求 id（messages 不含挂起请求）
  const trace = await b.call<string>("session.trace", { sessionId: s.id });
  const pendingReq = trace
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: { type?: string; requestId?: string } };
      } catch {
        return null;
      }
    })
    .filter((r): r is { event: { type: string; requestId: string } } => r?.event?.type === "permission.requested")
    .at(-1)?.event.requestId;
  check("从落盘账本找到挂起权限请求", typeof pendingReq === "string", pendingReq);
  await b.call("permission.resolve", { sessionId: s.id, requestId: pendingReq, decision: "allow" });
  await sleep(2500); // mockperm 轮落定
  const bLive = b.events.length;
  check(`B 实时收到断线窗口事件（n=${bLive}）`, bLive > 0);
  b.close();

  // ---- 3. A 重连，since 补拉 ----
  const a2 = makeClient(port);
  await a2.open();
  const missed = await a2.call<Array<{ seq: number; event: { type?: string } }>>(
    "session.events.since",
    { sessionId: s.id, afterSeq: lastSeqA },
  );
  check("补拉非空", missed.length > 0);
  const missedSeqs = missed.map((m) => m.seq);
  check("补拉全部 > lastSeqA", missedSeqs.every((v) => v > lastSeqA), missedSeqs);
  const noGap = missedSeqs.every((v, i) => i === 0 || v === (missedSeqs[i - 1] as number) + 1);
  check("补拉无缺口（环内连续）", noGap, missedSeqs);
  check("补拉含轮终态（mockperm 以 session.ended 收尾）", missed.some((m) => m.event.type === "session.ended"));

  // ---- 4. session.trace 落盘账本：NDJSON 且带 seq ----
  const trace2 = await a2.call<string>("session.trace", { sessionId: s.id });
  const traceLines = trace2.split("\n").filter((l) => l !== "");
  const traceRecs = traceLines.map((l) => JSON.parse(l) as { seq: number; event: { type?: string } });
  check("trace 为 TraceRecord NDJSON 且带 seq", traceRecs.every((r) => typeof r.seq === "number"));
  check("trace 覆盖补拉范围", traceRecs.filter((r) => r.seq > lastSeqA).length >= missed.length);
  const sinceTail = await a2.call<string>("session.trace", { sessionId: s.id, afterSeq: lastSeqA });
  const tailCount = sinceTail.split("\n").filter((l) => l !== "").length;
  check(`trace afterSeq 游标生效（tail=${tailCount}）`, tailCount === missed.length);

  a2.close();
} finally {
  // 程序化退出走 daemon.stop（Windows 无跨进程 SIGTERM）
  try {
    const stopper = makeClient(port);
    await stopper.open();
    await stopper.call("daemon.stop", null, 5000).catch(() => {});
    stopper.close();
  } catch {
    daemon?.kill();
  }
  await sleep(800);
}

console.log(failures === 0 ? "smoke-phase8: all checks passed — seq 帧/断线补拉/落盘游标成立" : `smoke-phase8: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
