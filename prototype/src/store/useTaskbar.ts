import { create } from "zustand";
import type { RuntimeEvent } from "../core/events.ts";
import { asSessionId, asUnitId, type SessionSource } from "../core/units.ts";
import {
  DaemonClient,
  defaultDaemonEndpoint,
  fetchSessions,
  type DaemonSessionRow,
} from "../adapters/daemon/client.ts";
import { runtimeSwitchBlocked, useWorkbench } from "./useWorkbench.ts";
import { useShell } from "./useShell.ts";
import { useHistoryPrefs } from "./useHistoryPrefs.ts";

/**
 * 任务栏数据面 —— 底栏「正在播放」列表（音乐播放器隐喻）。
 *
 * 收录口径（全局播放列表）：
 * - 用户从正在运行/等待中的对话**切走**的会话（离开视图侦测，见 attachLeaveWatch）；
 * - 后台无人值守来源（自动化 / 飞书 / Telegram 等渠道 / 手机端）新起的会话；
 * - 上述会话落定后的「完成未读」绿点条目 —— 点开或手动关闭才消失。
 * 正在前台看着的活跃会话不进榜（歌在耳边响着，不需要进度条提醒）。
 *
 * 数据面刻意不走 RuntimeAdapter（它的会话泵只投递本端 start/resume 过的会话，
 * 后台会话进不了它的跟踪集 —— LiveSessionPane 同款理由）：直接订阅
 * DaemonClient 的原始广播，事件驱动做幂等状态翻转，进场用 session.list
 * 补种正在跑的行。与 useWorkbench 的 timeline 互不依赖：切走会话的事件被
 * 事件泵过滤出时间线后，这里仍是它们唯一的跟踪者；回来时 openSession 的
 * 谱系回放会重建视图，不丢数据。
 */

export type TaskbarStatus =
  | "running"
  | "awaiting_permission"
  | "awaiting_input"
  | "done"
  | "failed"
  /** 主动折叠进底栏的空闲对话（最小化停靠）：没有任务在跑，只是把上下文停在这 */
  | "parked";

export interface TaskEntry {
  readonly sessionId: string;
  readonly unitId: string;
  readonly unitName: string;
  /** bot 自定义头像（data URL）；缺省由 UI 用 botAvatarStyle 画身份色 */
  readonly avatar?: string;
  /** 裸执行器 id（无 daemon: 前缀），jumpTo 时还原成 openSession 入参 */
  readonly runtimeId: string;
  readonly title: string;
  readonly status: TaskbarStatus;
  readonly startedAt: number;
  /** 实时活动行：最近一次工具调用标题 / 助手输出摘要（「正在唱什么」） */
  readonly activityText: string;
  readonly lastActivityAt: number;
  readonly endedAt: number | null;
  /** 完成未读：点开（jumpTo）或手动关闭前常驻 */
  readonly unread: boolean;
  /** 条目种类：目前只有会话；UI 预览窗等未来的「运行中的东西」从这里扩展 */
  readonly kind: "session";
}

/** 动画信号 —— nonce 单调递增，Fx 层靠 nonce 判「这是新的一次」而不是比对象 */
export interface TaskbarSignal {
  readonly sessionId: string;
  readonly nonce: number;
  /** 信号发出时刻的源/目标矩形：zustand 订阅回调同步于 setState、先于 React
   *  重渲染，此刻旧视图的 DOM 还在，是唯一能量到它的时机 */
  readonly rect: DOMRect | null;
}

/** 无人值守来源 —— 这些来源新起的会话直接进底栏（不需要用户先「切走」） */
const UNATTENDED_SOURCES: ReadonlySet<SessionSource> = new Set([
  "automation",
  "feishu",
  "telegram",
  "weixin",
  "discord",
  "webhook",
  "mcp",
  "mobile",
]);

/** 条目容量上限：防止渠道僵尸会话把底栏塞爆；淘汰最旧的已读条目 */
const ENTRY_CAP = 20;

/** message.delta 摘要的活动行节流间隔（工具调用事件不节流，本就低频） */
const ACTIVITY_THROTTLE_MS = 500;

const RUNNING_STATUSES: ReadonlySet<TaskbarStatus> = new Set(["running", "awaiting_permission", "awaiting_input"]);

/** 事件/台账里的原始状态串 → 底栏状态。live 会话转 idle = 本轮落定，按「完成未读」亮灯 */
function normalizeStatus(raw: string): TaskbarStatus {
  if (raw.startsWith("failed")) return "failed";
  if (raw === "awaiting_permission" || raw === "awaiting_input") return raw;
  if (raw === "done" || raw === "idle") return "done";
  return "running";
}

