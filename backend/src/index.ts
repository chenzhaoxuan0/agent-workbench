/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { healthPayload, startHttp } from "./httpd.ts";
import { log, setLogLevel } from "./log.ts";
import { attachWs, registerMethod } from "./wsd.ts";

const startedAt = Date.now();
const config = loadConfig();
setLogLevel(config.logLevel);

mkdirSync(config.homeDir, { recursive: true });

const { server, port } = await startHttp(config, startedAt);
const wss = attachWs(server, { config, startedAt });

registerMethod("health", () => healthPayload(config, startedAt));

/**
 * 协议原生的关闭通道。Windows 上跨进程 SIGTERM 不可投递（冒烟脚本实证），
 * 程序化退出一律走这里；SIGINT/SIGTERM 处理器保留给终端 Ctrl+C 与 Unix。
 * 延迟退出是为了让响应帧先落 TCP。
 */
registerMethod("daemon.stop", () => {
  setTimeout(() => shutdown("rpc daemon.stop"), 30);
  return { stopping: true };
});

log.info("daemon listening", {
  http: `http://${config.host}:${port}`,
  ws: `ws://${config.host}:${port}/ws`,
  version: config.version,
  pid: process.pid,
  home: config.homeDir,
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  server.close();
  log.info("bye");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
