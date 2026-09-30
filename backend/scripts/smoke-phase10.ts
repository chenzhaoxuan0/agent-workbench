/**
 * Phase 10 验收 —— per-bot 外露面（docs/08 WP-9）：webhook + MCP。
 *
 *   webhook：错 secret → forbidden；对 secret → 起会话跑一轮回全文
 *   MCP：spawn src/mcp.ts（stdio）→ initialize / tools/list / tools/call(ask_bot)
 *   → 断言回复文本——别的 AI 客户端从此能把本机 bot 当工具调
 *
 * 用法：cd backend && pnpm smoke:phase10
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
};

const port = 5181 + Math.floor(Math.random() * 900);
const home = mkdtempSync(path.join(os.tmpdir(), "awb-phase10-"));
const botRoot = path.join(home, "workspace", "bot-a");
mkdirSync(botRoot, { recursive: true });

let daemon: ChildProcess | undefined;
daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
  cwd: backendRoot,
  env: {
    ...process.env,
    AGENT_WORKBENCH_PORT: String(port),
    AGENT_WORKBENCH_HOME: home,
    AGENT_WORKBENCH_INSECURE: "1",
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
  // 登记 bot（webhook 渠道 enabled，secret = s3cret）
  const unit = {
    id: "u-bot-a",
    rootPath: botRoot,
    name: "Bot A",
    kind: "bot",
    bindings: [],
    tags: [],
    channels: [{ kind: "webhook", enabled: true, config: { secret: "s3cret" } }],
  };
  {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", () => rej(new Error("ws fail")));
    });
    await new Promise<void>((resolve) => {
      ws.send(JSON.stringify({ v: 1, id: "c-1", method: "bot.put", params: { unit } }));
      ws.on("message", (d) => {
        const f = JSON.parse(String(d)) as { id?: unknown };
        if (f.id === "c-1") resolve();
      });
    });
    ws.close();
  }

  // mockperm 每轮必挂权限；预置 always-allow 规则让 headless 轮次能自动走完（phase9 同款）
  {
    const r = await fetch(`http://127.0.0.1:${port}/api/permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "mock_tool", decision: "allow" }),
    });
    check("预置权限规则", r.ok);
  }

  // ---- webhook：错 secret 拒；对 secret 回全文 ----
  const hook = async (secret: string): Promise<{ status: number; body: { reply?: string; error?: { code?: string } } }> => {
    const r = await fetch(`http://127.0.0.1:${port}/webhook/bot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "u-bot-a", secret, text: "只回复一个字符：9" }),
      signal: AbortSignal.timeout(120_000),
    });
    return { status: r.status, body: (await r.json()) as { reply?: string; error?: { code?: string } } };
  };
  const bad = await hook("wrong");
  check("错 secret 被拒", bad.status === 403 && bad.body.error?.code === "forbidden", bad);
  const good = await hook("s3cret");
  check("对 secret 跑通一轮", good.status === 200 && typeof good.body.reply === "string" && good.body.reply !== "", good);
  check("回复来自 mockperm", (good.body.reply ?? "").includes("mock ok"), good.body.reply);

  // ---- MCP：stdio 起桥，initialize → tools/list → tools/call ----
  const child = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "mcp.ts"), "--url", `http://127.0.0.1:${port}`], {
    cwd: backendRoot,
    stdio: ["pipe", "pipe", "pipe"] as StdioOptions,
  });
  const mcpReplies = new Map<number, Record<string, unknown>>();
  const rl = createInterface({ input: child.stdout! });
  let mcpReady = Promise.resolve();
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
      if (typeof msg.id === "number" && msg.result !== undefined) mcpReplies.set(msg.id, msg.result);
    } catch { /* ignore */ }
  });
  const mcpCall = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> => {
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return (async () => {
      for (let i = 0; i < 100; i++) {
        const hit = mcpReplies.get(id);
        if (hit !== undefined) return hit;
        await sleep(150);
      }
      throw new Error(`mcp ${method} timed out`);
    })();
  };
  const init = await mcpCall(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  const info = (init as { serverInfo?: { name?: string } }).serverInfo;
  check("MCP initialize 握手", info?.name === "agent-workbench", init);
  const tools = await mcpCall(2, "tools/list");
  const toolNames = ((tools as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name);
  check("MCP 工具清单含 ask_bot/list_bots", toolNames.includes("ask_bot") && toolNames.includes("list_bots"), toolNames);
  const asked = await mcpCall(3, "tools/call", { name: "ask_bot", arguments: { botId: "u-bot-a", text: "只回复一个字符：8" } });
  const content = (asked as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
  check("MCP ask_bot 拿到回复", content.includes("mock ok"), asked);
  child.kill();
} finally {
  try {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res) => {
      ws.on("open", () => res());
      ws.on("error", () => res());
    });
    ws.send(JSON.stringify({ v: 1, id: "stop", method: "daemon.stop", params: null }));
    await sleep(800);
    ws.close();
  } catch {
    daemon?.kill();
  }
}

console.log(failures === 0 ? "smoke-phase10: all checks passed — webhook 鉴权/跑通 + MCP 握手/工具调用成立" : `smoke-phase10: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
