import { useEffect } from "react";
import { useTaskbar, type TaskEntry, type TaskbarSignal } from "../../store/useTaskbar.ts";
import { currentMotionPref, nextFrames, playGhost, popElement, type GhostContent } from "./compressAnim.ts";
import { TASK_STATUS_META } from "./TaskChip.tsx";
import { botAvatarStyle } from "../Sidebar.tsx";
import { useAppearance } from "../../store/useAppearance.ts";

/**
 * 任务栏动画层 —— 渲染为 null，只订阅 useTaskbar 的两个信号并驱动 ghost：
 * - compressSignal：用户带着运行中的对话切走 → 「对话压缩进底栏」的引导动画
 *   （信号里的源矩形是 zustand 订阅回调里、React 重渲染前量到的，那时旧视图
 *   DOM 还在）；等两帧让 chip 上屏后量落点。
 * - expandSignal：点 chip 跳回 → 反向「从底栏展开回对话区」。
 * 起不起飞由动效档决定（见 compressAnim），off/reduced 档退化为落点轻弹。
 */
export function CompressGhost() {
  useEffect(() => {
    const unsub = useTaskbar.subscribe((s, prev) => {
      const c = s.compressSignal;
      if (c !== null && c.nonce !== prev.compressSignal?.nonce) void runCompress(c);
      const x = s.expandSignal;
      if (x !== null && x.nonce !== prev.expandSignal?.nonce) void runExpand(x);
    });
    return unsub;
  }, []);
  return null;
}

function ghostContentOf(entry: TaskEntry): GhostContent {
  const meta = TASK_STATUS_META[entry.status];
  const frame = useAppearance.getState().avatarFrame;
  return {
    title: entry.title,
    sub: `${entry.unitName} · ${meta.label}——任务收进底栏，随时点回来`,
    dotCls: meta.dot,
    avatarColor: botAvatarStyle(entry.unitName, frame).color,
    ...(entry.avatar !== undefined ? { avatarImg: entry.avatar } : {}),
  };
}

/** chip 落点：优先本条 chip，被折进「+N」弹层时落到弹层按钮上 */
async function landingChip(sessionId: string): Promise<HTMLElement | null> {
  const el =
    document.querySelector(`[data-taskbar-session="${sessionId}"]`) ??
    document.querySelector("[data-taskbar-more]");
  return el instanceof HTMLElement ? el : null;
}

async function runCompress(signal: TaskbarSignal): Promise<void> {
  const pref = currentMotionPref();
  const entry = useTaskbar.getState().entries.find((e) => e.sessionId === signal.sessionId);
  if (entry === undefined) return;
  await nextFrames(2);
  const chip = await landingChip(signal.sessionId);
  if (pref !== "standard" || signal.rect === null) {
    if (pref === "reduced") popElement(chip);
    return;
  }
  if (chip === null) return;
  playGhost({
    start: signal.rect,
    end: chip.getBoundingClientRect(),
    content: ghostContentOf(entry),
    direction: "compress",
  });
  popElement(chip);
}

async function runExpand(signal: TaskbarSignal): Promise<void> {
  const pref = currentMotionPref();
  if (pref !== "standard" || signal.rect === null) return; // 展开是纯糖：退化档直接切视图
  // 等导航提交：jumpTo 的 setMainView/openSession 让对话区（重新）上屏
  await nextFrames(2);
  const main = document.querySelector('main[aria-label="会话"]');
  if (!(main instanceof HTMLElement)) return;
  playGhost({
    start: signal.rect,
    end: main.getBoundingClientRect(),
    content: {
      title: "回到对话",
      sub: "",
      dotCls: "bg-teal",
      avatarColor: "transparent",
    },
    direction: "expand",
  });
}
