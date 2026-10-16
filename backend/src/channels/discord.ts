/**
 * Discord 渠道网关 —— 基于原生 WebSocket Gateway v10 + REST 实现。
 *
 * 遵循轻量与零依赖膨胀原则（参考 Hermes Agent）：
 * 1. 借助 Node 原生 fetch 与内置 ws 库直接建立 Discord Gateway 长连接；
 * 2. 接收私聊及被 @ 的频道消息，驱动 runBotTurn 执行；
 * 3. 敏感操作通过 Discord Message Components（交互式按钮）下发审批，
 *    用户点击按钮在手机/桌面 Discord 实时裁决确认门。
 */

import { WebSocket } from "ws";
import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import type { CredentialVault } from "../credentials/vault.ts";
import { resolveSecret } from "../credentials/vault.ts";
import { runBotTurn } from "./askBot.ts";
import type { RuntimeEvent } from "../../../prototype/src/core/events.ts";
import { log } from "../log.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

interface DiscordAccountSpec {
  readonly key: string;
  readonly botId: string;
  readonly botToken: string;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly interactiveApproval: boolean;
}

interface DiscordClientSession {
  ws: WebSocket;
  heartbeatTimer: NodeJS.Timeout | null;
  seq: number | null;
  botUserId?: string;
  reconnectTimer?: NodeJS.Timeout;
}

