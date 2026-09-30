/**
 * askBot（docs/08 WP-9）——"把一条文本交给某个 bot，等轮落定，拿回全文"的渠道无关内核。
 *
 * telegram 网关 / webhook / MCP 的 ask_bot 三家共用这一条路径；
 * 渠道差异只在外面（怎么进来的、回复送到哪）。
 */

import type { BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { asModelId, asSessionId, asUnitId } from "../../../prototype/src/core/units.ts";
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
  opts: { mode?: "plan" | "build" | "edit" | "yolo"; waitMs?: number } = {},
): Promise<BotTurnResult> {
  const unitId = typeof bot.id === "string" ? bot.id : "";
  const rootPath = typeof bot.rootPath === "string" ? bot.rootPath : "";
  if (unitId === "" || rootPath === "") throw Object.assign(new Error("bot definition missing id/rootPath"), { code: "bad_bot" });
  const { runtimeId, model } = primaryBinding(bot);

  let sessionId: string | null = lastSession.get(unitId) ?? null;
  if (sessionId !== null) {
    try {
      host.resumeSession(asSessionId(sessionId));
    } catch {
      sessionId = null;
    }
  }
  if (sessionId !== null) {
    try {
      host.sendMessage(asSessionId(sessionId), text);
    } catch {
      sessionId = null;
    }
  }
  if (sessionId === null) {
    const s = await host.startSession({
      runtimeId,
      unitId: asUnitId(unitId),
      unitName: typeof bot.name === "string" ? bot.name : unitId,
      rootPath,
      prompt: text,
      model,
      mode: opts.mode ?? "yolo", // faceless 渠道无审批面
    });
    sessionId = s.id;
  }
  lastSession.set(unitId, sessionId);

  // usage = turn 级完成（与 Ops 同口径）；超时不炸，回已知内容
  await host.waitForSessionEvent(asSessionId(sessionId), "usage", opts.waitMs ?? 180_000).catch(() => {});
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
  opts?: { mode?: "plan" | "build" | "edit" | "yolo"; waitMs?: number },
): Promise<BotTurnResult> {
  const bot = await registry.getBot(botId);
  if (bot === undefined) throw Object.assign(new Error(`no such bot: ${botId}`), { code: "unknown_bot" });
  return runBotTurn(host, bot, text, opts);
}
