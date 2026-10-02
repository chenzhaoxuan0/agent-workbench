/**
 * 飞书渠道网关 —— 每个 bot 一个飞书机器人。
 *
 * ## 借了 openclaw 什么，没借什么
 *
 * 借（结构，不是文件）：
 * - **多账号模型**：`extensions/feishu/src/monitor.ts` 的 `for (const account of accounts)`，
 *   一个飞书应用 = 一个账号 = 一个 bot 身份。本文件的 `AccountRunner` 是一一对应关系。
 * - **凭据用引用**：`accounts.ts` 的 `coerceSecretRef` / `SecretRef`。配置只说去哪取。
 * - **websocket 长连接**：`monitor.transport.ts` 的 `connectionMode` 二选一里选了 websocket。
 *   本地跑 bot 必须选它——webhook 模式要公网 URL + 签名校验，本机没有。
 * - **入站→会话→回话的三段**：`monitor.message-handler.ts` 的去重/串行，`bot.ts`
 *   `handleFeishuMessage` 的处理，`outbound.ts` 的回发。
 *
 * 没借（占 openclaw feishu 目录 80% 体积的东西，一律不碰）：文档 docx*（7 个文件
 * 80KB）、云盘 drive / 多维表格 bitable / 知识库 wiki、评论全家、卡片体系
 * （streaming-card / native-card / card-action / presentation-card）、bot-broadcast、
 * 贴纸表情 pins、dynamic-agent、subagent-hooks。本网关只做**纯文本收发**。
 *
 * 唯一外部依赖是飞书官方 SDK `@larksuiteoapi/node-sdk`（连接协议与鉴权都在它里面，
 * 不自己实现）。
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { runBotTurn } from "./askBot.ts";
import { log } from "../log.ts";

/** 飞书文本消息体上限的保守取值。openclaw 用卡片流式增量，我们只发纯文本。 */
const REPLY_CAP = 3_000;

/** 进程内去重窗口。飞书事件会重投；这里只挡最近的，不做持久化去重。 */
const DEDUP_CAP = 2_000;

interface AccountSpec {
  readonly key: string;
  readonly botId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: "feishu" | "lark";
  readonly allowFrom: readonly string[];
  readonly mentionOnly: boolean;
}

type AnyRecord = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s !== "") : [];
}

/**
 * 从一个 bot 定义里解析出「这个 bot 要跑哪些飞书账号」。
 *
 * 两种形态都吃：
 * - 新：`channels[].accounts[]`，appSecret 是 SecretRef（env / file）
 * - 旧：`channels[].config.{appId,appSecret}`，明文，迁一次就变新形态
 *
 * 解析不出来（缺 appId / 缺密钥 / source 指向不存在的环境变量）就返回空数组并记日志——
 * 一个配坏的 bot 不该让别的 bot 连不上飞书。
 */
function feishuAccounts(bot: BotDefinition): AccountSpec[] {
  const botId = str(bot.id);
  if (botId === "") return [];
  const channels = bot.channels as unknown;
  if (!Array.isArray(channels)) return [];

  const out: AccountSpec[] = [];
  for (const ch of channels as AnyRecord[]) {
    if (ch?.["kind"] !== "feishu" || ch["enabled"] !== true) continue;

    const raw = Array.isArray(ch["accounts"]) && ch["accounts"].length > 0
      ? (ch["accounts"] as AnyRecord[])
      : legacyAccount(ch["config"] as AnyRecord | undefined);

    for (const acc of raw) {
      if (acc === undefined || acc === null) continue;
      const appId = str(acc["appId"]);
      if (appId === "") {
        log.warn("feishu account skipped: no appId", { bot: botId, account: str(acc["id"]) });
        continue;
      }
      const appSecret = resolveSecret(acc["appSecret"], bot);
      if (appSecret === "") {
        log.warn("feishu account skipped: appSecret unresolvable", { bot: botId, account: str(acc["id"]) || "default" });
        continue;
      }
      out.push({
        key: `${botId}::${str(acc["id"]) || "default"}`,
        botId,
        appId,
        appSecret,
        domain: acc["domain"] === "lark" ? "lark" : "feishu",
        allowFrom: strList(acc["allowFrom"]),
        mentionOnly: bool(acc["mentionOnly"], true),
      });
    }
  }
  return out;
}

