/**
 * docs/07 §四方法表生成器（docs/21 P2）：
 *
 *   自起 daemon（随机端口 + INSECURE）→ POST /rpc { method: "rpc.methods" }
 *   → 按域前缀分组渲染 markdown → 写回 docs/07 的 methods:begin/end 锚点之间。
 *
 * 手工表退役：注册表是唯一真相，docs/07 是生成物。锚点内内容勿手改——
 * 加方法 / 改元数据后重跑 `pnpm -C backend gen:methods`。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.resolve(backendRoot, "..", "docs", "07-wire-protocol.md");
const BEGIN = "<!-- methods:begin（pnpm -C backend gen:methods 生成，勿手改） -->";
const END = "<!-- methods:end -->";

interface MethodDescriptor {
  method: string;
  description?: string;
  paramsHint?: string;
  danger?: string;
}

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

let daemon: ChildProcess | undefined;

async function main(): Promise<void> {
  const port = await freePort();
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOST: "127.0.0.1",
      AGENT_WORKBENCH_INSECURE: "1",
      // 生成器家隔离：daemon 只需 rpc.methods，状态住临时目录不碰真实 ~/.agent-workbench
      AGENT_WORKBENCH_HOME: mkdtempSync(path.join(os.tmpdir(), "aw-gen-home-")),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.on("data", (c: Buffer) => process.stderr.write(`  daemon | ${c}`));

  let methods: MethodDescriptor[] | undefined;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) throw new Error("daemon died during boot");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ v: 1, method: "rpc.methods" }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean; result?: { methods?: MethodDescriptor[] } };
          if (body.ok === true) {
            methods = body.result?.methods;
            break;
          }
        }
      } catch {
        // 还没起来，继续等
      }
      await sleep(200);
    }
  } finally {
    // 生成完就走协议退出，不留孤儿
    if (daemon.exitCode === null) {
      await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, method: "daemon.stop" }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => daemon?.kill("SIGKILL"));
      await sleep(500);
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
  }
  if (methods === undefined) throw new Error("failed to fetch rpc.methods");

  // 按域前缀分组（无点的归「基础」），域内按名排序（rpc.methods 本身已排序，双保险）
  const domains = new Map<string, MethodDescriptor[]>();
  for (const m of methods) {
    const dot = m.method.indexOf(".");
    const domain = dot === -1 ? "基础" : m.method.slice(0, dot);
    const list = domains.get(domain) ?? [];
    list.push(m);
    domains.set(domain, list);
  }

  const cell = (s: string | undefined): string => (s === undefined || s === "" ? "—" : s);
  const lines: string[] = [BEGIN];
  for (const [domain, list] of [...domains.entries()].sort((a, b) => (a[0] === "基础" ? -1 : b[0] === "基础" ? 1 : a[0].localeCompare(b[0])))) {
    lines.push("", `### ${domain}`, "", "| 方法 | 说明 | params | 危险 |", "|---|---|---|---|");
    for (const m of list) {
      lines.push(`| \`${m.method}\` | ${cell(m.description)} | ${cell(m.paramsHint)} | ${m.danger === undefined ? "—" : "⚠️ high"} |`);
    }
  }
  lines.push("", END);
  const generated = lines.join("\n");

  const doc = readFileSync(DOC, "utf8");
  const beginIdx = doc.indexOf(BEGIN);
  const endIdx = doc.indexOf(END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`docs/07 anchors missing or out of order: expected ${BEGIN} before ${END}`);
  }
  const next = doc.slice(0, beginIdx) + generated + doc.slice(endIdx + END.length);
  writeFileSync(DOC, next, "utf8");
  const described = methods.filter((m) => m.description !== undefined).length;
  const danger = methods.filter((m) => m.danger !== undefined).length;
  console.log(`gen: ${methods.length} methods (${domains.size} domains, ${described} described, ${danger} danger) → docs/07 §四`);
}

await main().catch((err: unknown) => {
  console.error("gen: failed", err);
  daemon?.kill("SIGKILL");
  process.exit(1);
});
