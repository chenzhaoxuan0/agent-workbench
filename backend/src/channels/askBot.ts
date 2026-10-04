/**
 * askBot（docs/08 WP-9）——"把一条文本交给某个 bot，等轮落定，拿回全文"的渠道无关内核。
 *
 * telegram 网关 / webhook / MCP 的 ask_bot 三家共用这一条路径；
 * 渠道差异只在外面（怎么进来的、回复送到哪）。
 */

import type { BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { asModelId, asSessionId, asUnitId, type SessionId, type SessionSource } from "../../../prototype/src/core/units.ts";
import type { ModelId } from "../contract.ts";
import { log } from "../log.ts";

export interface BotTurnResult {
  sessionId: string;
  reply: string;
}

/** 每进程的"bot → 最近会话"记忆（续聊优先），各入口共享 */
const lastSession = new Map<string, string>();

/** 读 bot 定义里的主绑定（runtime/model），缺省落 mockperm（注册表校验应拦住无绑定定义） */
export function primaryBinding(bot: BotDefinition): { runtimeId: string; model: ModelId | null } {
  const bindings = bot.bindings as Array<{ runtimeId?: string; modelHint?: string; primary?: boolean }> | undefined;
  const primary = bindings?.find((b) => b?.primary === true) ?? bindings?.[0];
  const runtimeId = typeof primary?.runtimeId === "string" && primary.runtimeId !== "" ? primary.runtimeId : "mockperm";
  const model = typeof primary?.modelHint === "string" && primary.modelHint !== "" ? asModelId(primary.modelHint) : null;
  return { runtimeId, model };
}

/** 一轮对话：续聊优先（resume→send），续不上起新会话（首轮 = 文本）；等 usage（turn 级完成）回全文 */
export async function runBotTurn(
  host: RuntimeHost,
  bot: BotDefinition,
  text: string,
  opts: {
    mode?: "plan" | "build" | "edit" | "yolo";
    waitMs?: number;
    source?: SessionSource;
    /**
     * 轮次一开始（sessionId 一拿到）就回调 —— **不等这一轮跑完**。
     *
     * 存在的理由：飞书流式要在 `message.delta` 到达时就刷 IM，而第一个 delta
     * 在 `startSession` 返回后几毫秒就来。只在函数末尾拿 sessionId 再订阅，
     * 会漏掉开头那一段。
     */
    onTurnStart?: (sessionId: SessionId) => void;
  } = {},
): Promise<BotTurnResult> {
  const unitId = typeof bot.id === "string" ? bot.id : "";
  const rootPath = typeof bot.rootPath === "string" ? bot.rootPath : "";
  if (unitId === "" || rootPath === "") throw Object.assign(new Error("bot definition missing id/rootPath"), { code: "bad_bot" });
  const { runtimeId, model } = primaryBinding(bot);

  // 派发前快照游标（评审 P1）：续聊时环里有上一轮的 usage，等待必须只认这轮的新事件
  let sinceSeq = 0;
  let sessionId: string | null = lastSession.get(unitId) ?? null;
  if (sessionId !== null) {
    try {
      sinceSeq = host.currentSeq(asSessionId(sessionId));
      host.resumeSession(asSessionId(sessionId));
    } catch {
      sessionId = null;
    }
  }
  if (sessionId !== null) {
    try {
      // 续聊路径：钩子必须赶在 sendMessage **之前**（跟新会话同一个道理）
      try {
        opts.onTurnStart?.(asSessionId(sessionId));
      } catch (err: unknown) {
        log.warn("onTurnStart hook threw (turn continues)", { unitId, error: err instanceof Error ? err.message : String(err) });
      }
      host.sendMessage(asSessionId(sessionId), text);
    } catch {
      sessionId = null;
    }
  }
  if (sessionId === null) {
    sinceSeq = 0; // 新会话 seq 从 1 重新起算，旧游标必须作废
    const s = await host.startSession({
      runtimeId,
      unitId: asUnitId(unitId),
      unitName: typeof bot.name === "string" ? bot.name : unitId,
      rootPath,
      prompt: text,
      model,
      mode: opts.mode ?? "yolo", // faceless 渠道无审批面
      // 来源标记：时间轴上据此显示「来自飞书 / 来自 webhook」徽标（docs/09 §六.2）
      source: opts.source ?? "workbench",
      // 新会话路径：同样在 send 之前交出去（startSession 内部保证顺序）
      onSessionReady: opts.onTurnStart === undefined ? undefined : (sid) => opts.onTurnStart?.(sid),
    });
    sessionId = s.id;
  }
  lastSession.set(unitId, sessionId);

  // usage = turn 级完成（与 Ops 同口径）；超时不炸，回已知内容。
  // sinceSeq：续聊时环里必有上一轮 usage，不设游标会立即返回拿旧回复（评审 P1）
  await host.waitForSessionEvent(asSessionId(sessionId), "usage", opts.waitMs ?? 180_000, sinceSeq).catch(() => {});
  const messages = host.sessionMessages(asSessionId(sessionId));
  let reply: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "assistant" && m.text !== "") {
      reply = m.text;
      break;
    }
  }
  log.info("bot turn done", { bot: unitId, sessionId, replyLen: reply?.length ?? 0 });
  return { sessionId, reply: reply ?? "(空回复)" };
}

/** 供 webhook/MCP 的入口：按 botId 查定义后跑一轮 */
export async function askBot(
  registry: import("../bots/registry.ts").BotRegistry,
  host: RuntimeHost,
  botId: string,
  text: string,
  opts?: { mode?: "plan" | "build" | "edit" | "yolo"; waitMs?: number; source?: SessionSource },
): Promise<BotTurnResult> {
  const bot = await registry.getBot(botId);
  if (bot === undefined) throw Object.assign(new Error(`no such bot: ${botId}`), { code: "unknown_bot" });
  return runBotTurn(host, bot, text, opts);
}
