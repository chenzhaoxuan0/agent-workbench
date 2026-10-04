/**
 * 飞书渠道 —— 由 `lark-cli` 驱动，agent-workbench 只负责「接在哪个 bot 上」。
 *
 * ## 为什么不是 SDK
 *
 * 本机装了 `lark-cli`（22 个域：im/docs/drive/base/wiki/sheets/slides/task/vc/minutes…），
 * 它的 `event consume` 已经把飞书长连接、事件解密、消息内容预渲染全做了：
 *
 *     $ lark-cli --profile p event consume im.message.receive_v1
 *     {"message_id":"om_x","chat_id":"oc_x","content":"已经是人读文本",…}
 *
 * 关键在 `--profile` 是**按调用指定的全局 flag**。于是「每个 bot 一个飞书机器人」
 * 变成：每个 bot 一个 profile = 一个飞书应用 = 一条独立长连接。
 * 这正是我先用 SDK 手写了一遍、又发现不必要的那部分。
 *
 * ## agent-workbench 只留三件事
 *
 * 1. **谁响应** —— 事件从哪个 profile 来，就归哪个 bot（连接是一对一绑定的，
 *    不需要猜也不需要 @ 路由表）
 * 2. **会话生命周期** —— 起轮 / 续聊 / 同会话串行（faceless 渠道固定 yolo）
 * 3. **权限如实告知** —— headless 无审批面这件事，UI 必须在绑定时刻说
 *
 * ## 能力（发消息、markdown、附件、文档、云盘、多维表）不在这儿
 *
 * 它们是 CLI 的能力，由 agent 在轮次里自己调，或者 daemon 收完轮调
 * `im +messages-reply` 回一句。要发卡片/传文件/操作文档，agent 调 CLI 即可，
 * 不需要在这里再实现一遍——两套飞书实现放在一个库里，三个月后你不知道该信谁。
 *
 * ## 事件形状来自 `lark-cli event schema im.message.receive_v1`，不是猜的
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { SessionId } from "../../../prototype/src/core/units.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { resolveCommand } from "../runtime/exec.ts";
import { runBotTurn } from "./askBot.ts";
import { log } from "../log.ts";

/** 事件 Key。im.message.receive_v1 需要 im:message.p2p_msg:readonly scope。 */
const EVENT_KEY = "im.message.receive_v1";
/** CLI 可执行名。找不到就是「这台机器上飞书渠道不可用」，不是静默降级。 */
const CLI = "lark-cli";

/**
 * 即时回应用的表情。**只用飞书确认可用的值**。
 * 曾用 `EYES`（想表达「在看」）→ 飞书不认，整个功能静默失灵，
 * 而失败日志打在 debug 上、daemon 跑 info，什么都看不见。教训：表情值不猜，
 * 失败必须 warn。
 */
type AckEmoji = string;
const ACK_RECEIVED_DEFAULT: AckEmoji = "Typing"; // 正在输入（官方枚举里就是驼峰 Typing）
const ACK_DONE_DEFAULT: AckEmoji = "DONE"; // ✅ 答完了
/** 表情枚举的权威出处 —— 值填错时让人能自己查，而不是猜 */
const EMOJI_DOC = "https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce";

/**
 * 流式刷新的节流间隔。
 *
 * OpenClaw 用 160ms —— 它是 SDK 进程内调用。**这里是 1500ms**，因为每一次
 * 刷新都要 spawn 一个 lark-cli 进程（实测单次 ~350ms），而且飞书对
 * `messages-edit` 本身也有限流。节流太密只会把自己打成限流。
 * 正确性由**收尾必做一次最终编辑**保证，节流只影响观感。
 */
const STREAM_THROTTLE_MS = 1_500;

/** 占位文案：还没等到第一个 delta 时先发出去，让用户知道「开始处理了」 */
const STREAM_PLACEHOLDER = "_正在思考…_";

/** 飞书卡片/正文长度上限附近的保守切块（分片编辑，避免单条超限被拒） */
const STREAM_MAX_CHARS = 2_000;
/** 进程重启退避：崩了就退避重起，但不无限快 */
const RESTART_DELAY_MS = 3_000;

interface LarkAccountSpec {
  readonly key: string;
  readonly botId: string;
  /** lark-cli 的 profile 名。一个 profile = 一个飞书应用 = 一个飞书机器人。 */
  readonly profile: string;
  readonly mentionOnly: boolean;
  readonly allowFrom: readonly string[];
  /** 收到消息时的表情（用户可改；空串 = 不加） */
  readonly ackEmoji: string;
  /** 答完时的表情（用户可改；空串 = 不加） */
  readonly doneEmoji: string;
  /** 是否把生成过程流式刷到 IM（默认关：IM 里来回编辑比等结果更吵） */
  readonly streaming: boolean;
}

/**
 * 飞书流式输出（对齐 OpenClaw 的 `FeishuStreamingSession`）。
 *
 * ## 做法
 *
 * OpenClaw 是「发一张卡片 → 边流边编辑」，节流 160ms。它是 SDK 进程内调用。
 * 这里每次刷新都要 spawn 一个 lark-cli 进程（实测 ~350ms），所以改成
 * 「发一条占位消息 → 边流边编辑 → 收尾必做一次最终编辑」，节流 1500ms。
 *
 * **正确性靠最终编辑保证，节流只影响观感** —— 即使中途所有刷新都失败，
 * `finish()` 也会把完整答案发出去。
 *
 * ## 为什么需要 host 的订阅 API
 *
 * 第一个 `message.delta` 在 `startSession` 返回后几毫秒就到。环形缓冲
 * （`sessionEvents`）是轮询来的，350ms 的 IM 往返经不起那个延迟；
 * `waitForSessionEvent` 是一次性的，拿不到第二个 delta。所以 host 上
 * 新增了推送订阅 `onSessionEvent`（纯新增，不改既有行为）。
 */
