/**
 * 渠道绑定向导（docs/09 §五）——「缺失的最大一块」。
 *
 * ## 为什么风险声明必须在绑定时刻
 *
 * 绑了渠道，这个 bot 在 IM 里就是 headless 的：没有逐条审批面，会话固定 yolo
 * （docs/08 已定死，收权靠预置规则表）。这件事**不能藏在设置里**，必须摆在
 * 用户点「启用」的那一刻——事后才发现「原来在飞书里它不用问我」，已经晚了。
 *
 * ## 为什么密钥只填变量名
 *
 * 填 token 的输入框，保存后必然在某个地方留明文，而 bot.json 是本机私有文件但
 * 也可能被 git 带走。所以这里只让用户填**环境变量名**，值不进文件。代价是要教
 * 一句「把密钥放环境变量」，换来的是 push 泄漏在形态上就不可能。
 *
 * ## 已实现 / 未实现
 *
 * 飞书：多账号、websocket 长连接、纯文本收发。卡片与附件在后续批次。
 * Telegram：长轮询，纯文本。
 * webhook：只需要一个 secret，天然 per-bot，已可用。
 *
 * 账号上的「流式输出 / 两个表情」是 IM 里的**表现**（它在别人面前长什么样），
 * 与 profile / token 那些**身份**字段分开写，见 ImBody。
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Radio,
  RotateCw,
  ShieldAlert,
  Stethoscope,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { DiagnosisResult } from "../adapters/daemon/client.ts";
import type { BotChannel, ChannelAccount } from "../core/units.ts";
import { FeishuSetup } from "./FeishuSetup.tsx";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

/** 渠道种类 → 人话。Discord 不在列：零实现，放进选项就是骗人。 */
const KINDS = [
  { kind: "feishu" as const, label: "飞书", hint: "每 bot 一个飞书机器人 · 长连接 · 本机可用" },
  { kind: "telegram" as const, label: "Telegram", hint: "长轮询 · 纯文本" },
  { kind: "webhook" as const, label: "Webhook", hint: "自建服务推给这个 bot · 最简单" },
];

/**
 * 账号上后端已实现、但共享类型还没声明的三个字段。
 *
 * `core/units.ts` 是前后端共享文件（backend 的 host.ts 从那里 import），所以这里
 * 不往里加字段 —— 跟 SettingsPage 里 crossSearch 是同一个处理。bot.list 会把
 * bot.json 的额外字段原样带回、bot.put 也原样落盘，运行时它们本来就在对象上。
 */
type ImAccount = ChannelAccount & {
  /** 收到消息时加的表情：飞书表情的**枚举名**（SMILE / DONE…），不是 emoji 字符。空串 = 不加 */
  readonly ackEmoji?: string;
  /** 答完时加的表情，同上 */
  readonly doneEmoji?: string;
  /** 是否把生成过程流式刷到 IM。缺省 = 关 */
  readonly streaming?: boolean;
};

/**
 * 表情枚举名的形状。**跟后端 `channels/feishu.ts` 的 `emojiOr` 逐字对齐**：
 * `^[A-Za-z0-9_]{1,32}$`，只 trim、**不做大小写转换**。
 *
 * ⚠️ 为什么必须接受大小写混用：飞书官方枚举里两种都有 ——
 * 全大写（DONE / SMILE / HEART / THINKING / OKR…）和驼峰/带下划线
 * （**Typing** / EatingFood / MeMeMe / LGTM / ThumbsDown / StatusReading /
 * Status_PrivateMessage / XmasHat / 18X…）。曾经这里写的是 `^[A-Z_]{1,24}$`
 * 且带 `toUpperCase`，那会把合法的 `Typing` 变成非法的 `TYPING`，
 * 结果就是「表情功能静默失灵」——和填错值是同一种症状。
 *
 * 抄后端规则而不是自己写宽松的：不合规值后端是**静默回落**到默认值的
 * （不报错不提示）。规则比它宽 = 界面说好的、实际已换回默认值；比它严 = 多一句提醒。
 * 两头都错，只有一条路是对的。
 */
const EMOJI_NAME = /^[A-Za-z0-9_]{1,32}$/;