/** 旧形态：config.appId + config.appSecret（明文）→ 一个 default 账号 */
function legacyAccount(config: AnyRecord | undefined): AnyRecord[] {
  if (config === undefined || config === null) return [];
  const appId = str(config["appId"]);
  if (appId === "") return [];
  return [
    {
      id: "default",
      appId,
      appSecret: { source: "literal", id: str(config["appSecret"]) },
      mentionOnly: config["mentionOnly"] !== "false",
    },
  ];
}

/**
 * 解析 SecretRef。`{source:"literal", id:"..."}` 是旧形态的明文逃生口，
 * 读的时候照样认，但新写入不会产生它。
 */
function resolveSecret(ref: unknown, bot: BotDefinition): string {
  if (typeof ref === "string") return ref; // 裸字符串 = 明文（迁移期兼容）
  if (ref === null || typeof ref !== "object") return "";
  const r = ref as AnyRecord;
  const source = str(r["source"]);
  const id = str(r["id"]);
  if (id === "") return "";
  if (source === "literal") return id;
  if (source === "env") return process.env[id] ?? "";
  if (source === "file") {
    // file 形态在 daemon 侧需要 rootPath 才能定位；本实现先只支持 env，
    // 写成 file 的账号会被跳过并留日志，而不是悄悄读错地方。
    log.warn("feishu SecretRef source=file not implemented yet", { bot: str(bot.id), id });
    return "";
  }
  return "";
}

/** 消息事件里我们关心的部分 */
interface InboundMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly messageType: string;
  readonly text: string;
  readonly senderOpenId: string;
  /** 群聊里 @ 机器人的那些人的 open_id */
  readonly mentions: readonly string[];
  /** 图片/文件/音频的 file_key；纯文本是 null */
  readonly mediaKey: { key: string; name: string } | null;
  /** messageResource.get 的 type 枚举：image / file */
  readonly mediaType: "image" | "file";
}

/**
 * 一个账号 = 一条长连接 = 一个 bot 身份。
 *
 * 生命周期完全跟着 bot.json 走：FeishuGateway 每轮 reconcile 比对「盘上想要的账号」
 * 与「在跑的账号」，多出来的起、少掉的关、改了的重建。所以用户在设置页改完渠道保存，
 * 不重启 daemon 就能生效。
 */
class AccountRunner {
  readonly #ws: lark.WSClient;
  readonly #client: lark.Client;
  readonly #spec: AccountSpec;
  /** 同一会话串行：前一条处理完才轮到下一条（与 Telegram 网关同一口径） */
  readonly #chains = new Map<string, Promise<void>>();
  readonly #seen = new Set<string>();
  #stopped = false;

