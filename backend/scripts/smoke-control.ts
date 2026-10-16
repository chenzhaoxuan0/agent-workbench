/**
 * 浏览器 / 电脑控制冒烟（docs/14）—— 全程注入临时 configHome/stateHome/skillsHome
 * 与假 Chrome 启动器 / fake 桌面运行时，绝不触碰真实执行器配置、不拉真浏览器、
 * 不动真实键鼠、不写用户家目录的技能。
 *
 * 覆盖面：
 * 【1】browserctl：隔离模式扇出（12 家 playwright 条目、per-executor profile 目录）
 *      → 停用回收（进停用库）→ 接管模式（假启动器）条目带 --cdp-endpoint；
 * 【2】computerctl：真 HTTP 端点上的 MCP 协议环（initialize 发会话头 / tools/list
 *      12 工具 / 总闸拒绝 / 截图 PNG / 坐标动作 / CONTROLLER_BUSY / 急停）；
 * 【3】dsh 注入形状（acpMcpServers：两能力启用时 stdio+http 两条，停用归零）；
 * 【4】技能只装不覆盖（第二次启用不重写用户可能改过的副本）。
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  acpMcpServers,
  registerAcpEntriesProvider,
  setControlContext,
  skillsHomeDir,
} from "../src/ctrl/store.ts";
import { createBrowserControlService } from "../src/browserctl/service.ts";
import { createComputerControl } from "../src/computerctl/server.ts";
import { createFakeRuntime } from "../src/computerctl/runtime.ts";
import type { SharedChromeHandle } from "../src/browserctl/chrome.ts";
import { mcpInventory } from "../src/mcpadmin/service.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const root = join(tmpdir(), `agent-workbench-smoke-control-${Date.now()}`);
const deps = { configHome: root, stateHome: join(root, "state") };
const skillsHome = join(root, "skills");
setControlContext(join(root, "awb-home"), 0, skillsHome);

/** 假 Chrome 启动器：返回收编型 handle（child=null，无进程副作用），端口固定 9390 */
const fakeLauncher = async (): Promise<SharedChromeHandle | { error: string }> => ({
  child: null,
  port: 9390,
  executable: "fake-chrome.exe",
  kind: "chrome",
});

