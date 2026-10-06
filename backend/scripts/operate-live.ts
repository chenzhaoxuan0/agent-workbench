import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

const PORT = 19222;
const ARTIFACT_DIR = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
const CAPTURE_PATH = path.join(ARTIFACT_DIR, "live_user_browser_operated.png");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=================================================");
  console.log("🎮 正在连接您当前屏幕上已打开的 Chrome 窗口...");
  console.log("=================================================");

  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  const targetPage = pages.find((p) => p.url.includes("localhost:5280"));

  if (!targetPage || !targetPage.webSocketDebuggerUrl) {
    throw new Error("未找到 localhost:5280 页面，当前页面列表: " + JSON.stringify(pages));
  }

  console.log("🎯 成功找到工作台页面:", targetPage.title, "(", targetPage.url, ")");
  const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once("open", resolve));

  let msgId = 1;
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = msgId++;
    return new Promise((resolve, reject) => {
      const handler = (data: Buffer) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.id === id) {
            ws.off("message", handler);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          }
        } catch {}
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");

  // 1. 将该 Tab 置于前台
  try {
    await send("Page.bringToFront");
  } catch {}

  console.log("✨ 已连接！请查看您屏幕上的 Chrome 窗口，正在执行操作：");

  // 2. 模拟点击记忆胶囊
  console.log("👉 [1/5] 点击底部工具栏中的「记忆胶囊」展开设置...");
  await evaluate(`
    (() => {
      const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
      if (btn) {
        btn.style.outline = '3px solid #00a896';
        btn.click();
      }
    })()
  `);
  await sleep(1500);

  // 3. 点击「双注入」预设
  console.log("👉 [2/5] 点击弹窗中的快捷预设「双注入」...");
  await evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const bothBtn = buttons.find(b => b.textContent.includes('双注入'));
      if (bothBtn) bothBtn.click();
    })()
  `);
  await sleep(1500);

  // 4. 点击外部关闭弹窗
  await evaluate(`
    (() => {
      const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
      if (btn) btn.style.outline = 'none';
      document.body.click();
    })()
  `);
  await sleep(800);

  // 5. 聚焦输入框并输入 '/' 触发斜杠指令
  console.log("👉 [3/5] 聚焦任务输入框，输入 '/' 调出快捷指令浮层...");
  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      ta.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, '/');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(1800);

  // 6. 执行 /status 指令
  console.log("👉 [4/5] 点击执行 '/status' 指令生成运行时全貌报告...");
  await evaluate(`
    (() => {
      const menu = document.querySelector('.max-h-72');
      if (!menu) return;
      const statusBtn = Array.from(menu.querySelectorAll('button')).find(b => b.textContent.includes('/status'));
      if (statusBtn) statusBtn.click();
    })()
  `);
  await sleep(1800);

  // 7. 输入问候语到输入框展示
  console.log("👉 [5/5] 在输入框中输入测试文本...");
  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      ta.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, '你好！浏览器已被 Antigravity AI 成功接管并完成实时控制测试 🎉');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(1000);

  // 8. 截取当前操作完毕后的画面
  console.log("📸 捕获当前浏览器实时画面...");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  if (screenshot?.data) {
    fs.writeFileSync(CAPTURE_PATH, Buffer.from(screenshot.data, "base64"));
    console.log("✅ 实时画面已保存至:", CAPTURE_PATH);
  }

  console.log("=================================================");
  console.log("🎉 浏览器实时操作成功完成！窗口已为您保留，您可以继续在其中输入或点击。");
  console.log("=================================================");

  ws.close();
}

void main();
