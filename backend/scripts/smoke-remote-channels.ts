/**
 * 冒烟测试：远控网络探测、凭证保险库与四大渠道网关生命周期。
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { CredentialVault } from "../src/credentials/vault.ts";
import { getNetworkInterfaces } from "../src/network.ts";

function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok   ${msg}`);
}

async function main(): Promise<void> {
  console.log("smoke-remote-channels: 开始测试");

  // 1. 测试网卡探测逻辑
  const interfaces = getNetworkInterfaces();
  ok(Array.isArray(interfaces) && interfaces.length > 0, "网卡探测返回非空列表");
  const hasLoopback = interfaces.some((i) => i.type === "loopback");
  ok(hasLoopback, "网卡列表中包含回环接口");

  // 2. 测试凭证保险库
  const tmpHome = process.env.TEMP || process.env.TMP || "/tmp";
  const vault = new CredentialVault(tmpHome);
  await vault.save("test-token", "sk-secret-123456", { botId: "bot-test" });
  const loaded = await vault.load("test-token");
  ok(loaded?.secret === "sk-secret-123456", "凭证保险库保存与读取成功");
  await vault.delete("test-token");
  const deleted = await vault.load("test-token");
  ok(deleted === null, "凭证保险库删除成功");

  // 3. 启动后台 Daemon 验证网关启动与 RPC 状态
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("freePort failed"));
      }
    });
    srv.on("error", reject);
  });

  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = {
    ...process.env,
    AGENT_WORKBENCH_PORT: String(port),
    AGENT_WORKBENCH_HOST: "127.0.0.1",
    AGENT_WORKBENCH_INSECURE: "1",
    AGENT_WORKBENCH_LOG_LEVEL: "error",
    AGENT_WORKBENCH_TELEGRAM_API: "http://127.0.0.1:9999",
  };

  const proc = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.on("error", (err) => {
    console.error("daemon process error:", err);
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  ok(healthy, "daemon 正常就绪并在健康检查中返回 200");
  console.log(`  daemon running at ${url}`);

  // 4. 测试 HTTP /api/network/interfaces 接口
  const netResp = await fetch(`${url}/api/network/interfaces`);
  ok(netResp.status === 200, "GET /api/network/interfaces 返回 200");
  const netJson = (await netResp.json()) as { ok: boolean; interfaces: unknown[] };
  ok(netJson.ok === true && Array.isArray(netJson.interfaces), "网卡接口返回结构正确");

  // 5. 测试 WS RPC channel.status 状态聚合
  const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve) => ws.once("open", resolve));

  const statusResult = await new Promise<Record<string, unknown>>((resolve) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: string; result?: Record<string, unknown> };
      if (msg.id === "call-1") {
        resolve(msg.result ?? {});
      }
    });
    ws.send(JSON.stringify({ v: 1, type: "call", id: "call-1", method: "channel.status", params: {} }));
  });

  const gateways = (statusResult.gateways ?? {}) as Record<string, unknown>;
  ok("feishu" in gateways, "channel.status 包含 feishu 网关状态");
  ok("telegram" in gateways, "channel.status 包含 telegram 网关状态");
  ok("weixin" in gateways, "channel.status 包含 weixin 网关状态");
  ok("discord" in gateways, "channel.status 包含 discord 网关状态");

  // 优雅停止
  await new Promise<void>((resolve) => {
    ws.send(JSON.stringify({ v: 1, type: "call", id: "call-stop", method: "daemon.stop", params: {} }));
    proc.on("exit", () => resolve());
  });

  ok(true, "daemon 正常退出");
  console.log("smoke-remote-channels: 全部检查通过");
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
