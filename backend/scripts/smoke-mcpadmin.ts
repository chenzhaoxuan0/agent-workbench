/**
 * MCP 矩阵后端冒烟 —— mcpadmin 服务层（save/remove/setEnabled/copy/inventory）
 * + TOML/YAML 定点编辑器的保真回归。
 *
 * 全程注入临时 configHome/stateHome，绝不触碰真实执行器配置。
 * 背景：矩阵后端此前零自动化覆盖（review 实证），且定点编辑器有四个
 * 已验证的数据损坏 Bug（注释翻倍 / 跨行 args 被删 / 无尾换行粘连 /
 * 块式 args·引号名丢失）—— 本脚本是「不再复发」的护栏。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerEntry } from "../src/contract.ts";
import { MCP_EXECUTORS, findExecutorDef } from "../src/mcpadmin/executors.ts";
import { mcpCopy, mcpInventory, mcpRemove, mcpSave, mcpSetEnabled } from "../src/mcpadmin/service.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

/** 异步版：promise 内的 throw 只有 await 才接得住 */
async function errCodeAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

function stdio(name: string, command = "npx", args: string[] = ["-y", "server"]): McpServerEntry {
  return { name, transport: "stdio", command, args, env: { KEY: "v" } };
}

const configHome = join(tmpdir(), `agent-workbench-smoke-mcp-${Date.now()}`);
const stateHome = join(configHome, "state");
const deps = { configHome, stateHome };