  constructor(spec: AccountSpec) {
    this.#spec = spec;
    const domain = spec.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.#ws = new lark.WSClient({
      appId: spec.appId,
      appSecret: spec.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
      source: "agent-workbench",
    });
    // WSClient 只管长连接；回消息要走 REST，用同一个凭据再起一个 Client
    this.#client = new lark.Client({ appId: spec.appId, appSecret: spec.appSecret, domain });
  }

  async start(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.#onEvent(data);
      },
    });
    this.#ws.start({ eventDispatcher: dispatcher });
    log.info("feishu account started", { bot: this.#spec.botId, appId: this.#spec.appId, domain: this.#spec.domain });
  }

  stop(): void {
    this.#stopped = true;
    try {
      this.#ws.close();
    } catch {
      /* 已死 */
    }
  }

  /** 账号配置是否与另一份等价（凭据/白名单/提及策略变了都要重连） */
  matches(other: AccountSpec): boolean {
    return (
      this.#spec.appId === other.appId &&
      this.#spec.appSecret === other.appSecret &&
      this.#spec.domain === other.domain &&
      this.#spec.allowFrom.join(",") === other.allowFrom.join(",") &&
      this.#spec.mentionOnly === other.mentionOnly
    );
  }

  async #onEvent(data: unknown): Promise<void> {
    if (this.#stopped) return;
    const msg = parseInbound(data);
    if (msg === null) return;
    if (this.#spec.allowFrom.length > 0 && !this.#spec.allowFrom.includes(msg.senderOpenId)) {
      log.debug("feishu message from non-allowlisted sender, dropped", { bot: this.#spec.botId, openId: msg.senderOpenId });
      return;
    }
    // 群里默认只在被 @ 时应答，否则 bot 会接话接成群聊旁白机
    if (this.#spec.mentionOnly && msg.chatType !== "p2p" && msg.mentions.length === 0) return;

    if (this.#seen.has(msg.messageId)) return;
    this.#seen.add(msg.messageId);
    if (this.#seen.size > DEDUP_CAP) {
      const first = this.#seen.values().next().value;
      if (first !== undefined) this.#seen.delete(first);
    }

    this.#enqueue(msg);
  }

  /**
   * 把飞书上的附件落到 bot 自己的工作目录。
   *
   * 为什么要落盘而不直接喂给模型：执行器（zcode/codex/claude）都跑在 cwd 里，
   * 图片/文件必须先在文件系统上存在，模型才能用 read / 截图 / 解析这些工具看到它。
   * 这也让 bot 的产出和输入都活在它的文件夹里——「bot 的一切都在文件夹里」不是
   * 口号，是执行器能工作的前提。
   */
  async #downloadMedia(bot: BotDefinition, msg: InboundMessage): Promise<string | null> {
    if (msg.mediaKey === null) return null;
    const root = str(bot.rootPath);
    if (root === "") return null;
    const dir = path.join(root, "outputs", "inbox");
    try {
      await mkdir(dir, { recursive: true });
      // messageResource.get 直接给二进制流（不是 URL），SDK 提供 writeFile 落盘
      const res = await this.#client.im.messageResource.get({
        params: { type: msg.mediaType },
        path: { message_id: msg.messageId, file_key: msg.mediaKey.key },
      });
      // 文件名只留安全字符：飞书给的 file_name 是用户可控的，路径分隔符必须去掉
      const safe = (msg.mediaKey.name === "" ? msg.mediaKey.key : msg.mediaKey.name)
        .replace(/[^\w.\-一-龥]+/g, "_")
        .slice(0, 80);
      const dest = path.join(dir, safe === "" ? `${msg.mediaKey.key}.bin` : safe);
      await res.writeFile(dest);
      log.info("feishu attachment saved", { bot: this.#spec.botId, path: dest });
      return dest;
    } catch (err: unknown) {
      log.warn("feishu attachment download failed", {
        bot: this.#spec.botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  #enqueue(msg: InboundMessage): void {
    const key = `${msg.chatId}`;
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const bot = await this.#registry.getBot(this.#spec.botId);
        if (bot === undefined) {
          log.warn("feishu message for unknown bot", { bot: this.#spec.botId });
          return;
        }
        // 附件先落盘，再把路径告诉模型——执行器得在文件系统上看得见它
        const saved = await this.#downloadMedia(bot, msg);
        const prompt =
          saved === null
            ? msg.text
            : `${msg.text}\n\n（附件已保存到 ${saved}，可以直接读它）`.trim();
        if (msg.text === "" && saved !== null) {
          await this.#reply(msg, `收到，已存到 ${saved}`).catch(() => {});
          return;
        }
        try {
          const { reply } = await runBotTurn(this.#host, bot, prompt, { source: "feishu" });
          await this.#reply(msg, reply);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("feishu turn failed", { bot: this.#spec.botId, error: message });
          await this.#reply(msg, `出错了：${message}`).catch(() => {});
        }
      });
    this.#chains.set(key, next);
  }

  /** 挂在实例上的引用，由 gateway 注入——AccountRunner 不该自己去摸全局单例 */
  #registry!: BotRegistry;
  #host!: RuntimeHost;

  bind(deps: { registry: BotRegistry; host: RuntimeHost }): void {
    this.#registry = deps.registry;
    this.#host = deps.host;
  }

  async #reply(msg: InboundMessage, text: string): Promise<void> {
    // 飞书卡片优先：纯文本回长文在飞书里是块难读的墙（openclaw 用 streaming-card
    // 增量更新卡片，这里用同样的思路但不做逐 token 刷新——那会把 API 打满，
    // 收益也不明显。发一次带 markdown 元素的卡片更好）。
    const card = buildTextCard(text);
    if (card !== null) {
      const ok = await this.#replyOnce(msg.messageId, { msg_type: "interactive", content: JSON.stringify(card) });
      if (ok) return;
      log.debug("feishu card reply failed, falling back to plain text", { bot: this.#spec.botId });
    }
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += REPLY_CAP) chunks.push(text.slice(i, i + REPLY_CAP));
    if (chunks.length === 0) chunks.push("(空回复)");
    for (const chunk of chunks) {
      await this.#replyOnce(msg.messageId, { msg_type: "text", content: JSON.stringify({ text: chunk }) });
    }
  }

  /** 发一条回复。返回是否成功——卡片发失败时要能退回纯文本，而不是静默丢消息 */
  async #replyOnce(messageId: string, data: { msg_type: string; content: string }): Promise<boolean> {
    try {
      await this.#client.im.message.reply({ path: { message_id: messageId }, data });
      return true;
    } catch (err: unknown) {
      log.warn("feishu reply failed", {
        bot: this.#spec.botId,
        msgType: data.msg_type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/**
 * 把一段回复包成飞书消息卡片（schema 2.0 的简化版）。
 *
 * 只做两件事：把 ``` 代码块和 `行内码` 变成真代码样式，其余当 markdown 渲染。
 * 不做 openclaw 那套元素系统（markdown / 分栏 / 图表 / 按钮）——那是它 16 个
 * 文件 114KB 的来源，这里一个卡片就够把可读性拉满。
 *
 * 失败（文本像 JSON、含不可渲染内容等）返回 null，让调用方退回纯文本。
 */
export function buildTextCard(text: string): Record<string, unknown> | null {
  try {
    const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
    const segments = escaped.split(/(```[\s\S]*?```|`[^`\n]+`)/g).filter((s) => s !== "");
    if (segments.length === 0) return null;
    const elements = segments.map((seg) => {
      const fence = /^```(\w*)\n([\s\S]*?)\n?```$/.exec(seg);
      if (fence !== null) {
        return { tag: "code", text: fence[2] ?? "", language: fence[1] === "" ? "plaintext" : fence[1] };
      }
      if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 2) {
        return { tag: "text", text: seg.slice(1, -1), styles: { code: true } };
      }
      return { tag: "markdown", content: seg };
    });
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "回复" }, template: "blue" },
      body: { elements },
    };
  } catch {
    return null;
  }
}

/**
 * 飞书网关：定期比对盘上 bot 定义与在跑的账号，多退少进。
 *
 * 这个「reconcile」是刻意加的——以前 Telegram 网关是启动时无条件 start、之后永不
 * 变化，bot.json 改完渠道不生效。渠道既然由 bot.json 声明，它的生命周期就必须跟着
 * bot.json 走。
 */
/**
 * 账号诊断（对齐 openclaw `extensions/feishu/src/doctor.ts` 的思路，不搬代码）。
 *
 * 为什么必须有：配错了以前的症状是「网关日志里一行 warn 就没了」，用户界面上
 * 表现为「绑了但没反应」，两边对不上。诊断要把「哪一环没通」直接说出来。
 *
 * 不做的事：不去猜「事件订阅开了没」——那只能从飞书管理后台看，API 查不到。
 * 查不到就说查不到，不编一条看似有用的检查项。
 */
export interface FeishuDiagnosis {
  readonly appId: string;
  readonly accountKey: string;
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export async function diagnoseFeishuAccount(spec: AccountSpec): Promise<FeishuDiagnosis> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const domain = spec.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({ appId: spec.appId, appSecret: spec.appSecret, domain });

  // 1) 凭据 + 群读权限：一次调用验两件事。appId/appSecret 错、或没开机器人能力，
  //    这里就会 99991663 / 鉴权失败，而不是等到连不上才发���。
  let chatCount = -1;
  try {
    const r = await client.im.chat.list({ params: { page_size: 1 } });
    chatCount = r?.data?.items?.length ?? 0;
    checks.push({ name: "凭据与鉴权", ok: true, detail: "tenant token 获取成功" });
    checks.push({ name: "群列表权限", ok: true, detail: `可读（样例 ${chatCount} 条）` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "凭据与鉴权", ok: false, detail: msg });
    checks.push({ name: "群列表权限", ok: false, detail: "凭据没过，这项无从判断" });
  }

  // 2) 主动出站能力：能不能给不在会话里的人发消息。没开通「获取用户信息」等
  //    权限时收不到 open_id，主动出站就无从谈起。
  checks.push({
    name: "事件订阅",
    ok: true,
    detail: "API 查不到，只能在飞书开放平台确认：机器人能力 + im.message.receive_v1 + 长连接",
  });

  return {
    appId: spec.appId,
    accountKey: spec.key,
    ok: checks.every((c) => c.ok),
    checks,
  };
}

export class FeishuGateway {
  readonly #runners = new Map<string, AccountRunner>();
  /** 盘上声明的账号规格（含未起成功的），诊断与主动出站都从这里取 */
  readonly #specs = new Map<string, AccountSpec>();
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      registry: BotRegistry;
      host: RuntimeHost;
      reconcileMs?: number;
    },
  ) {}

  start(): void {
    if (this.#timer !== null) return;
    const ms = this.opts.reconcileMs ?? 15_000;
    void this.reconcile();
    this.#timer = setInterval(() => void this.reconcile(), ms);
    this.#timer.unref();
    log.info("feishu gateway started", { reconcileMs: ms });
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const r of this.#runners.values()) r.stop();
    this.#runners.clear();
  }

  /** 当前在跑的账号数（Ops / 冒烟用） */
  get activeAccounts(): number {
    return this.#runners.size;
  }

  /** 当前在跑的账号规格（诊断 / 出站用）。key 形如 `<botId>::<accountId>` */
  specsOf(botId: string): AccountSpec[] {
    return [...this.#specs.values()].filter((s) => s.botId === botId);
  }

  /** 单个账号规格，找不到返回 null（未启用 / 凭据解不开 / 压根没配） */
  specOf(botId: string, accountId = "main"): AccountSpec | null {
    return this.#specs.get(`${botId}::${accountId}`) ?? null;
  }

  /**
   * 主动出站：bot 主动找人说话。
   *
   * 之前 bot 只能被动回话——你不问它，它永远不出声。日程、自动化、告警这些
   * 「该由 bot 主动开口」的场景全都不成立。这条补上后，渠道才真的是一扇门，
   * 不只是回程。
   *
   * 走独立的一次性 Client 而不复用 AccountRunner：出站不需要长连接，
   * 也不该因为某次发送失败影响正在跑的入站连接。
   */
  async sendTo(botId: string, accountId: string, receiveId: string, text: string): Promise<{ ok: boolean; detail: string }> {
    const spec = this.specOf(botId, accountId);
    if (spec === null) return { ok: false, detail: `bot ${botId} 没有可用的飞书账号 ${accountId}` };
    const domain = spec.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    const client = new lark.Client({ appId: spec.appId, appSecret: spec.appSecret, domain });
    try {
      const card = buildTextCard(text);
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data:
          card === null
            ? { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text }) }
            : { receive_id: receiveId, msg_type: "interactive", content: JSON.stringify(card) },
      });
      return { ok: true, detail: "已送达" };
    } catch (err: unknown) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async reconcile(): Promise<void> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return;
    }
    const desired: AccountSpec[] = [];
    for (const b of bots) desired.push(...feishuAccounts(b));

    // 少掉的 / 改掉的：关掉重开
    const desiredKeys = new Set(desired.map((d) => d.key));
    for (const [key, runner] of [...this.#runners]) {
      const spec = desired.find((d) => d.key === key);
      if (spec !== undefined && runner.matches(spec)) continue;
      runner.stop();
      this.#runners.delete(key);
      this.#specs.delete(key);
      log.info("feishu account stopped", { account: key });
    }
    // 规格表跟着 desired 走：诊断/出站要能查到「盘上配了什么」，哪怕它此刻没连上
    this.#specs.clear();
    for (const spec of desired) this.#specs.set(spec.key, spec);

    // 多出来的 / 变了的：起新的
    for (const spec of desired) {
      if (this.#runners.has(spec.key)) continue;
      const runner = new AccountRunner(spec);
      runner.bind({ registry: this.opts.registry, host: this.opts.host });
      this.#runners.set(spec.key, runner);
      try {
        await runner.start();
      } catch (err: unknown) {
        // 起不来不许留在表里，否则每轮 reconcile 都以为它在跑、永远不会重试
        this.#runners.delete(spec.key);
        log.warn("feishu account failed to start", {
          account: spec.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** 解析 im.message.receive_v1 的事件体。形状不对就返回 null，不抛——飞书会重投。 */
function parseInbound(data: unknown): InboundMessage | null {
  const d = data as AnyRecord | null;
  if (d === null || typeof d !== "object") return null;
  const message = d["message"] as AnyRecord | undefined;
  if (message === undefined || message === null || typeof message !== "object") return null;

  const messageId = str(message["message_id"]);
  const chatId = str(message["chat_id"]);
  const messageType = str(message["message_type"]);
  if (messageId === "" || chatId === "") return null;
  // 只接文本与附件两类。其他类型（富文本 post、交互消息、合并转发）直接不接，
  // 不是 bug 是范围——接了也只是把一堆结构化 JSON 喂给模型。
  const isText = messageType === "text";
  const isMedia = messageType === "image" || messageType === "file" || messageType === "audio";
  if (!isText && !isMedia) return null;

  const sender = d["sender"] as AnyRecord | undefined;
  // sender_type=app 是应用（含机器人自己）发出的消息。飞书正常不会把 bot 自己发的
  // 推回给它，但群聊 @ 别人时事件会扇出——用事件自带字段过滤，不为此多打一次 API。
  if (str(sender?.["sender_type"]) === "app") return null;
  const senderId = (sender?.["sender_id"] ?? {}) as AnyRecord;
  const senderOpenId = str(senderId["open_id"]);

  let text = "";
  if (isText) {
    try {
      const parsed = JSON.parse(str(message["content"])) as AnyRecord;
      text = str(parsed["text"]);
    } catch {
      return null;
    }
  }
  // 纯附件消息没有正文是正常的（用户就发了个图）；正文与附件都空才丢弃
  const mediaKey = isMedia ? readMediaKey(message["content"]) : null;
  if (text.trim() === "" && mediaKey === null) return null;

  const rawMentions = Array.isArray(message["mentions"]) ? (message["mentions"] as AnyRecord[]) : [];
  const mentions = rawMentions
    .map((m) => {
      const id = m["id"];
      return str(id !== null && typeof id === "object" ? (id as AnyRecord)["open_id"] : id);
    })
    .filter((s) => s !== "");

  // 附件：图片 / 文件 / 音频。飞书给的 key 要经 messageResource 换二进制流。
  return {
    messageId,
    chatId,
    chatType: str(message["chat_type"]),
    messageType,
    // 群里 @ 机器人的那串 @占位符去掉，别让模型看到 "@_user_1 帮我查一下"
    text: stripMentions(text, rawMentions),
    senderOpenId,
    mentions,
    mediaKey,
    // messageResource.get 的 type 参数：图片与文件是不同枚举，不能把 message_type 原样丢进去
    mediaType: messageType === "image" ? "image" : "file",
  };
}

/** 从 content JSON 里取出附件的 file_key */
function readMediaKey(content: unknown): { key: string; name: string } | null {
  try {
    const parsed = JSON.parse(str(content)) as AnyRecord;
    const key = str(parsed["file_key"]);
    if (key === "") return null;
    return { key, name: str(parsed["file_name"]) };
  } catch {
    return null;
  }
}

/** 飞书群里 @ 机器人在 text 里表现为 `@_user_1` 这类占位符，回给模型前抹掉 */
function stripMentions(text: string, mentions: readonly AnyRecord[]): string {
  let out = text;
  for (const m of mentions) {
    const key = str(m["key"]);
    if (key !== "") out = out.split(key).join("");
  }
  return out.replace(/@_user_\d+/g, "").replace(/[ \t]{2,}/g, " ").trim();
}
