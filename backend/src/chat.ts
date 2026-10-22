/**
 * session.chat 编排（docs/21 P4a / D5）—— headless 的「一条命令闭环一轮对话」。
 *
 * 与 GUI run() 的分工是操作/呈现二分（ADR 0015）：
 *   操作（在这里）：附件路径内联、续聊判定、模型解析、等轮落定收全文；
 *   呈现（在 GUI）：活跃会话是视图状态、fork 父段回放、回显登记。
 *
 * 续聊优先级：显式 sessionId > 该单元最近一段（同执行器、live/resumable、未终结，
 * 台账为准——GUI 的 retention 查询同款判定）> 开新段（谱系延续最近一段的
 * conversationId）。resume/send 失败（含 session_not_live）降级开新段，
 * 与 GUI run() 的降级路径同语义。
 *
 * 附件内联格式与前端 run() 完全一致（同一条组装路径，GUI 与 CLI 不分叉）；
 * session.start / session.send 的 `attachments` 参数也走这里的 inlineAttachments。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BotDefinition, BotRegistry } from "./bots/registry.ts";
import type { RuntimeHost } from "./runtime/host.ts";
import {
  asModelId,
  asSessionId,
  asUnitId,
  normalizeContextManifest,
  normalizeSkillBinding,
  type Session,
} from "../../prototype/src/core/units.ts";
import type { ModelId } from "./contract.ts";
import { primaryBinding } from "./channels/askBot.ts";

// ---- 附件内联（与 prototype run() 的拼装格式逐字一致）---------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const TEXT_LIKE_EXT =
  /^(cjs|conf|cpp|cs|css|csv|diff|env|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|patch|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;
/** 单文件文本读取上限：GUI 经 FileReader 全量读，daemon 面向任意路径，超限截断并明示 */
const ATTACHMENT_TEXT_MAX_BYTES = 512 * 1024;

export async function inlineAttachments(paths: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const p of paths) {
    const name = path.basename(p);
    let size = 0;
    try {
      size = (await stat(p)).size;
    } catch {
      throw Object.assign(new Error(`attachment not readable: ${p}`), { code: "attachment_missing", data: { path: p } });
    }
    if (IMAGE_EXT.test(name)) {
      parts.push(`[图片附件: ${name} (本地路径: ${p})]`);
      continue;
    }
    const ext = name.split(".").pop() ?? "";
    if (TEXT_LIKE_EXT.test(ext) || size <= ATTACHMENT_TEXT_MAX_BYTES) {
      const buf = await readFile(p);
      let text =
        buf.byteLength > ATTACHMENT_TEXT_MAX_BYTES
          ? buf.subarray(0, ATTACHMENT_TEXT_MAX_BYTES).toString("utf8") +
            `\n…(截断：原文件 ${buf.byteLength} 字节，读取上限 ${ATTACHMENT_TEXT_MAX_BYTES})`
          : buf.toString("utf8");
      // 含 NUL 判二进制：utf8 文本不会含 \0，别把二进制当文本灌进 prompt
      if (!text.includes("\0")) {
        parts.push(`\n--- 附件文件: ${name} ---\n${text}\n---`);
        continue;
      }
    }
    parts.push(`[附件文件: ${name} (本地路径: ${p})]`);
  }
  return parts.join("\n");
}

export function composePrompt(text: string, inlined: string): string {
  return text.trim() !== "" ? `${text}\n\n${inlined}` : inlined;
}

// ---- 模型解析 ------------------------------------------------------------------

export function resolveChatModel(
  bot: BotDefinition | undefined,
  runtimeId: string,
  explicit: unknown,
): { model: ModelId | null; origin: "explicit" | "binding" | "adapter-default" } {
  if (typeof explicit === "string" && explicit !== "" && explicit !== "auto") {
    return { model: asModelId(explicit), origin: "explicit" };
  }
  const bindings = bot?.bindings as Array<{ runtimeId?: string; modelHint?: string; primary?: boolean }> | undefined;
  const binding = bindings?.find((x) => x?.runtimeId === runtimeId) ?? bindings?.find((x) => x?.primary === true);
  if (typeof binding?.modelHint === "string" && binding.modelHint !== "") {
    return { model: asModelId(binding.modelHint), origin: "binding" };
  }
  // 显式/绑定都没有 → null = 执行器自决（其原生默认值）。GUI 的
  // visible→hint→retired 回退链等模型偏好上移（docs/21 P4d）后在 daemon 侧补全。
  return { model: null, origin: "adapter-default" };
}

// ---- 一轮对话 ------------------------------------------------------------------

export interface ChatParams {
  /** 显式指定续聊段；不存在报 unknown_session */
  sessionId?: string;
  /** 按 bot 定义拿 rootPath / 绑定执行器 / manifest（推荐入口） */
  botId?: string;
  /** 无 bot.json 的单元（项目/临时目录）走这对字段 */
  unitId?: string;
  unitName?: string;
  rootPath?: string;
  runtimeId?: string;
  text: string;
  /** 本地文件路径：daemon 侧读取并内联进 prompt（操作，不在客户端拼） */
  attachments?: string[];
  /** "auto"（缺省）= 执行器自决；显式模型名优先 */
  model?: string;
  mode?: "plan" | "build" | "edit" | "yolo";
  waitMs?: number;
  /** true = 跳过续聊判定强制开新段（谱系延续） */
  newSession?: boolean;
}

