const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5280";

function pingServer() {
  return new Promise((resolve) => {
    const req = http.get(DEV_URL, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 轮询 vite 的节奏与总耐心。
 *
 * 为什么是 100ms 而不是 500ms：vite 冷启动实测约 500ms 就绪，而 500ms 的粒度
 * 意味着「刚好就绪」这一常见情形会被整整漏掉一轮，平均白等 250ms。这段等待是
 * 纯损耗 —— 界面此刻还没建，多等多久都是一样的黑屏。
 *
 * 总耐心仍保持 30s：vite 真起不来时，Electron 也不该比现在更早放弃 ——
 * 反正 main.cjs 里还有一层 did-fail-load 重试兜底，两层不冲突。
 */
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;

async function main() {
  console.log(`[electron:launcher] 等待 Web 前端 (${DEV_URL}) 就绪...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let ready = false;
  // 用 deadline 而不是次数计数：改粒度时上限自动跟着对，
  // 不会像「60 次 × 100ms = 6s」那样悄悄把耐心砍到五分之一。
  while (Date.now() < deadline) {
    if (await pingServer()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (ready) {
    console.log("[electron:launcher] 前端已就绪，正在启动 Electron 客户端...");
  } else {
    // 不静默：等超时了要说，main.cjs 会靠 did-fail-load 继续重试加载。
    console.warn(`[electron:launcher] 等待 ${POLL_TIMEOUT_MS / 1000}s 后前端仍未就绪，先启动 Electron（加载失败会自动重试）`);
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
