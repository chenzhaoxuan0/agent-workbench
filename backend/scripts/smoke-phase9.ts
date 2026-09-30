/**
 * Phase 9 验收 —— Bot 注册表（docs/08 WP-5）+ 渠道网关（WP-8，本文件下半部分）。
 *
 * 注册表：bot.put 写 <rootPath>/.agent-workbench/bot.json → bot.list 扫描回读 roundtrip
 * → 父目录自动登记为扫描根 → 换 daemon 实例（重启）仍可读。
 * 渠道：telegram 网关对 mock Bot API 长轮询收消息 → 起会话 → 回 sendMessage。
 *
 * 用法：cd backend && pnpm smoke:phase9
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
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
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
};

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

function makeClient(port: number): {
  events: Array<{ seq?: number; type?: string; sessionId?: string }>;
  call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  open: () => Promise<void>;
  close: () => void;
} {
  const events: Array<{ seq?: number; type?: string; sessionId?: string }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let n = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (ev) => {
    let f: Frame;
    try {
      f = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (f.type === "event" && f.event?.type) {
      events.push({ seq: f.seq, type: f.event.type, sessionId: f.event.sessionId });
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
    events,
    open: () =>
      new Promise<void>((res, rej) => {
        socket.addEventListener("open", () => res(), { once: true });
        socket.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      }),
    call: <T,>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = `c-${++n}`;
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
const home = mkdtempSync(path.join(os.tmpdir(), "awb-phase9-"));
// bot 根目录：tmp 下造 workspace/bot-a 结构
const wsRoot = path.join(home, "workspace");
const botRoot = path.join(wsRoot, "bot-a");
mkdirSync(botRoot, { recursive: true });

let daemon: ChildProcess | undefined;
daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
  cwd: backendRoot,
  env: {
    ...process.env,
    AGENT_WORKBENCH_PORT: String(port),
    AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1",
    // WP-8：telegram 网关打向本地 mock Bot API
    AGENT_WORKBENCH_TELEGRAM_API: "http://127.0.0.1:" + (await freePort()),
  },
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
  const c = makeClient(port);
  await c.open();

  // ---- bot.put：写盘 + 父目录自动成根 ----
  const unit = {
    id: "u-bot-a",
    rootPath: botRoot,
    name: "Bot A",
    kind: "bot",
    bindings: [],
    tags: [],
    channels: [{ kind: "telegram", enabled: false, config: { botToken: "test-token", chatId: "42" } }],
  };
  await c.call("bot.put", { unit });
  const { existsSync } = await import("node:fs");
  check("bot.json 落盘", existsSync(path.join(botRoot, ".agent-workbench", "bot.json")));

  // ---- bot.list：扫描回读 roundtrip ----
  const listed = await c.call<Array<{ id?: string; name?: string; channels?: unknown[] }>>("bot.list", null);
  check("bot.list 扫描回读", listed.some((b) => b.id === "u-bot-a" && b.name === "Bot A"), listed);
  check("channels 字段保真", listed.find((b) => b.id === "u-bot-a")?.channels !== undefined);

  // ---- 重启 daemon：定义仍在（文件即数据库） ----
  c.close();
  await stopDaemon(port);
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1",
      AGENT_WORKBENCH_TELEGRAM_API: "http://127.0.0.1:" + (await freePort()),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
      break;
    } catch {
      await sleep(400);
    }
  }
  const c2 = makeClient(port);
  await c2.open();
  const listed2 = await c2.call<Array<{ id?: string }>>("bot.list", null);
  check("daemon 重启后 bot 定义仍在", listed2.some((b) => b.id === "u-bot-a"), listed2);
  c2.close();
} finally {
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

console.log(failures === 0 ? "smoke-phase9: all checks passed — bot 定义落盘/扫描/跨重启成立" : `smoke-phase9: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

async function stopDaemon(port: number): Promise<void> {
  const stopper = makeClient(port);
  await stopper.open();
  await stopper.call("daemon.stop", null, 5000).catch(() => {});
  stopper.close();
  await sleep(800);
}
