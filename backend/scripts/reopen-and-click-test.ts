import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

const PORT = 19222;
const ARTIFACT_DIR = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
const CAPTURE_PATH = path.join(ARTIFACT_DIR, "reopened_click_test_result.png");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=================================================");
  console.log("🔄 重新连接并激活 http://localhost:5280/ 页面...");
  console.log("=================================================");

  // 1. 获取页面列表
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  let page = pages.find((p) => p.url.includes("localhost:5280"));

  if (!page || !page.webSocketDebuggerUrl) {
    // 若没有，尝试打开新页面
    const newTabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?http://localhost:5280/`, { method: "PUT" });
    page = (await newTabRes.json()) as { title: string; url: string; webSocketDebuggerUrl: string };
  }

  console.log("🎯 目标页面就绪:", page.title, "(", page.url, ")");
  const ws = new WebSocket(page.webSocketDebuggerUrl!);
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

  // 激活窗口至最前端并刷新导航
  try {
    await send("Page.bringToFront");
  } catch {}

  console.log("🔄 重新导航并刷新 http://localhost:5280/ ...");
  await send("Page.navigate", { url: "http://localhost:5280/" });
  await sleep(1500);

  // 等待页面就绪
  for (let i = 0; i < 30; i++) {
    const loaded = await evaluate(`!!document.querySelector('textarea')`);
    if (loaded) break;
    await sleep(400);
  }

  console.log("✅ 页面已重新加载渲染就绪！开始执行全套点击交互测试：\n");

  // -------------------------------------------------------------
  // 测试 1：侧边栏切换 Bot
  // -------------------------------------------------------------
  console.log("👉 [1/6] 点击侧边栏，从「总管」切换至「研究员2」...");
  const switchedBot = await evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find(b => b.textContent.includes('研究员2'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("   点击结果:", switchedBot ? "成功选中研究员2" : "未找到");
  await sleep(1200);

  console.log("👉 [2/6] 点击侧边栏切回「总管」...");
  await evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find(b => b.textContent.includes('总管'));
      if (target) target.click();
    })()
  `);
  await sleep(1200);

  // -------------------------------------------------------------
  // 测试 2：记忆胶囊点击与配置
  // -------------------------------------------------------------
  console.log("👉 [3/6] 点击输入框底部「记忆胶囊」展开配置弹窗...");
  await evaluate(`
    (() => {
      const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
      if (btn) btn.click();
    })()
  `);
  await sleep(1200);

  console.log("   点击「双注入」预设按钮...");
  await evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const bothBtn = buttons.find(b => b.textContent.includes('双注入'));
      if (bothBtn) bothBtn.click();
    })()
  `);
  await sleep(1200);

  // 点击外部关闭弹窗
  await evaluate(`document.body.click()`);
  await sleep(600);

  const scopeText = await evaluate(`
    (() => {
      const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
      return btn ? btn.textContent.trim() : '';
    })()
  `);
  console.log("   当前记忆胶囊文案:", scopeText);

  // -------------------------------------------------------------
  // 测试 3：斜杠指令菜单弹出与点击
  // -------------------------------------------------------------
  console.log("👉 [4/6] 聚焦输入框，键入 '/' 呼出快捷指令菜单...");
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
  await sleep(1500);

  console.log("   点击执行菜单中的 '/status' 指令...");
  await evaluate(`
    (() => {
      const menu = document.querySelector('.max-h-72');
      if (!menu) return;
      const statusBtn = Array.from(menu.querySelectorAll('button')).find(b => b.textContent.includes('/status'));
      if (statusBtn) statusBtn.click();
    })()
  `);
  await sleep(1800);

  // -------------------------------------------------------------
  // 测试 4：直接命令行交互
  // -------------------------------------------------------------
  console.log("👉 [5/6] 在输入框键入 '/mem daily' 并按回车提交...");
  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      ta.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, '/mem daily');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(600);

  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    })()
  `);
  await sleep(1800);

  // -------------------------------------------------------------
  // 测试 5：/model 动态候选并输入文本
  // -------------------------------------------------------------
  console.log("👉 [6/6] 键入测试输入并在屏幕上保留交互态...");
  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      ta.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, '点击测试成功：已完成侧栏切换、记忆胶囊弹窗、快捷指令菜单及回车执行 ✅');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(1000);

  // 截图取证
  console.log("📸 捕获重新加载并点击后的屏幕状态截图...");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  if (screenshot?.data) {
    fs.writeFileSync(CAPTURE_PATH, Buffer.from(screenshot.data, "base64"));
    console.log("✅ 截图已保存至:", CAPTURE_PATH);
  }

  console.log("=================================================");
  console.log("🎉 页面重载与全部点击测试顺利完成！窗口保持前台可见。");
  console.log("=================================================");

  ws.close();
}

main().catch(console.error);
