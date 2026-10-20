import { useEffect, useState } from "react";
import type { RuntimeEvent } from "../core/events.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";

/**
 * 「上一轮」改动数据面（ZCode GitPane last-turn 来源的对位）：取会话事件账本
 * 里最后一轮（turn.started → turn.completed）之间的 file.diff 事件，聚合出
 * 本轮改了哪些文件。**不碰 useGitChanges 单槽**（那是工作树口径，与提交对话
 * 框/源代码管理页共用，ADR 0010）—— 这里是会话口径的独立只读路径。
 *
 * 现实约束（如实展示）：file.diff 事件依赖执行器适配器的 fileDiff 能力位
 * （目前 codex / opencode / mcode 为 true，其余执行器空态），开关的可用性由
 * 调用方按 capabilities 判定，这里只管取数与跟随。
 */

export interface LastTurnFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** 事件自带的 patch 文本（部分适配器不带，展开时退化回 git.diff 拉取） */
  readonly patch?: string;
}

export interface LastTurnDiffResult {
  readonly files: readonly LastTurnFile[];
  /** 最后一轮的轮号（无完整轮次时 null） */
  readonly turn: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** 事件账本里一个 turn.completed 都没有：当前轮还在跑（区别于「有轮次但缺配对 started」的宁可空） */
  readonly running: boolean;
}

type TurnCompletedFrame = { seq: number; event: Extract<RuntimeEvent, { type: "turn.completed" }> };
type TurnStartedFrame = { seq: number; event: Extract<RuntimeEvent, { type: "turn.started" }> };

function aggregate(
  events: readonly { seq: number; event: RuntimeEvent }[],
): { files: LastTurnFile[]; turn: number | null; running: boolean } {
  const completed = events.filter(
    (it): it is TurnCompletedFrame => it.event.type === "turn.completed",
  );
  const last = completed[completed.length - 1];
  // 一个 turn.completed 都没有 = 当前轮还在跑。这种空该提示「等待落定」，
  // 与下面「有轮次但缺配对 started」的宁可空是两种空，不能混用同一句文案
  if (last === undefined) return { files: [], turn: null, running: true };
  const turnNo = last.event.turn;
  // 本轮起点：同一轮号的最后一次 turn.started（重试会重开同号轮，取最近的）。
  // 找不到配对 started（适配器缺帧 / 轮号错位）时宁可空也不误报 —— 回退 -1 会把
  // 该会话从头到这轮的所有 file.diff 都算进「上一轮」，跨轮污染
  const started = events.filter(
    (it): it is TurnStartedFrame => it.event.type === "turn.started" && it.event.turn === turnNo && it.seq < last.seq,
  );
  const open = started[started.length - 1];
  if (open === undefined) return { files: [], turn: null, running: false };
  const startSeq = open.seq;
  const map = new Map<string, LastTurnFile>();
  for (const it of events) {
    if (it.seq <= startSeq || it.seq > last.seq) continue;
    const e = it.event;
    if (e.type !== "file.diff") continue;
    // 同文件多次 diff：取最新的计数与 patch（适配器一般每轮每文件只发一次）
    map.set(e.path, {
      path: e.path,
      additions: e.additions,
      deletions: e.deletions,
      ...(e.patch !== undefined ? { patch: e.patch } : {}),
    });
  }
  return { files: [...map.values()], turn: turnNo, running: false };
}

export function useLastTurnDiff(sessionId: string | null, enabled: boolean): LastTurnDiffResult {
  const [files, setFiles] = useState<readonly LastTurnFile[]>([]);
  const [turn, setTurn] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 断线重连 / daemon 换代 / 本会话轮次落定 → 重放
  useEffect(() => {
    if (sessionId === null || !enabled) return;
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const bump = (): void => setReloadKey((k) => k + 1);
    const u1 = client.onResync(bump);
    const u2 = client.onGenerationChange(bump);
    const u3 = client.onEvent((event) => {
      if (!("sessionId" in event) || String(event.sessionId) !== sessionId) return;
      if (event.type === "turn.completed" || event.type === "session.ended") bump();
    });
    return () => {
      u1();
      u2();
      u3();
    };
  }, [sessionId, enabled]);

  useEffect(() => {
    if (sessionId === null || !enabled) {
      setFiles([]);
      setTurn(null);
      setError(null);
      setLoading(false);
      setRunning(false);
      return;
    }
    // 不设在途防重入：React 重跑 effect 前必先跑 cleanup（alive 置 false），
    // 旧请求落地即被丢弃，不会脏写；跟随信号密集 bump 至多多打一次请求
    let alive = true;
    setLoading(true);
    const client = DaemonClient.get(defaultDaemonEndpoint());
    void client
      .rpc<Array<{ seq: number; event: RuntimeEvent }> | null>("session.events.since", { sessionId, afterSeq: 0 }, 20000)
      .then((items) => {
        if (!alive) return;
        const agg = aggregate(items ?? []);
        setFiles(agg.files);
        setTurn(agg.turn);
        setRunning(agg.running);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, enabled, reloadKey]);

  return { files, turn, loading, error, running };
}
