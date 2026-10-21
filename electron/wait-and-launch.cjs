const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5280";
const DAEMON_PORT = process.env.AGENT_WORKBENCH_PORT || "5281";
const DAEMON_HEALTH_URL = `http://127.0.0.1:${DAEMON_PORT}/healthz`;

function pingUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pingWeb() {
  return pingUrl(DEV_URL);
}

function pingDaemon() {
  return pingUrl(DAEMON_HEALTH_URL);
}

/**
 * 轮询 vite 与 daemon 的节奏与总耐心。
 */
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;

async function main() {
  console.log(`[electron:launcher] 等待全栈服务就绪 (Web: ${DEV_URL}, Daemon: ${DAEMON_HEALTH_URL})...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let webReady = false;
  let daemonReady = false;

  while (Date.now() < deadline) {
    if (!webReady) webReady = await pingWeb();
    if (!daemonReady) daemonReady = await pingDaemon();
    if (webReady && daemonReady) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (webReady && daemonReady) {
    console.log("[electron:launcher] 前端与 Daemon 守护进程均已就绪，正在启动 Electron 客户端...");
  } else {
    console.warn(`[electron:launcher] 等待超时 (Web: ${webReady ? "就绪" : "未就绪"}, Daemon: ${daemonReady ? "就绪" : "未就绪"})，先启动 Electron...`);
  }

  const electronBin = process.platform === "win32"
    ? path.join(__dirname, "../node_modules/electron/dist/electron.exe")
    : path.join(__dirname, "../node_modules/.bin/electron");

  const child = spawn(electronBin, ["."], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
