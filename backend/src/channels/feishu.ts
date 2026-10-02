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
import type { RuntimeHost } from "../runtime/host.ts";
import { resolveCommand } from "../runtime/exec.ts";
import { runBotTurn } from "./askBot.ts";
import { log } from "../log.ts";

/** 事件 Key。im.message.receive_v1 需要 im:message.p2p_msg:readonly scope。 */
const EVENT_KEY = "im.message.receive_v1";
/** CLI 可执行名。找不到就是「这台机器上飞书渠道不可用」，不是静默降级。 */
const CLI = "lark-cli";
/** 进程重启退避：崩了就退避重起，但不无限快 */
const RESTART_DELAY_MS = 3_000;

interface LarkAccountSpec {
  readonly key: string;
  readonly botId: string;
  /** lark-cli 的 profile 名。一个 profile = 一个飞书应用 = 一个飞书机器人。 */
  readonly profile: string;
  readonly mentionOnly: boolean;
  readonly allowFrom: readonly string[];
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

/** 跑一条 lark-cli 命令，返回 { code, stdout, stderr }。**不抛**——诊断要看到失败原因。 */
async function runCli(
  args: readonly string[],
  timeoutMs = 30_000,
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

    this.#enqueue({ messageId, chatId, text: stripMentions(content, mentions) });
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
          const { reply } = await runBotTurn(this.#host, bot, msg.text, { source: "feishu" });
          await this.#reply(msg.messageId, reply);
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          log.warn("feishu: 轮次失败", { bot: this.#spec.botId, error: m });
          await this.#reply(msg.messageId, `出错了：${m}`).catch(() => {});
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
