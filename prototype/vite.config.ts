import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig(({ mode }) => {
  // 端口可配，默认 5280。**旧的 5180 在本机不可绑定** —— Windows 的 Hyper-V / WSL
  // 保留了 5141–5240 一整段动态端口，旧默认 5180 与 daemon 旧默认 5181 都落在里面，
  // 且 strictPort: true 时 vite 会直接报错退出。daemon 侧的默认端口见
  // backend/src/config.ts 的 DEFAULT_DAEMON_PORT（5281），两边必须能一起改。
  const env = loadEnv(mode, process.cwd(), "");
  const uiPort = Number(env["VITE_UI_PORT"] ?? "5280");

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": src },
    },
    // host: true = 绑全部网卡：Windows 上同时覆盖 ::1 与 0.0.0.0，
    // 本地工具与手机（http://<pc-ip>:<uiPort>）都可达
    // 配置 proxy 将 /ws, /bootstrap, /api 转发至 daemon 5281，避免手机端防火墙/跨端口访问失败
    server: {
      host: true,
      port: uiPort,
      strictPort: true,
      proxy: {
        "/ws": {
          target: "ws://127.0.0.1:5281",
          ws: true,
          changeOrigin: true,
        },
        "/bootstrap": {
          target: "http://127.0.0.1:5281",
          changeOrigin: true,
        },
        "/api": {
          target: "http://127.0.0.1:5281",
          changeOrigin: true,
        },
        "/healthz": {
          target: "http://127.0.0.1:5281",
          changeOrigin: true,
        },
      },
    },
  };
});
