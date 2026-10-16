import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileDiff,
  Package,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import type { RuntimeEvent } from "../core/events.ts";
import { SESSION_SOURCE_LABEL } from "../core/units.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { cn } from "./cn.ts";

/**
 * 时间线 —— Personal Agent 归一化事件流渲染层。
 *
 * 借鉴 GrokBot 与 Meta Muse：
 * - 思考过程折叠收纳（Thinking Accordion），展示耗时/字数摘要
 * - 工具调用卡片化（Tool Execution Pills），内联参数与输出预览
 * - 助手回复采用 Markdown 富文本排版与代码块复制
 * - 用户消息独立卡片排版
 */
export function Timeline() {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);

  // 事件流归并处理：合并流式连续思考片段，配对工具调用
  const items = useMemo(() => groupTimelineEvents(timeline), [timeline]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto max-w-[900px] px-6 py-6 sm:px-8 sm:py-8",
          items.length === 0 && "flex min-h-full flex-col justify-center pb-10 sm:pb-20 transition-all duration-200",
        )}
      >
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <TimelineItemRow key={item.id} item={item} unitName={unit?.name ?? "Agent"} busy={busy} />
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-body-sm text-teal">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" aria-hidden />
                <span>{unit?.name ?? "Agent"} 正在思考与执行…</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 事件归并 */

interface GroupedItem {
  id: string | number;
  kind:
    | "session.start"
    | "session.end"
    | "user.message"
    | "thinking"
    | "assistant.message"
    | "tool"
    | "permission"
    | "subagent.spawned"
    | "subagent.finished"
    | "file.diff"
    | "deliverable"
    | "usage"
    | "error"
    | "system.notice";
  at: number;
  data: any;
}

function groupTimelineEvents(events: readonly { id: number | string; event: RuntimeEvent; at: number }[]): GroupedItem[] {
  const result: GroupedItem[] = [];

  for (const entry of events) {
    const { id, event, at } = entry;

    switch (event.type) {
      case "session.started":
        result.push({ id, kind: "session.start", at, data: event });
        break;

      case "session.ended":
        result.push({ id, kind: "session.end", at, data: event });
        break;

      case "message.delta":
        if (event.role === "user") {
          result.push({ id, kind: "user.message", at, data: { text: event.text } });
        }
        break;

      case "reasoning.delta": {
        const last = result[result.length - 1];
        if (last && last.kind === "thinking") {
          last.data.text += event.text;
        } else {
          result.push({ id, kind: "thinking", at, data: { text: event.text } });
        }
        break;
      }

      case "message.completed":
        result.push({ id, kind: "assistant.message", at, data: { text: event.text } });
        break;

      case "tool.started":
        result.push({
          id,
          kind: "tool",
          at,
          data: {
            callId: event.callId,
            toolName: event.toolName,
            title: event.title,
            input: event.input,
            completed: false,
          },
        });
        break;

      case "tool.completed": {
        // 回溯匹配同 callId 的 started 记录
        const target = result.find(
          (r) => r.kind === "tool" && r.data.callId === event.callId && !r.data.completed,
        );
        if (target) {
          target.data.completed = true;
          target.data.ok = event.ok;
          target.data.output = event.output;
        } else {
          result.push({
            id,
            kind: "tool",
            at,
            data: {
              callId: event.callId,
              toolName: "工具执行",
              title: "",
              completed: true,
              ok: event.ok,
              output: event.output,
            },
          });
        }
        break;
      }

      case "permission.requested":
        result.push({ id, kind: "permission", at, data: event });
        break;

      case "subagent.spawned":
        result.push({ id, kind: "subagent.spawned", at, data: event });
        break;

      case "subagent.finished":
        result.push({ id, kind: "subagent.finished", at, data: event });
        break;

      case "file.diff":
        result.push({ id, kind: "file.diff", at, data: event });
        break;

      case "deliverable":
        result.push({ id, kind: "deliverable", at, data: event });
        break;

      case "usage":
        result.push({ id, kind: "usage", at, data: event });
        break;

      case "error":
        result.push({ id, kind: "error", at, data: event });
        break;

      case "system.notice":
        result.push({ id, kind: "system.notice", at, data: event });
        break;

      default:
        break;
    }
  }

  return result;
}

/* ------------------------------------------------------------- 行渲染 */

