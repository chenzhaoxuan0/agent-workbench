import { useEffect, useRef, useState } from "react";
import { fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { UnitId } from "../core/units.ts";

/**
 * 解析「跟随目标」会话：workbench 的活跃会话（属于本 bot 时）优先，没有则落
 * 台账里最近一条有 id 的会话（回放也成立）。PlanPane（计划跟随）与 DiffPane
 * 的「上一轮」来源共用同一套解析 —— 两个伴随视角对「当前在看哪个会话」必须
 * 同口径，否则左边的计划和右边的改动面说的不是同一场对话。
 *
 * 每 bot 的台账回退只解析一次：unit 来回切不重复拉，也消掉回退目标在
 * 「活跃会话 / 台账最新」之间来回翻面造成的整段重放抖动。
 */
export function useFollowedSessionId(unitId: UnitId): { sessionId: string | null; live: boolean } {
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const sessions = useWorkbench((s) => s.sessions);
  const [fallback, setFallback] = useState<string | null>(null);
  const resolvedRef = useRef(new Set<string>());

  const activeBelongsToUnit =
    activeSessionId !== null &&
    String(activeUnitId) === String(unitId) &&
    sessions.some((x) => String(x.id) === String(activeSessionId));
  const target = activeBelongsToUnit ? String(activeSessionId) : fallback;

  useEffect(() => {
    if (activeBelongsToUnit) return;
    if (resolvedRef.current.has(String(unitId))) return;
    let alive = true;
    // 扫描深度与侧栏历史同口径（100）：台账最新的若干条可能是无 sessionId 的
    // 旧 TUI 行，带 id 的会话在更深处 —— 扫浅了会误报「没有可跟随的会话」
    void fetchUnitHistory(unitId, 100)
      .then((list: readonly UnitHistoryEntry[]) => {
        if (!alive) return;
        resolvedRef.current.add(String(unitId));
        const found = list.find((e) => e.sessionId !== null && e.sessionId !== "");
        setFallback(found?.sessionId ?? null);
      })
      .catch(() => {
        // 瞬时失败不清空既有目标（清了会把正在显示的内容打成空态且不自愈）
      });
    return () => {
      alive = false;
    };
    // activeBelongsToUnit 翻回 false 时沿用缓存，不再重拉
  }, [unitId, activeBelongsToUnit]);

  return { sessionId: target ?? null, live: activeBelongsToUnit };
}
