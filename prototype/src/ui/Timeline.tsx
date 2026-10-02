import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  FileDiff,
  Package,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import type { RuntimeEvent } from "../core/events.ts";
import { SESSION_SOURCE_LABEL } from "../core/units.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 时间线 —— 消费归一化事件流的唯一渲染层。
 *
 * 这里是 SPI 的验收现场：无论底下是 ACP 的 JSON-RPC、pi 的 CBOR、
 * 还是 ZCode 的 HTTP，六家工具的事件都在这一套组件里渲染。
 * 接真运行时不需要动这个文件。
 *
 * 排版对齐 DESIGN.md：内容列封顶 900px 居中，保证长会话的可读行宽。
 */
export function Timeline() {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto max-w-[900px] px-8 py-8",
          timeline.length === 0 && "flex min-h-full flex-col justify-center pb-24",
        )}
      >
        {timeline.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {timeline.map(({ id, event, at }) => (
              <Row key={id} event={event} at={at} />
            ))}
            {busy && (
              <div className="mt-3 flex items-center gap-2 text-body-sm text-graphite">
                <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden />
                执行中…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 空态 */

const SUGGESTIONS: readonly { title: string; desc: string; prompt: string }[] = [
  {
    title: "今日选题",
    desc: "读语料风格，产出 5 个可写选题",
    prompt: "读一下已沉淀的语料风格，产出今天可写的 5 个选题",
  },
  {
    title: "扫描项目",
    desc: "巡检目录结构与 TODO，列出改进项",
    prompt: "巡检当前项目的目录结构与 TODO，列出可执行的改进项",
  },
  {
    title: "写日报",
    desc: "汇总今日产出，生成一段日报",
    prompt: "汇总今天所有产出，生成一段可直接发的日报",
  },
  {
    title: "复盘会话",
    desc: "从轨迹里找出可改进的环节",
    prompt: "复盘最近的会话轨迹，找出最值得改进的环节",
  },
];

function EmptyState() {
  const setDraft = useWorkbench((s) => s.setDraft);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));

  // 时段问候（ZCode: chat.empty.greeting.*，5/9/12/14/18/23 点换档）
  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? "夜深了" : hour < 9 ? "早上好" : hour < 12 ? "上午好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  return (
    <div className="flex flex-col items-center">
      <p className="text-caption text-ash">{greeting}</p>
      <p className="mt-1 text-body-lg text-graphite">
        {/* 同 Composer 的坑：unit 为空时 `${unit?.name}` 会印出字面量 "undefined"。
            空单元是正常状态（还没建 bot），要给它自己的话，不要冒充项目模式。 */}
        {!unit
          ? "选一个工作单元开始"
          : unit.kind === "bot"
            ? `给「${unit.name}」派活`
            : `对「${unit.name}」下任务`}
      </p>
      <p className="mt-1 text-body-sm text-ash">
        {!unit
          ? "新建一个 bot，或添加一个项目目录"
          : unit.kind === "bot"
            ? "会先读它的 AGENTS.md 当岗位说明书"
            : "项目模式，可开 worktree 隔离"}
      </p>

      <div className="mt-8 grid w-full grid-cols-2 gap-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => setDraft(s.prompt)}
            className="rounded-card bg-card px-4 py-3 text-left shadow-subtle hover:bg-surface-hover"
          >
            <p className="text-body-sm font-medium text-ink">{s.title}</p>
            <p className="mt-0.5 text-body-sm text-graphite">{s.desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 权限卡 */

/**
 * 时间线里的权限行只做**审计回迹**，交互交给 PermissionDialog。
 *
 * 对齐 ZCode：待裁决请求用模态对话框打断，不用内联卡片。
 * 这里保留一行紧凑记录，是为了时间线读起来是完整的因果链，而不是断口。
 */
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

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** 事件卡：Soft Paper 面 + 16px 圆角 + 那一道唯一的阴影 */
const card = "rounded-card bg-card px-4 py-3 shadow-subtle";

/**
 * 「会话开始」这一行同时回答两个问题（docs/09 §六.1 / §六.2）：
 *
 * 1. **这轮从哪来** —— 飞书里点的和工作台里点的，是同一个 bot 的同一段对话。
 *    来源不同只体现为这一枚徽标，不产生第二套会话体系。
 * 2. **实际在烧哪个模型** —— 你配的 modelHint 可能被静默丢掉（那家 CLI 不接），
 *    落到了执行器默认。这件事只在 daemon 里发生，界面不说就等于没发生：
 *    用户以为在用便宜模型，实际在烧贵的。
 */
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
      {/* 来源徽标：工作台是默认面，不必占位；其他端才亮出来 */}
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

function Row({ event, at }: { event: RuntimeEvent; at: number }) {
  switch (event.type) {
    case "session.started":
    case "session.ended": {
      if (event.type === "session.started") {
        return <SessionStartRow event={event} at={at} />;
      }
      const label = `会话结束 · ${event.reason}`;
      return (
        <div className="my-6 flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <span className="tnum shrink-0 text-caption text-ash">{label}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    }

    case "message.delta": {
      // 用户消息 —— ZCode 的用户行右对齐、带气泡（rounded-tr 切角是它的识别特征）
      if (event.role !== "user") return null;
      return (
        <div className="mb-4 flex flex-col items-end">
          <div className="max-w-[85%] rounded-[14px] rounded-tr-[4px] border border-line bg-card px-4 py-3">
            <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{event.text}</p>
          </div>
        </div>
      );
    }

    case "reasoning.delta":
      return (
        <p className="my-2 flex items-baseline gap-2 pl-1 text-body-sm text-ash">
          <span className="tnum shrink-0 font-mono text-caption">{clock(at)}</span>
          <span className="italic">{event.text}</span>
        </p>
      );

    case "message.completed":
      // ZCode 的助手行没有气泡：正文直接落在画布上，来源标识弱化为前缀行
      return (
        <div className="group/assistant mb-3">
          <p className="mb-1 flex items-center gap-1.5 text-caption text-ash">
            <Bot size={12} />
            assistant
          </p>
          <p className="text-body leading-relaxed text-ink">{event.text}</p>
        </div>
      );

    case "subagent.spawned":
      return (
        <div className={`${card} mb-2 flex items-center gap-2 border-l-2 border-l-teal`}>
          <Package size={12} className="shrink-0 text-teal" />
          <p className="text-body-sm text-graphite">
            派生子代理 · 角色 <span className="text-ink">{event.role}</span> · 经由 {event.runtimeId}
          </p>
        </div>
      );

    case "subagent.finished":
      return (
        <div className="mb-2 flex items-center gap-2 pl-1 text-body-sm text-graphite">
          <Check size={12} className="shrink-0 text-gain" />
          子代理完成{event.summary ? ` · ${event.summary}` : ""}
        </div>
      );

    case "permission.requested":
      return (
        <PermissionRow
          requestId={event.requestId}
          detail={event.detail}
          risk={event.risk}
        />
      );

    case "tool.started":
      return (
        <div className="mb-1 flex items-center gap-2 rounded-btn px-1 py-1 hover:bg-line-soft">
          <ChevronRight size={12} className="shrink-0 text-ash" />
          <span className="font-mono text-body-sm text-graphite">{event.toolName}</span>
          <span className="truncate text-body-sm text-ash">{event.title}</span>
        </div>
      );

    case "tool.completed":
      return (
        <div className="mb-2 flex items-center gap-2 pl-1 text-body-sm text-ash">
          {event.ok ? (
            <Check size={12} className="shrink-0 text-gain" />
          ) : (
            <AlertTriangle size={12} className="shrink-0 text-loss" />
          )}
          <span className="font-mono">{event.output ?? (event.ok ? "完成" : "失败")}</span>
        </div>
      );

    case "file.diff":
      return (
        <div className={`${card} mb-3 flex items-center gap-2`}>
          <FileDiff size={12} className="shrink-0 text-graphite" />
          <span className="truncate font-mono text-body-sm text-ink">{event.path}</span>
          <span className="tnum ml-auto shrink-0 font-mono text-caption">
            <span className="text-gain">+{event.additions}</span>{" "}
            <span className="text-loss">−{event.deletions}</span>
          </span>
        </div>
      );

    case "usage":
      return (
        <div className="mb-2 flex items-center gap-2 pl-1 text-caption text-ash">
          <Wallet size={12} />
          <span className="font-mono">{event.model}</span>
          <span className="tnum font-mono">
            {event.inputTokens}↑ / {event.outputTokens}↓
          </span>
          <span className="tnum ml-auto font-mono text-graphite">${event.costUsd.toFixed(3)}</span>
        </div>
      );

    case "deliverable":
      return (
        <div className={`${card} mb-3 flex items-center gap-2`}>
          <Package size={12} className="shrink-0 text-teal" />
          <span className="text-body-sm text-ink">{event.title}</span>
          {event.path && (
            <span className="ml-auto shrink-0 font-mono text-caption text-ash">{event.path}</span>
          )}
        </div>
      );

    case "error":
      return (
        <div className="mb-3 rounded-card border border-loss/30 bg-loss/5 px-4 py-3 text-body-sm text-loss">
          {event.message}
        </div>
      );

    default:
      return null;
  }
}
