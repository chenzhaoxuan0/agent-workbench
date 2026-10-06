import { spawn, execSync, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 19222;
const PROFILE_DIR = "C:\\Users\\chenziyu\\.gemini\\antigravity-browser-profile";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureChromeWithCdp() {
  // 1. 尝试直接连接 19222 端口
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (res.ok) {
      console.log("✅ 发现已有 Chrome 实例已在 19222 端口监听！直接复用连接。");
      return;
    }
  } catch {}

  console.log("🔄 正在为用户 Profile 启动支持 CDP 交互的 Chrome 窗口 (端口 19222)...");

  // 关闭无法绑定端口的旧 chrome 进程（释放 profile 锁）
  try {
    execSync(`taskkill /F /IM chrome.exe`, { stdio: "ignore" });
    await sleep(800);
  } catch {}

  // 用用户的 profile 启动 Chrome，挂载非受阻端口 19222
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:5280/",
  ], {
    detached: true,
    stdio: "ignore",
  }).unref();

  // 等待 Chrome 启动并就绪
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        console.log("✅ Chrome 桌面窗口已启动并在 19222 端口就绪！");
        return;
      }
    } catch {}
  }
  throw new Error("启动 Chrome 并绑定端口 19222 超时");
}

async function main() {
  await ensureChromeWithCdp();

  // 获取页面列表
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const pages = (await res.json()) as Array<{ title: string; url: string; webSocketDebuggerUrl?: string }>;
  console.log("📑 检测到浏览器中打开的页面列表:", pages.map((p) => ({ title: p.title, url: p.url })));

  let page = pages.find((p) => p.url.includes("localhost:5280"));
  if (!page || !page.webSocketDebuggerUrl) {
    // 如果没有 5280 页面，拿第一个页面导航到 5280
    page = pages[0];
  }

  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error("未找到可操作的浏览器页面");
  }

  console.log("🎯 正在接入页面:", page.title, "(", page.url, ")");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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

  // 把窗口激活到前台
  try {
    await send("Page.bringToFront");
  } catch {}

  // 如果页面不是 5280，导航到 5280
  if (!page.url.includes("localhost:5280")) {
    console.log("正在导航至 http://localhost:5280/ ...");
    await send("Page.navigate", { url: "http://localhost:5280/" });
    await sleep(2000);
  }

  // 等待 React 渲染
  console.log("等待工作台渲染就绪...");
  for (let i = 0; i < 30; i++) {
    const loaded = await evaluate(`!!document.querySelector('textarea')`);
    if (loaded) break;
    await sleep(500);
  }

  console.log("✨ 浏览器页面连接成功！开始在您眼前的 Chrome 中执行实时点击操作：");

  // 1. 点击记忆胶囊
  console.log("👉 [1/6] 正在点击输入框下方的「记忆胶囊」展开配置弹窗...");
  await evaluate(`
    (() => {
      const btn = document.querySelector('button[title*="选择本轮对话要注入的记忆类型"]');
      if (btn) btn.click();
    })()
  `);
  await sleep(1500);

  // 2. 点击「双注入」预设
  console.log("👉 [2/6] 正在点击弹窗中的「双注入」快捷预设...");
  await evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const bothBtn = buttons.find(b => b.textContent.includes('双注入'));
      if (bothBtn) bothBtn.click();
    })()
  `);
  await sleep(1500);

  // 3. 点击外部关闭弹窗
  await evaluate(`document.body.click()`);
  await sleep(800);

  // 4. 在输入框输入 / 调出斜杠指令菜单
  console.log("👉 [3/6] 正在聚焦输入框并输入 '/' 唤起快捷指令菜单...");
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
  await sleep(2000);

  // 5. 点击 /status 执行
  console.log("👉 [4/6] 正在点击执行 '/status' 指令...");
  await evaluate(`
    (() => {
      const menu = document.querySelector('.max-h-72');
      if (!menu) return;
      const statusBtn = Array.from(menu.querySelectorAll('button')).find(b => b.textContent.includes('/status'));
      if (statusBtn) statusBtn.click();
    })()
  `);
  await sleep(2000);

  // 6. 输入 /mem daily 并回车执行
  console.log("👉 [5/6] 正在输入 '/mem daily' 并按回车提交执行...");
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
  await sleep(800);

  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    })()
  `);
  await sleep(2000);

  // 7. 输入 /model 查看大模型推荐
  console.log("👉 [6/6] 正在输入 '/model ' 展开当前生效大模型候选清单...");
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
  await sleep(1500);

  console.log("=================================================");
  console.log("🎉 浏览器实时操作顺利完成！");
  console.log("注意：浏览器窗口已保持打开，您可以直接在当前屏幕上查看所有操作产生的结果。");
  console.log("=================================================");

  // 关闭 ws 连接即可，不 kill 浏览器进程，让用户继续查看和操作
  ws.close();
}

void main();
