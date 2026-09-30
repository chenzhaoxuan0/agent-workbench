/**
 * MCP stdio 入口（docs/08 WP-9）——把 daemon 上的 bot 暴露为 MCP 工具，
 * 任何 MCP 客户端（ZCode / Claude / Cherry…）都能把"问某个 bot 一句"当工具调。
 *
 * 用法：npx tsx src/mcp.ts [--url http://127.0.0.1:5181] [--token <t>]
 * 链路：MCP stdio（换行 JSON-RPC）→ 本进程 → WS → daemon `bot.ask`。
 * 工具：list_bots / ask_bot({botId, text})。
 */

import { createInterface } from "node:readline";
import WebSocket from "ws";

// ---- 参数 ----

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const httpUrl = argOf("url") ?? process.env["AGENT_WORKBENCH_ENDPOINT"] ?? "http://127.0.0.1:5181";
const token = argOf("token") ?? process.env["AGENT_WORKBENCH_TOKEN"] ?? null;
const wsUrl = `${httpUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/ws${token !== null ? `?token=${encodeURIComponent(token)}` : ""}`;

// ---- daemon WS-RPC 客户端（与冒烟脚本同款最小实现） ----

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let ws: WebSocket;
let nextReady: Promise<void>;

function connect(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
    ws.on("message", (data) => {
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof f["id"] === "string") {
        const p = pending.get(f["id"]);
        if (!p) return;
        pending.delete(f["id"]);
        if (f["ok"] === true) p.resolve(f["result"]);
        else p.reject(Object.assign(new Error(String((f["error"] as { message?: string })?.message ?? "rpc failed")), { code: (f["error"] as { code?: string })?.code }));
      }
    });
    ws.on("close", () => {
      for (const p of pending.values()) p.reject(new Error("daemon connection closed"));
      pending.clear();
    });
  });
}
nextReady = connect();

function call<T>(method: string, params: unknown, timeoutMs = 180_000): Promise<T> {
  return nextReady.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = `mcp-${++seq}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v as T); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ v: 1, id, method, params }));
      }),
  );
}

// ---- MCP 工具面 ----

const TOOLS = [
  {
    name: "list_bots",
    description: "列出 daemon 上登记的全部 bot（id / 名称 / 工作目录 / 渠道）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_bot",
    description: "给某个 bot 发一条文本，等它的轮跑完，返回回复全文",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string", description: "bot 的 id（list_bots 可查）" },
        text: { type: "string", description: "要交给 bot 的任务/问题" },
      },
      required: ["botId", "text"],
      additionalProperties: false,
    },
  },
] as const;

async function toolCall(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "list_bots") {
    const bots = await call<Array<Record<string, unknown>>>("bot.list", null);
    return bots
      .map((b) => `- ${String(b["id"])}：${String(b["name"] ?? "")}（${String(b["rootPath"] ?? "")}）`)
      .join("\n");
  }
  if (name === "ask_bot") {
    const r = await call<{ reply: string }>("bot.ask", { botId: args["botId"], text: args["text"] });
    return r.reply;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---- stdio JSON-RPC 循环（MCP 换行帧） ----

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = msg["id"];
  const method = msg["method"];
  if (id === undefined || id === null) return; // notification：忽略
  void (async () => {
    try {
      if (method === "initialize") {
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-workbench", version: "0.1.0" },
        });
        return;
      }
      if (method === "tools/list") {
        respond(id, { tools: TOOLS });
        return;
      }
      if (method === "tools/call") {
        const params = (msg["params"] ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        try {
          const text = await toolCall(params.name ?? "", params.arguments ?? {});
          respond(id, { content: [{ type: "text", text }] });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          respond(id, { isError: true, content: [{ type: "text", text: `出错：${message}` }] });
        }
        return;
      }
      respond(id, {}, new Error(`method not supported: ${String(method)}`));
    } catch (err: unknown) {
      respond(id, undefined, err instanceof Error ? err : new Error(String(err)));
    }
  })();
});

function respond(id: unknown, result: unknown, error?: Error): void {
  process.stdout.write(
    JSON.stringify(
      error === undefined
        ? { jsonrpc: "2.0", id, result }
        : { jsonrpc: "2.0", id, error: { code: -32603, message: error.message } },
    ) + "\n",
  );
}

process.stderr.write(`agent-workbench MCP bridge ready → ${httpUrl}\n`);
