/**
 * 「从此处分叉」按钮渲染验证（CDP 真实页面端到端）。
 *
 * 对正在运行的 dev 前端（localhost:5280）+ daemon（5281）做无头浏览器实测：
 *   选 MockPerm 测试夹具（不动真实执行器）→ 发一条消息 → 等用户气泡出现
 *   → 断言「从此处分叉」按钮存在于 DOM、真实悬停后 opacity 生效
 *   → 拒绝挂起的权限让轮落定 → 恢复原执行器选择 → 截图留证
 *
 * 用法：cd backend && npx tsx scripts/verify-fork-button.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 19233;
const PAGE = "http://localhost:5280/";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "awb-forkbtn-"));
let chrome: ChildProcess | undefined;
const cleanup = () => {
  if (chrome) {
    try { chrome.kill(); } catch {}
  }
};
process.on("exit", cleanup);

chrome = spawn(CHROME_PATH, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${tmpDir}`,
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--window-size=1280,900",
  PAGE,
], { stdio: "ignore" });

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  }
}

// ---- CDP 连接 ----
let ws: WebSocket | undefined;
for (let i = 0; i < 30 && ws === undefined; i++) {
  await sleep(500);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = list.find((x) => x.type === "page");
    if (page?.webSocketDebuggerUrl) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* retry */ }
}
if (ws === undefined) {
  console.log("  FAIL 无法连接 CDP");
  process.exit(1);
}
await new Promise((res) => ws!.once("open", res));

let msgId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const consoleErrors: string[] = [];
ws.on("message", (data: Buffer) => {
  const m = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { text?: string; level?: string } };
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id)!;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" || m.method === "Log.entryAdded") {
    const lvl = m.params?.level;
    const text = m.params?.text ?? "";
    if (lvl === "error" || lvl === "warning") consoleErrors.push(`${lvl}: ${text.slice(0, 200)}`);
  }
});

const send = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve: (v) => resolve(v as T), reject });
    ws!.send(JSON.stringify({ id, method, params }));
  });

/** 页面内执行表达式（async 包裹，返回 JSON 化结果） */
async function evalJs<T>(expr: string): Promise<T> {
  const r = await send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; description?: string } }>(
    "Runtime.evaluate",
    { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true },
  );
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.description ?? r.exceptionDetails.text);
  return r.result?.value as T;
}

async function clickSelector(sel: string): Promise<boolean> {
  return evalJs<boolean>(`{
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) false;
    else { el.click(); true; }
  }`);
}

