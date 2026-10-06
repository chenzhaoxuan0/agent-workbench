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

  const evalResult = await send("Runtime.evaluate", {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll(".xterm-rows > div")).map(d => d.innerText).filter(t => t.trim().length > 0);
      return {
        count: rows.length,
        rows,
      };
    })()`,
    returnByValue: true,
  });

  console.log("Current XTerm Output:", evalResult?.result?.value);

  const snap = await send("Page.captureScreenshot", { format: "png" });
  const artifactDir = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
  fs.writeFileSync(path.join(artifactDir, "path_a_tui_now.png"), Buffer.from(snap.data, "base64"));
  console.log("Screenshot saved: path_a_tui_now.png");

  ws.close();
}

main().catch(console.error);
