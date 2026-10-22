/**
 * AI-native P4a 验收（docs/21 §2 P4a）：session.chat 编排上移。
 *
 *   自起 daemon（随机端口 + INSECURE）→ POST /rpc session.chat（mockperm 执行器）：
 *   首轮（带附件路径）→ 附件在 daemon 侧内联进 prompt（session.messages 验）→
 *   二轮自动续聊（同 sessionId）→ 显式 sessionId 续聊 → newSession 开新段且谱系延续
 *   （conversationId 相同）→ 附件不可读报 attachment_missing →
 *   session.start 直带 attachments 同样内联（GUI 改薄的通路）。
 *
 * 用法：cd backend && pnpm smoke:ai-native-chat
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      daemonOutput.push(chunk.toString().trimEnd());
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

interface RpcEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

async function rpc(port: number, method: string, params: unknown): Promise<RpcEnvelope> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as RpcEnvelope;
}

interface ChatResult {
  sessionId: string;
  reply: string;
  status: "done" | "timeout";
  continued: boolean;
  model: string | null;
  modelOrigin: string;
  runtimeId: string;
}

interface Message {
  at: number;
  role: string;
  text: string;
}

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "aw-chat-"));
  const unitRoot = path.join(tmp, "unit");
  mkdirSync(path.join(unitRoot, ".agent-workbench"), { recursive: true });
  const notes = path.join(tmp, "notes.md");
  writeFileSync(notes, "# 备注\n内联内容标记 X7Q-ATTACH-MARKER\n");

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. 首轮：附件路径内联 + 轮落定回全文
    const first = await rpc(port, "session.chat", {
      unitId: "u-chat-smoke",
      unitName: "Chat Smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "第一轮，读一下附件",
      attachments: [notes],
      waitMs: 30_000,
    });
    const r1 = first.result as ChatResult | undefined;
    check(
      "first turn settles with a reply",
      first.ok === true && r1?.status === "done" && typeof r1?.reply === "string" && r1.reply !== "" && r1.continued === false,
      first,
    );

    // 2. 内联事实：daemon 组装的 prompt 进了用户消息（GUI 同一条路）
    const msgs1 = (await rpc(port, "session.messages", { sessionId: r1?.sessionId })).result as Message[] | undefined;
    const userTurn1 = [...(msgs1 ?? [])].reverse().find((m) => m.role === "user");
    check(
      "attachment inlined daemon-side into the prompt",
      userTurn1 !== undefined && userTurn1.text.includes("--- 附件文件: notes.md ---") && userTurn1.text.includes("X7Q-ATTACH-MARKER"),
      userTurn1,
    );

    // 3. 二轮：mockperm 每轮结束会话（session.ended，一次性执行器）——台账判定
    //    死段不可续 → 开新段，谱系延续根段（conversationId 缺省 = 自身 id，units.ts）
    const second = await rpc(port, "session.chat", {
      unitId: "u-chat-smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "第二轮",
      waitMs: 30_000,
    });
    const r2 = second.result as ChatResult | undefined;
    check(
      "one-shot executor: dead segment → fresh segment (same lineage)",
      second.ok === true && r2?.status === "done" && r2?.reply !== "" && r2?.sessionId !== r1?.sessionId && r2?.continued === false,
      second,
    );

    // 4. 显式指向已终结段：mockperm 有 reattach，显式指定即可接回（自动选段不挑死段、
    //    显式才接——与 GUI retention「已终结的段不自动续」同一语义）
    const third = await rpc(port, "session.chat", {
      sessionId: r1?.sessionId,
      unitId: "u-chat-smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "显式指回第一段",
      waitMs: 30_000,
    });
    const r3 = third.result as ChatResult | undefined;
    check("explicit sessionId reattaches the ended segment", third.ok === true && r3?.sessionId === r1?.sessionId && r3?.continued === true, third);

    // 5. newSession：显式开新段
    const fresh = await rpc(port, "session.chat", {
      unitId: "u-chat-smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "强制新段",
      newSession: true,
      waitMs: 30_000,
    });
    const r5 = fresh.result as ChatResult | undefined;
    check("newSession opens a fresh segment", fresh.ok === true && r5?.sessionId !== r2?.sessionId, fresh);

    // 6. 谱系一致性：四段（r1 根 + r2/r3/r5 后继）同一条 conversationId
    const sessions = (await rpc(port, "session.list", null)).result as Array<{ id: string; conversationId?: string }> | undefined;
    const convOf = (id: string | undefined): string | undefined => {
      const s = sessions?.find((x) => x.id === id);
      return s !== undefined ? (s.conversationId ?? s.id) : undefined;
    };
    check(
      "all segments share one conversationId (root defaults to its own id)",
      convOf(r1?.sessionId) !== undefined &&
        convOf(r2?.sessionId) === convOf(r1?.sessionId) &&
        convOf(r3?.sessionId) === convOf(r1?.sessionId) &&
        convOf(r5?.sessionId) === convOf(r1?.sessionId),
      { r1: convOf(r1?.sessionId), r2: convOf(r2?.sessionId), r3: convOf(r3?.sessionId), r5: convOf(r5?.sessionId) },
    );

    // 7. 附件不可读：结构化错误（attachment_missing）
    const missing = await rpc(port, "session.chat", {
      unitId: "u-chat-smoke",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      text: "带坏附件",
      attachments: [path.join(tmp, "no-such-file.txt")],
      waitMs: 30_000,
    });
    check("unreadable attachment fails with attachment_missing", missing.ok === false && missing.error?.code === "attachment_missing", missing);

    // 7. session.start 直带 attachments（GUI 改薄的通路）
    const startEnv = await rpc(port, "session.start", {
      runtimeId: "mockperm",
      unitId: "u-chat-smoke-2",
      unitName: "Start Attach",
      rootPath: unitRoot,
      prompt: "直起带附件",
      attachments: [notes],
    });
    const started = startEnv.result as { id?: string } | undefined;
    check("session.start accepts attachments", startEnv.ok === true && typeof started?.id === "string", startEnv);
    const msgs2 = (await rpc(port, "session.messages", { sessionId: started?.id })).result as Message[] | undefined;
    const userTurn2 = [...(msgs2 ?? [])].reverse().find((m) => m.role === "user");
    check(
      "session.start inlines attachments the same way",
      userTurn2 !== undefined && userTurn2.text.includes("X7Q-ATTACH-MARKER"),
      userTurn2,
    );
  } finally {
    await stopDaemon();
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
