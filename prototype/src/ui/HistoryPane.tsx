import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Copy,
  GitBranch,
  ListTodo,
  MessageSquare,
  Radio,
  RotateCcw,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  dispatchTerminal,
  fetchNativeSessionDetail,
  fetchNativeSessions,
  fetchSessionMessages,
  fetchTerminalTranscript,
  fetchUnitHistory,
  type NativeSessionDetail,
  type NativeSessionSummary,
  type UnitHistoryEntry,
} from "../adapters/daemon/client.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { asSessionId, asUnitId } from "../core/units.ts";
import { useShell } from "../store/useShell.ts";
import { collapseForkVersions } from "./forkHistory.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { cn } from "./cn.ts";

/**
 * 单元历史会话 —— 每个 bot 一条统一时间轴：自动化任务、待办任务、心跳会话、
 * 手动/IM 会话。核心目的是「打开就能看到这个 bot 历史执行过什么」，不用再去
 * 各执行器的 TUI 会话列表里翻。
 *
 * 迁移自 HistoryDialog 弹窗（ZCode 右侧栏模式）：内容主体原样平移，只换壳 ——
 * - 不再有 fixed overlay / Esc / 点遮罩关闭；关闭即关 tab（面板条上的 ×）
 * - 跨 bot 保活：面板隐藏（切走 bot / 收起）时**不轮询不重置**，列表缓存与
 *   展开态保留，切回即达；重新可见时立刻刷一次并恢复轮询
 * - 「TUI 恢复 / 在聊天页继续」成功后调 onFinished 关掉这个 tab（弹窗时代
 *   是 onClose 关弹窗 —— 动作完成，这个视图的使命就结束了）
 *
 * - headless 条目带 sessionId，可展开内联看对话（session.messages，daemon 对
 *   历史会话有 store 兜底）
 * - TUI 条目没有消息流，只有运行状态与结果摘要（terminal exit / ended: …）
 */

const KIND_META: Record<UnitHistoryEntry["kind"], { icon: typeof ListTodo; label: string; cls: string }> = {
  automation: { icon: AlarmClock, label: "定时", cls: "bg-teal-tint text-teal" },
  backlog: { icon: ListTodo, label: "待办", cls: "bg-amber-500/10 text-amber-600" },
  manual: { icon: Terminal, label: "手动", cls: "bg-violet-500/10 text-violet-500" },
  session: { icon: MessageSquare, label: "会话", cls: "bg-line-soft text-graphite" },
};

function statusMeta(status: string): { icon: typeof CircleCheck; cls: string; label: string } {
  if (status === "done" || status === "completed" || status === "idle") {
    return { icon: CircleCheck, cls: "text-gain", label: "完成" };
  }
  if (status === "failed") return { icon: CircleAlert, cls: "text-loss", label: "失败" };
  if (status === "skipped") return { icon: CircleAlert, cls: "text-ash", label: "跳过" };
  if (status === "running") return { icon: CircleDot, cls: "text-blue-500 animate-pulse", label: "运行中" };
  return { icon: CircleDot, cls: "text-graphite", label: status };
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return hm;
  return `${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${hm}`;
}

