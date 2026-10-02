/**
 * Telegram 渠道网关（docs/08 WP-8）——"bot 找得到你"的入站通道第一站。
 *
 * 语义对齐 waku gateway（MIT，waku/gateway/runner.py）：单 bot 串行排队
 * （同一 bot 的消息绝不并发两轮）、轮落定后回全文。渠道是 faceless 的：
 * headless 无审批面，会话固定 yolo（与 cron 自动化同一口径，文档已写明边界）。
 *
 * apiBase 可被 AGENT_WORKBENCH_TELEGRAM_API 覆盖——冒烟用本地 mock Bot API。
 */

import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { runBotTurn } from "./askBot.ts";
import { log } from "../log.ts";

interface TgUpdate {
  update_id?: number;
  message?: { chat?: { id?: number }; text?: string };
}

interface TgAccountSpec {
  readonly key: string;
  readonly botId: string;
  readonly botToken: string;
  readonly chatId: string;
}

const REPLY_CAP = 3_900; // Telegram 文本消息上限 4096，留余量

/** 解析一个 bot 的 telegram 账号。SecretRef（env）与旧明文都认，迁移期兼容。 */
function telegramAccounts(bot: BotDefinition): TgAccountSpec[] {
  const botId = typeof bot.id === "string" ? bot.id : "";
  if (botId === "") return [];
  const channels = bot.channels as unknown;
  if (!Array.isArray(channels)) return [];

  const out: TgAccountSpec[] = [];
  for (const ch of channels as Array<Record<string, unknown> | undefined>) {
    if (ch?.["kind"] !== "telegram" || ch["enabled"] !== true) continue;
    const raw: Array<Record<string, unknown>> =
      Array.isArray(ch["accounts"]) && ch["accounts"].length > 0
        ? (ch["accounts"] as Array<Record<string, unknown>>)
        : [
            {
              id: "default",
              botToken: (ch["config"] as Record<string, unknown> | undefined)?.["botToken"],
              chatId: (ch["config"] as Record<string, unknown> | undefined)?.["chatId"],
            },
          ];
    for (const acc of raw) {
      const token = resolveSecretValue(acc["botToken"]);
      const chatId = typeof acc["chatId"] === "string" ? acc["chatId"] : "";
      const id = typeof acc["id"] === "string" && acc["id"] !== "" ? acc["id"] : "default";
      // 评审 P2：单份畸形 bot.json 不许拖死排在后面的所有 bot
      if (token === "" || chatId === "") {
        log.warn("telegram account skipped: incomplete credentials", { bot: botId, account: id });
        continue;
      }
      out.push({ key: `${botId}::${id}`, botId, botToken: token, chatId });
    }
  }
  return out;
}

/** SecretRef 解析：env 查环境变量；裸字符串当明文认（迁移期兼容） */
function resolveSecretValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return "";
  const r = v as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : "";
  if (id === "") return "";
  if (r["source"] === "env") return process.env[id] ?? "";
  if (r["source"] === "literal") return id;
  return "";
}

export class TelegramGateway {
  private timer: NodeJS.Timeout | null = null;
  private readonly offsets = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 在途轮询锁（评审 P2）：API 变慢时无锁会让同 bot 轮询堆叠、同 offset 被并发取走重复消费 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly opts: {
      apiBase: string;
      registry: BotRegistry;
      host: RuntimeHost;
      /** 轮询间隔。tick() 每轮都重读 bot.json，所以它本身就是 reconcile——渠道改了
       *  最迟一个 pollMs 就生效，不必重启 daemon */
      pollMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.opts.pollMs ?? 1500;
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.timer.unref();
    log.info("telegram gateway started", { apiBase: this.opts.apiBase, pollMs });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 在途轮询中的账号数（channel.status 用；轮询是每 tick 重建的，瞬时值） */
  get activeAccountCount(): number {
    return this.inFlight.size;
  }

  /**
   * 扫盘上的 bot 定义，逐账号轮询。
   *
   * ⚠ 这是「reconcile」而不是「启动时定死」：渠道由 bot.json 声明，用户在设置页改完
   * 渠道保存，下一轮就生效，不必重启 daemon。
   */
  private async tick(): Promise<void> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return;
    }
    for (const bot of bots) {
      // 评审 P2：单份畸形 bot.json 不许拖死排在后面的所有 bot
      try {
        for (const acc of telegramAccounts(bot)) {
          if (this.inFlight.has(acc.botToken)) continue;
          this.inFlight.add(acc.botToken);
          void this.pollBot(bot, acc).finally(() => this.inFlight.delete(acc.botToken));
        }
      } catch (err: unknown) {
        log.warn("telegram channel skipped", { bot: bot.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async pollBot(bot: BotDefinition, acc: TgAccountSpec): Promise<void> {
    const { botToken: token, chatId } = acc;
    if (token === "" || chatId === "") return;
    const offset = this.offsets.get(token) ?? 0;
    let updates: TgUpdate[];
    try {
      const r = await fetch(`${this.opts.apiBase}/bot${token}/getUpdates?timeout=0&offset=${offset}`, {
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json()) as { ok?: boolean; result?: TgUpdate[] };
      if (j.ok !== true || !Array.isArray(j.result)) return;
      updates = j.result;
    } catch (err: unknown) {
      log.debug("telegram getUpdates failed", { bot: bot.id, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const u of updates) {
      if (typeof u.update_id === "number") this.offsets.set(token, u.update_id + 1);
      const msg = u.message;
      if (msg?.text === undefined || msg.chat?.id === undefined) continue;
      if (String(msg.chat.id) !== chatId) continue;
      this.enqueue(bot, acc, msg.text);
    }
  }

  /** 单 bot 串行链：前一条处理完才轮到下一条 */
  private enqueue(bot: BotDefinition, acc: TgAccountSpec, text: string): void {
    const key = bot.id ?? "";
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.handleText(bot, acc, text));
    this.chains.set(key, next);
  }

  private async handleText(bot: BotDefinition, acc: TgAccountSpec, text: string): Promise<void> {
    const { botToken: token, chatId } = acc;
    try {
      const { reply } = await runBotTurn(this.opts.host, bot, text);
      await this.sendTelegram(this.opts.apiBase, token, chatId, reply);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("telegram turn failed", { bot: bot.id, error: message });
      await this.sendTelegram(this.opts.apiBase, token, chatId, `出错了：${message}`).catch(() => {});
    }
  }

  private async sendTelegram(apiBase: string, token: string, chatId: string, text: string): Promise<void> {
    if (token === "" || chatId === "") return;
    // 评审 P3：按 3900 分片循环发，不再静默丢长回复后半段
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += REPLY_CAP) chunks.push(text.slice(i, i + REPLY_CAP));
    if (chunks.length === 0) chunks.push("(空回复)");
    for (const chunk of chunks) {
      const r = await fetch(`${apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) log.warn("telegram sendMessage failed", { status: r.status });
    }
  }
}
