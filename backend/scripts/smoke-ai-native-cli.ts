/**
 * AI-native P3 验收（docs/21 §2 P3）：`aw` CLI 全链。
 *
 *   自起 daemon（随机端口 + 显式 token）→ 用 node 直跑 cli/bin/aw.mjs：
 *   call 回环 / methods 自描述 / 退出码矩阵（3=RPC 错、4=传输错、4=401）/
 *   bot put+list 落盘 / backlog add+list+done / git status（--json）/
 *   doctor。全程无 GUI，headless 纪律（docs/06 §九）。
 *
 * 用法：cd backend && pnpm smoke:ai-native-cli
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AW = path.resolve(backendRoot, "..", "cli", "bin", "aw.mjs");
const TOKEN = "smoke-cli-token-0123456789";

// ---- 小工具（对齐 smoke-ai-native-rpc.ts）-----------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

let daemon: ChildProcess | undefined;
const daemonOutput: string[] = [];

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      daemonOutput.push(text);
    });
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => {
    daemon?.once("exit", (code) => resolve(code));
  });
  daemon.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    daemon.kill("SIGKILL");
    return null;
  }
  return code;
}

async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return false;
}

interface AwResult {
  code: number;
  stdout: string;
  stderr: string;
}

function aw(port: number, args: string[], env: Record<string, string> = {}): Promise<AwResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AW, ...args], {
      cwd: backendRoot,
      env: {
        ...process.env,
        AGENT_WORKBENCH_URL: `http://127.0.0.1:${port}`,
        AGENT_WORKBENCH_TOKEN: TOKEN,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c));
    child.stderr?.on("data", (c: Buffer) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

// ---- 主流程 ---------------------------------------------------------------

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}, aw at ${AW}`);
  startDaemon(port);

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. 透传层：call 回环 + methods 自描述
    const health = await aw(port, ["call", "health"]);
    let healthJson: Record<string, unknown> | undefined;
    try {
      healthJson = JSON.parse(health.stdout) as Record<string, unknown>;
    } catch {
      /* 断言里报 */
    }
    check("aw call health round-trips", health.code === 0 && healthJson?.["name"] === "agent-workbench-daemon", health);

    const methods = await aw(port, ["methods", "--json"]);
    let methodsJson: Array<Record<string, unknown>> | undefined;
    try {
      methodsJson = JSON.parse(methods.stdout) as Array<Record<string, unknown>>;
    } catch {
      /* 断言里报 */
    }
    check("aw methods lists the registry", methods.code === 0 && (methodsJson?.length ?? 0) >= 150, { len: methodsJson?.length });

    const domain = await aw(port, ["methods", "--domain", "git"]);
    check("aw methods --domain filters", domain.code === 0 && domain.stdout.includes("git.status") && !domain.stdout.includes("session.start"));

    // 2. 退出码矩阵：3 = RPC 错、4 = 传输错 / 401
    const unknown = await aw(port, ["call", "definitely_not_a_method"]);
    check("aw exit 3 on rpc error (unknown_method)", unknown.code === 3 && unknown.stderr.includes("unknown_method"), unknown);

    const badJson = await aw(port, ["call", "health", "--params", "{not json"]);
    check("aw exit 2 on bad --params", badJson.code === 2, badJson);

    const dead = await aw(port, ["call", "health"], { AGENT_WORKBENCH_URL: "http://127.0.0.1:1" });
    check("aw exit 4 on dead daemon", dead.code === 4 && dead.stderr.includes("transport"), dead);

    const noAuth = await aw(port, ["call", "health"], { AGENT_WORKBENCH_TOKEN: "wrong-token" });
    check("aw exit 4 on 401 (bad token)", noAuth.code === 4 && noAuth.stderr.includes("401"), noAuth);

    // 3. bot put + list：落盘 roundtrip（docs/21 验收 2 的建 bot 步）
    const tmp = mkdtempSync(path.join(os.tmpdir(), "aw-cli-"));
    const botRoot = path.join(tmp, "bot-a");
    mkdirSync(path.join(botRoot, ".agent-workbench"), { recursive: true });
    const unitFile = path.join(tmp, "unit.json");
    writeFileSync(unitFile, JSON.stringify({
      id: "u-cli-bot",
      rootPath: botRoot,
      name: "CLI Bot",
      kind: "bot",
      bindings: [],
      tags: [],
      channels: [],
    }));
    const put = await aw(port, ["bot", "put", "--file", unitFile]);
    check("aw bot put writes bot.json", put.code === 0 && existsSync(path.join(botRoot, ".agent-workbench", "bot.json")), put);

    const list = await aw(port, ["bot", "list"]);
    check("aw bot list reads it back", list.code === 0 && list.stdout.includes("u-cli-bot") && list.stdout.includes(botRoot), list);

    // 4. backlog add → list → done
    const add = await aw(port, ["backlog", "add", "--goal", "验证 CLI 待办闭环", "--unit", "u-cli-bot", "--root", botRoot, "--title", "CLI 冒烟待办"]);
    let addJson: { id?: number } | undefined;
    try {
      addJson = JSON.parse(add.stdout) as { id?: number };
    } catch {
      /* 断言里报 */
    }
    check("aw backlog add creates an item", add.code === 0 && typeof addJson?.id === "number", add);

    const bl = await aw(port, ["backlog", "list"]);
    check("aw backlog list shows it", bl.code === 0 && bl.stdout.includes(`#${addJson?.id}`), bl);

    // done 的语义是「验收」（确认门闭环的一环）：新建待办不在待验收态，daemon 正确挡回
    // bad_state —— 这里断言 CLI 把这个门槛如实透出（exit 3 + bad_state），再用 delete 清场。
    const done = await aw(port, ["backlog", "done", "--id", String(addJson?.id)]);
    check(
      "aw backlog done enforces the review gate (bad_state on fresh item)",
      done.code === 3 && done.stderr.includes("bad_state"),
      done,
    );
    const del = await aw(port, ["call", "backlog.delete", "--params", JSON.stringify({ id: addJson?.id })]);
    check("aw call backlog.delete cleans up", del.code === 0, del);

    // 5. git status（--json 机器口径；human 口径另眼验）
    const repoRoot = path.join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const gitInit = spawnSync("git", ["init", "-q", "--initial-branch=main", repoRoot], { encoding: "utf8" });
    if (gitInit.status !== 0) {
      check("git init fixture (git 不可用则跳过后续 git 断言)", false, gitInit.stderr);
    } else {
      const gs = await aw(port, ["git", "status", "--root", repoRoot, "--json"]);
      let gsJson: Record<string, unknown> | undefined;
      try {
        gsJson = JSON.parse(gs.stdout) as Record<string, unknown>;
      } catch {
        /* 断言里报 */
      }
      check("aw git status on a fresh repo", gs.code === 0 && gsJson?.["isRepo"] === true && gsJson?.["branch"] === "main", gs);
      const human = await aw(port, ["git", "status", "--root", repoRoot]);
      check("aw git status human output", human.code === 0 && human.stdout.includes("main"), human);
    }

    // 6. doctor
    const doctor = await aw(port, ["doctor"]);
    check("aw doctor reaches daemon", doctor.code === 0 && doctor.stderr.includes("methods") && doctor.stderr.includes("adapters"), doctor);

    // 7. 事件面（docs/21 D4）：补拉（session.events.since）+ 跟随（WS → JSONL）同源同 seq
    const chatTurn = await aw(port, ["call", "session.chat", "--params", JSON.stringify({ unitId: "u-cli-events", rootPath: botRoot, runtimeId: "mockperm", text: "events 验证", waitMs: 30_000 })]);
    let chatSid: string | undefined;
    try {
      chatSid = (JSON.parse(chatTurn.stdout) as { sessionId?: string }).sessionId;
    } catch {
      /* 断言里报 */
    }
    check("aw call session.chat (events fixture)", chatTurn.code === 0 && typeof chatSid === "string", chatTurn);

    const ev = await aw(port, ["events", "--session", String(chatSid), "--since", "0"]);
    const evLines = ev.stdout.trim().split("\n").filter((l) => l !== "");
    let evParsed = 0;
    for (const l of evLines) {
      try {
        JSON.parse(l);
        evParsed++;
      } catch {
        /* 计数 */
      }
    }
    check(
      "aw events catch-up emits parseable JSONL",
      ev.code === 0 && evLines.length >= 4 && evParsed === evLines.length,
      { lines: evLines.length, parsed: evParsed, stderr: ev.stderr.trim() },
    );

    const followRes = await new Promise<{ out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [AW, "events", "--follow"], {
        cwd: backendRoot,
        env: { ...process.env, AGENT_WORKBENCH_URL: `http://127.0.0.1:${port}`, AGENT_WORKBENCH_TOKEN: TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (c: Buffer) => (out += c));
      child.stderr?.on("data", (c: Buffer) => (err += c));
      setTimeout(() => {
        // 跟随挂上后触发一轮新对话，实时帧应当流过来
        void fetch(`http://127.0.0.1:${port}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-awb-token": TOKEN },
          body: JSON.stringify({ v: 1, method: "session.chat", params: { unitId: "u-cli-events", rootPath: botRoot, runtimeId: "mockperm", text: "follow 验证", waitMs: 30_000 } }),
        }).catch(() => undefined);
      }, 1000);
      setTimeout(() => child.kill(), 4500);
      child.on("close", () => resolve({ out, err }));
    });
    const fLines = followRes.out.trim().split("\n").filter((l) => l !== "");
    let fParsed = 0;
    for (const l of fLines) {
      try {
        JSON.parse(l);
        fParsed++;
      } catch {
        /* 计数 */
      }
    }
    check(
      "aw events --follow streams live frames as JSONL",
      fLines.length >= 3 && fParsed === fLines.length && !followRes.err.includes("transport error"),
      { lines: fLines.length, err: followRes.err.trim() },
    );

    // 8. 收尾：daemon 经 aw 停（危险面走 --yes；非 TTY 不受阻的纪律同款）
    const stop = await aw(port, ["--yes", "call", "daemon.stop"]);
    check("aw --yes call daemon.stop", stop.code === 0, stop);
    const exitPromise = new Promise<number | null>((resolve) => {
      daemon?.once("exit", (code) => resolve(code));
    });
    const exitCode = await Promise.race([exitPromise, sleep(8000).then(() => "timeout" as const)]);
    check("daemon exits 0 after aw daemon.stop", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon();
    if (code === null && daemon !== undefined && daemon.exitCode === null) {
      console.error("smoke: daemon did not exit, killed");
    }
  }

  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("smoke: crashed", err);
  void stopDaemon();
  process.exit(1);
});
