import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": src },
  },
  // host: true = 绑全部网卡：Windows 上同时覆盖 ::1 与 0.0.0.0，
  // 本地工具与手机（http://<pc-ip>:5180）都可达（daemon 侧需 AGENT_WORKBENCH_HOST=0.0.0.0 配合）
  server: { host: true, port: 5180, strictPort: true },
});
