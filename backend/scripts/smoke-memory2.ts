/**
 * 记忆系统 WP-3 验收 —— 记忆规则注入（docs/10 §4.2 / §十 场景 2）。
 *
 * 三段：
 *   [单元] hasRealEntries / renderRule —— 模板占位不算记忆、80% 提醒、规则长度受控
 *   [集成] FileMemoryInjector —— 有记忆才注入 / 无文件不注入 / 结构正确
 *   [端到端] 真 RuntimeHost + mockperm —— 记忆内容真的到了模型手里（mockperm 回显 prompt），
 *          messages 存用户原话、dispatches 存注入块、续聊不重复注入、不接注入器时行为不变
 *
 * 用法：cd backend && pnpm smoke:memory2
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeHost } from "../src/runtime/host.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import { MockPermAdapter } from "../src/runtime/adapters/mockperm.ts";
import { Store } from "../src/store/db.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { FileMemoryInjector, hasRealEntries } from "../src/memory/injection.ts";
import { renderRule, MEMORY_BLOCK_OPEN, MEMORY_BLOCK_CLOSE } from "../src/memory/ruleTemplate.ts";
import { ensureLayout, MEMORY_TEMPLATE } from "../src/memory/projectMemory.ts";
import { MEMORY_CHAR_LIMIT } from "../src/memory/limits.ts";
import { asModelId, asSessionId, asUnitId } from "../../prototype/src/core/units.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory2-"));
/** SQLite 的 WAL/SHM 文件被 DatabaseSync 锁着，Windows 上不 close 就删不掉临时目录 */
const openStores: Store[] = [];

const REAL_MEMORY = [
  "# 项目记忆",
  "",
  "- 这个仓库用 pnpm，不用 npm",
  "- 访问 github 需要挂代理 127.0.0.1:7897",
  "",
].join("\n");