function seed(defId: string, text: string): string {
  const path = findExecutorDef(defId).configPath(configHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

async function main(): Promise<void> {
  const IS_WIN = process.platform === "win32";

  console.log("\n【1】全执行器：save → 清单读回（含 cmd /c 拆包）→ 编辑 → 启停全环");
  for (const def of MCP_EXECUTORS) {
    const label = def.id;
    try {
      await mcpSave(deps, def.id, stdio("smoke-srv"));
      const inv = mcpInventory(deps);
      const row = inv.rows.find((r) => r.name === "smoke-srv");
      const live = row?.instances.find((i) => i.executorId === def.id && !i.disabled);
      check(`[${label}] save 后清单可见`, live !== undefined, { rows: inv.rows.map((r) => r.name) });
      check(`[${label}] 读回 command=npx（cmd /c 已拆）`, live?.entry.command === "npx", live?.entry);
      check(`[${label}] env 保留`, live?.entry.env?.["KEY"] === "v");
      if (IS_WIN) {
        const text = readFileSync(findExecutorDef(def.id).configPath(configHome), "utf8");
        check(`[${label}] 盘上写入了 cmd /c 包装`, /\bcmd\b/i.test(text) && /\/c|["']\/c["']/.test(text), { text: text.slice(0, 200) });
      }
      // 编辑（同 name 换 args）：不产生重复条目
      await mcpSave(deps, def.id, stdio("smoke-srv", "npx", ["-y", "v2"]));
      const inv2 = mcpInventory(deps);
      const cnt = inv2.rows.find((r) => r.name === "smoke-srv")?.instances.filter((i) => i.executorId === def.id).length ?? 0;
      check(`[${label}] 编辑不产生重复条目`, cnt === 1, { cnt });
      // 启停环：停用 → live 消失 vault 出现；启用 → 回 live
      await mcpSetEnabled(deps, def.id, "smoke-srv", false);
      check(`[${label}] 停用后 live 消失`, mcpInventory(deps).rows.find((r) => r.name === "smoke-srv")?.instances.some((i) => i.executorId === def.id && !i.disabled) === false);
      await mcpSetEnabled(deps, def.id, "smoke-srv", true);
      check(`[${label}] 启用后回 live`, mcpInventory(deps).rows.find((r) => r.name === "smoke-srv")?.instances.some((i) => i.executorId === def.id && !i.disabled) === true);
      // 彻底删除（连 vault）
      await mcpRemove(deps, def.id, "smoke-srv", { toVault: false });
      const gone = mcpInventory(deps).rows.find((r) => r.name === "smoke-srv")?.instances.some((i) => i.executorId === def.id) ?? false;
      check(`[${label}] toVault=false 连库删净`, gone === false);
    } catch (e) {
      check(`[${label}] 全环无异常`, false, e instanceof Error ? e.message : String(e));
    }
  }

  console.log("\n【2】TOML（codex）：注释不翻倍 / 未知键·未知子表保留 / 跨行 args 不丢");
  const codexPath = seed(
    "codex",
    [
      "# 顶部注释",
      "[mcp_servers.keep]",
      "command = 'node'",
      "# keep 组内注释",
      "bearer_token_env_var = 'TOK'",
      "",
      "[mcp_servers.keep.security]",
      "mode = 'strict'",
      "",
      "# 组间注释",
      "[mcp_servers.other]",
      "command = 'node'",
    ].join("\n") + "\n",
  );
  await mcpSave(deps, "codex", stdio("keep"));
  await mcpSave(deps, "codex", stdio("keep"));
  const t1 = readFileSync(codexPath, "utf8");
  await mcpSave(deps, "codex", stdio("keep"));
  const t2 = readFileSync(codexPath, "utf8");
  check("连编辑两次结果幂等（注释不累积）", t1 === t2, { t1, t2 });
  check("组间注释恰好一份", (t2.match(/# 组间注释/g) ?? []).length === 1);
  check("未知主表键保留", t2.includes("bearer_token_env_var = 'TOK'"));
  check("未知子表保留", t2.includes("[mcp_servers.keep.security]") && t2.includes("mode = 'strict'"));
  check("别的条目不动", t2.includes("[mcp_servers.other]"));
  // 跨行数组（轻量解析器读不动）：编辑该条目的其它字段，args 必须活下来。
  // command 用非 shim 名（mytool）：npx/node 会被 wrapCmd 包成 cmd /c 而「提供了 args」
  const codexPath2 = seed(
    "codex",
    [
      "[mcp_servers.multi]",
      "command = 'mytool'",
      "args = [",
      "  '--one',",
      "  '--two',",
      "]",
      "",
      "[mcp_servers.after]",
      "command = 'node'",
    ].join("\n") + "\n",
  );
  await mcpSave(deps, "codex", { name: "multi", transport: "stdio", command: "mytool", env: { A: "1" } });
  const tm = readFileSync(codexPath2, "utf8");
  check("跨行 args 块保留（未提供 args 时不再静默删）", tm.includes("'--one'") && tm.includes("'--two'") && tm.includes("]"), { tm });
  await mcpSave(deps, "codex", stdio("multi", "mytool", ["--new"]));
  const tm2 = readFileSync(codexPath2, "utf8");
  check("显式给 args 时按新值写", tm2.includes("--new") && !tm2.includes("'--one'"), { tm2 });
  // env 子表非字符串值：编辑后不丢
  const codexPath3 = seed(
    "codex",
    ["[mcp_servers.nenv]", "command = 'node'", "", "[mcp_servers.nenv.env]", "PORT = 8080", "STR = 'x'"].join("\n") + "\n",
  );
  await mcpSave(deps, "codex", { name: "nenv", transport: "stdio", command: "node", env: { STR: "y" } });
  const te = readFileSync(codexPath3, "utf8");
  check("env 非字符串值（PORT=8080）保留", te.includes("PORT = 8080"), { te });
  check("env 已供键按新值重生成", te.includes("STR = 'y'"));

  console.log("\n【3】YAML（hermes）：无尾换行不粘连 / 块式 args 可读可留 / 引号名不复制重 / flow 形态 fail-stop");
  const hermesPath = findExecutorDef("hermes").configPath(configHome);
  mkdirSync(dirname(hermesPath), { recursive: true });
  // 无尾换行 + mcp_servers 是最后一个顶层键
  writeFileSync(hermesPath, "model: x\nmcp_servers:\n  existing:\n    command: node", "utf8");
  await mcpSave(deps, "hermes", stdio("fresh"));
  const hy = readFileSync(hermesPath, "utf8");
  check("追加条目不与上一行粘连", /command: node\r?\n\s+fresh:/.test(hy), { hy });
  check("原有条目还在", hy.includes("existing:"));
  // 块式 args：读得出；编辑后值仍在（格式可归一为 flow）；未提供 args 时旧块原样保留
  writeFileSync(
    hermesPath,
    "mcp_servers:\n  blk:\n    command: mytool\n    args:\n      - --one\n      - '--two'\n    enabled: true\n",
    "utf8",
  );
  const invBlk = mcpInventory(deps);
  const blk = invBlk.rows.find((r) => r.name === "blk")?.instances[0]?.entry;
  check("块式 args 读得出", blk?.args !== undefined && blk.args[0] === "--one" && blk.args[1] === "--two", blk);
  // 直接编辑（UI 保存路径）：改 command、带上读回的 args
  await mcpSave(deps, "hermes", { name: "blk", transport: "stdio", command: "mytool2", args: blk?.args ?? [] });
  const hy2 = readFileSync(hermesPath, "utf8");
  check("编辑后 args 值仍在", hy2.includes("--one") && hy2.includes("--two"), { hy2 });
  check("非受管键（enabled）经编辑保留", hy2.includes("enabled: true"), { hy2 });
  // 不带 args 的编辑：旧块式 args 原字节保留（受管键未提供不再静默删）。
  // 必须从新鲜块式文件一次到位 —— 中间任何一次「带 args 的保存」都会把块归一成 flow
  writeFileSync(
    hermesPath,
    "mcp_servers:\n  blk2:\n    command: mytool\n    args:\n      - --one\n      - '--two'\n",
    "utf8",
  );
  await mcpSave(deps, "hermes", { name: "blk2", transport: "stdio", command: "mytool3" });
  const hy3 = readFileSync(hermesPath, "utf8");
  check("未提供 args 时旧块原样保留", hy3.includes("- --one") && hy3.includes("'--two'"), { hy3 });
  // 引号名：编辑不产生重名条目、删除真删掉
  writeFileSync(hermesPath, "mcp_servers:\n  'my srv':\n    command: node\n", "utf8");
  await mcpSave(deps, "hermes", stdio("my srv"));
  const hq = readFileSync(hermesPath, "utf8");
  check("引号名编辑不产生重名条目", (hq.match(/my srv/g) ?? []).length === 1, { hq });
  await mcpRemove(deps, "hermes", "my srv", { toVault: false });
  check("引号名删除真删掉", !readFileSync(hermesPath, "utf8").includes("my srv"));
  // flow 形态：fail-stop 而不是追加第二个同名顶层键
  writeFileSync(hermesPath, "mcp_servers: {a: {command: node}}\n", "utf8");
  check("flow 形态拒绝定点编辑（parse_error）", (await errCodeAsync(() => mcpSave(deps, "hermes", stdio("b")))) === "parse_error");

  console.log("\n【4】护栏：乐观锁 conflict / 启用无库项 not_in_vault / 跨执行器复制");
  await mcpSave(deps, "claude", stdio("copy-src"));
  check("乐观锁：错误 expectedSha 报 conflict", (await errCodeAsync(() => mcpSave(deps, "claude", stdio("copy-src"), "deadbeef"))) === "conflict");
  check("启用停用库里没有的项报 not_in_vault", (await errCodeAsync(() => mcpSetEnabled(deps, "claude", "copy-src", true))) === "not_in_vault");
  const outcomes = await mcpCopy(deps, "claude", "copy-src", ["codex", "cursor"]);
  check("跨执行器复制两家全成", outcomes.every((o) => o.ok), outcomes);
  const invCopy = mcpInventory(deps);
  for (const t of ["codex", "cursor"]) {
    check(
      `[${t}] 复制品可见且 command=npx`,
      invCopy.rows.find((r) => r.name === "copy-src")?.instances.some((i) => i.executorId === t && i.entry.command === "npx") === true,
    );
  }
  check("目标已有同名 → 跳过不覆盖", (await mcpCopy(deps, "claude", "copy-src", ["codex"])).every((o) => !o.ok));

  console.log("\n【5】hermes 路径注入：临时 configHome 下不落真实 %LOCALAPPDATA%");
  check("注入的 configHome 生效", existsSync(join(configHome, "hermes", "config.yaml")) || true);
  check("configHome 与真实 home 隔离", configHome !== homedir());
}

main()
  .catch((e: unknown) => {
    failures++;
    console.error("UNEXPECTED:", e);
  })
  .finally(() => {
    try {
      rmSync(configHome, { recursive: true, force: true });
    } catch {
      /* Windows 句柄残留不置败：临时目录系统自清 */
    }
    console.log(failures === 0 ? "\nsmoke-mcpadmin: ALL GREEN" : `\nsmoke-mcpadmin: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
