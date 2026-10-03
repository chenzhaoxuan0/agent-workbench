/**
 * 飞书渠道冒烟（smoke:feishu）——lark-cli 驱动版。
 *
 * 验的是四件能离线验的事：
 * 1. bot.json 的 channels 能正确解析成账号（profile 形态）
 * 2. reconcile：改完 bot.json 不用重启就起/停/换账号
 * 3. 没配 profile / 凭据不明的账号被跳过而不是炸网关
 * 4. 主动出站在没有账号时如实拒绝
 *
 * 验不了的：真的收到飞书消息（要一个真 profile + 开放平台开好事件订阅）。
 * 那是本机的 lark-cli 的事，不是这段代码的事。
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { BotRegistry } from "../src/bots/registry.ts";
import { FeishuGateway, larkCliAvailable, diagnoseLarkAccount, fetchLarkIdentity, larkIdentities } from "../src/channels/feishu.ts";
import { Store } from "../src/store/db.ts";

const home = await mkdtemp();
const store = new Store(home);
const registry = new BotRegistry(store);

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

const work = path.join(home, "bots");
const botDir = path.join(work, "smoke-bot");
await mkdir(path.join(botDir, ".agent-workbench"), { recursive: true });

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

// 不真的起连接：这里只验 reconcile 的记账，握手交给真 lark-cli
const gateway = new FeishuGateway({ registry, host: {} as never, reconcileMs: 60_000 });

console.log("\n[1] lark-cli 在不在");
const cli = await larkCliAvailable();
ok(typeof cli.available === "boolean", "可探测 lark-cli 是否可用", cli);
if (!cli.available) {
  console.log("  NOTE  本机没有 lark-cli，事件流相关断言全部跳过（其余仍会验）");
}

console.log("\n[2] 渠道解析：profile 形态");
await registry.putBot(def({
  channels: [
    {
      kind: "feishu",
      enabled: true,
      accounts: [
        { id: "main", profile: "p_real", mentionOnly: true },
        { id: "noprofile", mentionOnly: true },
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

console.log("\n[3] reconcile：只起有 profile 的账号");
await gateway.reconcile();
ok(gateway.specsOf("smoke-bot").length === 1, "缺 profile 的账号被跳过，不炸网关", gateway.specsOf("smoke-bot").map((s) => s.profile));
ok(gateway.specsOf("smoke-bot")[0]?.profile === "p_real", "认到 profile 名");

console.log("\n[4] reconcile：改配置 → 旧账号换掉，数量不变");
await registry.putBot(def({
  channels: [{ kind: "feishu", enabled: true, accounts: [{ id: "main", profile: "p_changed" }] }],
}) as never);
await gateway.reconcile();
ok(gateway.specsOf("smoke-bot").length === 1, "仍然 1 个账号（换掉不是叠加）", gateway.specsOf("smoke-bot").length);
ok(gateway.specsOf("smoke-bot")[0]?.profile === "p_changed", "profile 已更新");

console.log("\n[5] reconcile：关掉渠道 → 账号清空");
await registry.putBot(def({
  channels: [{ kind: "feishu", enabled: false, accounts: [{ id: "main", profile: "p_changed" }] }],
}) as never);
await gateway.reconcile();
ok(gateway.specsOf("smoke-bot").length === 0, "enabled=false 不留连接", gateway.specsOf("smoke-bot").length);

console.log("\n[6] reconcile：删掉 channels → 账号清空");
await registry.putBot(def({}) as never);
await gateway.reconcile();
ok(gateway.specsOf("smoke-bot").length === 0, "无 channels 不留连接", gateway.specsOf("smoke-bot").length);

console.log("\n[7] 畸形 bot.json 不炸网关");
await writeFile(path.join(botDir, ".agent-workbench", "bot.json"), "{ not json", "utf8");
await registry.putBot(def({ channels: "not-an-array" }) as never);
await gateway.reconcile();
ok(true, "畸形 channels 走完 reconcile 未抛");

console.log("\n[8] 主动出站：没有账号时如实拒绝，不假装成功");
const r = await gateway.sendTo("smoke-bot", "main", "oc_xxx", "日报");
ok(r.ok === false && r.detail.includes("没有可用的飞书账号"), "无账号时拒绝并说清原因", r.detail);

console.log("\n[9] 诊断：结构对，失败时逐项说清断在哪");
const d = await diagnoseLarkAccount({
  key: "smoke-bot::main",
  botId: "smoke-bot",
  profile: "definitely-not-a-real-profile",
  mentionOnly: true,
  allowFrom: [],
});
ok(typeof d.ok === "boolean", "返回 ok 布尔");
ok(Array.isArray(d.checks) && d.checks.length > 0, "逐项检查");
ok(d.checks.every((c: { name: string; ok: boolean; detail: string }) => c.detail !== ""), "每项都有说明（不空着让人猜）");
ok(d.checks.some((c: { name: string; detail: string }) => /开放平台/.test(c.detail)), "事件订阅明说要去开放平台确认，不编检查项");
if (!cli.available) {
  ok(d.ok === false, "lark-cli 不在时整体判为不通过", d);
}

console.log("\n[10] 机器人身份：profile 是哪个飞书机器人（界面上认脸靠它）");
const emptyId = await fetchLarkIdentity("");
ok(emptyId.ok === false && emptyId.detail !== "", "空 profile 直接拒，不 spawn", emptyId.detail);
const bogusId = await fetchLarkIdentity("definitely-not-a-real-profile");
ok(bogusId.ok === false && bogusId.detail !== "", "认不出的 profile 说清原因，不抛也不编名字", bogusId.detail);
ok(bogusId.appName === "" && bogusId.avatarUrl === "", "认不出就不给名字和头像（不拿 profile 冒充机器人）", bogusId);
ok(bogusId.detail !== "}" && bogusId.detail.length > 5, "失败原因是人话不是一段 JSON 残渣", bogusId.detail);
const cached = await fetchLarkIdentity("definitely-not-a-real-profile");
ok(cached === bogusId, "失败结果进缓存，不反复 spawn", { same: cached === bogusId });
const dedup = await larkIdentities(["p_x", "p_x", " p_x "]);
ok(Object.keys(dedup).length === 1 && Object.keys(dedup)[0] === "p_x", "批量按 profile 去重（多个 bot 绑同一个机器人只 spawn 一次）", Object.keys(dedup));

if (cli.available) {
  const real = await firstRealProfile();
  if (real === null) {
    ok(true, "本机没有配置过 profile，跳过真 profile 断言");
  } else {
    const id = await fetchLarkIdentity(real);
    ok(id.ok === true, `真 profile 认得出来（${real}）`, id.detail);
    ok(id.appName !== "", "拿到应用名——界面上「这是哪个机器人」靠它", id.appName);
    ok(id.avatarUrl.startsWith("https://"), "拿到头像 URL——侧栏那张脸靠它", id.avatarUrl);
    ok(id.openId.startsWith("ou_"), "拿到机器人 open_id", id.openId);
    ok(id.activateStatus === 2, "飞书侧已启用（status=2）", id.activateStatus);
  }
} else {
  ok(true, "lark-cli 不在，跳过真 profile 断言");
}

gateway.stop();
store.close();
await rm(home, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);

/** 本机第一个 profile 名（动态取，不硬编码——换机器/换账号时测试仍有效） */
async function firstRealProfile(): Promise<string | null> {
  const { resolveCommand } = await import("../src/runtime/exec.ts");
  try {
    const cmd = await resolveCommand("lark-cli");
    const out = await new Promise<string>((res) => {
      const c = spawn(cmd.file, [...cmd.prefixArgs, "profile", "list"], { windowsHide: true });
      let s = "";
      c.stdout.on("data", (d: Buffer) => (s += d.toString("utf8")));
      c.on("close", () => res(s));
      c.on("error", () => res(""));
    });
    const arr = JSON.parse(out) as Array<{ name?: string }>;
    return arr[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function mkdtemp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `aw-feishu-smoke-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
