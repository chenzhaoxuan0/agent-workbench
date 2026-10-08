import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./store/useTheme.ts";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
