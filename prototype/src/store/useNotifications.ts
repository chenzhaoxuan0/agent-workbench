import { create } from "zustand";
import type { BacklogSignal } from "../core/backlog.ts";
import type { RuntimeEvent } from "../core/events.ts";
import { SESSION_SOURCE_LABEL, type SessionSource } from "../core/units.ts";
import {
  DaemonClient,
  defaultDaemonEndpoint,
  fetchSessions,
  type DaemonSessionRow,
} from "../adapters/daemon/client.ts";
import { useWorkbench } from "./useWorkbench.ts";

/**
 * 通知中心的数据面 —— daemon 事件流的聚合筛选层（ZCode 没有通知面板，只有
 * 声音/角标；这里是本项目的差异化能力）。
 *
 * 三个设计决定：
 *
 * 1. **只报「你不在它面前」的事**。daemon 广播全部执行器的全部会话事件，其中
 *    工作台正前方的活跃会话（source === "workbench" 且就是 activeSessionId）
 *    的时间线已经在你眼前滚动 —— 再发通知是噪音。过滤口径：source 已知且为
 *    workbench → 跳过；sessionId 等于当前 activeSessionId → 跳过（source 缺失
 *    时的兜底，台账预热只有 unitId 没有 source）。自动化 / IM 渠道 / 手机端
 *    发起的后台会话是通知的主角。审批与报错是例外：挂着的审批不提醒就无限等，
 *    它们只豁免「正盯着」的那一个会话（stillWatching），不吃 workbench 整类豁免。
 * 2. **去重用自然键**（end:{sessionId} / perm:{sessionId}:{requestId} /
 *    git:{rootPath}…）：重复事件原位刷新时间戳，不堆叠（已读不翻回未读，见
 *    upsert）。上限 100 条。
 * 3. **不改 daemon**。自动化终态没有专用事件 —— 用 source === "automation" 的
 *    session.ended 表达（daemon 侧 finishAutomationRun 也是挂在它身上的），
 *    不为通知中心单开 RPC。
 *
 * 持久化到 localStorage（通知是日志不是状态机，F5 不该清空）。
 */

export type NotificationLevel = "info" | "ok" | "warn" | "loss";
export type NotificationKind =
  | "session"
  | "permission"
  | "error"
  | "notice"
  | "steer"
  | "deliverable"
  | "backlog"
  | "git";

export interface WorkbenchNotification {
  /** 自然键（去重口径），如 `end:s1` / `git:C:/repo` */
  readonly id: string;
  readonly at: number;
  readonly level: NotificationLevel;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly text: string;
  /** 来源徽标（自动化 / 飞书 / …） */
  readonly sourceLabel?: string;
  /** 可跳转的会话（点击 → 实时监控回放） */
  readonly sessionId?: string;
  /** 待办提议跳待办视图 */
  readonly backlog?: boolean;
  readonly read: boolean;
}

const MAX_ITEMS = 100;
const STORE_KEY = "agent-workbench:notifications-v1";
const GIT_COALESCE_MS = 2500;

/** sessionId → 归属（unitId/runtimeId/title/source）：跳转监控与来源过滤都靠它 */
interface SessionMeta {
  unitId?: string;
  runtimeId?: string;
  title?: string;
  source?: SessionSource;
}

const sessionMeta = new Map<string, SessionMeta>();

function rememberSession(sessionId: string, patch: SessionMeta): void {
  const prev = sessionMeta.get(sessionId);
  // 命中先删再插（逐出按 Map 插入序）：位置跟着刷新当 LRU 用，长命会话不因
  // 注册得早而被先逐出
  if (prev !== undefined) sessionMeta.delete(sessionId);
  sessionMeta.set(sessionId, { ...prev, ...patch });
  if (sessionMeta.size > 500) {
    const oldest = sessionMeta.keys().next().value;
    if (oldest !== undefined) sessionMeta.delete(oldest);
  }
}