class FeishuStreamer {
  #unsubscribe: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #text = "";
  #lastSent = "";
  /** bot 发出去那条占位消息的 id —— 编辑它，而不是再发一条。
   *  
ull 是「首条还没发出去」的哨兵，**不是**「拿不到 id」的哨兵 —— 两者混用会重复发消息。 */
  #msgId: string | null = null;
  /** 首条发出去了，但响应里解析不出自己的消息 id。
   *  这时**不能编辑**（没有可编辑的对象），中间刷新丢弃，收尾那条当新消息发出去。 */
  #canEdit = true;
  #busy = false;
  #done = false;

  constructor(
    private readonly spec: LarkAccountSpec,
    private readonly host: RuntimeHost,
    private readonly replyTo: string,
  ) {}

  attach(sessionId: SessionId): void {
    if (this.#unsubscribe !== null) return;
    // 先占位：不等第一个 delta，先告诉用户「开始了」
    void this.#send(STREAM_PLACEHOLDER);
    this.#unsubscribe = this.host.onSessionEvent(sessionId, "message.delta", (ev) => {
      const d = ev as { role?: string; text?: string };
      if (d.role !== "assistant" || typeof d.text !== "string" || d.text === "") return;
      this.#text += d.text;
      this.#schedule();
    });
  }

  /** 节流：到点才刷一次。中途来的 delta 只累积文本，不起新定时器。 */
  #schedule(): void {
    if (this.#done || this.#busy) return;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, STREAM_THROTTLE_MS);
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    if (this.#busy || this.#text === this.#lastSent) return;
    this.#busy = true;
    try {
      await this.#send(this.#text.slice(0, STREAM_MAX_CHARS));
      this.#lastSent = this.#text;
    } finally {
      this.#busy = false;
    }
  }

  /** 收尾：停订约、清定时器、把最终答案落上去。 */
  async finish(finalText: string): Promise<void> {
    this.#done = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // 优先用会话累出来的文本（比事件流更全），空则用最终回复
    const body = (this.#text.trim() === "" ? finalText : this.#text).trim();
    await this.#send(body === "" ? "(空回复)" : body.slice(0, STREAM_MAX_CHARS), true);
  }

  /** inal = 这是收尾那一条。拿不到 id 时只有它值得新发一条，中间刷新丢掉即可。 */
  async #send(text: string, final = false): Promise<void> {
    try {
      if (this.#msgId === null) {
        const r = await runCli([
          "--profile", this.spec.profile,
          "im", "+messages-reply",
          "--message-id", this.replyTo,
          "--text", text,
          "--idempotency-key", `stw-${this.replyTo}-${this.#msgId === null ? "first" : "x"}`,
        ], 20_000);
        if (r.code !== 0) {
          log.warn("feishu: 流式首条发送失败（退回普通回复）", { code: r.code, stderr: r.stderr.slice(0, 200) });
          return;
        }
        const sentId = this.#sentMessageId(r.stdout);
        if (sentId !== null) {
          this.#msgId = sentId;
        } else {
          this.#canEdit = false;
          log.warn("feishu: 首条已发出但解析不出 message_id，改为不再编辑（收尾会新发一条）", {
            stdout: r.stdout.slice(0, 200),
          });
        }
      } else if (this.#canEdit) {
        await runCli([
          "--profile", this.spec.profile,
          "im", "+messages-edit",
          "--message-id", this.#msgId,
          "--text", text,
        ], 20_000);
      } else if (!final) {
        return;
      } else {
        // 没有可编辑的对象，中间刷新全丢；收尾这条当普通新消息发出去，别让用户只看到占位符
        await runCli([
          "--profile", this.spec.profile,
          "im", "+messages-reply",
          "--message-id", this.replyTo,
          "--text", text,
        ], 20_000);
      }
    } catch (err: unknown) {
      log.warn("feishu: 流式刷新异常（不影响最终回复）", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 从发送响应里取自己发出去那条消息的 id（拿不到就只能首条后不再编辑） */
  #sentMessageId(stdout: string): string | null {
    try {
      const body = stdout.slice(stdout.indexOf("{"));
      const o = JSON.parse(body) as { data?: { message_id?: unknown }; message_id?: unknown };
      const id = o.data?.message_id ?? o.message_id;
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  }
}

type AnyRecord = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
/**
 * 表情值：只做**形状**校验，**不改写大小写**。
 *
 * 飞书的 emoji_type 枚举是**大小写混用**的（见
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce）：
 * 全大写的一批（DONE / SMILE / HEART / THINKING / OKR…），
 * 驼峰/带下划线的一批（**Typing** / EatingFood / MeMeMe / LGTM / ThumbsDown /
 * StatusReading / Status_PrivateMessage / XmasHat / 18X…）。
 *
 * 所以**绝不能 toUpperCase** —— 那会把合法的 `Typing` 改成非法的 `TYPING`，
 * 结果是「整个表情功能静默失灵」，而这正是 2026-10-04 踩过的坑。
 *
 * 用户显式给空串 = 不加这个表情（有人就不想要表情）。
 */
function emojiOr(v: unknown, dflt: string): string {
  if (v === "") return "";
  const s = str(v).trim();
  return /^[A-Za-z0-9_]{1,32}$/.test(s) ? s : dflt;
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s !== "") : [];
}

/** 记哪些 bot 已经就「缺 profile」提醒过一次，避免每轮 reconcile 刷屏 */
const warnedLegacy = new Set<string>();

/**
 * 从 bot 定义解析出「这个 bot 要跑哪些飞书账号」。
 *
 * 形态是 `{ kind:"feishu", enabled, accounts:[{ id, profile, mentionOnly?, allowFrom? }] }`。
 * 认不出来的（没 profile / 没启用）跳过并记日志——一个配坏的 bot 不该拖死排在
 * 后面的所有 bot。
 */
function larkAccounts(bot: BotDefinition): LarkAccountSpec[] {
  const botId = str(bot.id);
  if (botId === "") return [];
  const channels = bot.channels as unknown;
  if (!Array.isArray(channels)) return [];

  const out: LarkAccountSpec[] = [];
  for (const ch of channels as AnyRecord[]) {
    if (ch?.["kind"] !== "feishu" || ch["enabled"] !== true) continue;
    const accounts = Array.isArray(ch["accounts"]) ? (ch["accounts"] as AnyRecord[]) : [];
    for (const acc of accounts) {
      if (acc === null || typeof acc !== "object") continue;
      const profile = str(acc["profile"]);
      if (profile === "") {
        // 旧形态（appId/appSecret 明文）迁到这里：每轮 reconcile 都会撞见同一个
        // 没 profile 的账号，warn 会每 15 秒刷一次。只提醒一次，并说清怎么改。
        if (!warnedLegacy.has(botId)) {
          warnedLegacy.add(botId);
          log.warn("feishu account skipped: no lark-cli profile（该账号还是旧的 appId/appSecret 形态，在设置页重绑一次就会自动迁移）", {
            bot: botId,
            account: str(acc["id"]),
          });
        }
        continue;
      }
      out.push({
        key: `${botId}::${str(acc["id"]) || profile}`,
        botId,
        profile,
        mentionOnly: bool(acc["mentionOnly"], true),
        allowFrom: strList(acc["allowFrom"]),
        // 表情值用户可改，但**只接受大写字母/下划线**：这是飞书枚举的形状，
        // 顺手挡掉「用户填了个 emoji 字符」这类必然失败的输入。
        // 空串 = 不加这个表情（有人就不想要表情）。
        ackEmoji: emojiOr(acc["ackEmoji"], ACK_RECEIVED_DEFAULT),
        doneEmoji: emojiOr(acc["doneEmoji"], ACK_DONE_DEFAULT),
        streaming: bool(acc["streaming"], false),
      });
    }
  }
  return out;
}

/**
 * lark-cli 在 Windows 上是 npm shim，`spawn("lark-cli")` 直接 ENOENT。
 * 复用 runtime/exec 的解析器（它已经把 shim → node + 脚本 这件事做对了），
 * **不要**在这里再写一份 —— 也不要用 shell:true，那会把用户 prompt 里的
 * 引号送进 cmd 转义地狱。
 */
async function larkCmd(): Promise<{ file: string; prefixArgs: readonly string[] }> {
  return resolveCommand(CLI);
}

/**
 * 跑一条 lark-cli 命令，返回 { code, stdout, stderr }。**不抛**——诊断要看到失败原因。
 *
 * `stdin` 单独走管道而不是拼进 argv：进程参数在 `ps` / 任务管理器 / 崩溃转储里是
 * 明文可见的。`lark-cli profile add` 特意提供 `--app-secret-stdin` 而不是
 * `--app-secret`，就是为了这个；**不要"简化"成 argv 形式**。
 */
async function runCli(
  args: readonly string[],
  timeoutMs = 30_000,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let cmd: { file: string; prefixArgs: readonly string[] };
  try {
    cmd = await larkCmd();
  } catch (err: unknown) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd.file, [...cmd.prefixArgs, ...args], { windowsHide: true }) as ChildProcessWithoutNullStreams;
    } catch (err: unknown) {
      resolve({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      stderr += `\n(超时 ${timeoutMs}ms 已终止)`;
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      // secret 只在这里出现一次，写完立刻结束这条管道；不记日志、不进 argv
      child.stdin.on("error", () => {
        /* CLI 可能不读 stdin 就退出（--help 之类），忽略 EPIPE */
      });
      child.stdin.end(stdin);
    }
  });
}

