/**
 * 真实环境（默认 5281 daemon + 真实 home）的待办端到端验证：
 *
 *   backlog.list 就绪 → 真实配额探针（zcode quota / mmx quota 解析校验）
 *   → 建测试待办（mockperm 执行）→ 启用心跳(zcode) → forceBeat
 *   → 等 backlog 信号帧的真实提议（zcode LLM 决策）
 *   → 确认（改选 mockperm 执行器 = 改选链路）→ 终态回灌 → 待验收 → 验收
 *   → 清理测试数据、心跳恢复关闭
 *
 * 用法：cd backend && npx tsx scripts/verify-backlog-live.ts
 */

const BASE = "http://127.0.0.1:5281";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WsFrame {
  [k: string]: unknown;
}

async function main(): Promise<void> {
  // token：回环经 /bootstrap 免鉴权取
  const boot = (await (await fetch(`${BASE}/bootstrap`)).json()) as { token: string | null; home: string };
  console.log(`verify: daemon home = ${boot.home}`);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws${boot.token ? `?token=${encodeURIComponent(boot.token)}` : ""}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });

  let seq = 0;
  const pending = new Map<string, { resolve: (f: WsFrame) => void; timer: ReturnType<typeof setTimeout> }>();
  /** 挂起的 backlog 信号等待者 */
  const signalWaiters: Array<{ pred: (s: Record<string, unknown>) => boolean; resolve: (s: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = [];
  ws.addEventListener("message", (ev: MessageEvent) => {
    const frame = JSON.parse(String(ev.data)) as WsFrame;
    if (frame["type"] === "backlog") {
      const signal = frame["signal"] as Record<string, unknown>;
      for (let i = signalWaiters.length - 1; i >= 0; i--) {
        const w = signalWaiters[i]!;
        if (w.pred(signal)) {
          clearTimeout(w.timer);
          signalWaiters.splice(i, 1);
          w.resolve(signal);
        }
      }
      return;
    }
    const id = frame["id"];
    if (typeof id === "string" && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(frame);
    }
  });

  const rpc = (method: string, params: unknown, timeoutMs = 60000): Promise<WsFrame> => {
    const id = `verify-${++seq}`;
    const p = new Promise<WsFrame>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: { code: "timeout", message: `${method} ${timeoutMs}ms` } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
    ws.send(JSON.stringify({ v: 1, id, method, params }));
    return p;
  };
  const waitSignal = (pred: (s: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = signalWaiters.findIndex((w) => w.pred === pred);
        if (i >= 0) signalWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      signalWaiters.push({ pred, resolve, timer });
    });

  interface ItemShape {
    id: number;
    status: string;
    title: string;
  }
  const items = async (): Promise<ItemShape[]> => ((await rpc("backlog.list", null, 30000))["result"] as { items: ItemShape[] }).items;
  const waitStatus = async (id: number, status: string, timeoutMs = 30000): Promise<ItemShape | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await items()).find((i) => i.id === id);
      if (hit !== undefined && hit.status === status) return hit;
      await sleep(500);
    }
    return null;
  };

  // 1. RPC 就绪 + 初始状态
  const list0 = (await rpc("backlog.list", null, 30000))["result"] as {
    items: unknown[];
    state: { phase: string; heartbeatEnabled: boolean };
  };
  check("backlog.list on live daemon", Array.isArray(list0.items), list0);
  check("state snapshot present", typeof list0.state.phase === "string", list0.state);

  // 1b. 心跳常驻 bot 已注册（含主绑定）+ AGENTS.md 岗位说明书已播种
  const bots = (await rpc("bot.list", null, 30000))["result"] as Array<{ id?: string; bindings?: unknown[] }>;
  const hbBot = bots.find((b) => b.id === "heartbeat");
  check("heartbeat bot registered with binding", hbBot !== undefined && Array.isArray(hbBot.bindings) && hbBot.bindings.length > 0, hbBot);
  const agentsMd = await (await import("node:fs/promises")).readFile(`${boot.home}/heartbeat/AGENTS.md`, "utf8").catch(() => "");
  check("heartbeat AGENTS.md seeded (role contract)", agentsMd.includes("只提议") || agentsMd.includes("输出契约"), agentsMd.slice(0, 80));

  // 2. 真实配额探针（refresh 强制真跑命令）
  const quotas = ((await rpc("backlog.quotas", { refresh: true }, 60000))["result"] as { quotas: Array<{ runtimeId: string; percent: number | null; source: string; summary: string | null; resetsAt: number | null }> }).quotas;
  console.log("  quotas |", JSON.stringify(quotas));
  const zq = quotas.find((q) => q.runtimeId === "zcode");
  const mq = quotas.find((q) => q.runtimeId === "mcode");
  check("zcode probe parsed (percent + resets)", zq?.source === "probe" && zq.percent !== null && zq.resetsAt !== null, zq);
  check("mcode probe parsed (percent)", mq?.source === "probe" && mq.percent !== null, mq);

  // 3. 测试待办（先记下既有 id，最后只清理新增的）
  const before = new Set((await items()).map((i) => i.id));
  const created = await rpc("backlog.create", {
    goal: "验证：真实环境待办全链路（自动清理）",
    unitId: "steward",
    unitName: "总管",
    rootPath: `${boot.home}/steward`,
    runtimeId: "mockperm",
    prompt: "请直接回复「验证完成」。",
  });
  const item = (created["result"] as { item: ItemShape }).item;
  check("create test item", item.status === "ready", item);

  // 4. 启用心跳：显式 runtimeId 留空 —— 验证心跳 bot 主绑定的兜底解析路径。
  // LLM 决策 propose/silence 皆合法（沉默零代价是设计共识），断言以落账为准。
  const beforeOutcome = ((await rpc("backlog.list", null, 30000))["result"] as { state: { lastBeatOutcome: string | null } }).state.lastBeatOutcome;
  await rpc("backlog.config.set", { patch: { heartbeat: { enabled: true, runtimeId: "", intervalMinutes: 30 } } });
  const beat = await rpc("backlog.heartbeat.force", null, 15000);
  check("forceBeat acked", beat["ok"] === true, beat);
  console.log("  ...等心跳落账（最多 5 分钟，心跳会话真实跑）");
  let outcome: string | null = beforeOutcome;
  for (let waited = 0; waited < 300_000; waited += 3000) {
    await sleep(3000);
    outcome = ((await rpc("backlog.list", null, 30000))["result"] as { state: { lastBeatOutcome: string | null } }).state.lastBeatOutcome;
    if (outcome !== null && outcome !== beforeOutcome) break;
  }
  check(
    "heartbeat settled via bot binding (proposed or silence)",
    outcome !== null && outcome !== beforeOutcome && /^(proposed|silence)/.test(outcome),
    outcome,
  );
  const liveProposal = ((await rpc("backlog.list", null, 30000))["result"] as { proposal: { itemId: number; message: string } | null }).proposal;
  if (liveProposal !== null) {
    console.log("  proposal |", JSON.stringify(liveProposal));
    check("proposal targets the ready item", liveProposal.itemId === item.id, liveProposal);

    // 5. 确认（改选 mockperm 执行器——不烧真实额度）→ 执行 → 待验收。
    // settled 信号先挂等待者再发 confirm —— 广播发生在 confirm 处理中，晚了就错过
    const settledPromise = waitSignal((s) => s["kind"] === "settled", 15000);
    const confirm = await rpc("backlog.proposal.confirm", { runtimeId: "mockperm" }, 60000);
    check("confirm dispatches with runtime override", confirm["ok"] === true, confirm);
    const settled = await settledPromise;
    check("settled signal broadcast (cross-channel dismiss)", settled !== null && (settled as { decision: string }).decision === "confirmed", settled);
  } else {
    // 心跳沉默是合法结果 —— 改走 runNow 验证执行链
    await rpc("backlog.runNow", { id: item.id }, 60000);
    console.log(`  ...心跳本轮沉默（${outcome}），改走 runNow 验证执行链`);
  }
  const reviewing = await waitStatus(item.id, "awaiting_review", 60000);
  check("execution ends in awaiting_review", reviewing !== null, reviewing);

  // 6. 验收通过 → 清理测试数据 + 心跳恢复关闭（用户可一键开启）
  await rpc("backlog.review", { id: item.id, pass: true, note: "验证通过" });
  check("review pass → done", (await items()).find((i) => i.id === item.id)?.status === "done");
  await rpc("backlog.delete", { id: item.id });
  const after = (await items());
  check("test item cleaned up", after.every((i) => before.has(i.id) || !i.title.includes("自动清理")), after.map((i) => i.title));
  // 心跳恢复关闭；runtimeId 留空 = 跟随心跳 bot 的主绑定（一键开启即用 bot 配置）
  await rpc("backlog.config.set", { patch: { heartbeat: { enabled: false } } });
  const cfgEnd = (await rpc("backlog.config.get", null))["result"] as { heartbeat: { runtimeId: string } };
  check("heartbeat runtime follows bot binding", cfgEnd.heartbeat.runtimeId === "", cfgEnd);

  ws.close();
  if (failures > 0) {
    console.error(`verify: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("verify: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("verify: crashed", err);
  process.exit(1);
});