/** 通知行的跳转目标（NotificationsPane / B3 的监控入口共用） */
export function sessionTargetOf(
  sessionId: string,
): { unitId: string; runtimeId: string; title: string } | null {
  const m = sessionMeta.get(sessionId);
  if (m === undefined || m.unitId === undefined || m.runtimeId === undefined) return null;
  return { unitId: m.unitId, runtimeId: m.runtimeId, title: m.title ?? "" };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationsStore {
  items: WorkbenchNotification[];
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

function readPersisted(): WorkbenchNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as { items?: unknown[] };
    if (!Array.isArray(parsed.items)) return [];
    // localStorage 跨版本共享：字段残缺的条目（旧形状 / 手改）整条丢弃，
    // 不能让坏 id 混进去重键
    return parsed.items
      .filter(
        (n): n is WorkbenchNotification =>
          typeof n === "object" &&
          n !== null &&
          typeof (n as WorkbenchNotification).id === "string" &&
          typeof (n as WorkbenchNotification).at === "number" &&
          typeof (n as WorkbenchNotification).title === "string" &&
          typeof (n as WorkbenchNotification).kind === "string",
      )
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  if (typeof window === "undefined") return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ items: useNotifications.getState().items }));
    } catch {
      /* ignore */
    }
  }, 500);
}

function upsert(next: Omit<WorkbenchNotification, "read">): void {
  // 同键事件在面板开着期间会重复到达：已读的条目原位刷新但保持已读，否则同一件事
  // 反复点亮未读点
  const prevRead = useNotifications.getState().items.find((n) => n.id === next.id)?.read;
  const item: WorkbenchNotification = { ...next, read: prevRead === true };
  useNotifications.setState((s) => {
    const rest = s.items.filter((n) => n.id !== item.id);
    return { items: [item, ...rest].slice(0, MAX_ITEMS) };
  });
  persist();
}

/** 会话终态通知（实时 session.ended 与断线对账补拉共用一个形状与去重键） */
function notifySessionEnded(sid: string, reason: string): void {
  if (inForeground(sid)) return;
  const meta = sessionMeta.get(sid);
  const src = meta?.source;
  const sourceLabel = src !== undefined ? SESSION_SOURCE_LABEL[src] : undefined;
  upsert({
    id: `end:${sid}`,
    at: Date.now(),
    level: isFailureReason(reason) ? "loss" : reason === "cancelled" ? "warn" : "ok",
    kind: "session",
    title: `${sourceLabel ?? "后台"}会话${endReasonLabel(reason)}`,
    text: meta?.title || sid,
    sourceLabel,
    sessionId: sid,
  });
}

export const useNotifications = create<NotificationsStore>((set) => ({
  items: readPersisted(),
  // 已读也要落盘（persist 自带 500ms debounce）：只改内存的话，F5 会把全部历史
  // 通知翻回未读
  markRead: (id) => {
    set((s) => {
      if (!s.items.some((n) => n.id === id && !n.read)) return s;
      return { items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)) };
    });
    persist();
  },
  markAllRead: () => {
    set((s) => (s.items.some((n) => !n.read) ? { items: s.items.map((n) => ({ ...n, read: true })) } : s));
    persist();
  },
  clear: () => {
    set({ items: [] });
    persist();
  },
}));

// ---------------------------------------------------------------------------
// 事件 → 通知
// ---------------------------------------------------------------------------

/**
 * 失败终态判据 —— 对齐 backend（host.ts 的 session 结算口径）：error / *_error /
 * executor_exited 都是失败。只认 "error" 的话，执行器进程退出（executor_exited）
 * 会被判成绿勾，与自动化台账的 failed 记录口径分裂。
 */
function isFailureReason(reason: string): boolean {
  return reason === "error" || reason === "executor_exited" || reason.endsWith("_error");
}

function endReasonLabel(reason: string): string {
  if (reason === "executor_exited") return "执行器退出";
  if (isFailureReason(reason)) return "出错";
  if (reason === "cancelled") return "被取消";
  return reason === "idle" || reason === "done" || reason === "completed" || reason === "closed"
    ? "正常完成"
    : reason;
}

/** 台账 status 是不是终态（对账补拉用；awaiting_* 是活会话不是终态） */
function isEndedStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "idle";
}

/** 「你不在它面前」判据：workbench 来源、或就是当前活跃会话（正看着呢） */
function inForeground(sessionId: string): boolean {
  const meta = sessionMeta.get(sessionId);
  if (meta?.source === "workbench") return true;
  return String(useWorkbench.getState().activeSessionId ?? "") === sessionId;
}

