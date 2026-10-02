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
        try {
          const { reply } = await runBotTurn(this.#host, bot, msg.text);
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
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += REPLY_CAP) chunks.push(text.slice(i, i + REPLY_CAP));
    if (chunks.length === 0) chunks.push("(空回复)");
    for (const chunk of chunks) {
      try {
        await this.#client.im.message.reply({
          path: { message_id: msg.messageId },
          data: { content: JSON.stringify({ text: chunk }), msg_type: "text" },
        });
      } catch (err: unknown) {
        log.warn("feishu reply failed", { bot: this.#spec.botId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

/**
 * 飞书网关：定期比对盘上 bot 定义与在跑的账号，多退少进。
 *
 * 这个「reconcile」是刻意加的——以前 Telegram 网关是启动时无条件 start、之后永不
 * 变化，bot.json 改完渠道不生效。渠道既然由 bot.json 声明，它的生命周期就必须跟着
 * bot.json 走。
 */
export class FeishuGateway {
  readonly #runners = new Map<string, AccountRunner>();
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
      log.info("feishu account stopped", { account: key });
    }

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
  // 本实现只处理文本。其他类型（图片/文件/富文本）直接不接，不是 bug 是范围。
  if (messageType !== "text") return null;

  const sender = d["sender"] as AnyRecord | undefined;
  // sender_type=app 是应用（含机器人自己）发出的消息。飞书正常不会把 bot 自己发的
  // 推回给它，但群聊 @ 别人时事件会扇出——用事件自带字段过滤，不为此多打一次 API。
  if (str(sender?.["sender_type"]) === "app") return null;
  const senderId = (sender?.["sender_id"] ?? {}) as AnyRecord;
  const senderOpenId = str(senderId["open_id"]);

  let text = "";
  try {
    const parsed = JSON.parse(str(message["content"])) as AnyRecord;
    text = str(parsed["text"]);
  } catch {
    return null;
  }
  if (text.trim() === "") return null;

  const rawMentions = Array.isArray(message["mentions"]) ? (message["mentions"] as AnyRecord[]) : [];
  const mentions = rawMentions
    .map((m) => {
      const id = m["id"];
      return str(id !== null && typeof id === "object" ? (id as AnyRecord)["open_id"] : id);
    })
    .filter((s) => s !== "");

  return {
    messageId,
    chatId,
    chatType: str(message["chat_type"]),
    messageType,
    // 群里 @ 机器人的那串 @占位符去掉，别让模型看到 "@_user_1 帮我查一下"
    text: stripMentions(text, rawMentions),
    senderOpenId,
    mentions,
  };
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
