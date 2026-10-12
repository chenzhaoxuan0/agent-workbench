/**
 * 待办 UI 视觉验证：无头 Chrome + CDP。
 *   打开 http://127.0.0.1:5280 → 截主视图（总状态点）
 *   → 点侧栏「待办」→ 截清单页 → 收集页面 console error。
 * 截图写到 backend/.tmp/backlog-ui-*.png，供人工过目。
 * 用法：cd backend && npx tsx scripts/verify-backlog-ui.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 19233;
const APP_URL = "http://127.0.0.1:5280/";
const OUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), ".tmp");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>>;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome: ChildProcess = spawn(CHROME_PATH, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=" + path.join(OUT_DIR, "chrome-profile"),
    "--window-size=1280,880",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });
  console.log(`verify-ui: chrome pid=${chrome.pid}`);

  try {
    // 找 page target
    let pageWsUrl = "";
    for (let i = 0; i < 30 && pageWsUrl === ""; i++) {
      await sleep(500);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((t) => t.type === "page");
        if (page !== undefined) pageWsUrl = page.webSocketDebuggerUrl;
      } catch {
        /* chrome 还没就绪 */
      }
    }
    if (pageWsUrl === "") throw new Error("chrome CDP 未就绪");
    console.log("verify-ui: cdp ready");

    const errors: string[] = [];
    const ws = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("cdp ws failed")));
    });
    let seq = 0;
    const pendingCdp = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const eventWaiters: Array<{ method: string; resolve: (r: Record<string, unknown>) => void }> = [];
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined && pendingCdp.has(msg.id)) {
        const p = pendingCdp.get(msg.id)!;
        pendingCdp.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method !== undefined) {
        // console.error 收集（exception + console API error）
        if (msg.method === "Runtime.exceptionThrown") {
          errors.push(`exception: ${JSON.stringify((msg.params?.["exceptionDetails"] as Record<string, unknown>)?.exception ?? msg.params).slice(0, 300)}`);
        }
        if (msg.method === "Runtime.consoleAPICalled" && msg.params?.["type"] === "error") {
          errors.push(`console.error: ${JSON.stringify(msg.params?.["args"]).slice(0, 300)}`);
        }
        const i = eventWaiters.findIndex((w) => w.method === msg.method);
        if (i >= 0) {
          const w = eventWaiters[i]!;
          eventWaiters.splice(i, 1);
          w.resolve(msg.params ?? {});
        }
      }
    });
    const cdp: Cdp = {
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pendingCdp.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        }),
      waitEvent: (method, timeoutMs) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`event ${method} timeout`)), timeoutMs);
          eventWaiters.push({ method, resolve: (r) => { clearTimeout(timer); resolve(r); } });
        }),
    };

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: APP_URL });
    await cdp.waitEvent("Page.loadEventFired", 20000);
    await sleep(4000); // 等 app 启动、daemon 拉取、bot 合并

    const shot = async (name: string): Promise<void> => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      const file = path.join(OUT_DIR, name);
      writeFileSync(file, Buffer.from(String(r["data"]), "base64"));
      console.log(`verify-ui: screenshot → ${file}`);
    };

    await shot("backlog-ui-main.png");

    // 状态点在 chat 主视图的 header（待办页没有 WorkspaceHeader）——在主视图断言
    const dotProbe = await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector('header button[aria-label^="工作状态"]')`,
      returnByValue: true,
    });
    console.log("verify-ui: 主视图状态点 =", (dotProbe["result"] as { value?: boolean })?.value);

    // 点侧栏「待办」入口
    const click = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const b = document.querySelector('button[aria-label="待办"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED'; })()`,
      returnByValue: true,
    });
    console.log("verify-ui: 待办 click =", (click["result"] as { value?: string })?.value);
    await sleep(2500);
    await shot("backlog-ui-page.png");

    // 清单页关键元素断言（不依赖像素）
    const probe = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({
        heading: document.querySelector('main[aria-label="待办"] h1')?.textContent ?? null,
        createBtn: !!document.querySelector('main[aria-label="待办"] button'),
        filterChips: [...document.querySelectorAll('main[aria-label="待办"] button')].some(b => b.textContent === '就绪'),
        stateDotInChatHeader: ${"true"},
      }))()`,
      returnByValue: true,
    });
    console.log("verify-ui: page probe =", JSON.stringify((probe["result"] as { value: unknown }).value));
    const v = (probe["result"] as { value: Record<string, unknown> }).value;
    const okProbe =
      v !== null && v["createBtn"] === true && v["filterChips"] === true &&
      (dotProbe["result"] as { value?: boolean })?.value === true;
    console.log(okProbe ? "verify-ui: page probe OK" : "verify-ui: page probe FAILED");

    ws.close();
    console.log(`verify-ui: console errors = ${errors.length}`);
    for (const e of errors.slice(0, 8)) console.log(`  err | ${e}`);
    const pass = okProbe && errors.length === 0;
    console.log(pass ? "verify-ui: ALL OK" : "verify-ui: HAS FAILURES");
    process.exitCode = pass ? 0 : 1;
  } finally {
    chrome.kill();
  }
}

await main().catch((err: unknown) => {
  console.error("verify-ui: crashed", err);
  process.exit(1);
});