export interface ChatResult {
  sessionId: string;
  reply: string;
  /** done = 轮落定（usage 到达）；timeout = 等待超时，reply 是已知内容 */
  status: "done" | "timeout";
  continued: boolean;
  model: string | null;
  modelOrigin: "explicit" | "binding" | "adapter-default";
  runtimeId: string;
}

/** 首个非空字符串（参数解析糖） */
function str(...xs: readonly unknown[]): string | undefined {
  for (const x of xs) {
    if (typeof x === "string" && x !== "") return x;
  }
  return undefined;
}

export async function runChatTurn(
  deps: { host: RuntimeHost; registry: BotRegistry },
  p: ChatParams,
): Promise<ChatResult> {
  let bot: BotDefinition | undefined;
  if (typeof p.botId === "string" && p.botId !== "") {
    bot = await deps.registry.getBot(p.botId);
    if (bot === undefined) throw Object.assign(new Error(`no such bot: ${p.botId}`), { code: "unknown_bot" });
  }

  // —— 选段（台账为准，GUI retention 同款判定）——
  // unit 字段延迟校验：显式 sessionId 单独可用（unit/runtime 都能从段上继承），
  // 只有走到「开新段」才强求 unitId + rootPath。
  const all: Session[] = deps.host.listSessions();
  let explicit: Session | undefined;
  if (typeof p.sessionId === "string" && p.sessionId !== "") {
    explicit = all.find((s) => String(s.id) === p.sessionId);
    if (explicit === undefined) {
      throw Object.assign(new Error(`no such session: ${p.sessionId}`), { code: "unknown_session" });
    }
  }

  const unitId = str(p.unitId, bot?.id, explicit !== undefined ? String(explicit.unitId) : undefined);
  if (unitId === undefined && explicit === undefined) {
    throw Object.assign(new Error("botId or (unitId + rootPath) is required"), { code: "bad_params" });
  }
  const rootPath = str(p.rootPath, bot?.rootPath as string | undefined);

  const byUnit = unitId !== undefined ? all.filter((s) => String(s.unitId) === unitId) : [];
  const latest = [...byUnit].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const lineage = latest !== undefined ? (latest.conversationId ?? String(latest.id)) : undefined;

  const bindingRuntime = bot !== undefined ? primaryBinding(bot).runtimeId : undefined;
  const filterRuntime = str(p.runtimeId, bindingRuntime);
  let target: Session | undefined = explicit;
  if (target === undefined && p.newSession !== true && unitId !== undefined) {
    target = byUnit
      .filter(
        (s) =>
          (filterRuntime === undefined || String(s.runtimeId) === filterRuntime) &&
          s.status !== "done" &&
          s.status !== "failed" &&
          (s.live === true || s.resumable === true),
      )
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  }

  const runtimeId = str(p.runtimeId, bindingRuntime, target !== undefined ? String(target.runtimeId) : undefined);
  if (runtimeId === undefined) {
    throw Object.assign(new Error("runtimeId is required (explicitly, via bot binding, or via sessionId)"), { code: "bad_params" });
  }

  const { model, origin } = resolveChatModel(bot, runtimeId, p.model);
  const inlined = p.attachments !== undefined && p.attachments.length > 0 ? await inlineAttachments(p.attachments) : "";
  const prompt = inlined === "" ? p.text : composePrompt(p.text, inlined);
  const waitMs = typeof p.waitMs === "number" ? Math.min(Math.max(p.waitMs, 1_000), 600_000) : 180_000;

  // 派发前快照游标（askBot 评审 P1 同款）：续聊必须只等这一轮的新事件
  let sessionId: string | null = null;
  let sinceSeq = 0;
  let continued = false;
  if (target !== undefined) {
    try {
      sinceSeq = deps.host.currentSeq(asSessionId(String(target.id)));
      const resumed = deps.host.resumeSession(asSessionId(String(target.id)));
      sessionId = String(resumed.id);
      deps.host.sendMessage(asSessionId(sessionId), prompt);
      continued = true;
    } catch {
      sessionId = null; // resume/send 失败（含 session_not_live）→ 同谱系开新段
    }
  }
  if (sessionId === null) {
    if (unitId === undefined || rootPath === undefined) {
      throw Object.assign(new Error("unitId + rootPath are required to open a new segment (botId or explicit params)"), { code: "bad_params" });
    }
    sinceSeq = 0; // 新会话 seq 从 1 起算，旧游标必须作废
    const s = await deps.host.startSession({
      runtimeId,
      unitId: asUnitId(unitId),
      unitName: str(p.unitName, bot?.name as string | undefined) ?? unitId,
      rootPath,
      prompt,
      model,
      mode: p.mode ?? "yolo", // faceless：无审批面
      source: "cli",
      interactive: false,
      ...(lineage !== undefined ? { conversationId: lineage } : {}),
      ...(bot !== undefined
        ? { contextManifest: normalizeContextManifest(bot.contextManifest), skillsBinding: normalizeSkillBinding(bot.skills) }
        : {}),
    });
    sessionId = String(s.id);
  }

  const settled = await deps.host
    .waitForSessionEvent(asSessionId(sessionId), "usage", waitMs, sinceSeq)
    .then(
      () => true,
      () => false,
    );
  const messages = deps.host.sessionMessages(asSessionId(sessionId));
  let reply: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "assistant" && m.text !== "") {
      reply = m.text;
      break;
    }
  }
  return {
    sessionId,
    reply: reply ?? "",
    status: settled ? "done" : "timeout",
    continued,
    model: model ?? null,
    modelOrigin: origin,
    runtimeId,
  };
}