/**
 * 注意力口径（审批 / 报错用，比 inForeground 严）：workbench 起的长任务在用户
 * 切到别的会话后，原会话挂着的审批与报错既不在时间线眼前、PermissionDialog 又
 * 只对着 activeSessionId —— 不通知就无限挂等。所以 workbench 来源不再整类豁免，
 * 一切来源统一只认「现在正盯着的是不是它」（非 workbench 来源与 inForeground
 * 的活跃判据本来就相同）。
 */
function stillWatching(sessionId: string): boolean {
  return String(useWorkbench.getState().activeSessionId ?? "") === sessionId;
}

/** 全文指纹（djb2 十六进制）：错误正文做去重键时截前 80 字会把开头相同的不同
 *  错误并成一条互相顶掉；换全文哈希后，完全相同的错误仍原位合并刷新 */
function textKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 截断长文本（错误消息 / 通知正文可能整段堆栈） */
function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function onRuntimeEvent(e: RuntimeEvent): void {
  switch (e.type) {
    case "session.started": {
      rememberSession(String(e.sessionId), {
        unitId: String(e.unitId),
        source: e.source,
      });
      return;
    }
    case "session.ended": {
      const sid = String(e.sessionId);
      notifySessionEnded(sid, e.reason);
      return;
    }
    case "permission.requested": {
      const sid = String(e.sessionId);
      if (stillWatching(sid)) return;
      const src = sessionMeta.get(sid)?.source as SessionSource | undefined;
      upsert({
        id: `perm:${sid}:${e.requestId}`,
        at: Date.now(),
        level: "warn",
        kind: "permission",
        title: "等待审批",
        text: clip(e.detail),
        sourceLabel: src !== undefined ? SESSION_SOURCE_LABEL[src] : undefined,
        sessionId: sid,
      });
      return;
    }
    case "error": {
      const sid = String(e.sessionId);
      if (stillWatching(sid)) return;
      upsert({
        id: `err:${sid}:${textKey(e.message)}`,
        at: Date.now(),
        level: "loss",
        kind: "error",
        title: "会话出错",
        text: clip(e.message),
        sessionId: sid,
      });
      return;
    }
    case "system.notice": {
      // 刻意不做 inForeground 过滤：notice 常是 daemon 级提示，与用户正盯着
      // 哪个会话无关
      const sid = String(e.sessionId);
      upsert({
        id: `notice:${sid}:${e.title}:${e.text.slice(0, 60)}`,
        at: Date.now(),
        level: e.level === "warn" ? "warn" : e.level === "success" ? "ok" : "info",
        kind: "notice",
        title: e.title,
        text: clip(e.text),
        sessionId: sid,
      });
      return;
    }
    case "steer.undelivered": {
      const sid = String(e.sessionId);
      if (inForeground(sid)) return;
      upsert({
        id: `steer:${sid}`,
        at: Date.now(),
        level: "warn",
        kind: "steer",
        title: "插话未投递",
        text: `${e.inputs.length} 条插话在会话结束前没能发出`,
        sessionId: sid,
      });
      return;
    }
    case "deliverable": {
      const sid = String(e.sessionId);
      // 正盯着的会话，产出直接出现在时间线上，再通知是重复
      if (inForeground(sid)) return;
      upsert({
        id: `dlv:${sid}:${e.title}`,
        at: Date.now(),
        level: "ok",
        kind: "deliverable",
        title: `产出：${e.title}`,
        text: e.path ?? e.url ?? "",
        sessionId: sid,
      });
      return;
    }
    case "git.changed": {
      queueGitNotice(e.rootPath);
      return;
    }
    default:
      return;
  }
}

/** git.changed 节流聚合：同一仓库 2.5s 内的多次变更合成一条（重置未读不堆叠） */
const gitTimers = new Map<string, ReturnType<typeof setTimeout>>();
function queueGitNotice(rootPath: string): void {
  clearTimeout(gitTimers.get(rootPath));
  gitTimers.set(
    rootPath,
    setTimeout(() => {
      gitTimers.delete(rootPath);
      const name = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? rootPath;
      upsert({
        id: `git:${rootPath}`,
        at: Date.now(),
        level: "info",
        kind: "git",
        title: "仓库有新改动",
        text: name,
      });
    }, GIT_COALESCE_MS),
  );
}

