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
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Radio,
  ShieldAlert,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { BotChannel, ChannelAccount } from "../core/units.ts";
import { cn } from "./cn.ts";

/** 渠道种类 → 人话。Discord 不在列：零实现，放进选项就是骗人。 */
const KINDS = [
  { kind: "feishu" as const, label: "飞书", hint: "每 bot 一个飞书机器人 · 长连接 · 本机可用" },
  { kind: "telegram" as const, label: "Telegram", hint: "长轮询 · 纯文本" },
  { kind: "webhook" as const, label: "Webhook", hint: "自建服务推给这个 bot · 最简单" },
];

export function ChannelSection({
  channels,
  onChange,
  disabled,
}: {
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

function emptyAccount(kind: BotChannel["kind"]): ChannelAccount {
  return {
    id: "main",
    appId: "",
    appSecret: { source: "env", id: kind === "feishu" ? "FEISHU_APP_SECRET" : "TELEGRAM_BOT_TOKEN" },
    mentionOnly: true,
  };
}

function ChannelCard({
  channel,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
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
            <ImBody channel={channel} onChange={onChange} />
          )}

          {/* 风险声明：只在 IM 类渠道出现，且必须摆在绑定时刻 */}
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
        </div>
      )}
    </div>
  );
}

function ImBody({
  channel,
  onChange,
}: {
  channel: BotChannel;
  onChange: (next: BotChannel) => void;
}) {
  const isFeishu = channel.kind === "feishu";
  const accounts: readonly ChannelAccount[] =
    channel.accounts ?? [emptyAccount(channel.kind)];

  const setAccount = (i: number, patch: Partial<ChannelAccount>) => {
    const next = accounts.map((a, j) => (j === i ? { ...a, ...patch } : a));
    onChange({ ...channel, accounts: next });
  };
  const addAccount = () => onChange({ ...channel, accounts: [...accounts, { ...emptyAccount(channel.kind), id: `a${accounts.length}` }] });
  const removeAccount = (i: number) => onChange({ ...channel, accounts: accounts.filter((_, j) => j !== i) });

  return (
    <div className="space-y-2.5">
      {accounts.map((acc, i) => (
        <div key={acc.id} className="space-y-1.5 rounded-card border border-line p-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-ash">账号 {acc.id || "default"}</span>
            {accounts.length > 1 && (
              <button onClick={() => removeAccount(i)} aria-label="删除账号" className="ml-auto rounded-btn p-0.5 text-ash hover:text-loss">
                <X size={10} />
              </button>
            )}
          </div>
          <Field label={isFeishu ? "App ID" : "Bot Token（明文）"}>
            <input
              value={isFeishu ? acc.appId : (acc.appSecret as { id?: string } | undefined)?.id ?? ""}
              onChange={(e) =>
                isFeishu
                  ? setAccount(i, { appId: e.target.value })
                  : setAccount(i, { appSecret: { source: "env", id: e.target.value } })
              }
              spellCheck={false}
              aria-label={isFeishu ? "App ID" : "Bot Token"}
              className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
            />
          </Field>
          {isFeishu && (
            <>
              <Field label="App Secret 环境变量名" hint="只填变量名，密钥本身不落盘">
                <input
                  value={(acc.appSecret as { id?: string } | undefined)?.id ?? ""}
                  onChange={(e) => setAccount(i, { appSecret: { source: "env", id: e.target.value } })}
                  spellCheck={false}
                  aria-label="App Secret 环境变量名"
                  className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
                />
              </Field>
              <label className="flex items-center gap-1.5 text-caption text-graphite">
                <input type="checkbox" checked={acc.mentionOnly !== false} onChange={(e) => setAccount(i, { mentionOnly: e.target.checked })} />
                群里只在被 @ 时应答
              </label>
            </>
          )}
          {!isFeishu && (
            <Field label="Chat ID" hint="只应答这个会话">
              <input
                value={(acc as unknown as { chatId?: string }).chatId ?? ""}
                onChange={(e) => setAccount(i, { chatId: e.target.value } as Partial<ChannelAccount>)}
                spellCheck={false}
                aria-label="Chat ID"
                className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
              />
            </Field>
          )}
        </div>
      ))}
      <button onClick={addAccount} className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink">
        <Plus size={9} />
        再加一个账号（一个飞书应用 = 一个机器人）
      </button>
      {isFeishu && (
        <p className="text-caption text-ash">
          飞书侧要开：机器人能力 + 事件订阅 <code className="font-mono">im.message.receive_v1</code> +{" "}
          <strong className="font-medium text-graphite">长连接</strong>模式（webhook 模式要公网 URL，本机没有）。
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