/** 会话标题：台账 title 优先，缺省用最后一条用户消息（这首歌叫什么——任务是它发起的） */
function titleFromTimeline(sessionId: string, fallback: string): string {
  const { timeline } = useWorkbench.getState();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]!.event;
    if (e.type === "message.delta" && e.role === "user" && String(e.sessionId) === sessionId) {
      const t = e.text.replace(/\s+/g, " ").trim();
      if (t !== "") return t.length > 28 ? `${t.slice(0, 28)}…` : t;
    }
  }
  return fallback;
}

function unitOf(unitId: string): { name: string; avatar?: string } {
  const unit = useWorkbench.getState().units.find((u) => String(u.id) === unitId);
  return unit !== undefined ? { name: unit.name, avatar: unit.avatar } : { name: "" };
}

function entryFromRow(row: DaemonSessionRow): TaskEntry {
  const { name, avatar } = unitOf(row.unitId);
  const status = normalizeStatus(row.status);
  return {
    sessionId: row.id,
    unitId: row.unitId,
    unitName: name !== "" ? name : "未知 bot",
    ...(avatar !== undefined ? { avatar } : {}),
    runtimeId: row.runtimeId.replace(/^daemon:/, ""),
    title: row.title && row.title.trim() !== "" ? row.title : `${name !== "" ? name : "会话"} · 对话`,
    status,
    startedAt: row.startedAt,
    activityText: "",
    lastActivityAt: Date.now(),
    endedAt: status === "done" || status === "failed" ? Date.now() : null,
    unread: status === "done" || status === "failed",
    kind: "session",
  };
}

export interface TaskbarStore {
  entries: TaskEntry[];
  /** 切走 → 压缩进底栏的动画信号 */
  compressSignal: TaskbarSignal | null;
  /** 底栏条目 → 展开回对话区的动画信号 */
  expandSignal: TaskbarSignal | null;
  /** 挂全局侦听（Taskbar 组件挂载时调一次；幂等） */
  attach: () => void;
  /**
   * 主动把当前对话折叠进底栏（任务栏「最小化」）：对话列回到空白态可开新
   * 对话，被折叠的会话以条目停靠在底栏，点条目经 openSession 回放切回。
   * 运行/等待中折叠 = 任务转后台跟踪；空闲折叠 = 停靠（parked）。
   */
  minimize: () => void;
  /** 点条目跳回对话：同会话只切视图，跨会话走 openSession 谱系回放 */
  jumpTo: (sessionId: string) => void;
  /** 关掉一条完成/失败条目（运行中的不给关——它还活着，关了就失联） */
  dismiss: (sessionId: string) => void;
}

let nonce = 0;
let attached = false;
/** 活动行节流游标：sessionId → 上次正文更新时刻 */
const lastTextAt = new Map<string, number>();
/** 当前「被看着」的会话（mainView/conversationView/activeSessionId 三者的合取） */
let visibleSession: string | null = null;
/** minimize() → 离开侦测的交接：标题在时间线清空前取好，跨过同一次 set */
let minimizeStash: { sid: string; title: string } | null = null;

