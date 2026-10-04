/**
 * WP-3/4/5/6/7/9 的 RPC 面验收 —— 确认方法真的注册上了、daemon 起得来。
 *
 * 这是 index.ts 那一大坨 registerMethod 的唯一防线。冒烟从这里起 daemon，
 * 逐个调新方法：有的要真的答，有的要求被权限挡住（那是设计，不是故障）。
 *
 * 用法：cd backend && pnpm smoke:memory6
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (a !== null && typeof a === "object") {
        srv.close(() => resolve(a.port));
      } else reject(new Error("no free port"));
    });
    srv.on("error", reject);
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory6-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
let daemon: ChildProcess | undefined;

let ws: import("ws").WebSocket | null = null;
let wsId = 0;

/** 连一次，所有 call 复用（帧形状照 smoke-phase7 的可用写法：v + 字符串 id + 按 id 匹配）。 */
async function connect(port: number): Promise<void> {
  const { WebSocket } = await import("ws");
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
}

/** 结果信封：{ok:true,result} / {ok:false,error:{code,message}}。失败不抛，返回给断言去判。 */
async function call(method: string, params: unknown, timeoutMs = 30000): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }> {
  return new Promise((resolve) => {
    if (ws === null || ws.readyState !== 1) return resolve({ ok: false, error: "ws not open" });
    const id = `m6-${++wsId}`;
    const timer = setTimeout(() => { cleanup(); resolve({ ok: false, error: `${method} timed out` }); }, timeoutMs);
    const onMessage = (ev: { data: unknown }): void => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["id"] !== id) return; // 广播帧不是我们的响应
      cleanup();
      if (frame["ok"] === true) resolve({ ok: true, result: frame["result"] });
      else {
        const e = frame["error"] as { code?: string; message?: string } | undefined;
        resolve({ ok: false, error: e?.message ?? "unknown", code: e?.code });
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws?.removeEventListener("message", onMessage as never);
    };
    ws.addEventListener("message", onMessage as never);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

async function main(): Promise<void> {
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(project, "MEMORY.md"), "# 项目记忆\n\n- RPC 面验收用的记忆条目\n", "utf8");

  const port = await freePort();
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOME: home, AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });

  // 等 daemon 起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await connect(port);
      break;
    } catch {
      await sleep(500);
    }
  }
  for (let i = 0; i < 20; i++) {
    const h = await call("health", {});
    if (h.ok) { up = true; break; }
    await sleep(500);
  }
  check("daemon 起来了", up);
  if (!up) return;

  console.log("\n[项目记忆]");
  const read = await call("memory.project.read", { rootPath: project });
  check("memory.project.read 存在且能答", read.ok && String((read.result as { content?: string })?.content ?? "").includes("RPC 面验收"), read.error);
  check("返回了上限数字", typeof (read.result as { limit?: number })?.limit === "number");

  const write = await call("memory.project.write", { rootPath: project, content: "# 项目记忆\n\n- 被 RPC 改写的条目\n" });
  check("memory.project.write 存在", write.ok, write.error);
  const reread = await call("memory.project.read", { rootPath: project });
  check("写入生效", String((reread.result as { content?: string })?.content ?? "").includes("被 RPC 改写"));

  // 超限：必须被拒（这是红线，不是故障）。**错误码走 code 字段，消息里没有**
  const over = await call("memory.project.write", { rootPath: project, content: "- " + "超".repeat(2500) + "\n" });
  check("**超限被拒（code=memory_over_limit）**", !over.ok && over.code === "memory_over_limit", over.code);
  check("拒绝文案可执行（含现有条目）", (over.error ?? "").includes("被 RPC 改写的条目"), over.error);
  const after = await call("memory.project.read", { rootPath: project });
  check("被拒后内容没变", String((after.result as { content?: string })?.content ?? "").includes("被 RPC 改写"));

  const daily = await call("memory.project.daily", { rootPath: project });
  check("memory.project.daily 存在", daily.ok && Array.isArray(daily.result), daily.error);

  const bad = await call("memory.project.read", {});
  check("缺 rootPath 报 bad_params", !bad.ok && bad.code === "bad_params", bad.code);

  console.log("\n[分发日志]");
  const disp = await call("memory.dispatches", { sessionId: "nope" });
  check("memory.dispatches 存在（无记录返回空数组）", disp.ok && Array.isArray(disp.result), disp.error);
  const dispBad = await call("memory.dispatches", {});
  check("缺 sessionId 报 bad_params", !dispBad.ok && dispBad.code === "bad_params", dispBad.code);

  console.log("\n[管家检索]");
  const st = await call("steward.recent", {});
  check("steward.recent 存在", st.ok, st.error);
  const tel = await call("memory.telemetry", { rootPath: project });
  check("memory.telemetry 存在（无记录返回空数组）", tel.ok && Array.isArray(tel.result), tel.error);

  // 先建一个**真实存在**的普通 bot —— 权限拒绝必须用真 bot 验，
  // 拿不存在的 botId 去撞会得到 unknown_bot，测不到 CrossSearchDenied 那条路
  const NORMAL_ID = "normal-bot-for-test";
  const put = await call("bot.put", { unit: { id: NORMAL_ID, name: "普通 bot", rootPath: project, bindings: [{ runtimeId: "mockperm", primary: true }] } });
  check("普通 bot 注册成功", put.ok, put.error);

  // 无权 bot 搜索 → 必须被拒，且错误码是我们自己的
  const denied = await call("steward.search", { botId: NORMAL_ID, query: "记忆" });
  check("**普通 bot 搜索被权限挡住**", !denied.ok && denied.code === "cross_search_denied", denied.code);
  check("拒绝文案解释了原因", (denied.error ?? "").includes("信任"));
  check("拒绝文案给出两条出路", (denied.error ?? "").includes("crossSearch") && (denied.error ?? "").includes("管家"));

  // 显式开开关后同一个 bot 就能搜（**必须限字节** —— 冒烟不该扫用户 1.6GB 语料）
  const list0 = await call("bot.list", {});
  const def0 = Array.isArray(list0.result) ? (list0.result as Array<Record<string, unknown>>).find((b) => b["id"] === NORMAL_ID) : undefined;
  if (def0 !== undefined) {
    const opt = await call("bot.put", { unit: { ...def0, crossSearch: true } });
    check("开开关写进去了", opt.ok, opt.error);
    const after1 = await call("steward.search", { botId: NORMAL_ID, query: "记忆", limit: 2, maxBytesPerCli: 1_500_000 }, 60000);
    check("**开开关后同一个 bot 能搜了**", !after1.error?.includes("cross_search_denied"), after1.error);
  } else {
    check("能在 bot.list 里找到刚建的 bot", false);
  }

  // 管家 bot 能搜。**限 1.5MB/家**：这里验的是「RPC 通、结果结构对」，
  // 真实语料的全量成本另由 smoke:memory3 的真实数据段测，不该让冒烟烧几分钟。
  const t0 = Date.now();
  const stew = await call("steward.search", { botId: "steward", query: "记忆", limit: 3, maxBytesPerCli: 1_500_000 }, 60000);
  const searchMs = Date.now() - t0;
  check("管家 bot 能搜（没被权限挡）", !stew.error?.includes("cross_search_denied"), stew.error);
  check("返回结构完整", stew.ok && typeof stew.result === "object" && Array.isArray((stew.result as { hits?: unknown[] })?.hits), stew.error);
  console.log(`       受限搜索（1.5MB/家）耗时 ${searchMs}ms`);
  check("受限搜索 30 秒内返回", searchMs < 30000, searchMs);
  if (stew.ok) {
    const r = stew.result as { hits: Array<Record<string, unknown>>; byCli: Record<string, number> };
    check("命中带归属字段", r.hits.every((h) => typeof h["cli"] === "string" && typeof h["at"] === "string" && typeof h["srcPath"] === "string"));
    check("project 为 null 的命中没有被丢掉", r.hits.every((h) => "project" in h));
  }

  // 不存在的 botId：**不能**当管家放行（这曾是真漏洞）
  const ghost = await call("steward.search", { botId: "no-such-bot-9x7y", query: "记忆" });
  check("**不存在的 botId 被拒（不是当管家放行）**", !ghost.ok && (ghost.code === "unknown_bot" || ghost.code === "cross_search_denied"), ghost.code);
  const noBot = await call("steward.search", { query: "记忆", limit: 1, maxBytesPerCli: 800_000 }, 60000);
  check("不给 botId 时按工作台自身调用处理（不报权限错）", !noBot.error?.includes("cross_search_denied"), noBot.error);

  const emptyQ = await call("steward.search", { botId: "steward", query: "  " });
  check("空查询报 bad_params", !emptyQ.ok && emptyQ.code === "bad_params", emptyQ.code);

  console.log("\n[日报与 curator]");
  const dry = await call("memory.digest.run", { dryRun: true, force: true }, 90000);
  check("memory.digest.run dryRun 存在", dry.ok, dry.error);
  if (dry.ok) {
    const r = dry.result as { ran: boolean; dryRun?: boolean };
    check("dryRun 标记回来了", r.dryRun === true, r);
  }
  const cur = await call("curator.run", { dryRun: true });
  check("curator.run 存在", cur.ok, cur.error);
  if (cur.ok) {
    const r = cur.result as { ran: boolean; dryRun?: boolean; reportDir?: string };
    check("curator dryRun 标记回来了", r.dryRun === true, r);
    check("curator 写了报告目录", typeof r.reportDir === "string", r);
  }

  console.log("\n[旧接口仍在]");
  const legacy = await call("memory.list", { pillar: "semantic" });
  check("旧 memory.list 仍可用（旧路径没被拆掉）", legacy.ok, legacy.error);

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(async () => {
    ws?.close();
    if (daemon !== undefined && daemon.exitCode === null) daemon.kill();
    await sleep(300);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(failures === 0 ? 0 : 1);
  });