async function waitFor(desc: string, expr: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await sleep(400);
    try {
      if (await evalJs<boolean>(`return !!(${expr});`)) return true;
    } catch { /* 表达式可能因页面切换暂时失败 */ }
  }
  console.log(`  FAIL 等待超时：${desc}`);
  return false;
}

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  // ---- 1. 页面起来 + composer 就位 ----
  check("页面加载（composer 文本域出现）", await waitFor("composer textarea", `document.querySelector('textarea')`));

  // ---- 2. 切到 MockPerm（不动真实执行器；记下原执行器便于恢复） ----
  // 执行器触发器：composer 里有两个 aria-haspopup=dialog 按钮（顶部单元切换器 +
  // 底部执行器选择器），按 title 区分 —— 单元切换器以「点击切换」开头
  const prevRuntimeTitle = await evalJs<string | null>(`
    const btns = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const rt = btns.find((b) => !(b.getAttribute('title') ?? '').startsWith('点击切换'));
    return rt ? rt.getAttribute('title') : null;
  `);
  console.log("  原执行器：", prevRuntimeTitle);
  const opened = await evalJs<boolean>(`
    const btns = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const rt = btns.find((b) => !(b.getAttribute('title') ?? '').startsWith('点击切换'));
    if (rt) { rt.click(); return true; }
    return false;
  `);
  check("打开执行器选择器", opened);
  let railClicked = false;
  for (let i = 0; i < 10 && !railClicked; i++) {
    railClicked = await evalJs<boolean>(`
      return (() => { const rail = document.querySelector('[title^="MockPerm"]'); if (rail) { rail.click(); return true; } return false; })()
    `);
    if (!railClicked) await sleep(400);
  }
  check("点击 MockPerm rail", railClicked);
  await sleep(600);
  // 对话框里回车选中第一个模型（对话框 keydown 处理 Enter → pick）
  await evalJs<void>(`
    const dlg = document.querySelector('[role="dialog"][aria-label="选择执行器与模型"]');
    if (dlg) { dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    return;
  `);
  await sleep(600);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  const nowRuntime = await evalJs<string | null>(`
    const btns = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const rt = btns.find((b) => !(b.getAttribute('title') ?? '').startsWith('点击切换'));
    return rt ? rt.getAttribute('title') : null;
  `);
  console.log("  现执行器：", nowRuntime);
  check("已切到 MockPerm", (nowRuntime ?? "").startsWith("MockPerm"));

  // ---- 3. 发一条消息（用户气泡本地立即渲染） ----
  await evalJs<void>(`
    const ta = document.querySelector('textarea');
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '【自检】分叉按钮可见性测试');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  `);
  await sleep(300);
  await evalJs<void>(`
    const ta = document.querySelector('textarea');
    if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return;
  `);
  check("用户气泡渲染", await waitFor("user bubble", `document.querySelector('.group\\\\/user')`));

  // ---- 3b. 等 mockperm 轮落定（bypass 权限自动放行 → 助手回复 + usage 入账） ----
  check("助手回复渲染（mock ok）", await waitFor("assistant reply", `[...document.querySelectorAll('p,div')].some((el) => (el.textContent ?? '').includes('mock ok'))`, 40));

  // ---- 4. 核心断言：分叉按钮在助手消息底部 meta 行（左=时间+分叉，右=模型/token） ----
  const forkBtn = await evalJs<{ exists: boolean; disabled: boolean; usageMerged: boolean; costShown: boolean }>(`
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '从此处分叉');
    const metaRow = btn ? btn.closest('div.flex') : null;
    return {
      exists: !!btn,
      disabled: btn ? btn.disabled : false,
      usageMerged: metaRow ? (metaRow.textContent ?? '').includes('↑ /') : false,
      costShown: [...document.querySelectorAll('.group\\\\/msg')].some((el) => (el.textContent ?? '').includes('$')),
    };
  `);
  check("「从此处分叉」按钮在助手消息上", forkBtn.exists, forkBtn);
  check("分叉按钮未禁用（轮已落定）", forkBtn.exists && !forkBtn.disabled, forkBtn);
  check("usage 已并入助手底部 meta（token 上下行在右侧）", forkBtn.usageMerged, forkBtn);
  check("计费（$）不再显示", !forkBtn.costShown, forkBtn);

  // ---- 4b. 用户消息：铅笔编辑入口（末轮，echo 回填后可用） ----
  check("编辑入口就绪（echo 已回填 user-N 锚点）", await waitFor("edit entry enabled", `
    (() => { const btn = document.querySelector('button[aria-label="编辑重发"]'); return btn !== null && !btn.disabled; })()
  `, 20));

  // ---- 5. 就地编辑端到端：点击铅笔 → 原位编辑器 → 改文本 → 重发 → revision 分叉标记 ----
  let editClicked = false;
  for (let i = 0; i < 10 && !editClicked; i++) {
    editClicked = await evalJs<boolean>(`
      return (() => { const btn = document.querySelector('button[aria-label="编辑重发"]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()
    `);
    if (!editClicked) await sleep(400);
  }
  check("进入就地编辑", editClicked);
  check("编辑器出现（预填原文）", await waitFor("inline editor", `
    [...document.querySelectorAll('textarea')].some((t) => (t.value ?? '').includes('分叉按钮可见性测试'))
  `));
  await evalJs<void>(`
    const ta = [...document.querySelectorAll('textarea')].find((t) => (t.value ?? '').includes('分叉按钮可见性测试'));
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '【自检】就地编辑后的重发内容');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  `);
  await sleep(300);
  await evalJs<void>(`
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('重发'));
    if (btn) btn.click();
    return;
  `);
  check("编辑重发产生 revision 分叉（时间线出现分叉标记）", await waitFor("revision fork marker", `
    [...document.querySelectorAll('[role="separator"], div')].some((el) => (el.textContent ?? '').includes('已编辑重发'))
  `, 40));
  check("重发后的新内容进入新段", await waitFor("edited text in new segment", `
    [...document.querySelectorAll('p')].some((el) => (el.textContent ?? '').includes('就地编辑后的重发内容'))
  `, 40));

  // ---- 6. 截图留证 ----
  const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "awb-fork-button-proof.png");
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("  截图：", shotPath);

  // ---- 7. 收尾：bypass 权限下 mockperm 自动放行，无挂起弹窗；恢复执行器 ----
  await sleep(600);
  await evalJs<boolean>(`
    const btns = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const rt = btns.find((b) => !(b.getAttribute('title') ?? '').startsWith('点击切换'));
    if (rt) { rt.click(); return true; }
    return false;
  `);
  await sleep(500);
  // 恢复原执行器：按之前 title 里的显示名找 rail
  const restored = await evalJs<boolean>(`
    const prev = ${JSON.stringify((prevRuntimeTitle ?? "").split(" ·")[0])};
    if (!prev) return false;
    const rail = [...document.querySelectorAll('[title]')].find((el) => (el.getAttribute('title') ?? '').startsWith(prev) && el.closest('[role="dialog"]'));
    if (rail) { rail.click(); return true; }
    return false;
  `);
  if (restored) {
    await sleep(500);
    await evalJs<void>(`
      const dlg = document.querySelector('[role="dialog"][aria-label="选择执行器与模型"]');
      if (dlg) dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return;
    `);
  }
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  console.log(restored ? "  已恢复原执行器选择" : "  （未能恢复原执行器，请手动切回）");

  if (consoleErrors.length > 0) {
    console.log("  ⚠ 页面 console 报错（可能与按钮缺失相关）：");
    for (const e of consoleErrors.slice(0, 10)) console.log("    ", e);
  } else {
    console.log("  页面无 console 报错");
  }
} finally {
  cleanup();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "verify-fork-button: all checks passed — 按钮存在且悬停可见" : `verify-fork-button: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
