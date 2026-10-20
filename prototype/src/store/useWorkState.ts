import { create } from "zustand";
import type { WorkPhase } from "../core/backlog.ts";

/**
 * 全局工作状态的手动指定（状态点弹层「指定为当前状态」的落点）。
 *
 * 语义分两层，必须分清：
 * - **显示层覆盖**：manual 非空时状态点显示 manual，不再跟随 daemon 的自动判定
 *   （daemon 判定继续在跑，只是不展示它）。
 * - **真实门禁**：只有「工作中」有 —— 选它会同时把后端 forceBusy 打开
 *   （心跳免打扰、待办不自动提议，这个门禁本来就在 daemon 侧，复用不新建）。
 *   其余状态是纯显示层指定，弹层文案里如实说明。
 *
 * 持久化到 localStorage：手动指定的意图跨刷新有效；daemon 的快照每次重连都会
 * 推新的 phase，没有这层记忆的话选完一刷新就悄悄回自动了。
 */

const KEY = "agent-workbench:work-state-override";

const ALLOWED_PHASES: readonly string[] = [
  "busy",
  "idle",
  "beating",
  "awaiting_confirm",
  "executing",
  "awaiting_review",
];

function readManual(): WorkPhase | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const v = (JSON.parse(raw) as { manual?: unknown }).manual;
    return typeof v === "string" && ALLOWED_PHASES.includes(v) ? (v as WorkPhase) : null;
  } catch {
    return null;
  }
}

function persistManual(manual: WorkPhase | null): void {
  if (typeof window === "undefined") return;
  try {
    if (manual === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify({ manual }));
  } catch {
    /* ignore */
  }
}

interface WorkStateStore {
  /** 用户手动指定的工作状态；null = 自动（跟随 daemon 判定） */
  manual: WorkPhase | null;
  /** 指定当前状态（phase 传 null 即回到自动） */
  setManual: (phase: WorkPhase | null) => void;
}

export const useWorkState = create<WorkStateStore>((set) => ({
  manual: readManual(),
  setManual: (phase) => {
    persistManual(phase);
    set({ manual: phase });
  },
}));

/** 各工作状态的一句话语义：状态点弹层的「会发生什么」清单数据源 */
export const WORK_PHASE_DESCRIPTIONS: readonly { phase: WorkPhase; label: string; desc: string }[] = [
  {
    phase: "busy",
    label: "工作中",
    desc: "有会话在跑或你刚活动过。心跳暂停提议 —— 待办不会被自动启动，定时任务照常。",
  },
  {
    phase: "idle",
    label: "空闲",
    desc: "无运行中任务、距上次活动超过空闲阈值。心跳会在有余量时提议启动待办（仍要经你确认）。",
  },
  {
    phase: "beating",
    label: "心跳中",
    desc: "正在跑一轮心跳检查：评估空闲与用量冗余，决定要不要向你提议。",
  },
  {
    phase: "awaiting_confirm",
    label: "待确认",
    desc: "有待办提议正等你放行 —— 确认门前谁都不会动手，不点同意就一直是等。",
  },
  {
    phase: "executing",
    label: "长任务执行中",
    desc: "已放行的长任务正在执行，结束后转入待验收。",
  },
  {
    phase: "awaiting_review",
    label: "待验收",
    desc: "任务执行完成等你过目：验收通过即关闭，打回则重新排队。",
  },
];
