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

async function main() {
  console.log("[electron:launcher] 等待 Web 前端 (http://127.0.0.1:5280) 就绪...");
  let attempts = 0;
  while (attempts < 60) {
    const ready = await pingServer();
    if (ready) {
      console.log("[electron:launcher] 前端已就绪，正在启动 Electron 客户端...");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
    attempts++;
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
