import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig(({ mode }) => {
  // 端口可配。默认 5180 在**本机**不可绑定 —— Windows 的 Hyper-V / WSL 保留了
  // 5141–5240 一整段动态端口，5180 与 5181（daemon 默认）都落在里面，
  // 且 strictPort: true 时 vite 会直接报错退出。
  const env = loadEnv(mode, process.cwd(), "");
  const uiPort = Number(env["VITE_UI_PORT"] ?? "5280");

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": src },
    },
    // host: true = 绑全部网卡：Windows 上同时覆盖 ::1 与 0.0.0.0，
    // 本地工具与手机（http://<pc-ip>:<uiPort>）都可达（daemon 侧需 AGENT_WORKBENCH_HOST=0.0.0.0 配合）
    server: { host: true, port: uiPort, strictPort: true },
  };
});