export const useTaskbar = create<TaskbarStore>((set, get) => ({
  entries: [],
  compressSignal: null,
  expandSignal: null,

  attach: () => {
    if (attached) return;
    attached = true;
    void hydrate(set);
    attachDaemonWatch(set, get);
    attachLeaveWatch(set, get);
  },

  minimize: () => {
    const wb = useWorkbench.getState();
    const sid = wb.activeSessionId !== null ? String(wb.activeSessionId) : null;
    if (sid === null) return;
    // 标题必须在时间线清空前取好 —— 下面的 set 会触发离开侦测的 check()，
    // 那时 timeline 已空（stash 兜住标题跨过这次清空）
    const stash = { sid, title: titleFromTimeline(sid, "") };
    const rect = conversationRect();
    if (visibleSession === sid) {
      // 对话正被看着：check() 会在 set 上接管入榜 + 压缩动画（单一链路）
      minimizeStash = stash;
    } else {
      // 终端画布视图下 visibleSession 本来就是 null，离开侦测看不到这次
      // 变化 —— 直接入榜放动画，效果与 check() 路径一致
      const entry = buildEntry(sid, "minimize", stash.title);
      if (entry !== null) {
        upsert(set, entry);
        set(() => ({ compressSignal: { sessionId: sid, nonce: ++nonce, rect } }));
      }
    }
    // 最小化 = 窗口收进任务栏：对话列回到该 bot 的空白态。清空口径同
    // selectUnit（时间线是视图缓存，回来时 openSession 谱系回放重建）
    useWorkbench.setState({ activeSessionId: null, timeline: [], pendingFork: null, inputHistory: [], busy: false });
  },

  jumpTo: (sessionId) => {
    const entry = get().entries.find((e) => e.sessionId === sessionId);
    if (entry === undefined) return;
    const wb = useWorkbench.getState();
    const sh = useShell.getState();
    // 门禁只拦「当前对话在等你回答」这一种情况（运行中已放开，见 runtimeSwitchBlocked）。
    // 提前自查而不是打完 openSession 才发现被拦 —— 那样条目已被移除、已读已标，回不去了。
    if (String(wb.activeSessionId ?? "") !== sessionId && runtimeSwitchBlocked(wb)) {
      wb.pushNotice(
        "当前对话在等你回答",
        "它处于待裁决 / 待输入状态 —— 先在对话里处理完，再从底栏切去那边。",
        { level: "warn" },
      );
      return;
    }
    useHistoryPrefs.getState().markViewed(`session-${sessionId}`);
    set((s) => ({
      entries: s.entries.filter((e) => e.sessionId !== sessionId),
      expandSignal: { sessionId, nonce: ++nonce, rect: chipRectOf(sessionId) },
    }));
    // 无论哪种跳法都要把主视图带回对话页：openSession 只换数据不动视图，
    // 用户停在待办页点 chip 的话会「什么都没发生」
    sh.setMainView("chat");
    sh.setConversationView("chat");
    if (String(wb.activeSessionId ?? "") === sessionId) return;
    void wb.openSession({ sessionId: asSessionId(sessionId), unitId: asUnitId(entry.unitId), runtimeId: entry.runtimeId });
  },

  dismiss: (sessionId) => {
    useHistoryPrefs.getState().markViewed(`session-${sessionId}`);
    set((s) => ({ entries: s.entries.filter((e) => e.sessionId !== sessionId || RUNNING_STATUSES.has(e.status)) }));
  },
}));

/* --------------------------------------------------------------- 台账与事件 */

type SetFn = (fn: (s: TaskbarStore) => Partial<TaskbarStore>) => void;

/** 进场补种 / 断线重连对账：只种正在跑的行（历史完成不种，否则每次重连底栏爆满） */
async function hydrate(set: SetFn): Promise<void> {
  let rows: readonly DaemonSessionRow[];
  try {
    rows = await fetchSessions(defaultDaemonEndpoint());
  } catch {
    return; // daemon 未就绪：bootstrap 的重试链路会带动 units 到位，这里不硬扛
  }
  set((s) => {
    const known = new Map(s.entries.map((e) => [e.sessionId, e]));
    for (const row of rows) {
      const status = normalizeStatus(row.status);
      const prev = known.get(row.id);
      // live 恒有值（host：live = 进程内 impl 存活）。台账里会留着崩溃/断链的
      // 陈旧行（status 卡在 running 但 live=false）—— 不补种它们：底栏在启动
      // 时刻的语义是「现在真的在跑什么」，陈账失败不是用户此刻要被提醒的事
      if (RUNNING_STATUSES.has(status) && row.live === true) {
        const base = prev ?? entryFromRow(row);
        known.set(row.id, {
          ...base,
          status,
          // 台账 title 有了就补上（session.started 起的条目一开始只有兜底标题）
          title:
            row.title && row.title.trim() !== "" && base.title.endsWith("· 对话")
              ? row.title
              : base.title,
          ...(base.runtimeId === "" && row.runtimeId ? { runtimeId: row.runtimeId.replace(/^daemon:/, "") } : {}),
          endedAt: null,
        });
      } else if (prev !== undefined && RUNNING_STATUSES.has(prev.status)) {
        // 在榜条目落定（正常完成 / 断线期间收尾 / daemon 侧进程没了）→ 补翻转
        const settled = RUNNING_STATUSES.has(status) && row.live !== true ? "failed" : status;
        known.set(row.id, { ...prev, status: settled, endedAt: Date.now(), unread: true });
      }
    }
    return { entries: capEntries([...known.values()]) };
  });
  enrichUnknownUnits(set);
}

/** bot 列表是异步 bootstrap 的：补种早于 units 到位时先记「未知 bot」，到位后回填名字/头像 */
function enrichUnknownUnits(set: SetFn): void {
  set((s) => {
    if (!s.entries.some((e) => e.unitName === "未知 bot")) return {};
    return {
      entries: s.entries.map((e) => {
        if (e.unitName !== "未知 bot") return e;
        const { name, avatar } = unitOf(e.unitId);
        if (name === "") return e;
        return { ...e, unitName: name, ...(avatar !== undefined ? { avatar } : {}) };
      }),
    };
  });
}