export class DiscordGateway {
  private timer: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<string, DiscordClientSession>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly opts: {
      registry: BotRegistry;
      host: RuntimeHost;
      vault?: CredentialVault;
      pollMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.opts.pollMs ?? 5000;
    this.timer = setInterval(() => void this.reconcile(), pollMs);
    this.timer.unref();
    void this.reconcile();
    log.info("discord gateway started");
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const [key, session] of this.sessions.entries()) {
      this.closeSession(key, session);
    }
    this.sessions.clear();
  }

  get activeAccountCount(): number {
    return this.sessions.size;
  }

  private closeSession(key: string, session: DiscordClientSession): void {
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    try {
      session.ws.close(1000);
    } catch {
      // ignore
    }
  }

  private async resolveAccounts(): Promise<DiscordAccountSpec[]> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return [];
    }
    const specs: DiscordAccountSpec[] = [];
    for (const bot of bots) {
      const botId = typeof bot.id === "string" ? bot.id : "";
      if (!botId || !Array.isArray(bot.channels)) continue;
      for (const ch of bot.channels as Array<Record<string, unknown>>) {
        if (ch?.["kind"] !== "discord" || ch["enabled"] !== true) continue;
        const accounts = Array.isArray(ch["accounts"]) && ch["accounts"].length > 0 ? ch["accounts"] : [ch["config"] ?? {}];
        for (const rawAcc of accounts as Array<Record<string, unknown>>) {
          const id = typeof rawAcc["id"] === "string" && rawAcc["id"] !== "" ? rawAcc["id"] : "main";
          let token = "";
          if (this.opts.vault) {
            token = await resolveSecret(
              (rawAcc["secretRef"] as never) ?? rawAcc["botToken"] ?? (rawAcc["botTokenEnv"] ? { source: "env", id: String(rawAcc["botTokenEnv"]) } : undefined),
              this.opts.vault,
              bot.rootPath,
            );
          } else {
            const envName = rawAcc["botTokenEnv"];
            token = typeof rawAcc["botToken"] === "string" && rawAcc["botToken"] !== ""
              ? rawAcc["botToken"]
              : typeof envName === "string" && envName !== ""
                ? process.env[envName] ?? ""
                : "";
          }
          if (!token) continue;
          specs.push({
            key: `${botId}::${id}`,
            botId,
            botToken: token,
            guildId: typeof rawAcc["discordGuildId"] === "string" ? rawAcc["discordGuildId"] : undefined,
            channelId: typeof rawAcc["discordChannelId"] === "string" ? rawAcc["discordChannelId"] : undefined,
            interactiveApproval: rawAcc["interactiveApproval"] !== false,
          });
        }
      }
    }
    return specs;
  }

  private async reconcile(): Promise<void> {
    const specs = await this.resolveAccounts();
    const activeKeys = new Set(specs.map((s) => s.key));

    // 关闭失效的会话
    for (const [key, session] of this.sessions.entries()) {
      if (!activeKeys.has(key)) {
        log.info("closing removed discord session", { key });
        this.closeSession(key, session);
        this.sessions.delete(key);
      }
    }

    // 启动新的连接
    for (const spec of specs) {
      if (!this.sessions.has(spec.key)) {
        this.connectSpec(spec);
      }
    }
  }

  private connectSpec(spec: DiscordAccountSpec): void {
    const cleanToken = spec.botToken.replace(/^Bot\s+/i, "").trim();
    const ws = new WebSocket(DISCORD_GATEWAY_URL);

    const session: DiscordClientSession = {
      ws,
      heartbeatTimer: null,
      seq: null,
    };
    this.sessions.set(spec.key, session);

    ws.on("open", () => {
      log.info("discord gateway socket connected", { key: spec.key });
    });

    ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString()) as { op: number; d: unknown; s?: number; t?: string };
        if (payload.s !== undefined) session.seq = payload.s;

        // OP 10: Hello -> 发送心跳并 IDENTIFY
        if (payload.op === 10) {
          const helloData = payload.d as { heartbeat_interval: number };
          const interval = helloData.heartbeat_interval;
          session.heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: session.seq }));
            }
          }, interval);

          // 发送 IDENTIFY
          const identifyPayload = {
            op: 2,
            d: {
              token: `Bot ${cleanToken}`,
              // GUILDS (1) | GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096) | MESSAGE_CONTENT (32768)
              intents: 1 | 512 | 4096 | 32768,
              properties: {
                os: process.platform,
                browser: "agent-workbench",
                device: "agent-workbench",
              },
            },
          };
          ws.send(JSON.stringify(identifyPayload));
        }

        // OP 11: Heartbeat ACK
        if (payload.op === 11) {
          // ACK received
        }

        // OP 0: Dispatch
        if (payload.op === 0) {
          if (payload.t === "READY") {
            const readyData = payload.d as { user?: { id: string; username: string } };
            session.botUserId = readyData.user?.id;
            log.info("discord gateway ready", { key: spec.key, username: readyData.user?.username });
          } else if (payload.t === "MESSAGE_CREATE") {
            void this.handleMessageCreate(spec, session, payload.d as Record<string, unknown>);
          } else if (payload.t === "INTERACTION_CREATE") {
            void this.handleInteractionCreate(spec, payload.d as Record<string, unknown>);
          }
        }
      } catch (err) {
        log.warn("discord gateway parse error", { error: String(err) });
      }
    });

    ws.on("close", (code) => {
      log.warn("discord gateway socket closed", { key: spec.key, code });
      this.closeSession(spec.key, session);
      this.sessions.delete(spec.key);
      // 5秒后尝试重连
      session.reconnectTimer = setTimeout(() => void this.reconcile(), 5000);
    });

    ws.on("error", (err) => {
      log.warn("discord gateway socket error", { key: spec.key, error: err.message });
    });
  }

  private async handleMessageCreate(
    spec: DiscordAccountSpec,
    session: DiscordClientSession,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const author = (msg.author ?? {}) as Record<string, unknown>;
    if (author.bot === true) return; // 忽略自身与其他机器人消息

    const channelId = String(msg.channel_id ?? "");
    const guildId = msg.guild_id ? String(msg.guild_id) : undefined;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content || !channelId) return;

    // 频道限定过滤
    if (spec.channelId && channelId !== spec.channelId) return;
    if (spec.guildId && guildId !== spec.guildId) return;

    // 如果在群频道中，只在被 @ 或为私聊时响应
    const botId = session.botUserId;
    const isDirect = !guildId;
    const isMentioned = botId ? content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`) : false;
    if (!isDirect && !isMentioned) return;

    // 清洗文本中的 @ 机器人口令
    const cleanText = botId ? content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim() : content;
    if (!cleanText) return;

    const prev = this.chains.get(spec.key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.processTurn(spec, channelId, cleanText));
    this.chains.set(spec.key, next);
  }

  private async processTurn(spec: DiscordAccountSpec, channelId: string, text: string): Promise<void> {
    const bot = await this.opts.registry.getBot(spec.botId);
    if (!bot) return;

    // 发送 typing 状态
    void this.sendTyping(spec.botToken, channelId);

    try {
      const { reply } = await runBotTurn(this.opts.host, bot, text, {
        source: "discord",
        mode: spec.interactiveApproval ? "build" : "yolo",
        // 交互审批位：不开它，host 对非 workbench 来源一律自动放行，
        // 下面的 Components 按钮就只是装饰品（复审 P0）
        interactive: spec.interactiveApproval,
        onTurnStart: (sessionId) => {
          if (spec.interactiveApproval) {
            this.opts.host.onSessionEvent(sessionId, "permission.requested", (ev) => {
              const event = ev as Extract<RuntimeEvent, { type: "permission.requested" }>;
              void this.sendApprovalButtons(
                spec.botToken,
                channelId,
                sessionId,
                event.requestId,
                event.kind,
                event.detail,
              );
            });
          }
        },
      });

      if (reply) {
        await this.sendDiscordText(spec.botToken, channelId, reply);
      }
    } catch (err: unknown) {
      await this.sendDiscordText(spec.botToken, channelId, `出错了：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleInteractionCreate(spec: DiscordAccountSpec, interaction: Record<string, unknown>): Promise<void> {
    // Type 3: MESSAGE_COMPONENT (Button 点击)
    const type = interaction.type;
    const data = (interaction.data ?? {}) as Record<string, unknown>;
    const customId = typeof data.custom_id === "string" ? data.custom_id : "";
    const interactionId = String(interaction.id ?? "");
    const token = String(interaction.token ?? "");

    if (type === 3 && customId.startsWith("perm:")) {
      const parts = customId.split(":");
      const sessionId = parts[1];
      const requestId = parts[2];
      const decision = parts[3] as "allow" | "deny" | "always";
      if (sessionId && requestId && decision) {
        try {
          await this.opts.host.resolvePermission(sessionId as never, requestId, decision);
          // 响应回调，更新消息移除按钮
          await this.updateInteractionMessage(
            interactionId,
            token,
            `✅ 审批已完成：[${decision === "allow" ? "允许本次" : decision === "deny" ? "拒绝本次" : "永久允许"}]`,
          );
        } catch (err: unknown) {
          log.warn("discord resolvePermission failed", { error: String(err) });
        }
      }
    }
  }

  private async sendTyping(botToken: string, channelId: string): Promise<void> {
    try {
      await fetch(`${DISCORD_API_BASE}/channels/${channelId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken.replace(/^Bot\s+/i, "")}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 忽略
    }
  }

  private async sendApprovalButtons(
    botToken: string,
    channelId: string,
    sessionId: string,
    requestId: string,
    kind: string,
    detail: string,
  ): Promise<void> {
    try {
      const body = {
        content: `⚠️ **【操作审批】**\n任务需要执行以下敏感操作：\n**类别**: \`${kind}\`\n**详情**: \`${detail}\``,
        components: [
          {
            type: 1, // ActionRow
            components: [
              {
                type: 2, // Button
                style: 3, // Success / Green
                label: "允许 (Allow)",
                custom_id: `perm:${sessionId}:${requestId}:allow`,
              },
              {
                type: 2,
                style: 4, // Danger / Red
                label: "拒绝 (Deny)",
                custom_id: `perm:${sessionId}:${requestId}:deny`,
              },
              {
                type: 2,
                style: 1, // Primary / Blurple
                label: "永久允许 (Always)",
                custom_id: `perm:${sessionId}:${requestId}:always`,
              },
            ],
          },
        ],
      };
      await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken.replace(/^Bot\s+/i, "")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.warn("discord sendApprovalButtons failed", { error: String(err) });
    }
  }

  private async updateInteractionMessage(interactionId: string, token: string, newContent: string): Promise<void> {
    try {
      await fetch(`${DISCORD_API_BASE}/interactions/${interactionId}/${token}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: 7, // UPDATE_MESSAGE
          data: {
            content: newContent,
            components: [], // 清空按钮
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.warn("discord updateInteractionMessage failed", { error: String(err) });
    }
  }

  private async sendDiscordText(botToken: string, channelId: string, text: string): Promise<void> {
    const cleanToken = botToken.replace(/^Bot\s+/i, "");
    // Discord 单条消息限制 2000 字符
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 1900) {
      chunks.push(text.slice(i, i + 1900));
    }
    if (chunks.length === 0) chunks.push("(空回复)");

    for (const chunk of chunks) {
      // 内部必须捕获（复审 P1）：本函数常被 processTurn 的 catch 分支调用——
      // 网络故障时那里再 reject 就是 unhandled rejection，Node ≥15 直接掀翻 daemon。
      // telegram/weixin 的同类发送都有内部捕获，唯独这里裸奔。
      try {
        const resp = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${cleanToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: chunk }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) log.warn("discord message send failed", { status: resp.status, channelId });
      } catch (err: unknown) {
        log.warn("discord message send failed", { channelId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
