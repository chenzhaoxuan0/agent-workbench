import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 19222;
const PROFILE_DIR = path.join(os.tmpdir(), "chrome-workbench-profile");

console.log("启动常驻 Chrome 桌面 GUI 窗口（保留调试端口 19222）...");
console.log("Profile 目录:", PROFILE_DIR);

const chrome = spawn(CHROME_PATH, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--window-size=1280,880",
  "--window-position=60,60",
  "--no-first-run",
  "--no-default-browser-check",
  "http://localhost:5280/",
], {
  stdio: "inherit",
});

chrome.on("exit", (code, signal) => {
  console.log(`Chrome 进程已退出 code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  chrome.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  chrome.kill();
  process.exit(0);
});

// 保持 Node 进程存活
setInterval(() => {}, 10000);