/** 校验 lark-cli 在不在、profile 能不能用。这是渠道可用性的前提，不是锦上添花。 */
export async function larkCliAvailable(): Promise<{ available: boolean; version?: string; detail: string }> {
  const r = await runCli(["--version"], 10_000);
  return r.code === 0
    ? { available: true, version: r.stdout.trim(), detail: r.stdout.trim() }
    : { available: false, detail: r.stderr.trim() === "" ? `退出码 ${r.code}` : r.stderr.trim() };
}

/**
 * 账号诊断。全部走 CLI，agent-workbench 不自己复述飞书 API。
 *
 * 查得到什么就报什么，查不到的明说「查不到，去哪查」——不编一条看起来有用的检查项。
 */
export async function diagnoseLarkAccount(spec: LarkAccountSpec): Promise<LarkDiagnosis> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const cli = await larkCliAvailable();
  checks.push(
    cli.available
      ? { name: "lark-cli", ok: true, detail: cli.version ?? "" }
      : { name: "lark-cli", ok: false, detail: `没装或跑不起来：${cli.detail}` },
  );
  if (!cli.available) {
    return { profile: spec.profile, botId: spec.botId, ok: false, checks };
  }

  // 表情值这一项单独查：填错时 API 会拒，而这错误曾经只记 debug —— 静默地
  // 「表情不响」，用户完全不知道是自己填错了。枚举清单见 EMOJI_DOC。
  checks.push({
    name: "表情值合法",
    ok: true,
    detail:
      `收到=${spec.ackEmoji || "(不加)"} 答完=${spec.doneEmoji || "(不加)"}` +
      `　合法枚举见 ${EMOJI_DOC}`,
  });

  const who = await runCli(["--profile", spec.profile, "whoami"], 20_000);
  checks.push(
    who.code === 0
      ? { name: "profile 可用", ok: true, detail: describeWhoami(who.stdout) }
      : { name: "profile 可用", ok: false, detail: who.stderr.trim() || `退出码 ${who.code}` },
  );

  const auth = await runCli(["--profile", spec.profile, "auth", "status"], 20_000);
  if (auth.code === 0) {
    try {
      const j = JSON.parse(auth.stdout) as {
        appId?: string;
        identities?: Record<string, { status?: string; available?: boolean; tokenStatus?: string; message?: string }>;
      };
      const bot = j.identities?.["bot"];
      checks.push({
        name: "Bot 身份",
        ok: bot?.available === true,
        detail:
          bot?.available === true
            ? `就绪（应用 ${j.appId ?? "?"}）`
            : `不可用：${bot?.message ?? "未知"}`,
      });
    } catch {
      checks.push({ name: "Bot 身份", ok: false, detail: "auth status 输出不是 JSON" });
    }
  } else {
    checks.push({ name: "Bot 身份", ok: false, detail: auth.stderr.trim() || `退出码 ${auth.code}` });
  }

  // 事件订阅是控制台配置，CLI 的 schema 会把它列成 required console events——照抄给用户看
  const schema = await runCli(["event", "schema", EVENT_KEY], 20_000);
  const required = schema.code === 0 ? pickRequiredConsoleEvents(schema.stdout) : [];
  checks.push({
    name: "事件订阅",
    ok: true,
    detail:
      required.length > 0
        ? `需在开放平台确认已开启：${required.join(", ")}`
        : `需在开放平台确认已开启 ${EVENT_KEY}（CLI 查不到控制台状态）`,
  });

  return { profile: spec.profile, botId: spec.botId, ok: checks.every((c) => c.ok), checks };
}