function attachDaemonWatch(set: SetFn, _get: () => TaskbarStore): void {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  client.onEvent((event) => handleEvent(set, event));
  client.onResync(() => void hydrate(set));
  // 换代：session id 空间整体作废 —— 先清榜防僵尸条目，再重种（同一回调里保序）
  client.onGenerationChange(() => {
    set((s) => ({ entries: [] }));
    void hydrate(set);
  });
  // bot 列表到位后回填未知名字（bootstrap 竞态的收尾，见 enrichUnknownUnits）
  useWorkbench.subscribe((s, prev) => {
    if (s.units !== prev.units) enrichUnknownUnits(set);
  });
}

function handleEvent(set: SetFn, e: RuntimeEvent): void {
  if (!("sessionId" in e)) return;
  const sid = String(e.sessionId);

  if (e.type === "session.started") {
    const source = e.source;
    // 前台正开着的会话不进榜（切走时由离开侦测补位）；无人值守来源直接进榜
    if (source === undefined || !UNATTENDED_SOURCES.has(source)) return;
    if (String(useWorkbench.getState().activeSessionId ?? "") === sid) return;
    const { name, avatar } = unitOf(String(e.unitId));
    upsert(set, {
      sessionId: sid,
      unitId: String(e.unitId),
      unitName: name !== "" ? name : "未知 bot",
      ...(avatar !== undefined ? { avatar } : {}),
      runtimeId: "",
      title: `${name !== "" ? name : "会话"} · 对话`,
      status: "running",
      startedAt: Date.now(),
      activityText: "",
      lastActivityAt: Date.now(),
      endedAt: null,
      unread: false,
      kind: "session",
    });
    // runtimeId 台账里才有（事件不带）——下一次 hydrate 对账补上
    void hydrate(set);
    return;
  }

  if (e.type === "session.status" || e.type === "session.ended") {
    const next: TaskbarStatus =
      e.type === "session.ended" ? (e.reason === "error" ? "failed" : "done") : normalizeStatus(e.status);
    set((s) => {
      const entry = s.entries.find((x) => x.sessionId === sid);
      if (entry === undefined) return {};
      return {
        entries: s.entries.map((x) =>
          x.sessionId !== sid
            ? x
            : {
                ...x,
                status: next,
                endedAt: next === "done" || next === "failed" ? Date.now() : null,
                // 重新跑起来 = 上一次的完成提示作废；落定 = 亮未读灯
                unread: next === "done" || next === "failed",
              },
        ),
      };
    });
    return;
  }

  if (e.type === "permission.requested" || e.type === "permission.resolved") {
    set((s) => ({
      entries: s.entries.map((x) =>
        x.sessionId === sid && RUNNING_STATUSES.has(x.status)
          ? { ...x, status: e.type === "permission.requested" ? "awaiting_permission" : "running" }
          : x,
      ),
    }));
    return;
  }

  if (e.type === "turn.completed" && e.reason === "failed") {
    set((s) => ({
      entries: s.entries.map((x) =>
        x.sessionId === sid && x.status === "running" ? { ...x, status: "failed", endedAt: Date.now(), unread: true } : x,
      ),
    }));
    return;
  }

  // 活动行：「正在唱什么」。工具调用带人类可读标题，直接用；助手输出取摘要
  if (e.type === "tool.started") {
    updateActivity(set, sid, e.title !== "" ? e.title : e.toolName);
    return;
  }
  if (e.type === "message.delta" && e.role === "assistant") {
    const now = Date.now();
    if (now - (lastTextAt.get(sid) ?? 0) < ACTIVITY_THROTTLE_MS) return;
    lastTextAt.set(sid, now);
    const t = e.text.replace(/\s+/g, " ").trim();
    if (t !== "") updateActivity(set, sid, t.length > 40 ? `${t.slice(0, 40)}…` : t);
  }
}

function upsert(set: SetFn, entry: TaskEntry): void {
  set((s) => {
    const i = s.entries.findIndex((e) => e.sessionId === entry.sessionId);
    const next = i >= 0 ? s.entries.map((e, j) => (j === i ? { ...entry, activityText: e.activityText } : e)) : [...s.entries, entry];
    return { entries: capEntries(next) };
  });
}

function updateActivity(set: SetFn, sessionId: string, text: string): void {
  set((s) => ({
    entries: s.entries.map((x) =>
      x.sessionId === sessionId ? { ...x, activityText: text, lastActivityAt: Date.now() } : x,
    ),
  }));
}