async function main(): Promise<void> {
  // ---------------------------------------------------------------- [单元]
  console.log("\n[单元] 模板与规则");

  check("模板头不算真实记忆", hasRealEntries(MEMORY_TEMPLATE) === false);
  check("真实条目算记忆", hasRealEntries(REAL_MEMORY) === true);
  check("空文件不算", hasRealEntries("") === false);
  check("只有标题不算", hasRealEntries("# 项目记忆\n\n<!-- 注释 -->\n") === false);

  const ruleOk = renderRule({ memoryPath: "D:/p/MEMORY.md", used: 400, nearLimit: false });
  check("规则含记忆文件绝对路径", ruleOk.includes("D:/p/MEMORY.md"));
  check("规则含用量/上限", ruleOk.includes(`400/${MEMORY_CHAR_LIMIT} 字符`));
  check("规则含百分比", /\[\d+% —/.test(ruleOk));
  check("未到 80% 时不给超限提醒", !ruleOk.includes("先整合"));

  const ruleNear = renderRule({ memoryPath: "D:/p/MEMORY.md", used: 2000, nearLimit: true });
  check("到 80% 时给出先整合提醒", ruleNear.includes("先整合"));

  // 规则本身每轮都烧 token，必须有界
  check(`规则长度受控（${[...ruleOk].length} 字符）`, [...ruleOk].length < 1200, [...ruleOk].length);

  // ---------------------------------------------------------------- [集成]
  console.log("\n[集成] FileMemoryInjector");

  const projA = path.join(tmp, "projA");
  const projEmpty = path.join(tmp, "projEmpty");
  const projBare = path.join(tmp, "projBare");
  await mkdir(projA, { recursive: true });
  await mkdir(projEmpty, { recursive: true });
  await mkdir(projBare, { recursive: true });
  await writeFile(path.join(projA, "MEMORY.md"), REAL_MEMORY, "utf8");
  await ensureLayout(projEmpty); // 只有模板头

  const inj = new FileMemoryInjector();

  const a = await inj.build(projA, "帮我看下依赖");
  check("有真实记忆 → 注入", a !== null);
  check("注入块以 open 标记开头", a!.block.startsWith(MEMORY_BLOCK_OPEN));
  check("注入块以 close 标记结尾", a!.block.endsWith(MEMORY_BLOCK_CLOSE));
  check("注入块含记忆正文", a!.block.includes("这个仓库用 pnpm"));
  check("注入块含维护规则", a!.block.includes("应该写"));
  check("注入块含写文件的方式", a!.block.includes("直接编辑"));
  check("prompt = 注入块 + 分隔 + 用户原话", a!.prompt.endsWith("\n\n---\n\n帮我看下依赖"));
  check("prompt 以用户原话结尾", a!.prompt.trimEnd().endsWith("帮我看下依赖"));
  check("parts 含 semantic 及源路径", a!.parts.length === 1 && a!.parts[0]!.scope === "semantic" && a!.parts[0]!.sourcePath === path.join(projA, "MEMORY.md"));
  check("injectedChars 与 block 长度一致", a!.injectedChars === [...a!.block].length);

  check("只有模板头 → 不注入", (await inj.build(projEmpty, "问题")) === null);
  check("完全没有 MEMORY.md → 不注入", (await inj.build(projBare, "问题")) === null);

  // ---------------------------------------------------------------- [端到端]
  console.log("\n[端到端] RuntimeHost 真实代码路径");

  async function makeHost(name: string, withInjector: boolean): Promise<{ host: RuntimeHost; store: Store; gate: PermissionGate }> {
    const home = path.join(tmp, name);
    await mkdir(home, { recursive: true });
    const store = new Store(home);
    openStores.push(store);
    const gate = new PermissionGate(store);
    gate.addRule({ pattern: "mock", decision: "allow" }); // 放行 mockperm 的权限挂起
    const host = new RuntimeHost(
      () => {},
      new TraceSink(home),
      home,
      store,
      gate,
      withInjector ? new FileMemoryInjector() : undefined,
    );
    host.register(new MockPermAdapter());
    return { host, store, gate };
  }

  // A：接了注入器
  const on = await makeHost("home-on", true);
  const s1 = await on.host.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u1"),
    unitName: "U1",
    rootPath: projA,
    prompt: "帮我看下依赖",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  await sleep(120);

  // mockperm 的 message.completed 会回显它收到的完整 prompt —— 这是「记忆到没到模型手里」的铁证
  const msgs = on.host.sessionMessages(s1.id as never);
  const assistant = msgs.find((m) => m.role === "assistant");
  check("轮次跑完（有 assistant 回复）", assistant !== undefined);
  check("**记忆正文真的到达了模型**", (assistant?.text ?? "").includes("这个仓库用 pnpm"), assistant?.text?.slice(0, 120));
  check("维护规则也到达了模型", (assistant?.text ?? "").includes("应该写"));
  check("用户原话跟在注入块后面", (assistant?.text ?? "").endsWith("帮我看下依赖"));

  // messages 表存的是用户原话，不是整块 prompt
  const userMsg = msgs.find((m) => m.role === "user");
  check("messages 表存用户原话（不含注入）", userMsg?.text === "帮我看下依赖", userMsg?.text?.slice(0, 80));
  check("messages 表不含记忆内容", !(userMsg?.text ?? "").includes("这个仓库用 pnpm"));

  // 分发日志记录了注入
  const disp = on.store.listDispatches(s1.id);
  check("dispatches 有 1 行", disp.length === 1, disp.length);
  check("dispatches 记了用户原话", disp[0]?.userText === "帮我看下依赖");
  check("dispatches 记了注入块", (disp[0]?.injectedBlock ?? "").includes("这个仓库用 pnpm"));
  check("dispatches 记了注入字符数", (disp[0]?.injectedChars ?? 0) > 0);
  check("dispatches parts 可解析", Array.isArray(disp[0]?.parts) && disp[0]!.parts[0]?.scope === "semantic");
  check("dispatches 记了 root_path", disp[0]?.rootPath === projA);

  // 会话标题用用户原话，不被注入块污染
  check("会话标题未被注入内容污染", !s1.title.includes("项目记忆"), s1.title);

  // 冻结快照：续聊不重复注入
  on.host.sendMessage(s1.id as never, "继续");
  await sleep(120);
  check("**续聊不新增分发日志（冻结快照）**", on.store.listDispatches(s1.id).length === 1, on.store.listDispatches(s1.id).length);
  const msgs2 = on.host.sessionMessages(s1.id as never);
  const lastAssistant = msgs2.filter((m) => m.role === "assistant").pop();
  check("续聊的 prompt 干净（无注入块）", !(lastAssistant?.text ?? "").includes("这个仓库用 pnpm"), lastAssistant?.text?.slice(0, 100));
  check("续聊内容正确", (lastAssistant?.text ?? "").endsWith("继续"));

  // B：没接注入器 → 行为与引入记忆之前完全一致
  const off = await makeHost("home-off", false);
  const s2 = await off.host.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u2"),
    unitName: "U2",
    rootPath: projA, // 同一个有记忆的项目
    prompt: "帮我看下依赖",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  await sleep(120);
  const offAssistant = off.host.sessionMessages(s2.id as never).find((m) => m.role === "assistant");
  check("未接注入器：prompt 原样透传", (offAssistant?.text ?? "").endsWith("帮我看下依赖"));
  check("未接注入器：不含记忆内容", !(offAssistant?.text ?? "").includes("这个仓库用 pnpm"));
  check("未接注入器：不写分发日志", off.store.listDispatches(s2.id).length === 0);

  // C：注入器炸了不许阻断派发
  const boom = {
    build: async (): Promise<never> => {
      throw new Error("注入器内部炸了");
    },
  };
  const homeBoom = path.join(tmp, "home-boom");
  await mkdir(homeBoom, { recursive: true });
  const storeBoom = new Store(homeBoom);
  openStores.push(storeBoom);
  const gateBoom = new PermissionGate(storeBoom);
  gateBoom.addRule({ pattern: "mock", decision: "allow" });
  const hostBoom = new RuntimeHost(() => {}, new TraceSink(homeBoom), homeBoom, storeBoom, gateBoom, boom);
  hostBoom.register(new MockPermAdapter());
  const s3 = await hostBoom.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u3"),
    unitName: "U3",
    rootPath: projA,
    prompt: "注入器坏了也要能干活",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  await sleep(120);
  const boomAssistant = hostBoom.sessionMessages(s3.id as never).find((m) => m.role === "assistant");
  check("**注入器抛错不阻断派发**", (boomAssistant?.text ?? "").endsWith("注入器坏了也要能干活"));
  check("注入器抛错时不写分发日志", storeBoom.listDispatches(s3.id).length === 0);

  // D：没有记忆的项目 → 正常派发，不注入
  const s4 = await on.host.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u4"),
    unitName: "U4",
    rootPath: projBare,
    prompt: "空项目也要能干活",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  await sleep(120);
  const bareAssistant = on.host.sessionMessages(s4.id as never).find((m) => m.role === "assistant");
  check("无记忆项目正常派发", (bareAssistant?.text ?? "").endsWith("空项目也要能干活"));
  check("无记忆项目不写分发日志", on.store.listDispatches(s4.id).length === 0);

  // ---- 前端命名空间：界面写的 `daemon:<id>` 后端也得认 ----
  // 界面把适配器注册成 `daemon:<id>`（prototype/src/adapters/daemon/adapter.ts:44），
  // 后端注册的是裸 `<id>`。bot.json 的 bindings 是界面写的，所以后端必须两种都收。
  // 症状：飞书/telegram 走 IM 路径 → `no such executor: daemon:mcode`。
  const s5 = await on.host.startSession({
    runtimeId: "daemon:mockperm",
    unitId: asUnitId("u5"),
    unitName: "U5",
    rootPath: projA,
    prompt: "界面命名空间的执行器也要能跑",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  await sleep(150);
  const nsAssistant = on.host.sessionMessages(s5.id as never).find((m) => m.role === "assistant");
  check("**`daemon:` 前缀的执行器 id 能被解析**（IM 路径的命门）", (nsAssistant?.text ?? "").endsWith("界面命名空间的执行器也要能跑"), nsAssistant?.text?.slice(0, 90));
  check("带前缀的会话同样注入记忆", (nsAssistant?.text ?? "").includes("项目记忆"), nsAssistant?.text?.slice(0, 90));

  // 真不存在的执行器仍然要拒，且报错要带可用清单
  let badEx: unknown;
  try {
    await on.host.startSession({
      runtimeId: "daemon:no-such-thing",
      unitId: asUnitId("u6"),
      unitName: "U6",
      rootPath: projA,
      prompt: "x",
      model: asModelId("mock-1"),
      mode: "yolo",
    });
  } catch (e) { badEx = e; }
  check("真不存在的执行器仍被拒", badEx !== undefined);
  check("**报错里列出本机已注册的清单**", (badEx as Error)?.message.includes("本机已注册"), (badEx as Error)?.message);
  check("报错还点破前缀问题", (badEx as Error)?.message.includes("前缀只在界面侧有效"), (badEx as Error)?.message);

  // ---- 事件订阅（飞书流式输出靠它）----
  console.log("\n[订阅] onSessionEvent —— 飞书流式的地基");

  const s7 = await on.host.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u7"),
    unitName: "U7",
    rootPath: projA,
    prompt: "订阅测试",
    model: asModelId("mock-1"),
    mode: "yolo",
  });
  // 注意：mockperm **不发 message.delta**（它只发 message.completed），
  // 而 7 个真实适配器都发（claude/codex/dsh/mcode/opencode/pi/zcode）。
  // 所以这里测的是**订阅机制本身**，用 mockperm 确实会发的事件类型。
  const seen: string[] = [];
  const offSub = on.host.onSessionEvent(s7.id as never, "message.completed", (ev) => {
    seen.push((ev as { text?: string }).text ?? "");
  });
  const before = seen.length;
  await on.host.sendMessage(s7.id as never, "再来一轮");
  await sleep(250);
  check("**订阅能收到事件**", seen.length > before, { before, after: seen.length });
  offSub();
  const after = seen.length;
  await on.host.sendMessage(s7.id as never, "第三轮");
  await sleep(250);
  check("**退订后不再收到**", seen.length === after, { after, now: seen.length });

  // 订阅方自己炸了，不能掀翻这一轮
  const s8 = await on.host.startSession({
    runtimeId: "mockperm",
    unitId: asUnitId("u8"),
    unitName: "U8",
    rootPath: projA,
    prompt: "订阅方抛异常",
    model: asModelId("mock-1"),
    mode: "yolo",
    // **钩子在首轮 send 之前触发** —— 早放几毫秒会整段丢掉第一个 delta
    onSessionReady: (sid) => { on.host.onSessionEvent(sid, "message.completed", () => { throw new Error("subscriber exploded"); }); },
  });
  await sleep(250);
  const boomAsst = on.host.sessionMessages(s8.id as never).find((m) => m.role === "assistant");
  check("**订阅方抛异常不影响这一轮派发**", (boomAsst?.text ?? "").endsWith("订阅方抛异常"), boomAsst?.text?.slice(-40));
  check("onSessionReady 在首轮完成前就拿到了 sessionId", s8.id !== "");

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    for (const s of openStores) {
      try {
        s.close();
      } catch {
        /* 已经关了就算了 */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (err: unknown) {
      console.error("临时目录清理失败：", err);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
