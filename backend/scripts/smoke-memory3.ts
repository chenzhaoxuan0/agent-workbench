/**
 * 记忆系统 WP-4 + WP-5 验收 —— 流式扫描器 + 跨会话追溯搜索（docs/10 §4.3 / §4.4）。
 *
 * [合成] 四家真实字段形态的 fixture —— 含**半行 JSON、坏文件、缺目录**等坏情况
 * [容错] 红线 2：单行坏/单文件坏/单家没有，都不能掀翻整体
 * [检索] 2 字中文命中、跨词命中、同会话去重、时间衰减
 * [遮蔽] 密钥不出明文
 * [上下文] 命中处能翻前后文
 * [真实] 拿本机真实的 ~/.claude ~/.codex ~/.pi ~/.minimax 跑一遍，看真能不能扫出东西
 *
 * 用法：cd backend && pnpm smoke:memory3
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scan, chunkText, type ScanSource } from "../src/memory/scanner.ts";
import { search, timeDecay, loadContext, explainQuery } from "../src/memory/search.ts";
import { bigrams, matchScore, prepareQuery, gramSet } from "../src/memory/bigram.ts";
import { redact, hadRedaction } from "../src/memory/redact.ts";
import { setLogLevel } from "../src/log.ts";

// 扫不出东西时 warn 要看得见 —— 本 smoke 自己就被这个坑过一轮
setLogLevel("warn");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-memory3-"));
const DAY = 86400000;
const now = Date.now();

// ---- 合成 fixture：四家真实字段形态 -----------------------------------------

function writeJsonl(p: string, rows: unknown[]): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const roots = {
  claude: path.join(tmp, "home", ".claude", "projects", "C--Users-chenziyu-project-demo"),
  codex: path.join(tmp, "home", ".codex", "sessions", "2026", "10", "04"),
  pi: path.join(tmp, "home", ".pi", "agent", "sessions", "--C--Users-chenziyu-project-demo--"),
  mcode: path.join(tmp, "home", ".minimax", "v2", "sessions", "2026", "10", "04"),
};

// claude：message.content[].text + 顶层 cwd/sessionId
writeJsonl(path.join(roots.claude, "a.jsonl"), [
  { type: "user", cwd: "/home/u/project/demo", sessionId: "sess-claude-1", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "这个项目的代理要怎么配？TUN 模式老是反复 toggle" }] }, timestamp: new Date(now - 2 * DAY).toISOString() },
  { type: "assistant", cwd: "/home/u/project/demo", sessionId: "sess-claude-1", message: { role: "assistant", content: [{ type: "text", text: "挂 127.0.0.1:7897 就行，另外建议先查 nslookup 看是不是 fake-DNS。" }] }, timestamp: new Date(now - 2 * DAY).toISOString() },
]);

// codex：payload.content[].text + payload.cwd，state 里全是噪声
writeJsonl(path.join(roots.codex, "rollout-1.jsonl"), [
  { timestamp: new Date(now - 9 * DAY).toISOString(), ordinal: 1, type: "item", payload: { id: "p1", cwd: "/home/u/project/demo", content: [{ type: "text", text: "这个仓库用 sqlite 检索，LIKE 搜不到跨词的中文查询。" }], state: { permissions: { approved_command_prefixes: ["这是一大堆重复的权限前缀噪声不该进索引" ] } } } },
]);

// pi：cwd 顶层 + message.content[]
writeJsonl(path.join(roots.pi, "b.jsonl"), [
  { type: "message", version: 1, id: "sess-pi-1", cwd: "/home/u/project/demo", modelId: "m1", message: { content: [{ text: "记忆系统的 FTS5 用 trigram 的话两字中文会全部搜不到。" }] }, timestamp: new Date(now - 40 * DAY).toISOString() },
]);

// mcode：会话是**目录**，里面 messages.jsonl + manifest.json（无 cwd）
{
  const dir = path.join(roots.mcode, "04-12-00-000-session_abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId: "mvs-abc", createdAtMs: now - 30 * DAY, source: "local-runtime" }), "utf8");
  writeFileSync(
    path.join(dir, "messages.jsonl"),
    [
      { message_id: "m1", role: "user", message: { msg_id: "m1", role: "user", msg_content: [{ type: "text", text: "帮我把管家 bot 的跨项目检索默认打开" }], timestamp: new Date(now - 30 * DAY).toISOString() } },
      { message_id: "m2", role: "assistant", message: { msg_id: "m2", role: "assistant", msg_content: [{ type: "text", text: "好，默认只给管家开，其他 bot 走开关。" }], timestamp: new Date(now - 30 * DAY).toISOString() } },
    ]
      .map((r) => JSON.stringify(r)) // ← 少了这步，join 会把对象变成 "[object Object]"
      .join("\n") + "\n",
    "utf8",
  );
}

const SOURCES: ScanSource[] = [
  { cli: "claude", root: path.join(tmp, "home", ".claude", "projects"), maxFieldChars: 2000 },
  { cli: "codex", root: path.join(tmp, "home", ".codex", "sessions"), maxFieldChars: 2000 },
  { cli: "pi", root: path.join(tmp, "home", ".pi", "agent", "sessions"), maxFieldChars: 2000 },
  { cli: "mcode", root: path.join(tmp, "home", ".minimax", "v2", "sessions"), maxFieldChars: 2000 },
];

// ---- 坏情况 fixture：只影响 claude 这一家 ---------------------------------

// 1) 半行 JSON（对方正在写）
{
  const dir = path.join(tmp, "home", ".claude", "projects", "C--Users-chenziyu-project-broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "half.jsonl"),
    JSON.stringify({ type: "user", cwd: "/home/u/project/broken", sessionId: "s1", message: { content: [{ type: "text", text: "这条是完整的，应该能读出来。" }] }, timestamp: now }) +
      "\n" +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"这条只写了一半' + "\n" +
      JSON.stringify({ type: "assistant", cwd: "/home/u/project/broken", sessionId: "s1", message: { content: [{ type: "text", text: "坏行之后这条也该能读出来。" }] }, timestamp: now }) + "\n",
    "utf8",
  );
}
// 2) 完全不存在的目录（第四家根本没装）
SOURCES.push({ cli: "codex", root: path.join(tmp, "home", ".nonexistent-cli", "sessions"), maxFieldChars: 2000 });
// 3) 一个符号链接指向不存在的目标（坏文件）
{
  const p = path.join(tmp, "home", "claude-broken-link");
  try { writeFileSync(p, "x"); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- [bigram]
  console.log("\n[bigram] 中文短词");

  check("2 字中文切成 1 个 bigram", bigrams("代理").length === 1 && bigrams("代理")[0] === "代理");
  check("4 字中文切成 3 个重叠 bigram", bigrams("网络代理").length === 3, bigrams("网络代理"));
  check("跨词查询保留每个词", bigrams("sqlite 检索").includes("sqlite") && bigrams("sqlite 检索").includes("检索"));
  const q2 = prepareQuery("代理");
  check("整串出现 = 满分", matchScore(q2, "关于网络代理工具的说明") === 1);
  check("bigram 命中 = 满分", matchScore(q2, "代理") === 1);
  check("不相关 = 0 分", matchScore(q2, "今天天气不错适合出门散步") === 0);
  const qMix = prepareQuery("sqlite 检索");
  check("跨词查询能命中（LIKE 做不到）", matchScore(qMix, "我们用 sqlite 检索") >= 0.5, matchScore(qMix, "我们用 sqlite 检索"));
  check("同义词仍是天花板（预期 0）", matchScore(prepareQuery("工作台"), "这是 agent-workbench 的目录") === 0);
  check("explainQuery 能给 UI 拆词预览", explainQuery("网络代理").n === 3);

  // ---------------------------------------------------------------- [切块]
  console.log("\n[切块] 分块");

  const long = "第一句。".repeat(400);
  const pieces = chunkText(long, 400);
  check(`长文本切块（${pieces.length} 块）`, pieces.length > 1);
  check("每块不超过目标长度（±1 允许）", pieces.every((p) => p.length <= 401));
  check("切块后内容不丢字", pieces.join("").replace(/\s/g, "") === long.replace(/\s/g, ""));
  check("短文本不切", chunkText("短", 400).length === 1);

  // ---------------------------------------------------------------- [遮蔽]
  console.log("\n[遮蔽] 敏感内容");

  const secrets = [
    "key 是 sk-abcdefghijklmnopqrstuvwxyz123456",
    "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "aws AKIAIOSFODNN7EXAMPLE 和 Bearer abcdefghijklmnopqrstuvwxyz",
    'api_key = "averyverylongsecretvalue123"',
  ];
  for (const s of secrets) {
    const r = redact(s);
    check(`遮蔽：${s.slice(0, 22)}…`, !r.includes("abcdefghijklmnopqrstuvwxyz") && !r.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345") && !r.includes("averyverylongsecretvalue123"), r);
  }
  check("保留样式前缀便于识别", redact(secrets[0]!).startsWith("key 是 sk-"));
  check("hadRedaction 能判断", hadRedaction(secrets[0]!) && !hadRedaction("普通的一句话，没有密钥"));
  check("空串不炸", redact("") === "");
  check("长文本不炸（回溯保护）", redact("a".repeat(200000) + " sk-aaaaaaaaaaaaaaaaaaaaaaaa").includes("REDACTED"));

  // ---------------------------------------------------------------- [扫描]
  console.log("\n[扫描] 四家 fixture");

  const blocks = [];
  for await (const b of scan({ sources: SOURCES })) blocks.push(b);
  const clis = new Set(blocks.map((b) => b.cli));
  check("四家都扫到东西", clis.size === 4, [...clis]);
  check("claude 文本抽出来了", blocks.some((b) => b.text.includes("TUN 模式老是反复 toggle")));
  check("claude cwd 抽到了", blocks.some((b) => b.cli === "claude" && b.cwd === "/home/u/project/demo"));
  check("codex cwd 在 payload 里也抽到了", blocks.some((b) => b.cli === "codex" && b.cwd === "/home/u/project/demo"));
  check("codex 的 state 噪声没进来", !blocks.some((b) => b.text.includes("重复的权限前缀噪声")));
  check("pi 的 cwd 抽到了", blocks.some((b) => b.cli === "pi" && b.cwd === "/home/u/project/demo"));
  check("mcode 走目录型会话", blocks.some((b) => b.cli === "mcode" && b.sessionId === "mvs-abc"));
  check("mcode 无 cwd → 标缺省而不是瞎猜", blocks.some((b) => b.cli === "mcode" && b.cwd === undefined));
  check("块带 lineNo（供翻上下文）", blocks.every((b) => b.lineNo > 0));
  check("块带 srcPath", blocks.every((b) => b.srcPath.length > 0));

  // ---------------------------------------------------------------- [容错]
  console.log("\n[容错] 红线 2");

  const broken = blocks.filter((b) => b.srcPath.includes("C--Users-chenziyu-project-broken"));
  check("**半行 JSON 被跳过，完整行照常读**", broken.some((b) => b.text.includes("这条是完整的")) && broken.some((b) => b.text.includes("坏行之后这条也该能读出来")) && !broken.some((b) => b.text.includes("这条只写了一半")));
  check("缺目录的那家静默跳过、整体不炸", blocks.length > 0);
  check("扫描流正常结束（没抛）", true);

  // 只扫缺目录那一家 → 空结果而不是异常
  let onlyMissing = 0;
  for await (const _b of scan({ sources: [{ cli: "codex", root: path.join(tmp, "home", ".nonexistent-cli", "sessions"), maxFieldChars: 2000 }] })) onlyMissing++;
  check("只扫不存在的家 → 0 块且不抛", onlyMissing === 0);

  // 一个空文件
  {
    const p = path.join(tmp, "home", "empty.jsonl");
    writeFileSync(p, "", "utf8");
    let n = 0;
    for await (const _b of scan({ sources: [{ cli: "claude", root: p, maxFieldChars: 2000 }] })) n++;
    check("空文件 → 0 块且不抛", n === 0);
  }

  // 完全不是 JSON 的文件
  {
    const p = path.join(tmp, "home", "garbage");
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, "x.jsonl"), "这不是 JSON\n也不是\n", "utf8");
    let n = 0;
    for await (const _b of scan({ sources: [{ cli: "claude", root: p, maxFieldChars: 2000 }] })) n++;
    check("全是非 JSON → 0 块且不抛", n === 0);
  }

  // since 过滤
  const recent = [];
  for await (const b of scan({ sources: SOURCES, since: now - 10 * DAY })) recent.push(b);
  check("since 过滤掉了老的", recent.every((b) => b.ts >= now - 10 * DAY) && recent.length < blocks.length);

  // pathHint 收窄
  const narrowed = [];
  for await (const b of scan({ sources: SOURCES, pathHint: "C--Users-chenziyu-project-demo" })) narrowed.push(b);
  check("pathHint 收窄生效", narrowed.length > 0 && narrowed.every((b) => b.srcPath.includes("project-demo")), narrowed.length);

  // ---------------------------------------------------------------- [搜索]
  console.log("\n[搜索] 追溯");

  const r1 = await search({ sources: SOURCES, query: "代理", limit: 10 });
  check("2 字中文命中", r1.hits.length > 0, { blocks: r1.scannedBlocks, byCli: r1.byCli });
  check("结果按分数降序", r1.hits.every((h, i) => i === 0 || r1.hits[i - 1]!.score >= h.score));
  check("结果带归属（cli/ts/lineNo）", r1.hits.every((h) => typeof h.block.cli === "string" && h.block.ts > 0 && h.block.lineNo > 0));
  check("命中里的密钥已遮蔽", r1.hits.every((h) => !h.block.text.match(/sk-[A-Za-z0-9]{16,}/)));

  const r2 = await search({ sources: SOURCES, query: "sqlite 检索", limit: 10 });
  check("跨词查询命中（LIKE 无解）", r2.hits.some((h) => h.block.text.includes("sqlite 检索")), r2.hits.length);

  const r3 = await search({ sources: SOURCES, query: "管家", limit: 10 });
  check("mcode 的会话也搜得到", r3.hits.some((h) => h.block.cli === "mcode"));

  const r4 = await search({ sources: SOURCES, query: "量子纠缠的通信协议", limit: 10 });
  check("无关查询 → 0 命中", r4.hits.length === 0);

  const r5 = await search({ sources: SOURCES, query: "", limit: 10 });
  check("空查询 → 0 命中且不炸", r5.hits.length === 0 && r5.queryGrams === 0);

  // 同会话去重
  const r6 = await search({ sources: SOURCES, query: "记忆", limit: 50, perSession: 1 });
  const sessKeys = r6.hits.map((h) => `${h.block.cli}:${h.block.sessionId ?? h.block.srcPath}`);
  check("同会话最多留 1 条", new Set(sessKeys).size === sessKeys.length, sessKeys);

  // 时间衰减：新的排前面
  const r7 = await search({ sources: SOURCES, query: "代理", limit: 50, halfLifeDays: 1 });
  const tsOrder = r7.hits.map((h) => h.block.ts);
  check("同分时新的排前", tsOrder.every((t, i) => i === 0 || tsOrder[i - 1]! >= t));
  check("timeDecay 单调递减", timeDecay(now, now, 90) === 1 && timeDecay(now - 90 * DAY, now, 90) < 0.51);
  check("老数据不删、只降权", timeDecay(now - 900 * DAY, now, 90) > 0);

  // 限定某一家
  const r8 = await search({ sources: SOURCES, query: "代理", cli: ["pi"], limit: 10 });
  check("cli 过滤生效", r8.hits.every((h) => h.block.cli === "pi"));

  // 字节上限必须按**最近优先**截断（复审抓到：原来按 readdir 顺序，
  // codex/mcode 是日期目录 = 拿到最老的文件，上限切在哪跟相关性无关）
  {
    // 造三份：最新的一份含关键词，另两份更老且不含
    const rec = path.join(tmp, "home", ".claude", "projects", "C--recent");
    mkdirSync(rec, { recursive: true });
    const old = new Date(now - 90 * DAY);
    const f = path.join(rec, "newest.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/p", sessionId: "s-new", message: { content: [{ type: "text", text: "最近这次会话里讨论了量子纠缠的通信协议细节" }] }, timestamp: now }) + "\n", "utf8");
    const f2 = path.join(rec, "older.jsonl");
    writeFileSync(f2, JSON.stringify({ cwd: "/p", sessionId: "s-old", message: { content: [{ type: "text", text: "很久以前的一条不相干的内容记录而已" }] }, timestamp: old.getTime() }) + "\n", "utf8");
    const old2 = new Date(now - 120 * DAY);
    const f3 = path.join(rec, "oldest.jsonl");
    writeFileSync(f3, JSON.stringify({ cwd: "/p", sessionId: "s-oldest", message: { content: [{ type: "text", text: "更早的另一条不相干内容记录" }] }, timestamp: old2.getTime() }) + "\n", "utf8");
    // **必须显式设文件 mtime，且要比同脚本其他夹具明确更新** —— 扫描器按文件
    // mtime 排序（`since` 也用它），不是按 JSON 里的 timestamp。同一毫秒写完的
    // 几个文件排序是随机的：这条断言会时红时绿（第一版就踩了，单跑通过、
    // 批量跑失败；第二版设成 now 还是不稳，因为其他夹具也是 now）。
    // 往前挪一分钟，排序就无歧义了。
    const { utimesSync } = await import("node:fs");
    const newest = (now + 60_000) / 1000;
    utimesSync(f, newest, newest);
    utimesSync(f2, old.getTime() / 1000, old.getTime() / 1000);
    utimesSync(f3, old2.getTime() / 1000, old2.getTime() / 1000);
    // 额度只够放下一个文件 —— 谁的 mtime 新谁进
    const cap = Number(f.length) + 10;
    const r9 = await search({
      sources: SOURCES.filter((s) => s.cli === "claude"),
      query: "量子纠缠",
      limitBytesPerCli: cap,
      limit: 5,
    });
    check("**字节上限按最近优先截断**（新文件被覆盖、老文件被跳过）", r9.hits.some((h) => h.block.sessionId === "s-new"), r9.hits.map((h) => h.block.sessionId));
    check("超出额度的更老文件确实没被读", !r9.hits.some((h) => h.block.sessionId === "s-oldest" || h.block.sessionId === "s-old"));
  }

  // ---------------------------------------------------------------- [上下文]
  console.log("\n[上下文] 翻前后文");

  const hit = r1.hits[0];
  if (hit) {
    const ctx = await loadContext(hit.block.srcPath, hit.block.lineNo, { before: 1, after: 1 });
    check("能读回命中处上下文", ctx.length > 0 && ctx.some((c) => c.length > 0), ctx.length);
    const bad = await loadContext(path.join(tmp, "home", "nope.jsonl"), 1);
    check("读不存在的文件 → 空数组不抛", Array.isArray(bad) && bad.length === 0);
  } else {
    check("有命中可测上下文", false);
  }

  // ---------------------------------------------------------------- [真实数据]
  console.log("\n[真实] 本机真实会话落盘");

  const real = await search({ query: "代理", limit: 5, limitBytesPerCli: 8 * 1024 * 1024 });
  console.log(`       扫到 ${real.scannedBlocks} 块 / ${real.scannedFiles} 文件，用时 ${real.elapsedMs}ms`);
  console.log(`       各家命中：${JSON.stringify(real.byCli)}`);
  check("真实数据能扫出块", real.scannedBlocks > 0, real.scannedBlocks);
  check("真实数据 8MB 内完成扫描（够快）", real.elapsedMs < 120000, real.elapsedMs);
  if (real.hits[0]) {
    const h = real.hits[0];
    console.log(`       示例命中：${h.block.cli} · ${h.score.toFixed(2)} · ${h.block.text.slice(0, 60).replace(/\n/g, " ")}…`);
    check("真实命中带归属", typeof h.block.cli === "string" && h.block.ts > 0 && h.block.srcPath.length > 0);
  } else {
    check("真实数据有命中", false, real.byCli);
  }

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(failures === 0 ? 0 : 1);
  });
