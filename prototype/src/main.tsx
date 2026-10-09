import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
// 外观 store 在模块加载时就往 <html> 写 CSS 变量，必须先于 App 引入，
// 否则首屏会先用 styles.css 里硬编码的旧配色闪一帧。
import "./store/useAppearance.ts";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
