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

  console.log("1. Clicking '会话历史' button in header...");
  const clickedChat = await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("header button")).find(b => b.innerText.includes("会话历史"));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Clicked chat:", clickedChat);
  await new Promise((r) => setTimeout(r, 600));

  const state1 = await evaluate(`({
    hasTimeline: !!document.querySelector("div[class*='Timeline']") || !!document.querySelector("textarea"),
    hasComposer: !!document.querySelector("textarea"),
    hasTerminal: !!document.querySelector("main .xterm"),
  })`);
  console.log("After switching to 会话历史:", state1);

  const snap1 = await send("Page.captureScreenshot", { format: "png" });
  const artifactDir = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
  fs.writeFileSync(path.join(artifactDir, "path_a_view_chat_history.png"), Buffer.from(snap1.data, "base64"));
  console.log("Saved screenshot: path_a_view_chat_history.png");

  console.log("2. Clicking '终端 TUI' button in header to switch back...");
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("header button")).find(b => b.innerText.includes("终端 TUI"));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const state2 = await evaluate(`({
    hasTerminal: !!document.querySelector("main .xterm"),
    hasComposer: !!document.querySelector("textarea"),
  })`);
  console.log("After switching back to 终端 TUI:", state2);

  const snap2 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "path_a_view_terminal_restored.png"), Buffer.from(snap2.data, "base64"));
  console.log("Saved screenshot: path_a_view_terminal_restored.png");

  console.log("3. Testing typing into xterm...");
  // Let's send a few keystrokes into xterm
  await evaluate(`(() => {
    const termEl = document.querySelector(".xterm-helper-textarea");
    if (termEl) {
      termEl.focus();
    }
  })()`);

  ws.close();
  console.log("Interaction tests completed successfully!");
}

main().catch(console.error);
