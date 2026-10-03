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
  RotateCw,
  ShieldAlert,
  Stethoscope,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { DiagnosisResult, LarkBotIdentity } from "../adapters/daemon/client.ts";
import type { BotChannel, ChannelAccount } from "../core/units.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ChannelMark } from "./ChannelMark.tsx";
import { cn } from "./cn.ts";

/** 渠道种类 → 人话。Discord 不在列：零实现，放进选项就是骗人。 */
const KINDS = [
  { kind: "feishu" as const, label: "飞书", hint: "每 bot 一个飞书机器人 · 长连接 · 本机可用" },
  { kind: "telegram" as const, label: "Telegram", hint: "长轮询 · 纯文本" },
  { kind: "webhook" as const, label: "Webhook", hint: "自建服务推给这个 bot · 最简单" },
];

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
            <ImBody channel={channel} onChange={onChange} />
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
  channel,
  onChange,
}: {
  channel: BotChannel;
  onChange: (next: BotChannel) => void;
}) {
  const isFeishu = channel.kind === "feishu";
  const accounts: readonly ChannelAccount[] = accountsOf(channel);

  const setAccount = (i: number, patch: Partial<ChannelAccount>) => {
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
              <Field
                label="lark-cli profile"
                hint="一个 profile = 一个飞书应用 = 一个飞书机器人。用 lark-cli profile list 查已有 profile"
              >
                <input
                  value={acc.profile ?? ""}
                  onChange={(e) => setAccount(i, { profile: e.target.value })}
                  spellCheck={false}
                  placeholder="cli_a94d3ea8b5f99cc0"
                  aria-label="lark-cli profile"
                  className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                />
              </Field>
              <label className="flex items-center gap-1.5 text-caption text-graphite">
                <input type="checkbox" checked={acc.mentionOnly !== false} onChange={(e) => setAccount(i, { mentionOnly: e.target.checked })} />
                群里只在被 @ 时应答
              </label>
              <LarkIdentityCard profile={acc.profile ?? ""} />
              <p className="text-[10px] text-ash">
                凭据不进这里——profile 自己管。发消息/附件/文档/云盘由 agent 在轮次里调
                <code className="font-mono"> lark-cli</code> 自己完成。
              </p>
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
        </div>
      ))}
      <button onClick={addAccount} className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink">
        <Plus size={9} />
        再加一个账号（一个飞书应用 = 一个机器人）
      </button>
      {isFeishu && (
        <p className="text-caption text-ash">
          飞书侧要开：机器人能力 + 事件订阅 <code className="font-mono">im.message.receive_v1</code>
          （CLI 走长连接，不需要公网 URL）。这些在开放平台配，配完用下面的「测一下连得通不」验证。
        </p>
      )}
    </div>
  );
}

/**
 * 「这绑的是哪个飞书机器人」。
 *
 * ## 为什么必须在绑定那一刻就能看
 *
 * profile 是一串 `cli_a94d…`，谁也认不出它是飞书里的哪一个。用户配渠道时真正
 * 要回答的问题是「我等下在飞书里 @ 谁」——所以这里把 `bot/v3/info` 的应用名和
 * 头像直接摆出来，而不是让他填完保存、再凭记忆去飞书里对。
 *
 * 刻意支持**未保存的草稿 profile**：设置向导的前提就是「还没保存、正在配」。
 * 先存后认 = 逼用户盲填一串 ID。
 *
 * 认不出来也要说清为什么，不留空白：profile 写错、lark-cli 没装、daemon 没起，
 * 三种原因的处理方式完全不同。
 */
function LarkIdentityCard({ profile }: { profile: string }) {
  const key = profile.trim();
  const identity = useWorkbench((s) => (key === "" ? undefined : s.channelIdentity[key]));
  const refresh = useWorkbench((s) => s.refreshChannelIdentity);
  const [busy, setBusy] = useState(false);

  // 打字停顿 400ms 再认。lark-cli 每次认身份要 spawn 一下，逐键去认会起进程风暴。
  useEffect(() => {
    if (key === "" || identity !== undefined) return;
    let dead = false;
    const timer = setTimeout(() => {
      setBusy(true);
      void refresh([key]).finally(() => {
        if (!dead) setBusy(false);
      });
    }, 400);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [key, identity, refresh]);

  if (key === "") {
    return <p className="text-[10px] text-ash">填了 profile，这里会显示是飞书里的哪个机器人。</p>;
  }

  if (identity === undefined) {
    return (
      <p className="flex items-center gap-1 text-[10px] text-ash">
        {busy ? <Loader2 size={9} className="animate-spin" /> : null}
        {busy ? "在认这个机器人…" : "还没认出这个机器人"}
      </p>
    );
  }

  const retry = () => {
    setBusy(true);
    void refresh([key]).finally(() => setBusy(false));
  };

  if (!identity.ok) {
    return (
      <div className="space-y-1 rounded-card border border-loss/30 bg-loss/5 px-2 py-1.5">
        <p className="flex items-start gap-1.5 text-[10px] text-loss">
          <AlertTriangle size={9} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">认不出这个 profile 对应的机器人：{identity.detail}</span>
        </p>
        <div className="flex items-center gap-2">
          <button onClick={retry} disabled={busy} className="flex items-center gap-1 text-[10px] text-graphite hover:text-ink disabled:opacity-50">
            {busy ? <Loader2 size={9} className="animate-spin" /> : <RotateCw size={9} />}
            重试
          </button>
          <span className="text-[10px] text-ash">常见原因：profile 写错 / lark-cli 没装 / 那个应用已被删</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-card border border-line bg-rail/50 px-2 py-1.5">
      <ChannelMark kind="feishu" identity={identity} label={identity.appName} className="h-6 w-6 rounded-[4px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-caption font-medium text-ink">{identity.appName || "（飞书没给应用名）"}</p>
        <p className="truncate font-mono text-[10px] text-ash" title={`open_id ${identity.openId}`}>
          {identity.openId === "" ? identity.profile : identity.openId}
          {identity.activateStatus === 2 ? " · 飞书侧已启用" : ` · 飞书侧未启用（status=${identity.activateStatus}）`}
        </p>
      </div>
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