function capEntries(entries: TaskEntry[]): TaskEntry[] {
  if (entries.length <= ENTRY_CAP) return entries;
  // 淘汰最旧的「已读完成」条目；全都是活任务/未读时不硬裁（用户自己关）
  for (let i = 0; i < entries.length && entries.length > ENTRY_CAP; i++) {
    const e = entries[i]!;
    if (!RUNNING_STATUSES.has(e.status) && !e.unread) entries = entries.filter((x) => x !== e);
  }
  return entries.slice(Math.max(0, entries.length - ENTRY_CAP));
}

/* --------------------------------------------------------------- 离开视图侦测 */

/**
 * 建一条入榜条目。
 * - leave（切走）：只收运行/等待中的会话 —— 空闲对话切走不进榜（歌没在放）；
 * - minimize（主动折叠）：任何状态都收 —— 空闲/已完结的折叠成 parked（停靠）。
 */
function buildEntry(sid: string, mode: "leave" | "minimize", titleOverride: string | null): TaskEntry | null {
  const wb = useWorkbench.getState();
  const session = wb.sessions.find((x) => String(x.id) === sid);
  if (session === undefined) return null;
  const live = session.status;
  if (mode === "leave" && live !== "running" && live !== "awaiting_permission" && live !== "awaiting_input") {
    return null;
  }
  const status: TaskbarStatus =
    live === "running" || live === "awaiting_permission" || live === "awaiting_input" ? live : "parked";
  const { name, avatar } = unitOf(String(session.unitId));
  return {
    sessionId: sid,
    unitId: String(session.unitId),
    unitName: name !== "" ? name : "未知 bot",
    ...(avatar !== undefined ? { avatar } : {}),
    runtimeId: String(session.runtimeId).replace(/^daemon:/, ""),
    title: titleOverride !== null && titleOverride !== "" ? titleOverride : titleFromTimeline(sid, `${name !== "" ? name : "会话"} · 对话`),
    status,
    startedAt: session.startedAt,
    activityText: "",
    lastActivityAt: Date.now(),
    endedAt: null,
    unread: false,
    kind: "session",
  };
}

/**
 * 「切走正在运行的对话 → 压缩进底栏」的触发器。
 *
 * 订阅 useShell + useWorkbench 两个 store，任何一次 set 后重算「当前被看着的
 * 会话」：mainView === chat 且 conversationView === chat 且 activeSessionId 非空。
 * 看不见的时刻若它是 running/awaiting_* → 进榜 + 发压缩动画信号（此刻旧视图
 * DOM 还没重渲染，是量源矩形的唯一窗口）；重新看见 → 出榜（已读）。
 * minimize() 的显式折叠也从这里过（minimizeStash 交接标题）。
 */
function attachLeaveWatch(set: SetFn, get: () => TaskbarStore): void {
  const check = (): void => {
    const cur = computeVisibleSession();
    const prev = visibleSession;
    if (cur === prev) return;
    visibleSession = cur;

    if (prev !== null && cur !== prev) {
      const stash = minimizeStash;
      minimizeStash = null;
      const mode: "leave" | "minimize" = stash !== null && stash.sid === prev ? "minimize" : "leave";
      const entry = buildEntry(prev, mode, stash?.title ?? null);
      if (entry !== null) {
        upsert(set, entry);
        set(() => ({ compressSignal: { sessionId: prev, nonce: ++nonce, rect: conversationRect() } }));
      }
    }

    // 回到某条在榜会话：出榜 + 已读（歌回到耳边，不需要列表提醒）
    if (cur !== null && get().entries.some((e) => e.sessionId === cur)) {
      useHistoryPrefs.getState().markViewed(`session-${cur}`);
      set((s) => ({ entries: s.entries.filter((e) => e.sessionId !== cur) }));
    }
  };
  useShell.subscribe(check);
  useWorkbench.subscribe(check);
  visibleSession = computeVisibleSession();
}

function computeVisibleSession(): string | null {
  const sh = useShell.getState();
  if (sh.mainView !== "chat" || sh.conversationView !== "chat") return null;
  const wb = useWorkbench.getState();
  return wb.activeSessionId !== null ? String(wb.activeSessionId) : null;
}

function conversationRect(): DOMRect | null {
  const el = document.querySelector('main[aria-label="会话"]');
  return el !== null ? el.getBoundingClientRect() : null;
}

function chipRectOf(sessionId: string): DOMRect | null {
  const el = document.querySelector(`[data-taskbar-session="${sessionId}"]`);
  return el !== null ? el.getBoundingClientRect() : null;
}