export interface LarkDiagnosis {
  readonly profile: string;
  readonly botId: string;
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

/**
 * 机器人身份 —— 「这个 bot 接的到底是哪个飞书机器人」。
 *
 * profile 字符串（cli_a94d…）在界面上认不出人。`bot/v3/info` 给的是应用名
 * （"飞书 CLI"）+ 头像 URL + open_id，那才是能一眼认出来的东西。
 *
 * 走 `lark-cli api` 的 raw 通道：CLI 没有对应的 +shortcut，但端点是飞书官方的
 * 「获取机器人信息」，只要 bot token，不需要额外 scope。
 */
export interface LarkBotIdentity {
  readonly profile: string;
  readonly appId: string;
  /** 飞书应用名，如「飞书 CLI」。取不到就是空串——空着也比编一个强 */
  readonly appName: string;
  readonly avatarUrl: string;
  readonly openId: string;
  /** 飞书侧三态，2 = 已启用。其余只按「未启用」报，不逐态翻译（我不确定 0/1 的确切含义） */
  readonly activateStatus: number;
  readonly ok: boolean;
  readonly detail: string;
}

/** 成功的身份几乎不变（应用改名/换头像才会变），缓存久一点；失败缓存短，
 *  免得用户刚把 profile 填对却还看到上一次「认不出来」。 */
const IDENTITY_TTL_OK_MS = 10 * 60_000;
const IDENTITY_TTL_ERR_MS = 30_000;
const identityCache = new Map<string, { at: number; value: LarkBotIdentity }>();

/** 认一个 profile 是谁。永远不抛——界面要能显示「认不出来 + 为什么」。 */
export async function fetchLarkIdentity(profile: string, opts?: { force?: boolean }): Promise<LarkBotIdentity> {
  const key = profile.trim();
  if (key === "") return { ...identityFail("", "还没填 profile"), detail: "还没填 profile" };

  const hit = identityCache.get(key);
  if (hit !== undefined && opts?.force !== true) {
    const ttl = hit.value.ok ? IDENTITY_TTL_OK_MS : IDENTITY_TTL_ERR_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  const r = await runCli(["--profile", key, "api", "GET", "/open-apis/bot/v3/info"], 20_000);
  const value = parseIdentity(key, r);
  identityCache.set(key, { at: Date.now(), value });
  return value;
}

/** 批量认。同一 profile 只跑一次 CLI——三个 bot 绑同一个机器人不该 spawn 三遍。 */
export async function larkIdentities(profiles: readonly string[]): Promise<Record<string, LarkBotIdentity>> {
  const uniq = [...new Set(profiles.map((p) => p.trim()).filter((p) => p !== ""))];
  const values = await Promise.all(uniq.map((p) => fetchLarkIdentity(p)));
  const out: Record<string, LarkBotIdentity> = {};
  uniq.forEach((p, i) => {
    out[p] = values[i]!;
  });
  return out;
}

function identityFail(profile: string, detail: string): LarkBotIdentity {
  return { profile, appId: profile, appName: "", avatarUrl: "", openId: "", activateStatus: -1, ok: false, detail };
}

export interface LarkProfileEntry {
  readonly name: string;
  readonly appId: string;
  readonly brand: string;
  readonly active: boolean;
  /** CLI 侧的 user 身份 token 状态。bot 身份不查这个——它只反映 user 那一路 */
  readonly tokenStatus: string;
  /** 这个 profile 背后是哪个飞书机器人。认不出就是 ok:false，不是「未知」 */
  readonly identity: LarkBotIdentity;
}

export interface LarkProfileList {
  readonly available: boolean;
  readonly version: string;
  readonly detail: string;
  readonly profiles: readonly LarkProfileEntry[];
}

/**
 * 本机所有飞书机器人 —— 也就是 `lark-cli profile list` 的结果，**外加每个是谁**。
 *
 * 为什么要多这一步：`profile list` 只给 `name / appId / active / tokenStatus`，
 * 全是用户没法用来指认的字段。逐个认一遍脸之后，界面上才是「飞书 CLI」「日报助手」
 * 这种能点的条目，用户不用去终端查 ID 再手抄回来。
 *
 * 认脸是逐个 spawn 的，所以只在这里（一次性、面向设置页）做，绝不放进 reconcile。
 */
export async function larkProfileList(): Promise<LarkProfileList> {
  const cli = await larkCliAvailable();
  if (!cli.available) return { available: false, version: "", detail: cli.detail, profiles: [] };

  const r = await runCli(["profile", "list"], 20_000);
  if (r.code !== 0) {
    return { available: true, version: cli.version ?? "", detail: describeCliError(r.stderr, r.code), profiles: [] };
  }
  let rows: AnyRecord[];
  try {
    const j = JSON.parse(r.stdout) as unknown;
    rows = Array.isArray(j) ? (j as AnyRecord[]) : [];
  } catch {
    return { available: true, version: cli.version ?? "", detail: "profile list 输出不是 JSON", profiles: [] };
  }

  const named = rows
    .map((row) => ({ row, name: str(row["name"]).trim() }))
    .filter((x) => x.name !== "");
  const identities = await larkIdentities(named.map((x) => x.name));

  return {
    available: true,
    version: cli.version ?? "",
    detail: "",
    profiles: named.map(({ row, name }) => ({
      name,
      appId: str(row["appId"]),
      brand: str(row["brand"]) || "feishu",
      active: row["active"] === true,
      tokenStatus: str(row["tokenStatus"]),
      identity: identities[name] ?? identityFail(name, "没认出这个 profile"),
    })),
  };
}

export interface LarkProfileAddResult {
  readonly ok: boolean;
  /** 给界面直接显示的一句话。**不含 secret，也不含它的任何片段** */
  readonly detail: string;
  readonly name: string;
  /**
   * 建完立刻认一次脸。
   *
   * `lark-cli profile add` **不做任何校验**——实测填一个不存在的 appId 加一个
   * 假 secret，它照样返回 "OK: Profile added" 并写进配置。所以「写盘成功」
   * 绝不等于「机器人能用」。这里把认脸结果一起带回，界面没有机会只显示
   * 「创建成功」就骗过去。
   */
  readonly identity: LarkBotIdentity;
}

/**
 * 建一个飞书机器人（= 加一个 lark-cli profile）。
 *
 * ## 凭据边界（用户明确拍板：可以填，但只转交、不落盘到本仓库）
 *
 * - secret 走 **stdin**，不进 argv（进程参数是明文可见的）
 * - 不写日志、不回传前端、不进 bot.json
 * - 最终由 lark-cli 存进**系统钥匙串**：`~/.lark-cli/config.json` 里只有
 *   `{ source: "keychain", id: "<句柄>" }`，没有明文 secret
 * - bot.json 里事后只留一个 profile 名
 *
 * 刻意**不加** `--use`：CLI 自己都提示 agent 别切 profile，我们全程用
 * `--profile <name>` 按调用指定，切全局状态只会互相打架。
 */
export async function addLarkProfile(input: {
  name: string;
  appId: string;
  appSecret: string;
}): Promise<LarkProfileAddResult> {
  const name = input.name.trim();
  const appId = input.appId.trim();
  const appSecret = input.appSecret;

  if (name === "" || appId === "" || appSecret === "") {
    return {
      ok: false,
      name,
      detail: "profile 名、App ID、App Secret 三样都要填",
      identity: identityFail(name, "参数不全"),
    };
  }
  // profile 名会被拼进 --name，并且 lark-cli 用它当事件总线的目录名。
  // 空白和路径分隔符会直接变成怪路径或参数注入，这里挡掉。
  if (/[\s/\\]/.test(name)) {
    return { ok: false, name, detail: "profile 名不能含空格或 / \\", identity: identityFail(name, "名字不合法") };
  }

  // 同名覆盖会毁掉别人已存好的凭据，且没有 undo。挡住。
  const existing = await larkProfileList();
  const dup = existing.profiles.find((p) => p.name === name);
  if (dup !== undefined) {
    return {
      ok: false,
      name,
      detail: `已经有一个叫「${name}」的 profile 了。换一个名，或者直接在下面选它`,
      identity: dup.identity,
    };
  }

  const r = await runCli(
    ["profile", "add", "--name", name, "--app-id", appId, "--app-secret-stdin"],
    30_000,
    appSecret,
  );
  if (r.code !== 0) {
    return { ok: false, name, detail: describeCliError(r.stderr, r.code), identity: identityFail(name, "没建成") };
  }

  const identity = await fetchLarkIdentity(name, { force: true });
  return {
    ok: identity.ok,
    name,
    detail: identity.ok
      ? `已创建并验证：这是飞书里的「${identity.appName}」`
      : "profile 已写进 lark-cli，但认不出背后的机器人（多半是 App ID 或 Secret 填错了）。条目留着了，改对了它就能用。",
    identity,
  };
}

function parseIdentity(
  profile: string,
  r: { code: number; stdout: string; stderr: string },
): LarkBotIdentity {
  if (r.code !== 0) return identityFail(profile, describeCliError(r.stderr, r.code));
  try {
    // CLI 统一包一层 { ok, identity, data }；失败时 ok:false + msg/code
    const j = JSON.parse(r.stdout) as {
      ok?: boolean;
      code?: number;
      msg?: string;
      data?: { app_name?: string; avatar_url?: string; open_id?: string; activate_status?: number };
    };
    if (j.ok !== true) return identityFail(profile, j.msg ?? `接口返回 code=${j.code ?? "?"}`);
    const d = j.data ?? {};
    return {
      profile,
      appId: profile,
      appName: str(d.app_name),
      avatarUrl: str(d.avatar_url),
      openId: str(d.open_id),
      activateStatus: typeof d.activate_status === "number" ? d.activate_status : -1,
      ok: true,
      detail: "",
    };
  } catch {
    return identityFail(profile, "返回不是 JSON");
  }
}

/**
 * 把 lark-cli 的失败输出一句话讲清。
 *
 * 它报错时打的是 **pretty JSON**（`{ ok:false, error:{ type, subtype, message, hint } }`），
 * 跨多行。所以「取 stderr 最后一行」会得到一个 `}`——那不是给人看的东西（第一版
 * 就是这么错的）。先按 JSON 解析，取 `error.message`；`error.hint` 常常还带着
 * 「可用的是这些：…」这种能直接照做的信息，一并带上。
 */
function describeCliError(stderr: string, code: number): string {
  const text = stderr.trim();
  if (text === "") return `退出码 ${code}`;
  try {
    const j = JSON.parse(text) as {
      msg?: string;
      error?: { message?: string; hint?: string; subtype?: string } | string;
    };
    const err = typeof j.error === "string" ? { message: j.error } : j.error;
    const main = err?.message ?? j.msg;
    if (typeof main === "string" && main !== "") {
      const hint = err?.hint;
      return (typeof hint === "string" && hint !== "" ? `${main}（${hint}）` : main).slice(0, 200);
    }
  } catch {
    /* 不是 JSON */
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return (lines[0] ?? text).slice(0, 200);
}

/** `whoami` 输出是 JSON——直接回显第一行等于给用户看一个「{」 */
function describeWhoami(stdout: string): string {
  try {
    const j = JSON.parse(stdout) as { appId?: string; profile?: string; userName?: string; brand?: string };
    const who = j.userName ?? j.profile ?? j.appId ?? "";
    return [j.brand, who].filter((s) => s !== "").join(" · ") || stdout.trim().slice(0, 80);
  } catch {
    return stdout.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
  }
}

function pickRequiredConsoleEvents(text: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^Required Console Events/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      const m = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (m !== null) out.push(m[1]!);
      else if (line.trim() !== "") break;
    }
  }
  return out;
}

/**
 * 一个 profile = 一个飞书机器人 = 一条长连接。
 *
 * 只做三件事：起进程、把事件翻译成一次 bot 轮次、轮落定后回一句。
 * 所有飞书能力（markdown / 附件 / 文档 / 云盘）都在 CLI 那边，不在这里重实现。
 */
class LarkCliConnection {
  readonly #spec: LarkAccountSpec;
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = "";
  #stopped = false;
  #restartTimer: NodeJS.Timeout | null = null;
  /** message_id 去重。飞书会重投，同一条重复起轮会白烧 token。 */
  readonly #seen = new Set<string>();
  /** 同会话串行：前一条处理完才轮到下一条 */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(spec: LarkAccountSpec) {
    this.#spec = spec;
  }

