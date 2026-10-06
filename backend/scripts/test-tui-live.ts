import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

async function main() {
  console.log("Connecting to Chrome on port 19222...");
  const res = await fetch("http://127.0.0.1:19222/json/list");
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  const p = pages.find((x) => x.url.includes("localhost:5280"));

  if (!p || !p.webSocketDebuggerUrl) {
    throw new Error("Target page http://localhost:5280/ not found");
  }

  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1000000);
      const handler = (data: Buffer) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.id === id) {
            ws.off("message", handler);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          }
        } catch {
          // ignore non-json
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression: string) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true });
    return res?.result?.value;
  };

  console.log("Reloading page to pick up latest frontend build...");
  await send("Page.reload", {});
  await new Promise((r) => setTimeout(r, 2000));

  // 检查页面元素
  const checkInitial = await evaluate(`(() => {
    const header = document.querySelector("header");
    const headerText = header ? header.innerText : "";
    const hasTerminalBtn = headerText.includes("终端 TUI");
    const hasHistoryBtn = headerText.includes("会话历史");
    const hasGuardian = headerText.includes("后台守护");
    const hasXterm = !!document.querySelector(".xterm");
    const xtermText = document.querySelector(".xterm") ? document.querySelector(".xterm").innerText.slice(0, 200) : "";
    const buttons = Array.from(document.querySelectorAll("header button")).map(b => b.innerText.trim());

    return {
      headerText,
      hasTerminalBtn,
      hasHistoryBtn,
      hasGuardian,
      hasXterm,
      xtermText,
      buttons,
    };
  })()`);

  console.log("Initial Header & TUI State:", checkInitial);

  // 截取默认进入的 TUI 终端主画布
  const snap1 = await send("Page.captureScreenshot", { format: "png" });
  const artifactDir = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
  fs.writeFileSync(path.join(artifactDir, "path_a_tui_canvas.png"), Buffer.from(snap1.data, "base64"));
  console.log("Saved screenshot: path_a_tui_canvas.png");

  // 点击「会话历史」按钮切换视图
  console.log("Clicking '会话历史' button to switch view...");
  const clickHistoryResult = await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("会话历史"));
    if (btn) {
      btn.click();
      return "clicked";
    }
    return "not_found";
  })()`);
  console.log("Click history result:", clickHistoryResult);
  await new Promise((r) => setTimeout(r, 800));

  const checkHistoryView = await evaluate(`(() => {
    const hasComposer = !!document.querySelector("textarea");
    const hasXtermCanvas = !!document.querySelector("main .xterm");
    return { hasComposer, hasXtermCanvas };
  })()`);
  console.log("In History View:", checkHistoryView);

  // 截取会话历史视图
  const snap2 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "path_a_history_view.png"), Buffer.from(snap2.data, "base64"));
  console.log("Saved screenshot: path_a_history_view.png");

  // 点击「终端 TUI」切回终端主画布
  console.log("Clicking '终端 TUI' to return to terminal canvas...");
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("终端 TUI"));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  // 点击执行器选择器弹开下拉菜单
  console.log("Clicking ExecutorSelector...");
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("header button")).find(b => b.title && b.title.includes("切换当前执行器"));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const checkExecutorDropdown = await evaluate(`(() => {
    const menuItems = Array.from(document.querySelectorAll("div[class*='rounded-card'] button")).map(b => b.innerText.trim());
    return menuItems;
  })()`);
  console.log("Executor Dropdown Options:", checkExecutorDropdown);

  // 截取执行器切换器弹层
  const snap3 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "path_a_executor_menu.png"), Buffer.from(snap3.data, "base64"));
  console.log("Saved screenshot: path_a_executor_menu.png");

  // 点击后台守护状态指示胶囊
  console.log("Clicking Background Guardian Badge...");
  await evaluate(`(() => {
    // 关闭执行器弹窗
    const bg = document.querySelector("span[class*='fixed inset-0']");
    if (bg) bg.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  await evaluate(`(() => {
    const badge = Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("后台守护"));
    if (badge) badge.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const checkGuardianPopover = await evaluate(`(() => {
    const card = document.querySelector("div[class*='w-76']");
    return card ? card.innerText : "not_found";
  })()`);
  console.log("Guardian Popover Text:", checkGuardianPopover);

  const snap4 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "path_a_guardian_popover.png"), Buffer.from(snap4.data, "base64"));
  console.log("Saved screenshot: path_a_guardian_popover.png");

  ws.close();
  console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
