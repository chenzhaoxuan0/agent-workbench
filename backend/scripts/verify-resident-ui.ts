/**
 * 侧栏常驻分区 + 拖拽升降级验证（无头 Chrome + CDP）：
 *   常驻节存在且含总管/心跳 → 分割线存在
 *   → 合成 DragEvent 把一个普通 bot 拖入常驻节 → 断言移入 + 刷新后仍在（真落盘）
 *   → 拖回普通区 → 断言移出 + 刷新后仍在普通区
 * 用法：cd backend && npx tsx scripts/verify-resident-ui.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 19234;
const APP_URL = "http://127.0.0.1:5280/";
const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), ".tmp");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome: ChildProcess = spawn(CHROME_PATH, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(OUT_DIR, "chrome-profile2")}`,
    "--window-size=1280,880",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    let pageWsUrl = "";
    for (let i = 0; i < 30 && pageWsUrl === ""; i++) {
      await sleep(500);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((t) => t.type === "page");
        if (page !== undefined) pageWsUrl = page.webSocketDebuggerUrl;
      } catch { /* chrome 未就绪 */ }
    }
    if (pageWsUrl === "") throw new Error("chrome CDP 未就绪");

    const ws = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", () => reject(new Error("cdp ws failed")));
    });
    let seq = 0;
    const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const eventWaiters: Array<{ method: string; resolve: (r: Record<string, unknown>) => void }> = [];
    ws.on("message", (data: unknown) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method !== undefined) {
        const i = eventWaiters.findIndex((w) => w.method === msg.method);
        if (i >= 0) {
          const w = eventWaiters[i]!;
          eventWaiters.splice(i, 1);
          w.resolve(msg.params ?? {});
        }
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const waitEvent = (method: string, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`event ${method} timeout`)), timeoutMs);
        eventWaiters.push({ method, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      });
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return (r["result"] as { value?: unknown })?.value;
    };

    await send("Page.enable");
    await send("Page.navigate", { url: APP_URL });
    await waitEvent("Page.loadEventFired", 20000);
    await sleep(4500); // app 启动 + bot 合并

    // DOM 探针：分区结构与成员
    interface ProbeShape {
      residentSection: boolean;
      normalSection: boolean;
      divider: boolean;
      residentNames: string[];
      normalNames: string[];
    }
    const probeExpr = `(() => {
      const secRes = document.querySelector('section[aria-label="常驻 Agent"]');
      const secNorm = document.querySelector('section[aria-label="Agent 列表"]');
      const names = (sec) => [...(sec ?? { querySelectorAll: () => [] }).querySelectorAll('button')].map(b => b.textContent?.trim().split(/\\s/)[0]).filter(Boolean);
      const divider = !!document.querySelector('section[aria-label="常驻 Agent"] ~ div.my-2, section[aria-label="Agent 列表"]') && !!document.querySelector('div.my-2 > span.h-px');
      return { residentSection: !!secRes, normalSection: !!secNorm, divider, residentNames: names(secRes), normalNames: names(secNorm) };
    })()`;
    const p1 = (await evaluate(probeExpr)) as ProbeShape;
    console.log("  probe |", JSON.stringify(p1));
    check("常驻节与普通节存在", p1.residentSection && p1.normalSection, p1);
    check("分割线存在", p1.divider, p1);
    check("总管/心跳在常驻节", p1.residentNames.some((n) => n.includes("总管")) && p1.residentNames.some((n) => n.includes("心跳")), p1.residentNames);

    // 拖拽升降级：挑普通节第一个 bot
    const dragExpr = `(async () => {
      const secRes = document.querySelector('section[aria-label="常驻 Agent"]');
      const secNorm = document.querySelector('section[aria-label="Agent 列表"]');
      const row = secNorm?.querySelector('[draggable="true"]');
      if (!secRes || !secNorm || !row) return 'MISSING_TARGET';
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true }));
      fire(row, 'dragstart');
      // 让 React 把 dragUnit 渲染进新闭包 —— 同步连发 drop 时旧闭包里 dragUnit 还是 null
      await new Promise(r => setTimeout(r, 400));
      fire(secRes, 'dragover');
      fire(secRes, 'drop');
      fire(document, 'dragend');
      await new Promise(r => setTimeout(r, 2500)); // 等 updateUnit 写穿 + store 刷新
      const name = row.textContent?.trim().split(/\\s/)[0] ?? '?';
      const inResident = [...secRes.querySelectorAll('button')].some(b => (b.textContent ?? '').includes(name));
      return { name, inResident };
    })()`;
    const d1 = (await evaluate(dragExpr)) as { name: string; inResident: boolean } | string;
    console.log("  drag→常驻 |", JSON.stringify(d1));
    check("普通 bot 拖入常驻节成功", typeof d1 === "object" && d1.inResident, d1);

    // 刷新重载：真落盘验证（乐观更新不算数，重拉 bot.list 后仍在常驻节才成立）
    await send("Page.navigate", { url: APP_URL });
    await waitEvent("Page.loadEventFired", 20000);
    await sleep(4500);
    const p2 = (await evaluate(probeExpr)) as ProbeShape;
    check("刷新后仍在常驻节（bot.json 落盘）", typeof d1 === "object" && p2.residentNames.some((n) => n.includes(d1.name)), p2.residentNames);

    // 拖回普通区：降级
    const backExpr = `(async () => {
      const secRes = document.querySelector('section[aria-label="常驻 Agent"]');
      const secNorm = document.querySelector('section[aria-label="Agent 列表"]');
      const name = ${typeof d1 === "object" ? JSON.stringify(d1.name) : '""'};
      const row = [...(secRes?.querySelectorAll('[draggable="true"]') ?? [])].find(r => (r.textContent ?? "").includes(name) && !r.textContent.includes("总管") && !r.textContent.includes("心跳"));
      if (!secRes || !secNorm || !row) return 'MISSING_TARGET';
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true }));
      fire(row, 'dragstart');
      await new Promise(r => setTimeout(r, 400)); // 同上：给 React 留渲染间隙
      fire(secNorm, 'dragover');
      fire(secNorm, 'drop');
      fire(document, 'dragend');
      await new Promise(r => setTimeout(r, 2500));
      const stillResident = [...secRes.querySelectorAll('button')].some(b => (b.textContent ?? '').includes(name));
      return { name, stillResident };
    })()`;
    const d2 = (await evaluate(backExpr)) as { name: string; stillResident: boolean } | string;
    console.log("  drag→普通 |", JSON.stringify(d2));
    check("拖回普通区取消常驻", typeof d2 === "object" && !d2.stillResident, d2);

    // 截图存档
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(OUT_DIR, "resident-ui.png"), Buffer.from(String(shot["data"]), "base64"));
    console.log(`verify-resident: screenshot → ${path.join(OUT_DIR, "resident-ui.png")}`);

    ws.close();
    if (failures > 0) {
      console.error(`verify-resident: ${failures} check(s) FAILED`);
      process.exitCode = 1;
    } else console.log("verify-resident: all checks passed");
  } finally {
    chrome.kill();
  }
}

await main().catch((err: unknown) => {
  console.error("verify-resident: crashed", err);
  process.exit(1);
});
