import { WebSocket } from "ws";

async function main() {
  const res = await fetch("http://127.0.0.1:19222/json/list");
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  console.log("Pages:", pages.map(p => ({ title: p.title, url: p.url })));

  const p = pages.find(x => x.url.includes("localhost:5280"));
  if (!p || !p.webSocketDebuggerUrl) {
    console.log("No 5280 page found!");
    return;
  }

  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.once("open", r));

  const send = (method: string, params: Record<string, unknown> = {}) => {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 100000);
      const handler = (data: Buffer) => {
        const resp = JSON.parse(data.toString());
        if (resp.id === id) {
          ws.off("message", handler);
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp.result);
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const state: any = await send("Runtime.evaluate", {
    expression: "({ url: location.href, title: document.title, htmlLen: document.body ? document.body.innerHTML.length : 0, hasTextarea: !!document.querySelector('textarea'), visibleText: document.body ? document.body.innerText.slice(0, 150) : '' })",
    returnByValue: true,
  });

  console.log("State:", state?.result?.value);
  ws.close();
}

main().catch(console.error);