function parseSlashCommand(text: string): { isCommand: boolean; name: string; args: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\n")) {
    return { isCommand: false, name: "", args: "" };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { isCommand: true, name: trimmed.slice(1), args: "" };
  }
  return {
    isCommand: true,
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

function UserMessageBubble({ text }: { text: string }) {
  const parsed = parseSlashCommand(text);

  if (parsed.isCommand) {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-[16px] rounded-tr-[4px] border border-line bg-card px-3.5 py-2.5 shadow-xs flex items-center gap-2.5">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[11px] font-bold leading-none">
            /
          </div>
          <span className="font-mono text-body font-bold text-ink">
            /{parsed.name}
          </span>
          {parsed.args ? (
            <span className="font-mono text-body-sm text-graphite rounded-md bg-line-soft/80 px-2 py-0.5 border border-line-soft max-w-[420px] truncate">
              {parsed.args}
            </span>
          ) : null}
          <span className="ml-1 font-mono text-[10px] text-graphite/70 border border-line-soft rounded px-1.5 py-px shrink-0">
            斜杠指令
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] rounded-[16px] rounded-tr-[4px] border border-line bg-card px-4 py-3 shadow-xs">
        <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{text}</p>
      </div>
    </div>
  );
}

function TimelineItemRow({ item, unitName, busy }: { item: GroupedItem; unitName: string; busy: boolean }) {
  switch (item.kind) {
    case "session.start":
      return <SessionStartRow event={item.data} at={item.at} />;

    case "session.end":
      return (
        <div className="my-6 flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <span className="tnum shrink-0 text-caption text-ash">会话结束 · {item.data.reason}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );

    case "user.message":
      return <UserMessageBubble text={item.data.text} />;

    case "thinking":
      return <ThinkingBlock text={item.data.text} busy={busy} />;

    case "tool":
      return <ToolCallBlock data={item.data} />;

    case "assistant.message":
      return <AssistantMessageBlock text={item.data.text} unitName={unitName} at={item.at} />;

    case "permission":
      return (
        <PermissionRow
          requestId={item.data.requestId}
          detail={item.data.detail}
          risk={item.data.risk}
        />
      );

    case "subagent.spawned":
      return (
        <div className="rounded-card border-l-2 border-l-teal bg-card px-4 py-3 shadow-subtle flex items-center gap-2">
          <Package size={14} className="shrink-0 text-teal" />
          <p className="text-body-sm text-graphite">
            派生子代理 · 角色 <span className="font-medium text-ink">{item.data.role}</span> · 经由 {item.data.runtimeId}
          </p>
        </div>
      );

    case "subagent.finished":
      return (
        <div className="flex items-center gap-2 pl-1 text-body-sm text-graphite">
          <Check size={14} className="shrink-0 text-gain" />
          <span>子代理完成{item.data.summary ? ` · ${item.data.summary}` : ""}</span>
        </div>
      );

    case "file.diff":
      return (
        <div className="rounded-card bg-card px-4 py-3 shadow-subtle flex items-center gap-2 border border-line/60">
          <FileDiff size={14} className="shrink-0 text-graphite" />
          <span className="truncate font-mono text-body-sm text-ink">{item.data.path}</span>
          <span className="tnum ml-auto shrink-0 font-mono text-caption">
            <span className="text-gain">+{item.data.additions}</span>{" "}
            <span className="text-loss">−{item.data.deletions}</span>
          </span>
        </div>
      );

    case "deliverable":
      return (
        <div className="rounded-card bg-card px-4 py-3 shadow-subtle flex items-center gap-2 border border-teal/30">
          <Package size={14} className="shrink-0 text-teal" />
          <span className="text-body-sm font-medium text-ink">{item.data.title}</span>
          {item.data.path && (
            <span className="ml-auto shrink-0 font-mono text-caption text-ash">{item.data.path}</span>
          )}
        </div>
      );

    case "usage":
      return (
        <div className="flex items-center gap-2 pl-1 text-caption text-ash">
          <Wallet size={12} />
          <span className="font-mono">{item.data.model}</span>
          <span className="tnum font-mono">
            {item.data.inputTokens}↑ / {item.data.outputTokens}↓
          </span>
          <span className="tnum ml-auto font-mono text-graphite">${item.data.costUsd.toFixed(3)}</span>
        </div>
      );

    case "error":
      return (
        <div className="rounded-card border border-loss/30 bg-loss/5 px-4 py-3 text-body-sm text-loss">
          {item.data.message}
        </div>
      );

    case "system.notice":
      return <SystemNoticeRow event={item.data} at={item.at} />;

    default:
      return null;
  }
}

/* ------------------------------------------------------------- 系统通知卡片 */

function SystemNoticeRow({
  event,
  at,
}: {
  event: {
    title: string;
    text: string;
    level?: "info" | "success" | "warn";
    meta?: Readonly<Record<string, string>>;
  };
  at: number;
}) {
  const isSuccess = event.level === "success";
  const isWarn = event.level === "warn";

  return (
    <div
      className={cn(
        "rounded-card border p-3.5 shadow-xs transition animate-in fade-in slide-in-from-bottom-1 duration-150",
        isSuccess
          ? "border-teal/30 bg-teal-tint/20 text-ink"
          : isWarn
            ? "border-amber-500/30 bg-amber-500/10 text-ink"
            : "border-line bg-line-soft/80 text-ink",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold",
            isSuccess ? "bg-teal text-canvas" : isWarn ? "bg-amber-600 text-white" : "bg-ink text-canvas",
          )}
        >
          ⚡
        </div>
        <span className="font-semibold text-body-sm text-ink">{event.title}</span>
        <span className="ml-auto font-mono text-[10px] text-ash">
          {new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>

      <div className="mt-2 text-body-sm text-graphite whitespace-pre-wrap leading-relaxed font-normal">
        {event.text}
      </div>

      {event.meta && Object.keys(event.meta).length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-2 border-t border-line-soft">
          {Object.entries(event.meta).map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-0.5 text-[11px] font-mono text-graphite border border-line-soft"
            >
              <span className="text-ash">{k}:</span>
              <span className="font-medium text-ink">{v}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 思考过程折叠块 */

function ThinkingBlock({ text, busy }: { text: string; busy: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex items-center gap-2 rounded-btn px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <Sparkles size={13} className={cn("text-teal", busy && "animate-pulse")} />
        <span className="font-medium">{busy ? "思考中…" : "深度思考"}</span>
        <span className="font-mono text-ash text-[11px]">({text.length} 字)</span>
        {expanded ? (
          <ChevronDown size={12} className="text-ash transition group-hover:text-ink" />
        ) : (
          <ChevronRight size={12} className="text-ash transition group-hover:text-ink" />
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 max-h-96 overflow-y-auto rounded-card border border-line-soft bg-rail/60 p-3.5 font-mono text-body-sm italic leading-relaxed text-graphite whitespace-pre-wrap shadow-inner">
          {text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 工具调用卡片 */

function ToolCallBlock({
  data,
}: {
  data: {
    callId: string;
    toolName: string;
    title?: string;
    input?: unknown;
    completed: boolean;
    ok?: boolean;
    output?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);

  const ToolIcon = getToolIcon(data.toolName);
  const brief = data.title || formatInputBrief(data.input);

  return (
    <div className="overflow-hidden rounded-input border border-line bg-card shadow-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-line-soft/50"
      >
        <ToolIcon size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">{data.toolName}</span>
        {brief && <span className="min-w-0 flex-1 truncate font-mono text-caption text-ash">{brief}</span>}

        <div className="ml-auto flex items-center gap-2">
          {data.completed ? (
            data.ok ? (
              <span className="flex items-center gap-1 text-[11px] text-gain">
                <Check size={12} />
                <span>完成</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-loss">
                <AlertTriangle size={12} />
                <span>失败</span>
              </span>
            )
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span>执行中</span>
            </span>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line/60 bg-rail/40 px-3 py-2.5 text-caption font-mono space-y-2">
          {data.input !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1">输入参数</p>
              <pre className="max-h-40 overflow-auto rounded bg-card p-2 text-ink border border-line/50 leading-relaxed">
                <code>{typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2)}</code>
              </pre>
            </div>
          )}

          {data.output !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1">执行输出</p>
              <pre className="max-h-60 overflow-auto rounded bg-card p-2 text-graphite border border-line/50 leading-relaxed whitespace-pre-wrap">
                <code>{data.output}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getToolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("terminal") || n.includes("bash") || n.includes("exec") || n.includes("command")) return Terminal;
  if (n.includes("file") || n.includes("read") || n.includes("write") || n.includes("edit")) return FileCode;
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return Search;
  return Wrench;
}

function formatInputBrief(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const target = obj.path ?? obj.CommandLine ?? obj.command ?? obj.Query ?? obj.TargetFile ?? obj.url;
    if (typeof target === "string") return target;
  }
  return "";
}

/* ------------------------------------------------------------- 助手回复消息块 */

function AssistantMessageBlock({ text, unitName, at }: { text: string; unitName: string; at: number }) {
  const avatar = botAvatarStyle(unitName);

  return (
    <div className="group/msg py-1">
      {/* 头部：Agent 头像与名字 */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={cn("flex h-5 w-5 shrink-0 items-center justify-center text-[11px] font-medium text-canvas", avatar.shape)}
          style={{ backgroundColor: avatar.color }}
        >
          {unitName.slice(0, 1)}
        </span>
        <span className="text-body-sm font-medium text-ink">{unitName}</span>
        <span className="text-caption text-ash">{clock(at)}</span>
      </div>

      {/* 正文 Markdown 渲染 */}
      <div className="pl-7">
        <MarkdownContent content={text} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 辅助组件 */

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function SessionStartRow({
  event,
  at,
}: {
  event: Extract<RuntimeEvent, { type: "session.started" }>;
  at: number;
}) {
  const source = event.source ?? "workbench";
  const fromWorkbench = source === "workbench";
  return (
    <div className="my-6 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="h-px flex-1 bg-line" />
      <span className="tnum shrink-0 text-caption text-ash">会话开始 · {clock(at)}</span>
      {!fromWorkbench && (
        <span
          className="shrink-0 rounded-btn bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal"
          title="这个会话是从这个渠道发起的，和工作台里的是同一段对话"
        >
          来自{SESSION_SOURCE_LABEL[source]}
        </span>
      )}
      {event.modelActual !== undefined && (
        <span className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite" title="实际生效的模型">
          {event.modelActual}
        </span>
      )}
      {event.modelHintDropped !== undefined && (
        <span
          className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite"
          title={`你配的默认模型 ${event.modelHintDropped} 这家执行器不接，已回落到执行器默认`}
        >
          配的 {event.modelHintDropped} 不可用，已回落
        </span>
      )}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function PermissionRow({
  requestId,
  detail,
  risk,
}: {
  requestId: string;
  detail: string;
  risk: "low" | "medium" | "high";
}) {
  const decision = useWorkbench((s) => s.permissionDecisions[requestId]);

  return (
    <div className="mb-2 flex items-center gap-2 rounded-btn bg-line-soft px-3 py-2 text-body-sm">
      {decision ? (
        decision === "deny" ? (
          <X size={12} className="shrink-0 text-loss" />
        ) : (
          <Check size={12} className="shrink-0 text-gain" />
        )
      ) : (
        <ShieldCheck size={12} className="shrink-0 animate-pulse text-teal" />
      )}
      <span className="min-w-0 flex-1 truncate text-graphite">{detail}</span>
      {risk === "high" && <span className="shrink-0 text-caption text-loss">高风险</span>}
      <span className={cn("shrink-0 text-caption", decision ? "text-ash" : "text-teal")}>
        {decision ? (DECISION_LABEL[decision] ?? decision) : "待裁决"}
      </span>
    </div>
  );
}

const DECISION_LABEL: Record<string, string> = {
  allow: "已允许一次",
  always: "已始终允许",
  deny: "已拒绝",
};

/* ------------------------------------------------------------- 空态 */

function EmptyState() {
  const unit = useWorkbench(selectActiveUnit);
  const avatarFrame = useAppearance((s) => s.avatarFrame);

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? "夜深了" : hour < 9 ? "早上好" : hour < 12 ? "上午好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  const avatar = unit ? botAvatarStyle(unit.name, avatarFrame) : null;

  return (
    <div className="flex flex-col items-center">
      {unit && (
        /* 头像与 bot 设置里同一份：自定义头像优先，缺省回落设置页同款「浅底 + 首字」，
           外框形态跟随外观设置的「bot 头像框形态」 */
        unit.avatar ? (
          <img
            src={unit.avatar}
            alt=""
            className={cn("mb-3 h-14 w-14 object-cover shadow-subtle", avatar?.shape)}
          />
        ) : (
          <div
            className={cn(
              "mb-3 flex h-14 w-14 items-center justify-center bg-line-soft text-body-lg font-medium text-graphite shadow-subtle",
              avatar?.shape,
            )}
          >
            {unit.name.slice(0, 1)}
          </div>
        )
      )}
      <p className="text-caption text-ash">{greeting}</p>
      <p className="mt-1 text-body-lg font-medium text-ink">
        {!unit ? "选一个 Agent 开始" : `向「${unit.name}」交代任务`}
      </p>
      <p className="mt-1 text-body-sm text-graphite">
        {!unit
          ? "新建一个 Agent，或认领已有目录"
          : unit.identity?.role
            ? `已装载岗位：${unit.identity.role} · 读 AGENTS.md`
            : "从对话或快捷任务开始"}
      </p>
    </div>
  );
}
