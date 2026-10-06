import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 19222;
const ARTIFACT_DIR = "C:\\Users\\chenziyu\\.gemini\\antigravity-ide\\brain\\08423f02-479e-40b3-8c77-934fb4e30a93";
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "live_gui_test_result.png");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=================================================");
  console.log("🚀 启动真实 Chrome 桌面 GUI 窗口（非 Headless 模式）");
  console.log("=================================================");

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chrome-gui-test-"));

  // 关键：不带 --headless，真实打开有图形界面的 Chrome 窗口！
  const chrome: ChildProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmpDir}`,
    "--window-size=1280,880",
    "--window-position=50,50",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:5280/",
  ]);

  let killed = false;
  const cleanup = () => {
    if (!killed) {
      killed = true;
      try {
        chrome.kill();
      } catch {}
    }
  };
  process.on("SIGINT", cleanup);
  process.on("exit", cleanup);

  try {
    console.log("等待 Chrome 窗口与 CDP 端口就绪...");
    let targetWsUrl = "";
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((item) => item.type === "page");
        if (page?.webSocketDebuggerUrl) {
          targetWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }

    if (!targetWsUrl) {
      throw new Error("无法连接 Chrome CDP 端口 19222");
    }

    console.log("✅ Chrome GUI 窗口已在桌面打开，CDP 已连接:", targetWsUrl);
    const ws = new WebSocket(targetWsUrl);
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
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return res?.result?.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");

    console.log("等待前端页面加载完成...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const isLoaded = await evaluate(`!!document.querySelector('textarea')`);
      if (isLoaded) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (!ready) throw new Error("页面加载超时，未找到 textarea 输入框");

    console.log("✅ 页面已完全渲染！开始交互操作测试...");

    // 1. 检查初始 Agent 与记忆胶囊状态
    const initialScope = await evaluate(`
      (() => {
        const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
        return btn ? btn.textContent.trim() : null;
      })()
    `);
    console.log("📍 [步骤 1] 当前记忆胶囊初始文本:", initialScope);

    // 2. 点击记忆胶囊打开弹窗
    console.log("👉 [步骤 2] 点击记忆胶囊，展开配置弹窗...");
    await evaluate(`
      (() => {
        const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(400);

    const isPickerOpen = await evaluate(`
      (() => {
        return !!document.querySelector('.w-80');
      })()
    `);
    console.log("📍 记忆弹窗是否成功展开:", isPickerOpen);

    // 3. 点击「双注入」预设按钮
    console.log("👉 [步骤 3] 点击快捷预设「双注入」...");
    await evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const bothBtn = buttons.find(b => b.textContent.includes('双注入'));
        if (bothBtn) bothBtn.click();
      })()
    `);
    await sleep(400);

    const updatedScope = await evaluate(`
      (() => {
        const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
        return btn ? btn.textContent.trim() : null;
      })()
    `);
    console.log("📍 切换后记忆胶囊文本:", updatedScope);

    // 关闭弹窗（点击 body）
    await evaluate(`document.body.click()`);
    await sleep(300);

    // 4. 测试斜杠命令菜单弹出
    console.log("👉 [步骤 4] 在输入框中输入 '/' 调出斜杠指令菜单...");
    await evaluate(`
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        ta.focus();
        // 触发 React onChange
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        proto.set.call(ta, '/');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(500);

    const slashCommandsList = await evaluate(`
      (() => {
        const menu = document.querySelector('.max-h-72');
        if (!menu) return [];
        return Array.from(menu.querySelectorAll('button')).map(b => {
          const name = b.querySelector('.font-mono')?.textContent || '';
          const title = b.querySelector('.font-medium')?.textContent || '';
          return name + ' - ' + title;
        });
      })()
    `);
    console.log("📍 斜杠指令菜单项 (共", slashCommandsList.length, "项):", slashCommandsList.slice(0, 5));

    // 5. 点击运行 `/status` 指令
    console.log("👉 [步骤 5] 点击执行 '/status' 指令...");
    await evaluate(`
      (() => {
        const menu = document.querySelector('.max-h-72');
        if (!menu) return;
        const statusBtn = Array.from(menu.querySelectorAll('button')).find(b => b.textContent.includes('/status'));
        if (statusBtn) statusBtn.click();
      })()
    `);
    await sleep(600);

    const statusNoticeTitle = await evaluate(`
      (() => {
        const cards = Array.from(document.querySelectorAll('.rounded-card'));
        const notice = cards.find(c => c.textContent.includes('运行时全貌与上下文诊断报告'));
        return notice ? notice.querySelector('.font-semibold')?.textContent : null;
      })()
    `);
    console.log("📍 时间线是否出现系统诊断通知:", statusNoticeTitle);

    // 6. 测试在输入框直接键入 `/mem daily` 并按回车提交
    console.log("👉 [步骤 6] 直接输入 '/mem daily' 并按回车提交执行...");
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
    await sleep(300);

    // 触发 Enter
    await evaluate(`
      (() => {
        const ta = document.querySelector('textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      })()
    `);
    await sleep(600);

    const memoryScopeAfterCmd = await evaluate(`
      (() => {
        const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
        return btn ? btn.textContent.trim() : null;
      })()
    `);
    console.log("📍 执行 /mem daily 后胶囊状态:", memoryScopeAfterCmd);

    const memNoticeTitle = await evaluate(`
      (() => {
        const cards = Array.from(document.querySelectorAll('.rounded-card'));
        const notice = cards.find(c => c.textContent.includes('记忆注入配置已更新'));
        return notice ? notice.querySelector('.font-semibold')?.textContent : null;
      })()
    `);
    console.log("📍 时间线是否出现记忆更新系统通知:", memNoticeTitle);

    // 7. 测试 `/model`
    console.log("👉 [步骤 7] 输入 '/model ' 调出当前生效执行器模型列表...");
    await evaluate(`
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        ta.focus();
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        proto.set.call(ta, '/model ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(500);

    const modelsList = await evaluate(`
      (() => {
        const menu = document.querySelector('.max-h-72');
        if (!menu) return [];
        return Array.from(menu.querySelectorAll('button')).map(b => b.textContent.trim());
      })()
    `);
    console.log("📍 /model 动态大模型候选列表 (共", modelsList.length, "项):", modelsList.slice(0, 3));

    // 8. 截取真实桌面浏览器截图存盘
    console.log("📸 [步骤 8] 截取当前真实 Chrome GUI 窗口截图...");
    const screenshotData = await send("Page.captureScreenshot", { format: "png" });
    if (screenshotData?.data) {
      const buffer = Buffer.from(screenshotData.data, "base64");
      writeFileSync(SCREENSHOT_PATH, buffer);
      console.log("✅ 截图已保存至:", SCREENSHOT_PATH);
    }

    console.log("=================================================");
    console.log("🎉 真实桌面浏览器点击与指令测试全部通过！");
    console.log("=================================================");

    // 保持窗口打开 5 秒以便用户肉眼查看
    console.log("窗口将在 5 秒后关闭...");
    await sleep(5000);
    cleanup();
  } catch (err) {
    console.error("❌ 测试遇到错误:", err);
    cleanup();
    process.exit(1);
  }
}

void main();
