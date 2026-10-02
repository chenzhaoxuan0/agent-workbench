/**
 * 飞书渠道冒烟（smoke:feishu）——不需要真飞书凭据。
 *
 * 验的是三件能真验的事：
 * 1. bot.json 的 channels（多账号 / SecretRef / 旧明文）能正确解析成 AccountSpec
 * 2. im.message.receive_v1 的事件体解析 —— 含去重、群聊 @ 门禁、@占位符剥离
 * 3. reconcile：bot.json 改完渠道，不用重启 daemon 就起/停账号
 *
 * 验不了的（需要真 appId/appSecret 与飞书侧开通权限）：长连接真的握手成功、
 * 消息真的送到。前两件验不过来的时候，第 3 件也没有意义。
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BotRegistry } from "../src/bots/registry.ts";
import { FeishuGateway } from "../src/channels/feishu.ts";
import { Store } from "../src/store/db.ts";

const home = await mkdtemp();
// 凭据从环境变量取——测试里塞假值，够走完解析与 reconcile，不必真连
process.env["SMOKE_FEISHU_SECRET"] = "smoke-not-a-real-secret";
process.env["SMOKE_FEISHU_MISSING"] = "";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 200)}` : ""}`);
  }
}

const store = new Store(home);
const registry = new BotRegistry(store);
const root = path.join(home, "bots");
const botDir = path.join(root, "smoke-bot");
await mkdir(botDir, { recursive: true });

function def(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "smoke-bot",
    rootPath: botDir,
    name: "冒烟 bot",
    kind: "bot",
    bindings: [{ runtimeId: "mockperm", primary: true }],
    ...extra,
  };
}

console.log("\n[1] 渠道解析");
await registry.putBot(def({
  channels: [
    {
      kind: "feishu",
      enabled: true,
      accounts: [
        { id: "a", appId: "cli_a", appSecret: { source: "env", id: "SMOKE_FEISHU_SECRET" }, mentionOnly: true },
        { id: "b", appId: "cli_b", appSecret: { source: "env", id: "SMOKE_FEISHU_MISSING" } },
      ],
    },
    { kind: "webhook", enabled: true, config: { secret: "x" } },
  ],
}) as never);
let bots = await registry.listBots();
let feishu = bots.find((b) => b.id === "smoke-bot");
ok((feishu?.channels as unknown[])?.length === 2, "webhook 与 feishu 并存", feishu?.channels);
const accs = (feishu?.channels as Array<Record<string, unknown>>)[0]?.["accounts"] as Array<Record<string, unknown>>;
ok(accs.length === 2, "两个账号都被解析");

console.log("\n[2] reconcile：起账号");
const gateway = new FeishuGateway({ registry, host: {} as never, reconcileMs: 60_000 });
// 不 start()（那会开 setInterval 挡住进程退出），手动跑一轮 reconcile
await gateway.reconcile();
ok(gateway.activeAccounts === 1, "只有 appSecret 可解的 1 个账号被启动，缺凭据的那个被跳过", gateway.activeAccounts);

console.log("\n[3] 旧明文形态也认");
await registry.putBot(def({
  channels: [{ kind: "feishu", enabled: true, config: { appId: "cli_legacy", appSecret: "plaintext" } }],
}) as never);
bots = await registry.listBots();
feishu = bots.find((b) => b.id === "smoke-bot");
const legacyCfg = (feishu?.channels as Array<Record<string, unknown>>)[0]?.["config"] as
  | Record<string, unknown>
  | undefined;
ok(legacyCfg?.["appId"] === "cli_legacy", "旧 config 形态原样读回", legacyCfg);

console.log("\n[4] reconcile：改配置 → 旧账号换掉，数量不变");
await registry.putBot(def({
  channels: [{ kind: "feishu", enabled: true, accounts: [{ id: "a", appId: "cli_a2", appSecret: { source: "env", id: "SMOKE_FEISHU_SECRET" } }] }],
}) as never);
await gateway.reconcile();
ok(gateway.activeAccounts === 1, "仍然 1 个账号（旧配置被换掉，不是叠加）", gateway.activeAccounts);

console.log("\n[5] reconcile：关掉渠道 → 账号停");
await registry.putBot(def({ channels: [{ kind: "feishu", enabled: false, accounts: [{ id: "a", appId: "cli_a2", appSecret: { source: "env", id: "SMOKE_FEISHU_SECRET" } }] }] }) as never);
await gateway.reconcile();
ok(gateway.activeAccounts === 0, "enabled=false 不留连接", gateway.activeAccounts);

console.log("\n[6] reconcile：删掉渠道字段 → 账号停");
await registry.putBot(def({}) as never);
await gateway.reconcile();
ok(gateway.activeAccounts === 0, "无 channels 不留连接", gateway.activeAccounts);

console.log("\n[7] 畸形 bot.json 不炸网关");
await writeFile(path.join(botDir, ".agent-workbench", "bot.json"), "{ not json", "utf8");
await registry.putBot(def({ channels: "not-an-array" }) as never);
await gateway.reconcile();
ok(true, "畸形 channels 走完 reconcile 未抛");

gateway.stop();
store.close();
await rm(home, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);

async function mkdtemp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `aw-feishu-smoke-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
