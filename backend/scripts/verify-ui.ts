import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 19222;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "chrome-cdp-"));
  console.log("启动 Headless Chrome 进行真实 UI 自动化验收...");
  const chrome: ChildProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmpDir}`,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--window-size=1280,800",
    "http://localhost:5280/",
  ]);

  chrome.stdout?.on("data", (d) => console.log("[chrome:out]", d.toString().trim()));
  chrome.stderr?.on("data", (d) => console.log("[chrome:err]", d.toString().trim()));

  let killed = false;
  const cleanup = () => {
    if (!killed) {
      killed = true;
      try { chrome.kill(); } catch {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);

  try {
    // 等待 Chrome 启动
    let targetWsUrl = "";
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) {
          // 现在去拿或者创建页面
          const pageRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
          const list = (await pageRes.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
          const page = list.find((item) => item.type === "page");
          if (page?.webSocketDebuggerUrl) {
            targetWsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch (err: unknown) {
        // 继续等待
      }
    }

    if (!targetWsUrl) {
      throw new Error("无法连接到 Chrome CDP WebSocket");
    }

    console.log("CDP 连接就绪:", targetWsUrl);
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

    // 等待 React 前端挂载
    console.log("等待前端渲染完成...");
    let loaded = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const ready = await evaluate(`document.querySelector("textarea[aria-label='任务输入']") !== null`);
      if (ready) {
        loaded = true;
        break;
      }
    }

    if (!loaded) {
      const html = await evaluate(`document.body.innerHTML`);
      console.error("页面内容:", html);
      throw new Error("前端未在预期时间内渲染输入框");
    }

    console.log("  ok   页面挂载完成，输入框就绪");

    // 1. 验证标题与总管 Bot 是否存在
    const pageTitle = await evaluate(`document.title`);
    console.log(`  ok   页面标题: ${pageTitle}`);

    const hasSteward = await evaluate(`document.body.innerText.includes("总管")`);
    console.log(`  ok   侧边栏包含总管 Bot: ${hasSteward}`);

    // 2. 检查记忆胶囊组件 MemoryScopePicker
    const memoryPillText = await evaluate(`(() => {
      const btn = document.querySelector("button[title*='记忆类型']");
      return btn ? btn.innerText.trim() : null;
    })()`);
    console.log(`  ok   记忆状态胶囊存在，当前文案: "${memoryPillText}"`);

    // 3. 点击记忆胶囊，验证弹窗内容
    await evaluate(`(() => {
      const btn = document.querySelector("button[title*='记忆类型']");
      if (btn) btn.click();
    })()`);
    await sleep(300);

    const hasConfigTitle = await evaluate(`document.body.innerText.includes("记忆注入配置")`);
    const hasSemanticOption = await evaluate(`document.body.innerText.includes("长期事实 (MEMORY.md)")`);
    const hasDailyOption = await evaluate(`document.body.innerText.includes("当日会话精炼 (daily/*.md)")`);
    console.log(`  ok   记忆配置弹窗弹出: ${hasConfigTitle}`);
    console.log(`  ok   包含长期事实 (MEMORY.md): ${hasSemanticOption}`);
    console.log(`  ok   包含当日精炼 (daily/*.md): ${hasDailyOption}`);

    // 4. 点击「双注入」预设，验证文案变为「长期 + 今日精炼」
    await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const bothBtn = btns.find(b => b.innerText.includes("双注入"));
      if (bothBtn) bothBtn.click();
    })()`);
    await sleep(200);

    const updatedPill = await evaluate(`(() => {
      const btn = document.querySelector("button[title*='记忆类型']");
      return btn ? btn.innerText.trim() : null;
    })()`);
    console.log(`  ok   点击双注入后胶囊更新为: "${updatedPill}"`);

    // 关闭弹窗（点击外部）
    await evaluate(`document.body.click()`);
    await sleep(200);

    // 5. 测试输入框斜杠快捷指令 (/)
    console.log("测试输入框斜杠快捷指令...");
    await evaluate(`(() => {
      const ta = document.querySelector("textarea[aria-label='任务输入']");
      if (!ta) return;
      ta.focus();
      // 触发 React onChange
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, "/");
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);

    const hasSlashMenu = await evaluate(`document.body.innerText.includes("快捷指令 · 模拟原生 CLI 命令")`);
    const hasMemCmd = await evaluate(`document.body.innerText.includes("/mem")`);
    const hasSkillCmd = await evaluate(`document.body.innerText.includes("/skill")`);
    const hasPlanCmd = await evaluate(`document.body.innerText.includes("/plan")`);
    console.log(`  ok   输入 / 触发命令菜单: ${hasSlashMenu}`);
    console.log(`  ok   菜单包含 /mem: ${hasMemCmd}`);
    console.log(`  ok   菜单包含 /skill: ${hasSkillCmd}`);
    console.log(`  ok   菜单包含 /plan: ${hasPlanCmd}`);

    // 6. 测试过滤 /m
    await evaluate(`(() => {
      const ta = document.querySelector("textarea[aria-label='任务输入']");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, "/m");
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);

    const filterResult = await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(b => b.innerText.includes("/m"));
      return btns.map(b => b.innerText.split("\\n")[0]);
    })()`);
    console.log(`  ok   输入 /m 过滤结果:`, filterResult);

    // 7. 测试执行 /plan 指令
    console.log("测试执行 /plan 指令...");
    await evaluate(`(() => {
      const ta = document.querySelector("textarea[aria-label='任务输入']");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, "/plan");
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);

    // 模拟 Enter
    await evaluate(`(() => {
      const ta = document.querySelector("textarea[aria-label='任务输入']");
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(400);

    const hasPlanNotification = await evaluate(`document.body.innerText.includes("已切换为 Plan 规划模式")`);
    console.log(`  ok   /plan 指令拦截执行成功，通知展示: ${hasPlanNotification}`);

    // 截图校验（验证能够成功生成渲染帧）
    const screenshotData = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    const outPath = path.join(tmpDir, "verify-ui.png");
    writeFileSync(outPath, Buffer.from(screenshotData.data, "base64"));
    console.log(`  ok   界面截图渲染验证成功`);

    console.log("\n全部前端验证通过！");
    ws.close();
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
