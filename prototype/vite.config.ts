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
  // 显式绑 IPv4：Vite 在 Windows 上默认只绑 ::1，本地浏览器工具够不着
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
});