async function main(): Promise<void> {
  const browser = createBrowserControlService(deps, { launcher: fakeLauncher });

  // ---- 【1】browserctl ---------------------------------------------------------

  console.log("\n【1a】隔离模式扇出");
  let st = await browser.setEnabled(true);
  check("启用后 12 家全成", st.config.enabled === true && st.fanout.length === 12 && st.fanout.every((o) => o.ok), st.fanout);
  const inv = mcpInventory(deps);
  const row = inv.rows.find((r) => r.name === "playwright");
  check("inventory 可见 playwright 条目 12 家", row?.instances.filter((i) => !i.disabled).length === 12);
  const claudeEntry = row?.instances.find((i) => i.executorId === "claude")?.entry;
  check("claude 条目带专属 user-data-dir", claudeEntry?.args?.some((a) => a.includes(join("browser-profiles", "claude"))) === true, claudeEntry);
  check("条目含 --browser msedge", claudeEntry?.args?.includes("msedge") === true);
  const codexEntry = row?.instances.find((i) => i.executorId === "codex")?.entry;
  check("codex profile 目录与 claude 不同（隔离不串）", codexEntry?.args?.join(" ") !== claudeEntry?.args?.join(" "));

  console.log("\n【1b】停用回收");
  st = await browser.setEnabled(false);
  const invAfter = mcpInventory(deps);
  const rowAfter = invAfter.rows.find((r) => r.name === "playwright");
  check("live 里没有 playwright 了", rowAfter?.instances.some((i) => !i.disabled) === false);
  check("停用库留档 12 家", rowAfter?.instances.filter((i) => i.disabled).length === 12);

  console.log("\n【1c】接管模式（假启动器，无真浏览器）");
  st = await browser.setMode("takeover");
  st = await browser.setEnabled(true);
  const takeoverRow = mcpInventory(deps).rows.find((r) => r.name === "playwright");
  const tEntry = takeoverRow?.instances.find((i) => i.executorId === "zcode" && !i.disabled)?.entry;
  check("接管条目带 --cdp-endpoint 9390", tEntry?.args?.includes("http://127.0.0.1:9390") === true, tEntry);
  check("接管条目无 user-data-dir（连接复用而非新 profile）", tEntry?.args?.some((a) => a.includes("user-data-dir")) === false);
  check("共享 Chrome 状态为运行中（收编型）", st.sharedChrome.running === true && st.sharedChrome.port === 9390, st.sharedChrome);

  // ---- 【2】computerctl（真 HTTP 端点 + fake runtime） --------------------------

  console.log("\n【2a】MCP 端点协议环（真实 http server，fake runtime）");
  const computer = createComputerControl(deps, { fakeRuntime: createFakeRuntime() });
  const server: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      void computer.handleHttp(req, res).catch(() => res.destroy());
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const mcpPort = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${mcpPort}/mcp/computer`;
  // 同步端口给扇出条目（模拟 index.ts 的 setControlContext 第二跳）
  setControlContext(join(root, "awb-home"), mcpPort, skillsHome);

  let sessionId = "";
  const post = async (body: unknown, withSession = true): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(withSession && sessionId !== "" ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : JSON.parse(text), headers: Object.fromEntries(res.headers) };
  };

  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, false);
  const initSession = init.headers["mcp-session-id"];
  check("initialize 200 且发下会话头", init.status === 200 && typeof initSession === "string" && initSession !== "", init.headers);
  check("initialize 回显协议版本", init.json?.result?.protocolVersion === "2025-06-18");
  sessionId = String(initSession ?? "");

  const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("通知回 202 无体", notif.status === 202 && notif.json === null);

  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools: { name: string }[] = listed.json?.result?.tools ?? [];
  check("tools/list 12 个工具", tools.length === 12, tools.map((t) => t.name));
  check("含 computer_screenshot 与 computer_stop", tools.some((t) => t.name === "computer_screenshot") && tools.some((t) => t.name === "computer_stop"));

  const denied = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_click", arguments: { x: 10, y: 10 } } });
  check("总闸关：输入动作被拒", denied.json?.result?.isError === true && String(denied.json?.result?.content?.[0]?.text).includes("未启用"));

  const shotDenied = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "computer_screenshot", arguments: {} } });
  check("总闸关：只读工具同样被拒（口径统一）", shotDenied.json?.result?.isError === true);

  let cst = await computer.setEnabled(true);
  check("启用：12 家 http 条目全成", cst.config.enabled === true && cst.fanout.length === 12 && cst.fanout.every((o) => o.ok), cst.fanout);
  const compRow = mcpInventory(deps).rows.find((r) => r.name === "workbench-computer");
  const compEntry = compRow?.instances.find((i) => i.executorId === "claude" && !i.disabled)?.entry;
  check("claude 的条目 url 指向本端点", compEntry?.url === endpoint, compEntry);

  const shot = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "computer_screenshot", arguments: {} } });
  const shotContent: { type: string; data?: string; text?: string }[] = shot.json?.result?.content ?? [];
  check("截图返回 image+text 两块", shotContent.length === 2 && shotContent[0]?.type === "image" && shotContent[1]?.type === "text", shotContent);
  check("image 是合法 PNG（magic 头）", String(shotContent[0]?.data).startsWith("iVBORw0KGgo"));

  const click = await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "computer_click", arguments: { x: 100, y: 200 } } });
  check("点击成功", click.json?.result?.isError !== true && click.json?.result?.content?.[0]?.text === "完成", click.json);

  const winlist = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "computer_window_list", arguments: {} } });
  check("窗口清单（fake 两条）", String(winlist.json?.result?.content?.[0]?.text).includes("Fake 记事本"));

  console.log("\n【2b】输入租约与急停");
  const prevSession = sessionId;
  sessionId = "smoke-other-session";
  const busy = await post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "computer_type", arguments: { text: "hi" } } });
  check("第二会话输入被拒 CONTROLLER_BUSY", busy.json?.result?.isError === true && String(busy.json?.result?.content?.[0]?.text).includes("CONTROLLER_BUSY"), busy.json?.result);
  const stop = await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "computer_stop", arguments: {} } });
  check("computer_stop 释放租约（不受总闸/身份限制）", stop.json?.result?.isError !== true);
  sessionId = prevSession;
  const afterStop = await post({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "computer_type", arguments: { text: "re-taken" } } });
  check("释放后可重新取租约", afterStop.json?.result?.isError !== true);
  cst = await computer.panic();
  check("panic：总闸关 + 租约空", cst.config.enabled === false && cst.lease.holder === null);
  const afterPanic = await post({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "computer_click", arguments: { x: 1, y: 1 } } });
  check("panic 后输入动作被拒", afterPanic.json?.result?.isError === true);
  check("动作日志已记录工具调用", computer.getState().actions.some((a) => a.action === "tool.computer_click"));

  console.log("\n【2c】端点双闸（评审 P0 回归）：跨源 Origin 403 / 非 JSON content-type 415");
  const evil = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list" }),
  });
  check("跨源 Origin 一律 403（浏览器 simple request 打不进来）", evil.status === 403);
  const plainText = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain" }, // 浏览器无需预检能发的形态
    body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "computer_click", arguments: { x: 1, y: 1 } } }),
  });
  check("text/plain 415（伪造 content-type 必须过预检，而预检只放行本地源）", plainText.status === 415);

  console.log("\n【2d】急停取消排队动作（代际）+ 失败弃权租约");
  await computer.setEnabled(true);
  // 慢速 fake：typeText 占住队列 80ms，click 排在其后
  const fastFake = createFakeRuntime();
  const slowFake = {
    ...fastFake,
    typeText: async (t: string) => {
      await new Promise((r) => setTimeout(r, 80));
      await fastFake.typeText(t);
    },
  };
  computer.setRuntime(slowFake);
  const p1 = post({ jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "computer_type", arguments: { text: "slow" } } });
  const p2 = post({ jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "computer_click", arguments: { x: 5, y: 5 } } });
  await new Promise((r) => setTimeout(r, 20)); // 让 p1 进队列执行中
  const stopRes = await post({ jsonrpc: "2.0", id: 94, method: "tools/call", params: { name: "computer_stop", arguments: {} } });
  const [r1, r2] = await Promise.all([p1, p2]);
  check("执行中的动作完成（原生调用不可中断，是已记录的边界）", r1.json?.result?.isError !== true);
  check("排队中的动作被急停作废", r2.json?.result?.isError === true && String(r2.json?.result?.content?.[0]?.text).includes("已急停"), r2.json?.result);
  check("急停回执明确说明边界", String(stopRes.json?.result?.content?.[0]?.text).includes("无法中断"));

  // 失败弃权：运行时抛错 → 租约当场释放，而不是锁满 120s
  const brokenFake = {
    ...createFakeRuntime(),
    click: async (): Promise<void> => {
      throw new Error("boom");
    },
  };
  computer.setRuntime(brokenFake);
  const failing = await post({ jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: "computer_click", arguments: { x: 1, y: 1 } } });
  check("运行时抛错如实上抛", failing.json?.result?.isError === true && String(failing.json?.result?.content?.[0]?.text).includes("boom"));
  check("失败即弃权：租约已释放", computer.getState().lease.holder === null, computer.getState().lease);
  computer.setRuntime(createFakeRuntime());

  console.log("\n【2e】boot 端口对齐（daemon 重启端口变 → 条目重写）");
  setControlContext(join(root, "awb-home"), mcpPort + 1, skillsHome); // 模拟重启后端口漂移
  await computer.boot();
  const drifted = mcpInventory(deps).rows.find((r) => r.name === "workbench-computer");
  const driftedEntry = drifted?.instances.find((i) => i.executorId === "claude" && !i.disabled)?.entry;
  check("boot 后条目 url 对齐新端口", driftedEntry?.url === `http://127.0.0.1:${mcpPort + 1}/mcp/computer`, driftedEntry);
  setControlContext(join(root, "awb-home"), mcpPort, skillsHome); // 还原，后续断言用
  await computer.setEnabled(false); // 清场：把条目收回停用库

  await new Promise<void>((r) => server.close(() => r()));

  // ---- 【3】dsh 注入形状 ---------------------------------------------------------

  console.log("\n【3】dsh 的 ACP mcpServers 动态注入");
  registerAcpEntriesProvider(() => [...browser.acpEntries(), ...computer.acpEntries()]);
  // 现态：浏览器启用（接管）+ 电脑 panic 关
  let injected = acpMcpServers();
  check("只剩浏览器的 stdio 条目", injected.length === 1 && injected[0]?.name === "playwright" && injected[0]?.command === "npx", injected);
  check("条目带 cdp 参数（ACP 形状）", injected[0]?.args?.includes("http://127.0.0.1:9390") === true);
  await computer.setEnabled(true);
  injected = acpMcpServers();
  check("电脑启用后多出 http 条目", injected.length === 2 && injected.some((e) => e.name === "workbench-computer" && e.type === "http" && e.url === endpoint), injected);
  await computer.setEnabled(false);
  await browser.setEnabled(false);
  check("全停后注入归零（dsh 会话不挂任何 MCP）", acpMcpServers().length === 0);

  // ---- 【4】技能只装不覆盖 --------------------------------------------------------

  console.log("\n【4】技能安装纪律");
  const skillPath = join(skillsHomeDir(), "browser-control", "SKILL.md");
  await browser.setEnabled(true);
  check("首次启用装入 browser-control 技能", existsSync(skillPath));
  writeFileSync(skillPath, readFileSync(skillPath, "utf8") + "\n<!-- 用户改动 -->\n", "utf8");
  await browser.setEnabled(false);
  await browser.setEnabled(true);
  check("二次启用不覆盖用户改动", readFileSync(skillPath, "utf8").includes("<!-- 用户改动 -->"));
  await browser.setEnabled(false);
}

main()
  .catch((e: unknown) => {
    failures++;
    console.error("UNEXPECTED:", e);
  })
  .finally(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 句柄残留不置败：临时目录系统自清 */
    }
    console.log(failures === 0 ? "\nsmoke-control: ALL GREEN" : `\nsmoke-control: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