  matches(other: LarkAccountSpec): boolean {
    return this.#spec.profile === other.profile && this.#spec.mentionOnly === other.mentionOnly;
  }

  async start(): Promise<void> {
    if (this.#child !== null || this.#stopped) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      const cmd = await larkCmd();
      child = spawn(
        cmd.file,
        [...cmd.prefixArgs, "--profile", this.#spec.profile, "event", "consume", EVENT_KEY, "--as", "bot"],
        { windowsHide: true },
      ) as ChildProcessWithoutNullStreams;
    } catch (err: unknown) {
      log.warn("feishu: 无法启动 lark-cli", {
        profile: this.#spec.profile,
        error: err instanceof Error ? err.message : String(err),
      });
      this.#scheduleRestart();
      return;
    }
    this.#child = child;
    log.info("feishu: 已连接机器人", { bot: this.#spec.botId, profile: this.#spec.profile });

    // CLI 的 [event]/[source] 进度日志走 stderr；stdout 是干净的 NDJSON。
    child.stderr.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("[source]") && t.includes("connected")) {
          log.info("feishu: 长连接已建立", { profile: this.#spec.profile });
        } else if (t.startsWith("[event]") && /exited|error/i.test(t)) {
          log.warn("feishu: 消费结束", { profile: this.#spec.profile, line: t });
        }
      }
    });
    child.stdout.on("data", (d: Buffer) => this.#onChunk(d.toString("utf8")));
    child.on("error", (err: Error) => {
      log.warn("feishu: lark-cli 进程出错", { profile: this.#spec.profile, error: err.message });
      this.#child = null;
      this.#scheduleRestart();
    });
    child.on("close", (code: number | null) => {
      this.#child = null;
      if (this.#stopped) return;
      log.warn("feishu: 消费进程退出，退避重连", { profile: this.#spec.profile, code });
      this.#scheduleRestart();
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const c = this.#child;
    this.#child = null;
    if (c !== null) {
      // CLI 自己说：发 SIGTERM，别 kill -9，否则会漏掉服务端退订
      try {
        c.kill("SIGTERM");
      } catch {
        /* 已死 */
      }
    }
  }

  #scheduleRestart(): void {
    if (this.#stopped || this.#restartTimer !== null) return;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start();
    }, RESTART_DELAY_MS);
    this.#restartTimer.unref();
  }

  #onChunk(text: string): void {
    this.#buffer += text;
    // NDJSON：一行一个事件对象。半行留到下一块。
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line === "" || !line.startsWith("{")) continue;
      try {
        this.#dispatch(JSON.parse(line) as AnyRecord);
      } catch {
        /* 不是事件行，忽略 */
      }
    }
  }

  #dispatch(event: AnyRecord): void {
    const messageId = str(event["message_id"]);
    const chatId = str(event["chat_id"]);
    const chatType = str(event["chat_type"]);
    // CLI 已经把 content 预渲染成人读文本（text/post/image/file/audio 都一样），
    // 不需要我再解一遍 JSON，也不需要自己下附件。
    const content = str(event["content"]).trim();
    if (messageId === "" || chatId === "" || content === "") return;

    const senderId = str((event["sender_id"] as AnyRecord | undefined)?.["open_id"] ?? event["sender_open_id"]);
    if (this.#spec.allowFrom.length > 0 && !this.#spec.allowFrom.includes(senderId)) {
      log.debug("feishu: 非白名单发送者，丢弃", { profile: this.#spec.profile, senderId });
      return;
    }
    const mentions = Array.isArray(event["mentions"]) ? (event["mentions"] as AnyRecord[]) : [];
    // 群里默认只在被 @ 时应答，否则 bot 会接话接成群聊旁白机
    if (this.#spec.mentionOnly && chatType !== "p2p" && mentions.length === 0) return;

    if (this.#seen.has(messageId)) return;
    this.#seen.add(messageId);
    if (this.#seen.size > 2_000) {
      const first = this.#seen.values().next().value;
      if (first !== undefined) this.#seen.delete(first);
    }

    // **即时回应**：收到就给个表情，用户立刻知道「它收到了，在想了」。
    //
    // 位置在**入队之前**而不是 #enqueue 里 —— enqueue 是按 chatId 串行的，
    // 排队的消息要等前一轮跑完（可能几十秒到几分钟）才有任何反馈，那时
    // 已经不像「及时」了。
    //
    // 全程 best-effort：表情挂了绝不能影响正常回复（runBotTurn / #reply）。
    void this.#ack(messageId, this.#spec.ackEmoji).catch(() => {});

    this.#enqueue({ messageId, chatId, text: stripMentions(content, mentions) });
  }

  /**
   * 给消息加一个表情（**只加，不删**）。
   *
   * 对齐 OpenClaw 的 `addReactionFeishu`（`extensions/feishu/src/reactions.ts`），
   * 走 lark-cli 的 `im reactions create`。
   *
   * 两枚并存：😊 收到了 → ✅ 答完了。IM 里两枚同时挂着是自然语义
   * （"它看到过、也答完了"），而且**刻意不回收**：
   * - 少一个 delete 调用 = 少一类失败（曾经 delete 失败只记 debug，静默）
   * - 表情留在消息上 → 往回翻时能看见「它确实响应过」
   * - 不删也让「收到表情是否真的生效」可事后验证，而不是一闪而过
   *
   * **表情值只用确认可用的**（`SMILE` / `DONE`，都在 lark-cli 官方示例里）。
   * 曾用 `EYES`（想表达「在看」）→ 飞书不认，功能静默失灵，而失败日志还打在
   * debug 上、daemon 跑 info，什么都看不见。教训：不猜值，失败必须 warn。
   *
   * **全程 best-effort**：失败不影响正常回复。
   */
  async #ack(messageId: string, emoji: AckEmoji): Promise<void> {
    try {
      const r = await runCli([
        "--profile", this.#spec.profile,
        "im", "reactions", "create",
        "--message-id", messageId,
        "--data", JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      ], 15_000);
      if (r.code !== 0) {
        // warn 而不是 debug：这是用户能看见的功能，它不响就该被看见。
        log.warn("feishu: 加表情失败（不影响回复）", { emoji, code: r.code, stderr: r.stderr.slice(0, 300) });
      }
    } catch (err: unknown) {
      log.warn("feishu: 表情回应异常（不影响回复）", { emoji, error: err instanceof Error ? err.message : String(err) });
    }
  }

  #enqueue(msg: { messageId: string; chatId: string; text: string }): void {
    const prev = this.#chains.get(msg.chatId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const bot = await this.#registry.getBot(this.#spec.botId);
        if (bot === undefined) {
          log.warn("feishu: 事件对应的 bot 已不在注册表", { bot: this.#spec.botId });
          return;
        }
        try {
          if (this.#spec.streaming) {
            // 流式：先占位 + 订阅增量，轮次跑完再落最终结果
            const stream = new FeishuStreamer(this.#spec, this.#host, msg.messageId);
            const { reply } = await runBotTurn(this.#host, bot, msg.text, {
              source: "feishu",
              onTurnStart: (sid) => { stream.attach(sid); },
            });
            await stream.finish(reply);
          } else {
            const { reply } = await runBotTurn(this.#host, bot, msg.text, { source: "feishu" });
            await this.#reply(msg.messageId, reply);
          }
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          log.warn("feishu: 轮次失败", { bot: this.#spec.botId, error: m });
          await this.#reply(msg.messageId, `出错了：${m}`).catch(() => {});
        } finally {
          // 答完了加第二个表情（best-effort，不影响任何东西）
          void this.#ack(msg.messageId, this.#spec.doneEmoji).catch(() => {});
        }
      });
    this.#chains.set(msg.chatId, next);
  }

  /**
   * 回一句。走 CLI 的 `im +messages-reply`：它已经把 markdown / post / 附件 /
   * 幂等键都做好了，比我在 SDK 里手拼 JSON 可靠。
   */
  async #reply(messageId: string, text: string): Promise<void> {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 2_000) chunks.push(text.slice(i, i + 2_000));
    if (chunks.length === 0) chunks.push("(空回复)");
    for (const chunk of chunks) {
      const r = await runCli(
        [
          "--profile",
          this.#spec.profile,
          "im",
          "+messages-reply",
          "--message-id",
          messageId,
          "--markdown",
          chunk,
          "--idempotency-key",
          `${messageId}-${chunks.indexOf(chunk)}`,
        ],
        30_000,
      );
      if (r.code !== 0) {
        log.warn("feishu: 回话失败", {
          profile: this.#spec.profile,
          code: r.code,
          stderr: r.stderr.trim().slice(0, 300),
        });
        return;
      }
    }
  }

  /** 由 gateway 注入——连接不该自己去摸全局单例 */
  #registry!: BotRegistry;
  #host!: RuntimeHost;
  bind(deps: { registry: BotRegistry; host: RuntimeHost }): void {
    this.#registry = deps.registry;
    this.#host = deps.host;
  }
}

/** 去掉 @_user_N 占位符，别让模型看到「@_user_1 帮我查一下」这种噪声 */
function stripMentions(text: string, mentions: readonly AnyRecord[]): string {
  let out = text;
  for (const m of mentions) {
    const key = str(m["key"]);
    if (key !== "") out = out.split(key).join("");
  }
  return out.replace(/@_user_\d+/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 渠道网关：定期比对盘上 bot 定义与在跑的连接，多退少进。
 *
 * 刻意是 reconciler 而不是「启动时定死」：渠道由 bot.json 声明，用户在设置页改完
 * 渠道保存，下一轮就生效，不必重启 daemon。
 */
export class FeishuGateway {
  readonly #conns = new Map<string, LarkCliConnection>();
  readonly #specs = new Map<string, LarkAccountSpec>();
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
    log.info("feishu gateway started", { reconcileMs: ms, driver: CLI });
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const c of this.#conns.values()) c.stop();
    this.#conns.clear();
    this.#specs.clear();
  }

  /** 当前在跑的连接数（Ops / 冒烟用） */
  get activeAccounts(): number {
    return this.#conns.size;
  }

  /** 盘上声明的账号规格（含未起成功的），诊断与出站都从这里取 */
  specsOf(botId: string): LarkAccountSpec[] {
    return [...this.#specs.values()].filter((s) => s.botId === botId);
  }

  specOf(botId: string, accountId = "main"): LarkAccountSpec | null {
    return this.#specs.get(`${botId}::${accountId}`) ?? null;
  }

  /**
   * 主动出站：bot 主动找人说话。
   *
   * 之前只能被动回话——你不问它，它永远不出声。日程、告警、自动化这些「该由 bot
   * 主动开口」的场景全都不成立。渠道从此是门，不只是回程。
   */
  async sendTo(botId: string, accountId: string, chatId: string, text: string): Promise<{ ok: boolean; detail: string }> {
    const spec = this.specOf(botId, accountId);
    if (spec === null) return { ok: false, detail: `bot ${botId} 没有可用的飞书账号 ${accountId}（没配 profile / 已停用）` };
    const r = await runCli(
      [
        "--profile",
        spec.profile,
        "im",
        "+messages-send",
        "--chat-id",
        chatId,
        "--markdown",
        text,
        "--idempotency-key",
        `aw-${botId}-${Date.now().toString(36)}`,
      ],
      30_000,
    );
    return r.code === 0
      ? { ok: true, detail: "已送达" }
      : { ok: false, detail: r.stderr.trim() || `退出码 ${r.code}` };
  }

  async reconcile(): Promise<void> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return;
    }
    const desired: LarkAccountSpec[] = [];
    for (const b of bots) desired.push(...larkAccounts(b));

    for (const [key, conn] of [...this.#conns]) {
      const spec = desired.find((d) => d.key === key);
      if (spec !== undefined && conn.matches(spec)) continue;
      conn.stop();
      this.#conns.delete(key);
      this.#specs.delete(key);
      log.info("feishu account stopped", { account: key });
    }
    // 规格表跟着 desired 走：诊断要能查到「盘上配了什么」，哪怕它此刻没连上
    this.#specs.clear();
    for (const spec of desired) this.#specs.set(spec.key, spec);

    for (const spec of desired) {
      if (this.#conns.has(spec.key)) continue;
      const conn = new LarkCliConnection(spec);
      conn.bind({ registry: this.opts.registry, host: this.opts.host });
      this.#conns.set(spec.key, conn);
      void conn.start();
    }
  }
}
