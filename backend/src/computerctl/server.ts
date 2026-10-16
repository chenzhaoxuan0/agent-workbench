/**
 * 电脑控制服务（docs/14 §3）—— daemon 常驻单实例 MCP server + 总闸 + 输入租约。
 *
 * 协议形态：Streamable HTTP 的无状态最小实现（POST /mcp/computer，JSON-RPC 逐条
 * 处理，请求回 JSON、通知回 202）。会话识别用 MCP 标准的 mcp-session-id 头
 * （initialize 未带则生成），它同时就是输入租约的持有者身份。
 *
 * 安全三件套（docs/14 §3.3）：
 * - 总闸：computer-control.json 的 enabled=false（默认）→ 一切工具拒绝；
 * - 输入租约：同一时刻一个持有方，他人得 CONTROLLER_BUSY（借 ZCode 错误语义：
 *   不可重试，需持有方退出或急停）；空闲 120s 自动释放；只读工具不占租约；
 * - 急停：computer_stop 工具 + computerControl.panic RPC（关闸 + 释放租约）。
 *
 * 动作日志：每次 tools/call 记会话/工具/参数摘要/成败/耗时 —— 观测追责，不是审批。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLocalOrigin, isLoopbackAddr } from "../httpd.ts";
import type {
  AcpMcpServer,
  ComputerControlState,
  ComputerLeaseInfo,
  ControlFanoutOutcome,
  McpServerEntry,
} from "../contract.ts";
import {
  COMPUTER_ENTRY_NAME,
  computerMcpUrl,
  controlActions,
  logControlAction,
  readComputerControlConfig,
  writeComputerControlConfig,
} from "../ctrl/store.ts";
import { installComputerControlSkill } from "../ctrl/skills.ts";
import { MCP_EXECUTORS, MCP_UNSUPPORTED_EXECUTORS } from "../mcpadmin/executors.ts";
import { mcpRemove, mcpSave, type McpServiceDeps } from "../mcpadmin/service.ts";
import { log } from "../log.ts";
import {
  createFakeRuntime,
  createNutRuntime,
  type DesktopRuntime,
} from "./runtime.ts";

/** 输入租约空闲 TTL：超过即视为持有方已弃，自动让位 */
const LEASE_TTL_MS = 120_000;

/** 我们唯一实现并回应的 MCP 协议版本（客户端要别的也回这个——不假装支持） */
const MCP_PROTOCOL_VERSION = "2025-06-18";

// ---- 工具面 -----------------------------------------------------------------------

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** true = 只读（screenshot / 尺寸 / 窗口清单），不占输入租约 */
  readonly readOnly?: true;
}

const XY_PROPS = {
  x: { type: "integer", minimum: 0, description: "X 坐标（相对最近一次 computer_screenshot 的图像）" },
  y: { type: "integer", minimum: 0, description: "Y 坐标（相对最近一次 computer_screenshot 的图像）" },
} as const;