/**
 * 有效默认值 —— **必须跟后端 `channels/feishu.ts` 的
 * `ACK_RECEIVED_DEFAULT` / `ACK_DONE_DEFAULT` 逐字一致**。
 *
 * 为什么界面要显示它、而不是显示空：
 * 「键缺失」在后端 = 用默认值（Typing / DONE）；「空串」= 不加这个表情。
 * 两者**语义完全不同**。界面若把缺失显示成空，用户会以为功能是关的；
 * 而他一旦在这个页面保存，空框就会被原样写成 `""` —— **等于把表情功能静默关掉**。
 * 所以：缺失 → 显示默认；用户主动清空 → 才是不加。
 */
const DEFAULT_ACK_EMOJI = "Typing";
const DEFAULT_DONE_EMOJI = "DONE";

/** 官方枚举清单：值填错时照这个查，别猜。 */
const EMOJI_DOC = "https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce";

export function ChannelSection({
  botId,
  channels,
  onChange,
  disabled,
}: {
  /** 诊断要用：诊断的最小单位是账号，但归属是 bot */
  botId: string;
  channels: readonly BotChannel[];
  onChange: (next: readonly BotChannel[]) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (disabled) {
    return (
      <div className="space-y-2">
        <Notice tone="warn" icon={AlertTriangle}>
          渠道要在 bot 建好之后才能绑。先把它建出来，再回来接上 IM。
        </Notice>
      </div>
    );
  }

  const update = (i: number, next: BotChannel) => onChange(channels.map((c, j) => (j === i ? next : c)));
  const remove = (i: number) => onChange(channels.filter((_, j) => j !== i));
  const add = (kind: BotChannel["kind"]) => {
    onChange([
      ...channels,
      kind === "webhook"
        ? { kind, enabled: false, config: { secret: "" } }
        : { kind, enabled: false, accounts: [emptyAccount(kind)] },
    ]);
    // 新卡片落在末尾，index 就是加之前的 length——键必须跟下面卡片用的键同构，
    // 否则加完不展开（第一版这里就写错过，表现为「点了没反应」）
    setExpanded(`${kind}-${channels.length}`);
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-ash">
        渠道是「bot 找得到你」的那几扇门。没接渠道，它就只存在于这个工作台里。
      </p>

      {channels.length === 0 && (
        <div className="rounded-card border border-line bg-rail/40 p-4 text-center">
          <p className="text-caption text-ash">还没接任何渠道</p>
        </div>
      )}

      {channels.map((ch, i) => (
        <ChannelCard
          key={`${ch.kind}-${i}`}
          botId={botId}
          channel={ch}
          expanded={expanded === `${ch.kind}-${i}`}
          onToggle={() => setExpanded(expanded === `${ch.kind}-${i}` ? null : `${ch.kind}-${i}`)}
          onChange={(next) => update(i, next)}
          onRemove={() => remove(i)}
        />
      ))}

      {channels.length < 3 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-ash">接一个：</span>
          {KINDS.filter((k) => !channels.some((c) => c.kind === k.kind)).map((k) => (
            <button
              key={k.kind}
              onClick={() => add(k.kind)}
              title={k.hint}
              className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-ink hover:bg-line-soft"
            >
              <Plus size={9} />
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function emptyAccount(_kind: BotChannel["kind"]): ChannelAccount {
  return { id: "main", mentionOnly: true };
}

function ChannelCard({
  botId,
  channel,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  botId: string;
  channel: BotChannel;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: BotChannel) => void;
  onRemove: () => void;
}) {
  const meta = KINDS.find((k) => k.kind === channel.kind);
  // 旧形态（config 明文）也认，但要告诉用户它会随保存迁到 SecretRef
  const legacy = channel.accounts === undefined;

  return (
    <div className={cn("rounded-card border", expanded ? "border-line bg-canvas" : "border-line bg-rail/30")}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Radio size={12} className={channel.enabled ? "text-teal" : "text-ash"} />
          <span className="text-body-sm font-medium text-ink">{meta?.label ?? channel.kind}</span>
          {channel.enabled ? (
            <span className="rounded-btn bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已启用</span>
          ) : (
            <span className="rounded-btn bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">已停用</span>
          )}
          {legacy && <span className="text-[10px] text-loss">旧格式，保存后自动迁移</span>}
        </button>
        <button
          onClick={() => onChange({ ...channel, enabled: !channel.enabled })}
          aria-label={channel.enabled ? "停用渠道" : "启用渠道"}
          title={channel.enabled ? "停用" : "启用"}
          className={cn(
            "rounded-btn p-1",
            channel.enabled ? "text-teal hover:bg-line-soft" : "text-ash hover:bg-line-soft hover:text-ink",
          )}
        >
          <Check size={12} />
        </button>
        <button
          onClick={onRemove}
          aria-label="解绑渠道"
          title="解绑（只删 bot.json 里的声明，不动别的）"
          className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-loss"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-line px-2.5 py-2.5">
          {channel.kind === "webhook" ? (
            <WebhookBody channel={channel} onChange={onChange} />
          ) : (
            <ImBody botId={botId} channel={channel} onChange={onChange} />
          )}

          {(channel.kind === "feishu" || channel.kind === "telegram") && (
            <div className="rounded-card border border-loss/30 bg-loss/5 p-2.5">
              <p className="flex items-center gap-1.5 text-caption font-medium text-loss">
                <ShieldAlert size={11} />
                启用后这个 bot 在 {meta?.label} 里是 headless 的
              </p>
              <p className="mt-1 text-caption text-graphite">
                没有逐条审批面。它会按【完全放行】直接对着工作目录执行命令——
                谁在群里 @ 它，谁就能让它动这个文件夹。
              </p>
              <p className="mt-1 text-caption text-ash">
                收权办法：先在 Ops 里给这个执行器配好预置规则（拒绝敏感命令），
                再回来启用。规则是后端强制的，比这里口头承诺可靠。
              </p>
            </div>
          )}

          {channel.kind === "feishu" && (
            <DiagnosePanel botId={botId} accounts={accountsOf(channel)} />
          )}
        </div>
      )}
    </div>
  );
}

function ImBody({
  botId,
  channel,
  onChange,
}: {
  botId: string;
  channel: BotChannel;
  onChange: (next: BotChannel) => void;
}) {
  const isFeishu = channel.kind === "feishu";
  // 这三个字段运行时就在对象上（bot.list 原样带回），只是共享类型没声明
  const accounts = accountsOf(channel) as readonly ImAccount[];

  /**
   * 改一个账号的字段。**只 spread、不重建** —— 账号上还有 profile / mentionOnly /
   * allowFrom 等字段是别处（飞书向导、诊断）带回来的，重建对象就会把它们抹掉，
   * 保存时等于静默删除用户的配置。
   */
  const setAccount = (i: number, patch: Partial<ImAccount>) => {
    const next = accounts.map((a, j) => (j === i ? { ...a, ...patch } : a));
    onChange({ ...channel, accounts: next });
  };
  const addAccount = () =>
    onChange({ ...channel, accounts: [...accounts, { id: `a${accounts.length}`, mentionOnly: true }] });
  const removeAccount = (i: number) => onChange({ ...channel, accounts: accounts.filter((_, j) => j !== i) });

  return (
    <div className="space-y-2.5">
      {accounts.map((acc, i) => (
        <div key={acc.id} className="space-y-1.5 rounded-card border border-line p-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-ash">账号 {acc.id || "main"}</span>
            {accounts.length > 1 && (
              <button onClick={() => removeAccount(i)} aria-label="删除账号" className="ml-auto rounded-btn p-0.5 text-ash hover:text-loss">
                <X size={10} />
              </button>
            )}
          </div>
          {isFeishu ? (
            <>
              <FeishuSetup botId={botId} account={acc} onChange={(next) => setAccount(i, next)} />
              <label className="flex items-center gap-1.5 text-caption text-graphite">
                <input type="checkbox" checked={acc.mentionOnly !== false} onChange={(e) => setAccount(i, { mentionOnly: e.target.checked })} />
                群里只在被 @ 时应答
              </label>
            </>
          ) : (
            <>
              <Field label="Bot Token（环境变量名）" hint="只填变量名，token 本身不落盘">
                <input
                  value={(acc as unknown as { botTokenEnv?: string }).botTokenEnv ?? ""}
                  onChange={(e) => setAccount(i, { botTokenEnv: e.target.value } as Partial<ChannelAccount>)}
                  spellCheck={false}
                  aria-label="Bot Token 环境变量名"
                  className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
                />
              </Field>
              <Field label="Chat ID" hint="只应答这个会话">
                <input
                  value={(acc as unknown as { chatId?: string }).chatId ?? ""}
                  onChange={(e) => setAccount(i, { chatId: e.target.value } as Partial<ChannelAccount>)}
                  spellCheck={false}
                  aria-label="Chat ID"
                  className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
                />
              </Field>
            </>
          )}
          <ImBehavior account={acc} onPatch={(patch) => setAccount(i, patch)} />
        </div>
      ))}
      <button onClick={addAccount} className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink">
        <Plus size={9} />
        再加一个账号（一个飞书应用 = 一个机器人）
      </button>
    </div>
  );
}

/**
 * 账号级的 IM 表现：流式输出 + 两个表情。
 *
 * 位置在飞书向导之后、诊断之前 —— 上面那些回答「它是谁」（哪个机器人、哪个 profile），
 * 这三条回答「它在群里长什么样」，诊断回答「通不通」。三件事，挨着但不是一回事。
 */
function ImBehavior({ account, onPatch }: { account: ImAccount; onPatch: (patch: Partial<ImAccount>) => void }) {
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <label className="flex items-center gap-1.5 text-caption text-graphite">
        <Toggle on={account.streaming === true} onChange={(v) => onPatch({ streaming: v })} />
        流式输出
      </label>
      <p className="text-[10px] leading-relaxed text-ash">
        开着：先发一条「正在思考…」，再边生成边反复改同一条消息。IM 里来回编辑比干等结果更吵，所以默认关。
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        <EmojiField
          label="收到消息时"
          placeholder={DEFAULT_ACK_EMOJI}
          value={account.ackEmoji ?? DEFAULT_ACK_EMOJI}
          onChange={(v) => onPatch({ ackEmoji: v })}
        />
        <EmojiField
          label="答完时"
          placeholder={DEFAULT_DONE_EMOJI}
          value={account.doneEmoji ?? DEFAULT_DONE_EMOJI}
          onChange={(v) => onPatch({ doneEmoji: v })}
        />
      </div>
    </div>
  );
}

/**
 * 表情枚举名输入框。
 *
 * 「清空」写的是**空串，而不是把这个键删掉** —— 后端对「缺字段」和「空串」是两回事：
 * 缺字段 = 走默认值，空串 = 明确不要这个表情。这两件事要是搞混，「清空」就变成了
 * 「恢复默认」，用户会以为关掉了其实没关。
 *
 * 提示里**只举官方文档里确认存在的枚举名** —— 后端注释里明写「表情值不猜」：它试过
 * EYES，飞书不认，整个功能静默失灵。宁可少举几个例子，也不把没验证过的枚举名推给用户。
 *
 * `placeholder` 由调用方显式传，**不靠 label 反推** —— 之前写的是 `label === "收到消息"`，而
 * label 实际是 `"收到消息时"`，永远不匹配，两个框的 placeholder 都落成了 DONE。
 */
function EmojiField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const invalid = trimmed !== "" && !EMOJI_NAME.test(trimmed);

  return (
    <div className="space-y-1">
      <span className="block text-caption text-graphite">{label}的表情</span>
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // 失焦时只 trim，**不做大小写转换** —— 官方枚举大小写混用（Typing 是驼峰、
          // DONE 是全大写），转一下就把合法值改非法了。跟后端 emojiOr 保持一致。
          onBlur={() => {
            if (trimmed !== value) onChange(trimmed);
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          aria-label={`${label}的表情枚举名`}
          aria-invalid={invalid}
          className={cn(
            "w-full min-w-0 rounded-input border bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash",
            invalid ? "border-loss focus:border-loss" : "border-transparent focus:border-teal",
          )}
        />
        {value !== "" && (
          <button
            onClick={() => onChange("")}
            aria-label={`清空${label}的表情`}
            className="shrink-0 rounded-btn border border-line px-1.5 py-1 text-[10px] text-graphite hover:bg-line-soft hover:text-ink"
          >
            清空
          </button>
        )}
      </div>
      {invalid ? (
        <p className="text-[10px] leading-relaxed text-loss">
          这里要填飞书的表情枚举名（字母/数字/下划线），不是 👍 这样的表情字符 ——
          填错不会报错，后端会悄悄换回默认值。
        </p>
      ) : (
        <p className="text-[10px] text-ash">
          枚举名（大小写按官方，Typing / DONE / SMILE / HEART…）；留空 = 不加这个表情 ·{" "}
          <a
            href={EMOJI_DOC}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line underline-offset-2 hover:text-graphite"
          >
            查全部枚举
          </a>
        </p>
      )}
    </div>
  );
}

function WebhookBody({
  channel,
  onChange,
}: {
  channel: BotChannel;
  onChange: (next: BotChannel) => void;
}) {
  const cfg = channel.config ?? {};
  return (
    <div className="space-y-2">
      <Field label="Secret" hint="调用时带上它，daemon 用常量时间比较">
        <input
          value={cfg["secret"] ?? ""}
          onChange={(e) => onChange({ ...channel, config: { ...cfg, secret: e.target.value } })}
          spellCheck={false}
          aria-label="Webhook Secret"
          className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
        />
      </Field>
      <p className="text-caption text-ash">
        地址：<code className="font-mono">POST http://127.0.0.1:5181/webhook/bot</code>，body 带{" "}
        <code className="font-mono">botId / secret / text</code>
      </p>
    </div>
  );
}

/** 渠道保存后由 daemon reconcile 自动生效，UI 只提示这一点 */
export function ChannelStatusHint() {
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    return () => undefined;
  }, []);
  return (
    <span className="text-caption text-ash">
      {checking ? <Loader2 size={9} className="inline animate-spin" /> : null} 保存后约 15 秒内生效，不用重启
    </span>
  );
}

/** 渠道配置的账号清单（新形态 accounts，旧形态 config 归一出一个 default） */
function accountsOf(channel: BotChannel): readonly ChannelAccount[] {
  return channel.accounts ?? [emptyAccount(channel.kind)];
}

/**
 * 连通性诊断（向导第三步）。
 *
 * 放在这里而不是设置页深处，是因为诊断的前提是「还没保存、正在配」——
 * 保存之后渠道就生效了，那时候再诊断是另一回事（该看的是运行态）。
 * 诊断按账号走：配了几个飞书账号就各自能独立验。
 */
function DiagnosePanel({ botId, accounts }: { botId: string; accounts: readonly ChannelAccount[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, DiagnosisResult>>({});
  const [err, setErr] = useState<string | null>(null);

  const run = async (acc: ChannelAccount) => {
    setBusyId(acc.id);
    setErr(null);
    try {
      const { diagnoseChannel } = await import("../adapters/daemon/client.ts");
      const r = await diagnoseChannel({ botId, accountId: acc.id });
      setResult((prev) => ({ ...prev, [acc.id]: r }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {accounts.map((acc) => (
        <div key={acc.id} className="space-y-1">
          <div className="flex items-center gap-2">
            <button
              onClick={() => void run(acc)}
              disabled={busyId !== null}
              className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-ink hover:bg-line-soft disabled:opacity-50"
            >
              {busyId === acc.id ? <Loader2 size={9} className="animate-spin" /> : <Stethoscope size={9} />}
              {busyId === acc.id ? "诊断中…" : "测一下连得通不"}
            </button>
            <span className="truncate text-[10px] text-ash">
              {acc.profile === undefined || acc.profile === "" ? "还没填 profile" : acc.profile}
            </span>
          </div>
          {result[acc.id] !== undefined && (
            <ul className="space-y-0.5">
              {result[acc.id]!.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-1.5 text-[10px]">
                  <span className={c.ok ? "text-teal" : "text-loss"}>{c.ok ? "✓" : "✕"}</span>
                  <span className="shrink-0 text-graphite">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-ash" title={c.detail}>
                    {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {err !== null && <p className="text-[10px] text-loss">{err}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-caption text-graphite">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-ash">{hint}</span>}
    </label>
  );
}

function Notice({ tone, icon, children }: { tone: "warn"; icon: LucideIcon; children: React.ReactNode }) {
  const Icon = icon;
  return (
    <div className="flex items-start gap-2 rounded-card border border-line bg-rail/60 p-2.5">
      <span className="mt-0.5 shrink-0 text-graphite">
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1 text-caption text-graphite">{children}</div>
    </div>
  );
}
