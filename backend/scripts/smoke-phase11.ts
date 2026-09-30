/**
 * Phase 11 验收 —— token 鉴权面（docs/08 WP-7，评审 P2 指出的覆盖盲区）。
 *
 * 此前全部冒烟跑 INSECURE=1，鉴权回归无人看守。本文件以显式 token 启动 daemon，
 * 断言四个关键行为：
 *   1. 无 token 的 HTTP 401 / WS upgrade 拒绝
 *   2. 带 token（header 与 query 双通道）通过
 *   3. /bootstrap 仅回环放行，且跨源 Origin（带本地对端）被拒——评审 P0 的偷 token 面
 *   4. token 开启时 /webhook/bot 仍可凭 per-bot secret 进入（豁免链完整）
 *
 * 用法：cd backend && pnpm smoke:phase11
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 200) : "");
  }
};

const port = 5181 + Math.floor(Math.random() * 9000) + 1000;
const home = mkdtempSync(path.join(os.tmpdir(), "awb-phase11-"));
const botRoot = path.join(home, "workspace", "bot-a");
mkdirSync(botRoot, { recursive: true });

const TOKEN = "phase11-token";
let daemon: ChildProcess | undefined;
daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
  cwd: backendRoot,
  env: {
    ...process.env,
    AGENT_WORKBENCH_PORT: String(port),
    AGENT_WORKBENCH_HOME: home,
    AGENT_WORKBENCH_TOKEN: TOKEN,
    // 不设 INSECURE——本文件的存在意义就是测鉴权
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
  daemon?.kill();
  process.exit(1);
}

try {
  const base = `http://127.0.0.1:${port}`;

  // ---- 1. 无 token：HTTP 401 / WS upgrade 拒绝 ----
  const noAuth = await fetch(`${base}/api/permissions/rules`, { signal: AbortSignal.timeout(5000) });
  check("无 token HTTP 401", noAuth.status === 401, noAuth.status);
  const wsRejected = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => {
      resolve(false);
      ws.close();
    });
    ws.on("error", () => resolve(true));
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode === 401);
    });
  });
  check("无 token WS upgrade 被拒（401）", wsRejected);

  // ---- 2. 带 token：header 与 query 双通道 ----
  const viaHeader = await fetch(`${base}/api/permissions/rules`, {
    headers: { "x-awb-token": TOKEN },
    signal: AbortSignal.timeout(5000),
  });
  check("header 通道通过", viaHeader.status === 200, viaHeader.status);
  const viaQuery = await fetch(`${base}/api/permissions/rules?token=${TOKEN}`, { signal: AbortSignal.timeout(5000) });
  check("query 通道通过", viaQuery.status === 200, viaQuery.status);
  const wsOk = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    ws.on("open", () => {
      resolve(true);
      ws.close();
    });
    ws.on("error", () => resolve(false));
  });
  check("WS query token 通过", wsOk);
  const wrongToken = await fetch(`${base}/api/permissions/rules?token=wrong`, { signal: AbortSignal.timeout(5000) });
  check("错 token 401", wrongToken.status === 401, wrongToken.status);

  // ---- 3. /bootstrap：回环放行、跨源 Origin 拒（评审 P0 的偷 token 面） ----
  const boot = await fetch(`${base}/bootstrap`, { signal: AbortSignal.timeout(5000) });
  const bootBody = (await boot.json()) as { token?: string };
  check("回环 /bootstrap 放行且 token 正确", boot.status === 200 && bootBody.token === TOKEN, bootBody);
  const evil = await fetch(`${base}/bootstrap`, {
    headers: { origin: "https://evil.example" },
    signal: AbortSignal.timeout(5000),
  });
  check("跨源 Origin 的 /bootstrap 被拒", evil.status === 401 || evil.status === 403, evil.status);
  // CORS 头只对本地源回显：恶意源即使打到本地端点也读不到响应体
  const corsProbe = await fetch(`${base}/healthz`, { headers: { origin: "https://evil.example" } });
  const acao = corsProbe.headers.get("access-control-allow-origin");
  check("非本地源不回 CORS 头", acao === null, acao);
  const localCors = await fetch(`${base}/healthz`, { headers: { origin: "http://localhost:5180" } });
  check("本地源回显 CORS", localCors.headers.get("access-control-allow-origin") === "http://localhost:5180");

  // ---- 4. token 开启时 webhook 凭 per-bot secret 进入（豁免链完整） ----
  {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", () => rej(new Error("ws fail")));
    });
    const unit = {
      id: "u-bot-a",
      rootPath: botRoot,
      name: "Bot A",
      kind: "bot",
      bindings: [],
      tags: [],
      channels: [{ kind: "webhook", enabled: true, config: { secret: "s3cret" } }],
    };
    await new Promise<void>((resolve) => {
      ws.send(JSON.stringify({ v: 1, id: "c-1", method: "bot.put", params: { unit } }));
      ws.on("message", (d) => {
        const f = JSON.parse(String(d)) as { id?: unknown };
        if (f.id === "c-1") resolve();
      });
    });
    ws.close();
  }
  // 预置 allow 规则让 mockperm 轮次自动走完（headless 渠道口径，与 phase9/10 相同）
  await fetch(`${base}/api/permissions/rules`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-awb-token": TOKEN },
    body: JSON.stringify({ pattern: "mock_tool", decision: "allow" }),
  });
  const hook = await fetch(`${base}/webhook/bot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId: "u-bot-a", secret: "s3cret", text: "只回复一个字符：1" }),
    signal: AbortSignal.timeout(120_000),
  });
  const hookBody = (await hook.json()) as { reply?: string };
  check("token 开启时 webhook 凭 bot secret 仍可进入", hook.status === 200 && (hookBody.reply ?? "").includes("mock ok"), hookBody);
} finally {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
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

console.log(failures === 0 ? "smoke-phase11: all checks passed — token 鉴权面（401/双通道/bootstrap/CORS/webhook 豁免）成立" : `smoke-phase11: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