function onBacklog(s: BacklogSignal): void {
  if (s.kind === "notice") {
    upsert({
      id: `bl:${s.text.slice(0, 80)}`,
      at: Date.now(),
      level: s.level === "warn" ? "warn" : s.level === "success" ? "ok" : "info",
      kind: "backlog",
      title: "待办提醒",
      text: clip(s.text),
    });
    return;
  }
  if (s.kind === "proposal") {
    upsert({
      id: `blp:${s.proposal.id}`,
      at: Date.now(),
      level: "info",
      kind: "backlog",
      title: "待办提议",
      text: clip(s.proposal.message !== "" ? s.proposal.message : s.proposal.title),
      backlog: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 安装（WorkspaceShell 挂一次；订阅原始广播，不走 RuntimeAdapter）
// ---------------------------------------------------------------------------

/** 台账状态快照（sessionId → status）：断线对账补拉的基线 */
let sessionSnapshot: Map<string, string> | null = null;

/**
 * 断线对账补拉：daemon 广播不留存（无订阅者即丢弃），休眠/断网窗口里的终态与
 * 审批请求不会重发 —— 重连/换代后拉一次台账，对比上次快照把漏掉的补上：
 * - 快照后新结束的会话（基线是活态、或快照里根本没有 = 断线期间新起的）→ 补终态通知；
 * - 现在仍挂着 awaiting_permission 的会话 → 补「等待审批」（漏报它会让后台
 *   任务无限等审批且毫无痕迹，这是补拉最重要的动机）；
 * - 首次调用只建基线不翻旧账（否则启动时把全部历史终态刷成通知）。
 * git.changed 显式不落盘，漏一条的代价只是晚一轮刷新，不在对账范围。
 */
function reconcileFromLedger(): void {
  void fetchSessions()
    .then((rows: readonly DaemonSessionRow[]) => {
      const next = new Map<string, string>();
      for (const r of rows) {
        rememberSession(r.id, { unitId: r.unitId, runtimeId: r.runtimeId, title: r.title });
        next.set(r.id, r.status);
      }
      const prev = sessionSnapshot;
      sessionSnapshot = next;
      if (prev === null) return;
      const notified = new Set(useNotifications.getState().items.map((n) => n.id));
      for (const [id, status] of next) {
        if (!isEndedStatus(status) || notified.has(`end:${id}`)) continue;
        // 基线里已是终态 = 旧账，不翻；活态（running/awaiting_*）或断线期间
        // 新起（快照里没有）= 这次的漏，补
        const was = prev.get(id);
        if (was !== undefined && isEndedStatus(was)) continue;
        notifySessionEnded(id, status === "failed" ? "error" : "done");
      }
      for (const [id, status] of next) {
        if (status !== "awaiting_permission" || notified.has(`permstuck:${id}`)) continue;
        // 与实时 permission.requested 同口径（stillWatching）：对账发现的是断线
        // 期间挂起的审批，workbench 来源但已切走的同样会无限等 —— 不吃整类豁免
        if (stillWatching(id)) continue;
        upsert({
          id: `permstuck:${id}`,
          at: Date.now(),
          level: "warn",
          kind: "permission",
          title: "等待审批",
          text: "断线期间进入等待审批，会话仍挂着",
          sessionId: id,
        });
      }
    })
    .catch(() => {
      /* 对账失败不致命：实时订阅仍在，只损失断线窗口的补报 */
    });
}

export function installNotifications(): () => void {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  const unsubs = [
    client.onEvent(onRuntimeEvent),
    client.onBacklogSignal(onBacklog),
    client.onResync(reconcileFromLedger),
    client.onGenerationChange(reconcileFromLedger),
  ];
  // 台账预热兼对账基线：装之前就开始的会话没有 session.started 可听 —— 拉一次
  // 全量台账补 unitId/runtimeId/title（source 台账不带，活跃会话判定有 inForeground 兜底）
  reconcileFromLedger();
  return () => {
    for (const u of unsubs) u();
  };
}