function formatDuration(entry: UnitHistoryEntry): string | null {
  if (entry.endedAt === null) return null;
  const s = Math.round((entry.endedAt - entry.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * 每执行器的 TUI 恢复口径（各家 --help 实测）：
 *   zcode    --resume <sessionId>（我们的 id 即原生 sess_ id）
 *   claude   --resume <session-id>（cli_ref = CLI 原生 session id）
 *   codex    resume <SESSION_ID>（子命令，cli_ref = thread id）
 *   mcode    --session <id>（ACP sessionId 与 TUI 会话同库）
 *   kimi     --session <id>（-S，带 id 直接恢复）
 *   opencode --session <id>（-s，session id to continue）
 *   hermes   --resume <SESSION>
 *   dsh      --resume <id>（TUI 走 dst shim，--resume [id]）
 * ACP 系的 id 与 TUI 会话库同源（同一 CLI 的会话存储），若个别家实测对不上，
 * 从表里删一行即可，记录侧不受影响。
 */
const RESUME_ARGS: Record<string, (ref: string) => string[]> = {
  zcode: (ref) => ["--resume", ref],
  claude: (ref) => ["--resume", ref],
  codex: (ref) => ["resume", ref],
  mcode: (ref) => ["--session", ref],
  kimi: (ref) => ["--session", ref],
  opencode: (ref) => ["--session", ref],
  hermes: (ref) => ["--resume", ref],
  dsh: (ref) => ["--resume", ref],
  agy: (ref) => ["--conversation", ref],
  antigravity: (ref) => ["--conversation", ref],
  pi: (ref) => ["--session-id", ref],
  grok: (ref) => ["--resume", ref],
  cursor: (ref) => ["--resume", ref],
  "cursor-agent": (ref) => ["--resume", ref],
  openclaw: (ref) => ["agent", "--session-id", ref],
};

/** 可恢复判定（侧栏子列表与历史面板共用） */
export function resumeArgsFor(runtimeId: string, resumeRef: string | null): string[] | null {
  if (resumeRef === null) return null;
  const build = RESUME_ARGS[runtimeId];
  return build === undefined ? null : build(resumeRef);
}

export function HistoryPane({
  unitId,
  unitName,
  focusKey,
  isActive,
  onFinished,
}: {
  unitId: string;
  unitName: string;
  /** 侧栏子列表点进来时预展开的条目（对话直接可见，不用再点一次） */
  focusKey?: string;
  /** 面板当前可见且为本 tab（保活协议：false 时停轮询、保留缓存） */
  isActive: boolean;
  /** 「TUI 恢复 / 在聊天页继续」成功后关掉本 tab */
  onFinished: () => void;
}): ReactElement {
  const units = useWorkbench((s) => s.units);
  const [entries, setEntries] = useState<readonly UnitHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(focusKey ?? null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);

  /** 页签：运行记录（daemon 台账）| 原生会话（各 CLI 自己的存储，docs/13 Phase 1） */
  const [tab, setTab] = useState<"runs" | "native">("runs");
  const [nativeList, setNativeList] = useState<readonly NativeSessionSummary[] | null>(null);
  const [nativeErr, setNativeErr] = useState<string | null>(null);
  const [nativeExpanded, setNativeExpanded] = useState<string | null>(null);

  /**
   * 在 TUI 中恢复：按条目执行器派发终端，带各家 resume 口径的参数（见 RESUME_ARGS）。
   * 依据是 cli_ref（执行器原生会话 id），不是我们的内部 id —— 记录侧只存 id，
   * 适配全部收敛在这张映射表里。
   */
  const resumable = (e: UnitHistoryEntry): boolean =>
    resumeArgsFor(e.runtimeId, e.resumeRef) !== null && units.some((u) => u.id === unitId);

  const handleResume = (e: UnitHistoryEntry): void => {
    const u = units.find((x) => x.id === unitId);
    const args = resumeArgsFor(e.runtimeId, e.resumeRef);
    if (u === undefined || args === null) return;
    setResumeBusy(e.key);
    // 派发意图先登记：紧跟的「终端跟随 bot」effect 看到在途就不再发一个全新 TUI
    useTerminalStore.getState().notePendingUnitDispatch(unitId);
    void dispatchTerminal({
      unitId,
      unitName: u.name,
      rootPath: u.rootPath,
      runtimeId: e.runtimeId,
      args,
    })
      .then(() => {
        const wb = useWorkbench.getState();
        // 当前 bot 不重复 selectUnit —— 那会清掉正在看的聊天时间线
        if (String(wb.activeUnitId) !== String(unitId)) wb.selectUnit(asUnitId(unitId));
        // TUI 恢复的落点就是终端画布：切过去，别让用户对着聊天页猜终端在哪
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        // 打开即已读：熄掉侧栏的「完成未读」绿灯
        useHistoryPrefs
          .getState()
          .markViewed([e.key, ...(e.sessionId !== null ? [`session-${e.sessionId}`] : [])]);
        onFinished();
      })
      .catch((err2: unknown) => console.error("[HistoryPane] TUI 恢复失败:", err2))
      .finally(() => setResumeBusy(null));
  };

  /**
   * 在聊天页继续（ADR 0012 resume-in-chat）：headless 会话从 daemon 账本重建
   * 时间线；可恢复（live / cli_ref）时接回执行器，否则打开只读段。
   * 与 TUI 恢复互补：TUI 走执行器自己的存储（原生原味），这里走 host 账本投影。
   */
  const handleOpenInChat = (e: UnitHistoryEntry): void => {
    // unitId 用面板自身的所属 bot（daemon 的 history 条目不填 unitId，见 Sidebar 同注）
    if (e.sessionId === null) return;
    void useWorkbench
      .getState()
      .openSession({ sessionId: asSessionId(e.sessionId), unitId: asUnitId(unitId), runtimeId: e.runtimeId });
    const sh = useShell.getState();
    sh.setMainView("chat");
    sh.setConversationView("chat");
    // 打开即已读：熄掉侧栏的「完成未读」绿灯
    useHistoryPrefs.getState().markViewed([e.key, `session-${e.sessionId}`]);
    onFinished();
  };

  useEffect(() => {
    let alive = true;
    // 保活协议：隐藏（切走 bot / 切到别的 tab / 收起面板）时不轮询不重置 ——
    // 列表缓存留着，切回即达；重新可见时立刻刷一次再恢复 20s 轮询
    //（运行中的条目状态会推进）
    if (!isActive) return;
    setErr(null);
    const load = (): void => {
      if (!alive) return;
      void fetchUnitHistory(unitId, 200)
        .then((list) => {
          if (alive) setEntries(list);
        })
        .catch((e: unknown) => {
          if (alive) setErr(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const poll = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
    // focusKey 不进依赖：面板开着换展开目标时只动 expanded，列表不重载不闪
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, isActive]);

  useEffect(() => {
    setExpanded(focusKey ?? null);
  }, [focusKey]);

  // 原生会话列表：切到该页签且面板可见时拉一次（不轮询——磁盘事实源，基本不变；
  // 拉过的结果在保活期间复用，切回不重拉）
  useEffect(() => {
    if (tab !== "native" || !isActive || nativeList !== null) return;
    let alive = true;
    setNativeErr(null);
    void fetchNativeSessions(unitId, 60)
      .then((rows) => {
        if (alive) setNativeList(rows);
      })
      .catch((e: unknown) => {
        if (alive) setNativeErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [tab, unitId, nativeList, isActive]);

  /** 原生会话的 TUI 恢复：sessionId 即各家原生 id（与 RESUME_ARGS 口径一致） */
  const handleNativeResume = (s: NativeSessionSummary): void => {
    const u = units.find((x) => x.id === unitId);
    const args = resumeArgsFor(s.executorId, s.sessionId);
    if (u === undefined || args === null) return;
    setResumeBusy(`native-${s.executorId}-${s.sessionId}`);
    useTerminalStore.getState().notePendingUnitDispatch(unitId);
    void dispatchTerminal({
      unitId,
      unitName: u.name,
      rootPath: u.rootPath,
      runtimeId: s.executorId,
      args,
    })
      .then(() => {
        const wb = useWorkbench.getState();
        if (String(wb.activeUnitId) !== String(unitId)) wb.selectUnit(asUnitId(unitId));
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        onFinished();
      })
      .catch((err2: unknown) => console.error("[HistoryPane] 原生会话 TUI 恢复失败:", err2))
      .finally(() => setResumeBusy(null));
  };

  const hideFailedInDialog = useHistoryPrefs((s) => s.prefs.hideFailedInDialog);
  const setPrefs = useHistoryPrefs((s) => s.setPrefs);

  const failedCount = useMemo(() => {
    if (!entries) return 0;
    return entries.filter((e) => e.status === "failed").length;
  }, [entries]);

  const displayedEntries = useMemo(() => {
    if (!entries) return null;
    if (!hideFailedInDialog) return entries;
    return entries.filter((e) => e.status !== "failed" || e.key === focusKey);
  }, [entries, hideFailedInDialog, focusKey]);

  return (
    <section aria-label={`${unitName} 历史会话`} className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        {/* 页签切换：daemon 运行台账 | 各 CLI 原生存储 */}
        <div className="flex items-center rounded-btn bg-line-soft/80 p-0.5">
          <button
            type="button"
            onClick={() => setTab("runs")}
            className={cn(
              "rounded-btn px-2 py-0.5 text-caption font-medium transition",
              tab === "runs" ? "bg-card text-teal font-semibold shadow-xs" : "text-graphite hover:text-ink",
            )}
          >
            运行记录
          </button>
          <button
            type="button"
            onClick={() => setTab("native")}
            title="各 CLI 自己的会话存储（TUI 里聊的、任何入口产生的都来自磁盘事实源）"
            className={cn(
              "rounded-btn px-2 py-0.5 text-caption font-medium transition",
              tab === "native" ? "bg-card text-teal font-semibold shadow-xs" : "text-graphite hover:text-ink",
            )}
          >
            原生会话
          </button>
        </div>

        {tab === "runs" && failedCount > 0 && (
          <button
            type="button"
            onClick={() => setPrefs({ hideFailedInDialog: !hideFailedInDialog })}
            title={hideFailedInDialog ? "点击显示包含失败在内的全部会话" : "点击隐藏失败会话"}
            className={cn(
              "flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-caption font-medium transition cursor-pointer",
              hideFailedInDialog
                ? "bg-loss/10 text-loss hover:bg-loss/15"
                : "bg-line-soft text-graphite hover:bg-line",
            )}
          >
            <CircleAlert size={11} className={hideFailedInDialog ? "text-loss" : "text-ash"} />
            <span>{hideFailedInDialog ? `已隐藏 ${failedCount} 条失败（点击查看）` : `已显示失败（点击隐藏）`}</span>
          </button>
        )}
        <span className="ml-auto shrink-0 text-caption text-ash">
          {tab === "native"
            ? nativeList === null
              ? "加载中…"
              : `${nativeList.length} 条`
            : entries === null
              ? "加载中…"
              : hideFailedInDialog && failedCount > 0
                ? `${displayedEntries?.length ?? 0} / ${entries.length} 条`
                : `${entries.length} 条`}
        </span>
      </div>

      {tab === "native" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {nativeErr !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{nativeErr}</p>}
          {nativeList !== null && nativeList.length === 0 && (
            <p className="px-1 py-6 text-center text-caption text-ash">
              这个工作目录下还没找到各 CLI 的原生会话 —— 在 TUI 里跑过之后会出现在这里
            </p>
          )}
          {nativeList?.map((s) => (
            <NativeRow
              key={`${s.executorId}-${s.sessionId}`}
              summary={s}
              expanded={nativeExpanded === `${s.executorId}-${s.sessionId}`}
              resumeBusy={resumeBusy === `native-${s.executorId}-${s.sessionId}`}
              onToggle={() =>
                setNativeExpanded(nativeExpanded === `${s.executorId}-${s.sessionId}` ? null : `${s.executorId}-${s.sessionId}`)
              }
              onResume={() => handleNativeResume(s)}
            />
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {err !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>}
          {entries !== null && entries.length === 0 && (
            <p className="px-1 py-6 text-center text-caption text-ash">还没有执行记录 —— 自动化、待办或手动会话跑过之后会出现在这里</p>
          )}
          {entries !== null && entries.length > 0 && displayedEntries !== null && displayedEntries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-caption text-ash">
                此 Bot 当前共有 {failedCount} 条记录，全部为失败会话，已根据设置隐藏。
              </p>
              <button
                type="button"
                onClick={() => setPrefs({ hideFailedInDialog: false })}
                className="mt-2.5 rounded-btn bg-line-soft px-3 py-1 text-caption font-medium text-graphite transition hover:bg-line hover:text-ink cursor-pointer"
              >
                显示全部 {failedCount} 条失败记录
              </button>
            </div>
          )}
          {displayedEntries !== null && collapseForkVersions(displayedEntries).map((slot) => (
            <HistoryRow
              key={slot.entry.key}
              unitId={unitId}
              entry={slot.entry}
              family={slot.family}
              expanded={expanded === slot.entry.key}
              onToggle={() => setExpanded(expanded === slot.entry.key ? null : slot.entry.key)}
              resumable={resumable(slot.entry)}
              resumeBusy={resumeBusy === slot.entry.key}
              onResume={() => handleResume(slot.entry)}
              onOpenInChat={slot.entry.sessionId !== null ? () => handleOpenInChat(slot.entry) : undefined}
              onOpenFamilyMember={(m) => handleOpenInChat(m)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** 原生会话行：执行器徽标 + 标题 + 时间，展开富转录，可 TUI 恢复 */
function NativeRow({
  summary,
  expanded,
  resumeBusy,
  onToggle,
  onResume,
}: {
  summary: NativeSessionSummary;
  expanded: boolean;
  resumeBusy: boolean;
  onToggle: () => void;
  onResume: () => void;
}): ReactElement {
  const resumable = resumeArgsFor(summary.executorId, summary.sessionId) !== null;
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button onClick={onToggle} className="flex w-full items-start gap-2 rounded-btn px-2 py-2 text-left transition hover:bg-line-soft">
        <span className="mt-0.5 shrink-0 rounded-chip bg-teal-tint px-1.5 py-0.5 font-mono text-[10px] text-teal">
          {summary.executorId}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{summary.title}</span>
            <span className="shrink-0 text-caption text-ash">{summary.messageCount} 条</span>
            <span className="shrink-0 text-caption text-ash">{formatWhen(summary.updatedAt)}</span>
            {resumable && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onResume();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onResume();
                  }
                }}
                title={`在终端以 TUI 重开这段原生会话（${summary.executorId} resume）`}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas",
                  resumeBusy && "opacity-50",
                )}
              >
                <RotateCcw size={9} />
                {resumeBusy ? "恢复中" : "TUI 恢复"}
              </span>
            )}
            {expanded ? <ChevronDown size={13} className="shrink-0 text-ash" /> : <ChevronRight size={13} className="shrink-0 text-ash" />}
          </span>
          {summary.rootPath !== null && (
            <span className="mt-0.5 block truncate font-mono text-caption text-ash/70">{summary.rootPath}</span>
          )}
        </span>
      </button>
      {expanded && <NativeTranscript executorId={summary.executorId} sessionId={summary.sessionId} />}
    </div>
  );
}

/** 原生会话富转录：user/assistant 对话 + 工具行 + 思考折叠 */
function NativeTranscript({ executorId, sessionId }: { executorId: string; sessionId: string }): ReactElement {
  const [detail, setDetail] = useState<NativeSessionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    void fetchNativeSessionDetail(executorId, sessionId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [executorId, sessionId]);

  if (err !== null) return <p className="px-4 pb-2 text-caption text-loss">转录读取失败：{err}</p>;
  if (detail === null) return <p className="px-4 pb-2 text-caption text-ash">读取转录…</p>;
  if (detail.transcript.length === 0) return <p className="px-4 pb-2 text-caption text-ash">这条会话没有可展示的对话内容</p>;

  return (
    <div className="mx-2 mb-2 max-h-80 space-y-1.5 overflow-y-auto rounded-btn bg-rail p-2.5">
      {detail.transcript.map((e, i) => {
        if (e.kind === "tool") {
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="flex w-14 shrink-0 items-center justify-end gap-0.5 text-right text-caption text-ash/70">
                <Wrench size={9} />
                工具
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-graphite/80">
                {e.toolName !== undefined ? `[${e.toolName}] ` : ""}
                {e.text === "" ? "（无参数/输出）" : e.text}
              </p>
            </div>
          );
        }
        if (e.kind === "thinking") {
          return (
            <details key={i} className="flex items-start gap-2 group">
              <summary className="flex w-14 shrink-0 cursor-pointer items-center justify-end gap-0.5 text-right text-caption text-ash/70 list-none">
                <Sparkles size={9} />
                思考
              </summary>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed text-ash group-open:text-graphite/80">
                {e.text}
              </p>
            </details>
          );
        }
        const label = e.kind === "user" ? "用户" : e.kind === "assistant" ? "助手" : e.kind === "compaction" ? "压缩" : "系统";
        return (
          <div key={i} className="flex items-start gap-2">
            <span
              className={cn(
                "w-14 shrink-0 text-right text-caption",
                e.kind === "user" ? "text-teal" : e.kind === "assistant" ? "text-graphite" : "text-ash/60",
              )}
            >
              {label}
            </span>
            {/* 助手行走 markdown 富渲染（docs/17）；用户/系统行保持纯文本 */}
            {e.kind === "assistant" && e.text !== "" ? (
              <div className="min-w-0 flex-1 text-graphite">
                <MarkdownContent content={e.text} className="text-caption leading-relaxed" />
              </div>
            ) : (
              <p
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed",
                  e.kind === "user" ? "text-ink" : e.kind === "assistant" ? "text-graphite" : "text-ash/70",
                )}
              >
                {e.text === "" ? "（空）" : e.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryRow({
  unitId,
  entry,
  family,
  expanded,
  onToggle,
  resumable,
  resumeBusy,
  onResume,
  onOpenInChat,
  onOpenFamilyMember,
}: {
  /** 面板所属 bot —— 监控跳转用（daemon 的 history 条目不填 unitId） */
  unitId: string;
  entry: UnitHistoryEntry;
  /** 同锚点的 revision 家族（旧 → 新，含 entry；ADR 0013 P2 版本折叠） */
  family?: readonly UnitHistoryEntry[];
  expanded: boolean;
  onToggle: () => void;
  resumable: boolean;
  resumeBusy: boolean;
  onResume: () => void;
  /** ADR 0012 resume-in-chat：headless 会话才有（TUI 条目没有我们的账本） */
  onOpenInChat?: () => void;
  /** 家族成员「在聊天页继续」（版本导航的落点） */
  onOpenFamilyMember?: (m: UnitHistoryEntry) => void;
}): ReactElement {
  const kind = KIND_META[entry.kind];
  const st = useMemo(() => statusMeta(entry.status), [entry.status]);
  const dur = formatDuration(entry);
  const KIcon = kind.icon;
  const SIcon = st.icon;
  const expandable = entry.sessionId !== null || Boolean(entry.terminalId) || entry.launchMode === "terminal";
  const [familyOpen, setFamilyOpen] = useState(false);
  const badge =
    family !== undefined && family.length > 1
      ? `${family.length} 个版本`
      : entry.forkKind === "branch"
        ? "分叉"
        : entry.forkKind === "revision"
          ? "重发"
          : null;

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        onClick={expandable ? onToggle : undefined}
        className={cn(
          "flex w-full items-start gap-2 rounded-btn px-2 py-2 text-left transition",
          expandable ? "hover:bg-line-soft" : "cursor-default",
        )}
        title={expandable ? "点击查看对话内容或终端输出快照" : undefined}
      >
        <span className={cn("mt-0.5 shrink-0 rounded-chip px-1.5 py-0.5 text-[10px]", kind.cls)}>
          <KIcon size={10} className="mr-0.5 inline-block align-[-1px]" />
          {kind.label}
        </span>
        {badge !== null && (
          <span
            role={family !== undefined && family.length > 1 ? "button" : undefined}
            tabIndex={family !== undefined && family.length > 1 ? 0 : undefined}
            onClick={() => {
              if (family !== undefined && family.length > 1) setFamilyOpen(!familyOpen);
            }}
            onKeyDown={(ev) => {
              if ((ev.key === "Enter" || ev.key === " ") && family !== undefined && family.length > 1) {
                ev.stopPropagation();
                setFamilyOpen(!familyOpen);
              }
            }}
            className={cn(
              "mt-0.5 flex shrink-0 items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal",
              family !== undefined && family.length > 1 && "cursor-pointer transition hover:bg-teal hover:text-canvas",
            )}
            title={
              family !== undefined && family.length > 1
                ? "同一轮的多个重发版本：展开回看旧版本（旧分支永不删）"
                : "这段是从更早的对话分叉出来的"
            }
          >
            <GitBranch size={9} />
            {badge}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{entry.title}</span>
            <SIcon size={12} className={cn("shrink-0", st.cls)} />
            <span className={cn("shrink-0 text-caption", st.cls)}>{st.label}</span>
            {dur !== null && <span className="shrink-0 text-caption text-ash">{dur}</span>}
            <span className="shrink-0 text-caption text-ash">{formatWhen(entry.startedAt)}</span>
            {/* 在聊天页继续 / 在 TUI 中恢复：行根是 button，内嵌动作用 span 实现（button 套 button 非法） */}
            {onOpenInChat !== undefined && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenInChat();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onOpenInChat();
                  }
                }}
                title="把这段对话接回聊天页：可恢复时续聊原会话，否则打开只读历史（发消息将开新段）"
                className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
              >
                <MessageSquare size={9} />
                在聊天页继续
              </span>
            )}
            {entry.sessionId !== null && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  useSidePane.getState().openLiveSession({
                    unitId: asUnitId(unitId),
                    sessionId: entry.sessionId!,
                    runtimeId: entry.runtimeId,
                    title: entry.title,
                  });
                }}
                onKeyDown={(ev) => {
                  if (ev.key !== "Enter" && ev.key !== " ") return;
                  // Space 不拦默认行为会先滚动列表再触发，按钮语义应吃掉它
                  ev.preventDefault();
                  ev.stopPropagation();
                  useSidePane.getState().openLiveSession({
                    unitId: asUnitId(unitId),
                    sessionId: entry.sessionId!,
                    runtimeId: entry.runtimeId,
                    title: entry.title,
                  });
                }}
                title="在右侧面板跟随这条会话的事件流：在跑的实时看，已结束的可回放"
                className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
              >
                <Radio size={9} />
                监控
              </span>
            )}
            {resumable && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onResume();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onResume();
                  }
                }}
                title={`在新终端以 TUI 重现这段会话（${entry.runtimeId} --resume）—— 对话原文在执行器自己的存储里，不依赖本表`}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas",
                  resumeBusy && "opacity-50",
                )}
              >
                <RotateCcw size={9} />
                {resumeBusy ? "恢复中" : "TUI 恢复"}
              </span>
            )}
            {expandable && (expanded ? <ChevronDown size={13} className="shrink-0 text-ash" /> : <ChevronRight size={13} className="shrink-0 text-ash" />)}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-caption">
            <span className="font-mono text-ash">{entry.runtimeId}</span>
            <span className={cn("rounded-chip px-1 py-px", entry.launchMode === "terminal" ? "bg-teal-tint text-teal" : "bg-line-soft text-ash")}>
              {entry.launchMode === "terminal" ? (
                <>
                  <Terminal size={9} className="mr-0.5 inline-block align-[-1px]" />
                  TUI
                </>
              ) : (
                "后台"
              )}
            </span>
            {entry.subtitle !== null && <span className="min-w-0 flex-1 truncate text-ash">{entry.subtitle}</span>}
          </span>
          {entry.detail !== null && entry.detail !== "" && (
            <span className="mt-0.5 block truncate text-caption text-ash" title={entry.detail}>
              {entry.detail}
            </span>
          )}
        </span>
      </button>
      {familyOpen && family !== undefined && (
        <div className="mx-2 mb-2 rounded-btn border border-line-soft bg-rail/60 p-1.5">
          {family.map((m, i) => (
            <div
              key={m.key}
              className={cn(
                "flex items-center gap-2 rounded-btn px-2 py-1 text-caption",
                m.key === entry.key && "bg-teal-tint/60",
              )}
            >
              <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] font-mono text-graphite">
                v{i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-graphite">{m.title}</span>
              <span className="shrink-0 text-ash/70">{formatWhen(m.startedAt)}</span>
              {m.key === entry.key ? (
                <span className="shrink-0 text-[10px] text-teal">当前</span>
              ) : (
                onOpenFamilyMember !== undefined &&
                m.sessionId !== null && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenFamilyMember(m)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") onOpenFamilyMember(m);
                    }}
                    title="把这个旧版本接回聊天页（旧分支只读可回看，不会丢）"
                    className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite transition hover:bg-teal hover:text-canvas"
                  >
                    <MessageSquare size={9} />
                    在聊天页查看
                  </span>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {expanded && (
        <>
          {entry.sessionId !== null && <SessionMessages sessionId={entry.sessionId} />}
          {entry.launchMode === "terminal" && (
            <TerminalTranscript
              terminalId={entry.terminalId ?? null}
              runtimeId={entry.runtimeId}
              detail={entry.detail}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 展开的对话内容：user/assistant 两栏流（工具消息等次要角色灰显） */
function SessionMessages({ sessionId }: { sessionId: string }): ReactElement {
  const [msgs, setMsgs] = useState<Array<{ at: number; role: string; text: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchSessionMessages(sessionId)
      .then((rows) => {
        if (alive) setMsgs(rows);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (err !== null) return <p className="px-4 pb-2 text-caption text-loss">消息读取失败：{err}</p>;
  if (msgs === null) return <p className="px-4 pb-2 text-caption text-ash">读取对话…</p>;
  if (msgs.length === 0) return <p className="px-4 pb-2 text-caption text-ash">这条会话没有留下消息记录</p>;

  return (
    <div className="mx-2 mb-2 max-h-72 space-y-1.5 overflow-y-auto rounded-btn bg-rail p-2.5">
      {msgs.map((m, i) => (
        <div key={i} className="flex items-start gap-2">
          <span
            className={cn(
              "w-14 shrink-0 text-right text-caption",
              m.role === "user" ? "text-teal" : m.role === "assistant" ? "text-graphite" : "text-ash/60",
            )}
          >
            {m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role}
          </span>
          <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed", m.role === "user" ? "text-ink" : "text-graphite")}>
            {m.text === "" ? "（空）" : m.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/** 展开的终端会话输出快照（ANSI 过滤后的纯文本日志，支持复制与滚动） */
function TerminalTranscript({
  terminalId,
  runtimeId,
  detail,
}: {
  terminalId: string | null;
  runtimeId: string;
  detail: string | null;
}): ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(terminalId !== null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!terminalId) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    void fetchTerminalTranscript(terminalId)
      .then((res) => {
        if (alive) {
          setText(res);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [terminalId]);

  const handleCopy = () => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const lineCount = text ? text.split("\n").length : 0;

  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-btn border border-line bg-rail/80">
      <div className="flex h-7 items-center justify-between border-b border-line/60 bg-rail px-2.5 text-[10px] text-ash">
        <div className="flex items-center gap-1.5 font-mono">
          <Terminal size={11} className="text-teal" />
          <span>终端输出记录 · {runtimeId}</span>
          {lineCount > 0 && <span className="text-ash/60">({lineCount} 行)</span>}
        </div>
        {text && text.trim() !== "" && (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ash transition hover:bg-line-soft hover:text-ink cursor-pointer"
          >
            <Copy size={10} />
            <span>{copied ? "已复制" : "复制输出"}</span>
          </button>
        )}
      </div>

      <div className="p-2.5">
        {loading && <p className="text-caption text-ash">正在读取终端输出…</p>}
        {err !== null && <p className="text-caption text-loss">输出读取失败：{err}</p>}
        {!loading && err === null && text && text.trim() !== "" && (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink select-text">
            {text}
          </pre>
        )}
        {!loading && err === null && (!text || text.trim() === "") && (
          <div className="space-y-1 text-caption text-ash">
            <p>未截获到终端文本输出（会话在产生输出前已退出，或属于早期历史会话）。</p>
            {detail && <p className="font-mono text-[11px] text-graphite">结果摘要：{detail}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