const TOOLS: readonly ToolDef[] = [
  {
    name: "computer_screenshot",
    description: "全屏截图（PNG）。返回图像与尺寸；后续所有坐标操作都相对这张图。观察的第一手段。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "computer_screen_size",
    description: "当前屏幕坐标系宽高（与截图同口径）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "computer_click",
    description: "在 (x,y) 点击鼠标左键。",
    inputSchema: { type: "object", properties: { ...XY_PROPS }, required: ["x", "y"], additionalProperties: false },
  },
  {
    name: "computer_double_click",
    description: "在 (x,y) 双击。",
    inputSchema: { type: "object", properties: { ...XY_PROPS }, required: ["x", "y"], additionalProperties: false },
  },
  {
    name: "computer_right_click",
    description: "在 (x,y) 右键点击。",
    inputSchema: { type: "object", properties: { ...XY_PROPS }, required: ["x", "y"], additionalProperties: false },
  },
  {
    name: "computer_drag",
    description: "从 (x1,y1) 按住左键拖到 (x2,y2)。",
    inputSchema: {
      type: "object",
      properties: { x1: { type: "integer", minimum: 0 }, y1: { type: "integer", minimum: 0 }, x2: { type: "integer", minimum: 0 }, y2: { type: "integer", minimum: 0 } },
      required: ["x1", "y1", "x2", "y2"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_scroll",
    description: "在 (x,y) 滚动滚轮。amount 为格数，正数向下、负数向上。",
    inputSchema: {
      type: "object",
      properties: { ...XY_PROPS, amount: { type: "integer", description: "格数，正=向下" } },
      required: ["x", "y", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_type",
    description: "输入文本。中文等非 ASCII 由工具内部走剪贴板粘贴（会覆盖剪贴板），无需特殊处理。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "computer_key",
    description: "按组合键。键名小写、\"+\" 连接，如 \"enter\"、\"ctrl+a\"、\"ctrl+shift+t\"。",
    inputSchema: { type: "object", properties: { combo: { type: "string" } }, required: ["combo"], additionalProperties: false },
  },
  {
    name: "computer_window_list",
    description: "列出可见窗口（句柄 / 标题 / 位置尺寸）。用句柄做窗口激活。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "computer_window_activate",
    description: "激活（前置）一个窗口：按句柄，或按标题精确匹配。",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "integer" }, title: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "computer_stop",
    description: "急停：释放输入租约并中止队列中的动作。持有权被卡住（CONTROLLER_BUSY）时的出路之一。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ---- MCP 消息形状 ------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

export interface ComputerControlService {
  /** RawHttpRoute 的 handle（POST /mcp/computer）；参数少于接口类型是合法的逆变 */
  readonly handleHttp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly getState: () => ComputerControlState;
  readonly setEnabled: (enabled: boolean) => Promise<ComputerControlState>;
  readonly panic: () => Promise<ComputerControlState>;
  readonly acpEntries: () => AcpMcpServer[];
  /** daemon 启动时调：已启用则重写条目对齐当前端口（端口变了条目就成了死 url） */
  readonly boot: () => Promise<void>;
  /** 冒烟用：注入 fake 运行时 */
  readonly setRuntime: (rt: DesktopRuntime | null) => void;
}

export function createComputerControl(
  deps: McpServiceDeps,
  opts: { readonly fakeRuntime?: DesktopRuntime } = {},
): ComputerControlService {
  // ---- 租约 ----
  const lease: { holder: string | null; since: number | null; lastActive: number | null } = {
    holder: null, since: null, lastActive: null,
  };

  /**
   * 输入代际：急停/panic 时递增。已在队列里等着的动作按旧代际拒绝——
   * 否则「急停」放行的正是用户想拦下的整批待执行动作（in-flight 的那一个
   * 原生调用无法中断，是已知边界，docs/14 §3.3）。
   */
  let inputEpoch = 0;

  function releaseLease(): void {
    lease.holder = null;
    lease.since = null;
    lease.lastActive = null;
  }

  /** 占租约：返回 null=拿到；string=给模型的 CONTROLLER_BUSY 文案 */
  function acquireLease(session: string): string | null {
    if (lease.holder !== null && lease.holder !== session) {
      if (lease.lastActive !== null && Date.now() - lease.lastActive > LEASE_TTL_MS) {
        // 持有方超时弃权，让位
      } else {
        const idle = lease.lastActive === null ? "?" : Math.round((Date.now() - lease.lastActive) / 1000);
        return `CONTROLLER_BUSY：输入权正被会话 ${lease.holder} 持有（最近活动 ${idle}s 前）。此错误不可重试——等持有方结束、调用 computer_stop、或在工作台「电脑控制」设置里急停。`;
      }
    }
    if (lease.holder === null || lease.holder !== session) {
      lease.holder = session;
      lease.since = Date.now();
    }
    lease.lastActive = Date.now();
    return null;
  }

  // ---- 运行时（懒加载） ----
  let runtimePromise: Promise<DesktopRuntime> | null = null;
  let runtimeError: string | null = null;
  let injected: DesktopRuntime | null = opts.fakeRuntime ?? null;

  function loadRuntime(): Promise<DesktopRuntime> {
    if (injected !== null) return Promise.resolve(injected);
    if (runtimePromise === null) {
      runtimePromise = createNutRuntime().catch((e: unknown) => {
        runtimeError = e instanceof Error ? e.message : String(e);
        runtimePromise = null; // 下次调用重试（装好依赖后不用重启 daemon）
        throw e;
      });
    }
    return runtimePromise;
  }

  // ---- 工具执行（串行链：物理输入一次一件事） ----
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function argSummary(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return "";
    const parts = keys.slice(0, 6).map((k) => `${k}=${JSON.stringify(args[k]).slice(0, 60)}`);
    return parts.join(" ");
  }

  async function execTool(session: string, name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }> {
    const def = TOOLS.find((t) => t.name === name);
    if (def === undefined) {
      return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
    }
    // 急停是逃生口：不占租约、不受总闸限制（总闸关着它也只是再释放一次租约），
    // 并递增代际把排队中的动作全部作废
    if (name === "computer_stop") {
      const wasHeld = lease.holder !== null;
      releaseLease();
      inputEpoch += 1;
      logControlAction("computer", "tool.computer_stop", `会话 ${session} 急停（${wasHeld ? "释放了租约" : "本就空闲"}，排队动作已作废）`);
      return { content: [{ type: "text", text: "已急停：输入租约已释放，排队中的动作已作废（正在执行的那一个无法中断，但不会再有后续）。" }] };
    }
    if (!readComputerControlConfig().enabled) {
      return { content: [{ type: "text", text: "电脑控制未启用（总闸关闭）。请在工作台「设置 → 电脑控制」开启。" }], isError: true };
    }

    let busy: string | null = null;
    if (def.readOnly !== true) {
      busy = acquireLease(session);
      if (busy !== null) {
        logControlAction("computer", `tool.${name}`, `会话 ${session} 被拒：CONTROLLER_BUSY`);
        return { content: [{ type: "text", text: busy }], isError: true };
      }
    }

    const t0 = Date.now();
    const epoch = inputEpoch;
    try {
      const rt = await loadRuntime();
      const result = await serialize(async () => {
        // 排队期间发生急停（代际已变）：拒绝执行，模型收到明确的取消语义
        if (epoch !== inputEpoch) {
          throw new Error("已急停：该动作在队列中等待时被急停作废，未执行。重新 computer_screenshot 观察现状后再决定下一步。");
        }
        switch (name) {
          case "computer_screenshot": {
            const shot = await rt.screenshot();
            return {
              content: [
                { type: "image", data: shot.pngBase64, mimeType: "image/png" },
                { type: "text", text: `尺寸 ${shot.width}x${shot.height}。后续坐标一律相对本图。` },
              ],
            };
          }
          case "computer_screen_size": {
            const s = await rt.screenSize();
            return { content: [{ type: "text", text: `${s.width}x${s.height}` }] };
          }
          case "computer_click": return { content: [{ type: "text", text: await done(rt.click(intArg(args, "x"), intArg(args, "y"), "left")) }] };
          case "computer_double_click": return { content: [{ type: "text", text: await done(rt.click(intArg(args, "x"), intArg(args, "y"), "double")) }] };
          case "computer_right_click": return { content: [{ type: "text", text: await done(rt.click(intArg(args, "x"), intArg(args, "y"), "right")) }] };
          case "computer_drag": return { content: [{ type: "text", text: await done(rt.drag(intArg(args, "x1"), intArg(args, "y1"), intArg(args, "x2"), intArg(args, "y2"))) }] };
          case "computer_scroll": return { content: [{ type: "text", text: await done(rt.scroll(intArg(args, "x"), intArg(args, "y"), intArg(args, "amount", { negative: true }))) }] };
          case "computer_type": return { content: [{ type: "text", text: await done(rt.typeText(strArg(args, "text"))) }] };
          case "computer_key": return { content: [{ type: "text", text: await done(rt.key(strArg(args, "combo"))) }] };
          case "computer_window_list": {
            const ws = await rt.windows();
            const lines = ws.map((w) => `#${w.handle} 「${w.title}」 ${w.width}x${w.height} @(${w.x},${w.y})`);
            return { content: [{ type: "text", text: lines.length === 0 ? "（无可见窗口）" : lines.join("\n") }] };
          }
          case "computer_window_activate": {
            if (typeof args["handle"] === "number") {
              return { content: [{ type: "text", text: await done(rt.activateWindow(args["handle"])) }] };
            }
            if (typeof args["title"] === "string") {
              const ws = await rt.windows();
              const hit = ws.find((w) => w.title === args["title"]);
              if (hit === undefined) return { content: [{ type: "text", text: `没有标题完全等于「${args["title"]}」的窗口，用 computer_window_list 重查。` }], isError: true };
              return { content: [{ type: "text", text: await done(rt.activateWindow(hit.handle)) }] };
            }
            return { content: [{ type: "text", text: "需要 handle（整数）或 title（字符串）" }], isError: true };
          }
          default:
            return { content: [{ type: "text", text: `工具未实现：${name}` }], isError: true };
        }
      });
      logControlAction("computer", `tool.${name}`, `会话 ${session} · ${argSummary(args)} · ok · ${Date.now() - t0}ms`);
      return result as { content: unknown[] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 失败即弃权：参数错 / 依赖坏 / 被作废，都不该把租约锁满 120s
      if (lease.holder === session) releaseLease();
      logControlAction("computer", `tool.${name}`, `会话 ${session} · ${argSummary(args)} · 失败：${msg}`);
      return { content: [{ type: "text", text: `执行失败：${msg}` }], isError: true };
    }
  }

  // ---- MCP over HTTP ----
  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 来源闸（复审 P1）：这是全 daemon 唯一能动真实键鼠的面，无论 token 配置如何
    // 都只收回环来源——token 关闭 + daemon 绑非回环（AGENT_WORKBENCH_HOST=0.0.0.0）
    // 时 authorize 根本不跑，Origin/Content-Type 两闸又只有浏览器会带，LAN 内任意
    // 脚本裸发 POST 就能点桌面。回环判定自带豁免给本机 CLI 客户端。
    if (!isLoopbackAddr(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32052, message: "computer control endpoint only accepts loopback connections" } }));
      return;
    }
    // 双闸（评审 P0，与 index.ts authorize 的回环豁免构成纵深防御）：
    // - Origin：浏览器跨源 simple request（text/plain POST，无需预检）也能把请求
    //   送到回环端口。CLI 客户端不发 Origin；有 Origin 就必须是本地源，否则任意
    //   网页都能借这条端点点击真实桌面。
    // - Content-Type：MCP 规定 application/json；浏览器想伪造它就必须先过预检，
    //   而 httpd 的预检只放行本地源。
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32050, message: "cross-origin requests are not allowed" } }));
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().startsWith("application/json")) {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32051, message: "content-type must be application/json" } }));
      return;
    }
    // 只服务 POST（Streamable HTTP 的请求通道）；GET/SSE 首版不提供
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 4_000_000) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: -32400, message: "payload too large" } }));
        return;
      }
      chunks.push(c as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32700, message: "parse error" } }));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const headerSession = req.headers["mcp-session-id"];
    const session = typeof headerSession === "string" && headerSession !== "" ? headerSession : null;
    let newSession: string | null = null;

    const out: unknown[] = [];
    for (const m of messages) {
      const msg = (m ?? {}) as JsonRpcMessage;
      if (msg.id === undefined || msg.id === null) {
        continue; // 通知不回包（含 notifications/initialized）
      }
      out.push(await respondOne(msg, session, (s) => (newSession = s)));
    }
    if (out.length === 0) {
      const headers: Record<string, string> = {};
      if (newSession !== null) headers["mcp-session-id"] = newSession;
      res.writeHead(202, headers);
      res.end();
      return;
    }
    const headers: Record<string, string | number> = { "content-type": "application/json" };
    if (session !== null) headers["mcp-session-id"] = session;
    else if (newSession !== null) headers["mcp-session-id"] = newSession;
    const body = Array.isArray(parsed) ? out : out[0];
    res.writeHead(200, headers);
    res.end(JSON.stringify(body));
  };

  async function respondOne(msg: JsonRpcMessage, session: string | null, genSession: (s: string) => void): Promise<unknown> {
    const id = msg.id;
    try {
      if (msg.method === "initialize") {
        if (session === null) genSession(randomUUID());
        return {
          jsonrpc: "2.0", id,
          result: {
            // 只认自己实现的版本：客户端要别的版本也不回声假装支持（MCP 规定
            // 服务器可不支持请求版本，回应自己支持的即可）
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "workbench-computer", version: "0.1.0" },
          },
        };
      }
      if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (msg.method === "tools/list") {
        return {
          jsonrpc: "2.0", id,
          result: {
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          },
        };
      }
      if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "";
        const args = msg.params?.arguments ?? {};
        const r = await execTool(session ?? "anonymous", name, args);
        return { jsonrpc: "2.0", id, result: r };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${String(msg.method)}` } };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  // ---- 扇出 ----
  async function fanout(enabled: boolean): Promise<ControlFanoutOutcome[]> {
    const outcomes: ControlFanoutOutcome[] = [];
    const entry: McpServerEntry = { name: COMPUTER_ENTRY_NAME, transport: "http", url: computerMcpUrl() };
    for (const def of MCP_EXECUTORS) {
      try {
        if (enabled) await mcpSave(deps, def.id, entry);
        else await mcpRemove(deps, def.id, COMPUTER_ENTRY_NAME, { toVault: true });
        outcomes.push({ executorId: def.id, ok: true });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!enabled && code === "not_found") outcomes.push({ executorId: def.id, ok: true });
        else outcomes.push({ executorId: def.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    logControlAction("computer", enabled ? "entry.write" : "entry.remove", `workbench-computer 条目：${
      outcomes.filter((o) => o.ok).length}/${outcomes.length
    } 家${enabled ? "写入" : "移入停用库"}（url=${computerMcpUrl()}）`);
    return outcomes;
  }

  let lastFanout: ControlFanoutOutcome[] = [];

  const applyEnabled = async (enabled: boolean, viaPanic: boolean): Promise<ComputerControlState> => {
    writeComputerControlConfig({ enabled });
    if (!enabled) {
      releaseLease();
      inputEpoch += 1; // 关闸同时作废排队动作（panic 语义的一部分）
    }
    logControlAction("computer", viaPanic ? "panic" : enabled ? "enabled" : "disabled", viaPanic
      ? "急停：总闸关闭 + 租约释放"
      : enabled ? "电脑控制启用（总闸开）" : "电脑控制停用（总闸关 + 租约释放）");
    if (enabled) installComputerControlSkill();
    if (enabled) {
      // 启用即预载运行时：把「依赖没装好」暴露在开闸这一刻，而不是第一次工具调用
      try {
        await loadRuntime();
        runtimeError = null;
      } catch (e) {
        runtimeError = e instanceof Error ? e.message : String(e);
        log.warn("computer runtime failed to load", { error: runtimeError });
      }
    }
    lastFanout = await fanout(enabled);
    return getState();
  };

  function leaseInfo(): ComputerLeaseInfo {
    if (lease.holder === null || (lease.lastActive !== null && Date.now() - lease.lastActive > LEASE_TTL_MS)) {
      return { holder: null, since: null, lastActive: null };
    }
    return { holder: lease.holder, since: lease.since, lastActive: lease.lastActive };
  }

  function getState(): ComputerControlState {
    return {
      config: readComputerControlConfig(),
      lease: leaseInfo(),
      runtimeReady: injected !== null || runtimePromise !== null,
      runtimeError,
      fanout: lastFanout,
      notes: MCP_UNSUPPORTED_EXECUTORS.map((u) => ({
        executorId: u.id,
        note: u.id === "dsh" ? "MCP 随会话动态注入（启用后自动生效）" : u.reason,
      })),
      actions: controlActions().filter((a) => a.domain === "computer").slice(-50),
    };
  }

  return {
    handleHttp,
    getState,
    setEnabled: (enabled) => applyEnabled(enabled, false),
    panic: () => applyEnabled(false, true),
    acpEntries: () => {
      if (!readComputerControlConfig().enabled) return [];
      return [{ name: COMPUTER_ENTRY_NAME, type: "http" as const, url: computerMcpUrl() }];
    },
    boot: async () => {
      // daemon 重启后端口可能变（随机端口冒烟 / 配置改动），已启用的条目会指向死 url：
      // 启动时静默重写对齐当前端点
      if (readComputerControlConfig().enabled) {
        lastFanout = await fanout(true);
        logControlAction("computer", "reconcile", `daemon 启动对齐：条目已重写 → ${computerMcpUrl()}`);
      }
    },
    setRuntime: (rt) => {
      injected = rt;
      runtimeError = null;
    },
  };
}

// ---- 参数收窄（未知形态早报错，不静默转换） ------------------------------------------

function intArg(args: Record<string, unknown>, key: string, opts?: { readonly negative?: boolean }): number {
  const v = args[key];
  // negative 档专给滚轮 amount 这类「正数向下、负数向上」的参数（复审 P1）：
  // 工具契约明说负值合法，一刀切 ≥0 会把向上滚动拒之门外
  if (typeof v !== "number" || !Number.isFinite(v) || (!opts?.negative && v < 0)) {
    throw new Error(`参数 ${key} 必须是${opts?.negative ? "" : " ≥0 的"}整数`);
  }
  return Math.round(v);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return v;
}

/** void 表达式 → 固定回执文本 */
async function done(p: Promise<void>): Promise<string> {
  await p;
  return "完成";
}

export { createFakeRuntime };
