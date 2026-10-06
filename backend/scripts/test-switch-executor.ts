import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const res = await fetch("http://127.0.0.1:19222/json/list");
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  const p = pages.find((x) => x.url.includes("localhost:5280"));
  if (!p?.webSocketDebuggerUrl) return;

  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 100000);
      ws.on("message", (data) => {
        const resp = JSON.parse(data.toString());
        if (resp.id === id) resolve(resp.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    return r?.result?.value;
  };

  console.log("1. Opening ExecutorSelector dropdown...");
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("header button")).find(b => b.title && b.title.includes("切换当前执行器"));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  console.log("2. Selecting Claude Code or Codex or PowerShell...");
  const clicked = await evaluate(`(() => {
    const opts = Array.from(document.querySelectorAll("div[class*='rounded-card'] button"));
    // 找 Claude Code
    const target = opts.find(b => b.innerText.includes("Claude") || b.innerText.includes("claude")) || opts[0];
    if (target) {
      target.click();
      return target.innerText;
    }
    return "none";
  })()`);
  console.log("Clicked option:", clicked);
  await new Promise((r) => setTimeout(r, 2000));

  const snap = await send("Page.captureScreenshot", { format: "png" });
  const artifactDir = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
  fs.writeFileSync(path.join(artifactDir, "path_a_switched_executor.png"), Buffer.from(snap.data, "base64"));
  console.log("Screenshot saved: path_a_switched_executor.png");

  const rows = await evaluate(`(() => {
    return Array.from(document.querySelectorAll(".xterm-rows > div")).map(d => d.innerText).filter(t => t.trim().length > 0);
  })()`);
  console.log("Rows after switch:", rows);

  ws.close();
}

main().catch(console.error);
