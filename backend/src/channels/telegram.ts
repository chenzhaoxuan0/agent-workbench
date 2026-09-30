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

interface TelegramChannelConf {
  kind: "telegram";
  enabled: boolean;
  config: Record<string, string>;
}

interface TgUpdate {
  update_id?: number;
  message?: { chat?: { id?: number }; text?: string };
}

const REPLY_CAP = 3_900; // Telegram 文本消息上限 4096，留余量

export class TelegramGateway {
  private timer: NodeJS.Timeout | null = null;
  private readonly offsets = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly opts: {
      apiBase: string;
      registry: BotRegistry;
      host: RuntimeHost;
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

  /** 扫描全部 bot 定义里启用的 telegram 渠道，逐 bot 轮询 */
  private async tick(): Promise<void> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return;
    }
    for (const bot of bots) {
      const ch = telegramChannel(bot);
      if (ch === null) continue;
      void this.pollBot(bot, ch);
    }
  }

  private async pollBot(bot: BotDefinition, ch: TelegramChannelConf): Promise<void> {
    const token = ch.config["botToken"] ?? "";
    const chatId = ch.config["chatId"] ?? "";
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
      this.enqueue(bot, ch, msg.text);
    }
  }

  /** 单 bot 串行链：前一条处理完才轮到下一条 */
  private enqueue(bot: BotDefinition, ch: TelegramChannelConf, text: string): void {
    const key = bot.id ?? "";
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.handleText(bot, ch, text));
    this.chains.set(key, next);
  }

  private async handleText(bot: BotDefinition, ch: TelegramChannelConf, text: string): Promise<void> {
    const token = ch.config["botToken"] ?? "";
    const chatId = ch.config["chatId"] ?? "";
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
    const r = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, REPLY_CAP) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log.warn("telegram sendMessage failed", { status: r.status });
  }
}

function telegramChannel(bot: BotDefinition): TelegramChannelConf | null {
  const channels = bot.channels as TelegramChannelConf[] | undefined;
  const ch = channels?.find((c) => c?.kind === "telegram" && c.enabled === true);
  return ch ?? null;
}
