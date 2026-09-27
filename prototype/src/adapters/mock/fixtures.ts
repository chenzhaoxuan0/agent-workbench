/** 原型期的样例工作单元。真实数据从磁盘扫描 AGENTS.md 得到。 */

import { asRuntimeId, asSessionId, asUnitId, asModelId, type Deliverable, type Session, type WorkUnit } from "../../core/units.ts";
import type { Automation } from "../../core/automation.ts";

export const SAMPLE_UNITS: readonly WorkUnit[] = [
  {
    id: asUnitId("u-content"),
    rootPath: "C:/Users/chenziyu/project/Agent/content",
    name: "内容创作部",
    kind: "employee",
    identity: {
      role: "每日内容创作负责人",
      avatar: "✍️",
      persona: "每日 8:00 自动产出，风格贴合已沉淀的语料",
      sourcePath: "AGENTS.md",
      loadedAt: Date.now(),
    },
    schedule: {
      description: "每天 08:00",
      nextRunAt: Date.now() + 1000 * 60 * 60 * 8,
      enabled: true,
    },
    bindings: [
      { runtimeId: asRuntimeId("zcode"), primary: true, modelHint: asModelId("claude-haiku-4-5") },
      { runtimeId: asRuntimeId("opencode"), primary: false },
    ],
    assets: { agentFiles: ["AGENTS.md"], skillDirs: ["skills/writing"] },
    lastActiveAt: Date.now() - 1000 * 60 * 42,
    tags: ["日常", "自动化"],
  },
  {
    id: asUnitId("u-mmxdaily"),
    rootPath: "C:/Users/chenziyu/project/Agent/MMXdaily",
    name: "MMXdaily",
    kind: "project",
    bindings: [
      { runtimeId: asRuntimeId("claude-code"), primary: true },
      { runtimeId: asRuntimeId("codex"), primary: false },
    ],
    assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
    lastActiveAt: Date.now() - 1000 * 60 * 60 * 5,
    tags: ["已上线", "多agent"],
  },
  {
    id: asUnitId("u-workbench"),
    rootPath: "C:/Users/chenziyu/project/Agent/agent-workbench",
    name: "Agent Workbench",
    kind: "project",
    bindings: [{ runtimeId: asRuntimeId("zcode"), primary: true }],
    assets: { agentFiles: [], skillDirs: [] },
    lastActiveAt: Date.now(),
    tags: ["本项目", "进行中"],
  },
  {
    id: asUnitId("u-clipping"),
    rootPath: "C:/Users/chenziyu/project/Agent/Clippings",
    name: "剪藏归档",
    kind: "employee",
    identity: {
      role: "资料收集与归档",
      avatar: "📥",
      sourcePath: "AGENTS.md",
      loadedAt: Date.now(),
    },
    schedule: { description: "每 6 小时", enabled: false },
    bindings: [{ runtimeId: asRuntimeId("pi"), primary: true }],
    assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
    lastActiveAt: Date.now() - 1000 * 60 * 60 * 26,
    tags: ["低频"],
  },
];

export const SAMPLE_DELIVERABLES: readonly Deliverable[] = [
  {
    id: "d1",
    unitId: asUnitId("u-content"),
    title: "今日选题稿 v2",
    kind: "file",
    path: "drafts/2026-09-27.md",
    createdAt: Date.now() - 1000 * 60 * 40,
    summary: "5 个选题，2 个已扩写",
  },
  {
    id: "d2",
    unitId: asUnitId("u-mmxdaily"),
    title: "PR #128 · 修复配色切换",
    kind: "pr",
    url: "https://github.com/…/pull/128",
    createdAt: Date.now() - 1000 * 60 * 60 * 3,
  },
  {
    id: "d3",
    unitId: asUnitId("u-workbench"),
    title: "SPI 骨架",
    kind: "file",
    path: "prototype/src/core/adapter.ts",
    createdAt: Date.now() - 1000 * 60 * 8,
  },
];

/**
 * 样例会话 —— 对应 ZCode 侧栏里的 task 列表。
 * 没有这层，侧栏就退化成只有 workspace，交互手感会和 ZCode 差很远。
 */

const HOUR = 1000 * 60 * 60;
const now = Date.now();

function s(
  id: string,
  unitId: string,
  runtimeId: string,
  title: string,
  status: Session["status"],
  agoHours: number,
  stats: Partial<Session["stats"]> = {},
): Session {
  return {
    id: asSessionId(id),
    unitId: asUnitId(unitId),
    runtimeId: asRuntimeId(runtimeId),
    title,
    status,
    startedAt: now - agoHours * HOUR,
    ephemeral: false,
    stats: {
      messages: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      ...stats,
    },
  };
}

export const SAMPLE_SESSIONS: readonly Session[] = [
  s("t-content-1", "u-content", "zcode", "今日选题 · 第 3 轮", "done", 2, {
    messages: 14, toolCalls: 6, inputTokens: 42100, outputTokens: 9800, costUsd: 0.284, durationMs: 184000,
  }),
  s("t-content-2", "u-content", "zcode", "昨日稿件润色", "done", 20, {
    messages: 9, toolCalls: 3, inputTokens: 18600, outputTokens: 4200, costUsd: 0.121, durationMs: 92000,
  }),
  s("t-content-3", "u-content", "opencode", "竞品文案对比扫描", "done", 44, {
    messages: 6, toolCalls: 11, inputTokens: 5200, outputTokens: 3100, costUsd: 0.021, durationMs: 41000,
  }),

  s("t-mmxdaily-1", "u-mmxdaily", "claude-code", "配色切换 bug 定位", "done", 5, {
    messages: 22, toolCalls: 17, inputTokens: 128400, outputTokens: 26400, costUsd: 0.612, durationMs: 640000,
  }),
  s("t-mmxdaily-2", "u-mmxdaily", "codex", "PR #128 修复自查", "done", 9, {
    messages: 11, toolCalls: 8, inputTokens: 31000, outputTokens: 7400, costUsd: 0.153, durationMs: 210000,
  }),

  s("t-wb-1", "u-workbench", "zcode", "SPI 骨架设计", "done", 1, {
    messages: 18, toolCalls: 9, inputTokens: 58000, outputTokens: 15200, costUsd: 0.337, durationMs: 420000,
  }),
  s("t-wb-2", "u-workbench", "zcode", "设计系统落地", "running", 0, {
    messages: 7, toolCalls: 4, inputTokens: 21400, outputTokens: 6300, costUsd: 0.098, durationMs: 96000,
  }),

  s("t-clip-1", "u-clipping", "pi", "剪藏入库 · 9/26", "done", 26, {
    messages: 4, toolCalls: 2, inputTokens: 3100, outputTokens: 900, costUsd: 0.008, durationMs: 18000,
  }),
];

/**
 * 样例自动化 —— 员工模式的时间维度。
 * 覆盖了各种 scheduleRule 形态和状态分支，
 * 因为「下次运行」和状态徽章的算法只有在这些分支下才验得出来。
 */

const H = 1000 * 60 * 60;
const t0 = Date.now();

export const SAMPLE_AUTOMATIONS: readonly Automation[] = [
  {
    id: "a-content-daily",
    name: "每日内容创作",
    unitId: "u-content",
    description: "读语料风格，产出当天 5 个可写选题",
    runtimeId: "zcode",
    rule: { frequency: "daily", hour: 8, minute: 0, weekdays: [], dayOfMonth: 1 },
    enabled: true,
    recurring: true,
    runs: [
      { startedAt: t0 - 2 * H, endedAt: t0 - 2 * H + 184_000, status: "completed", summary: "产出 5 个选题" },
    ],
    deliverableIds: ["d1"],
    createdAt: t0 - 30 * 24 * H,
  },
  {
    id: "a-clipping-6h",
    name: "剪藏入库",
    unitId: "u-clipping",
    description: "把 Clippings 里新抓的内容归到 ObsidianVault",
    runtimeId: "pi",
    rule: { frequency: "custom", hour: 0, minute: 0, weekdays: [], dayOfMonth: 1, interval: 6, unit: "hours" },
    enabled: false,
    recurring: true,
    runs: [
      { startedAt: t0 - 26 * H, endedAt: t0 - 26 * H + 18_000, status: "completed" },
    ],
    deliverableIds: [],
    createdAt: t0 - 20 * 24 * H,
    lastFailure: { at: t0 - 50 * H, reason: "目标目录被占用" },
  },
  {
    id: "a-mmxdaily-weekly",
    name: "周报汇总",
    unitId: "u-mmxdaily",
    description: "汇总本周提交与 PR，生成周报草稿",
    runtimeId: "claude-code",
    rule: { frequency: "weekly", hour: 18, minute: 30, weekdays: [5], dayOfMonth: 1 },
    enabled: true,
    recurring: true,
    runs: [],
    deliverableIds: [],
    createdAt: t0 - 12 * 24 * H,
  },
  {
    id: "a-workbench-remind",
    name: "依赖更新提醒",
    unitId: "u-workbench",
    description: "检查六家工具的版本，有更新就提醒",
    runtimeId: "zcode",
    rule: { frequency: "custom", hour: 0, minute: 0, weekdays: [], dayOfMonth: 1, interval: 3, unit: "days" },
    enabled: true,
    recurring: true,
    runs: [
      { startedAt: t0 - 5 * H, endedAt: t0 - 5 * H + 9_000, status: "running" },
    ],
    deliverableIds: [],
    createdAt: t0 - 5 * 24 * H,
  },
  {
    id: "a-content-once",
    name: "一次性 · 迁移旧稿",
    unitId: "u-content",
    description: "把 drafts 里 2025 年的稿件批量改名，跑一次就停",
    runtimeId: "opencode",
    rule: {
      frequency: "custom",
      hour: 0,
      minute: 0,
      weekdays: [],
      dayOfMonth: 1,
      interval: 1,
      unit: "hours",
      anchorAt: t0 + 40 * 60_000,
    },
    enabled: true,
    recurring: false,
    maxRuns: 1,
    runs: [],
    deliverableIds: [],
    createdAt: t0 - 2 * H,
  },
  {
    id: "a-mmxdaily-monthly",
    name: "月度用量盘点",
    unitId: "u-mmxdaily",
    description: "导出上月各执行器的 token 与成本",
    runtimeId: "codex",
    rule: { frequency: "monthly", hour: 9, minute: 0, weekdays: [], dayOfMonth: 1 },
    enabled: true,
    recurring: true,
    runs: [
      { startedAt: t0 - 30 * 24 * H, endedAt: t0 - 30 * 24 * H + 60_000, status: "failed" },
    ],
    deliverableIds: [],
    createdAt: t0 - 90 * 24 * H,
    lastFailure: { at: t0 - 30 * 24 * H, reason: "usage 表尚未生成" },
  },
];

/**
 * 归档会话 —— 对应 ZCode 的 `toggleArchivedTasks` / `WorkspaceArchivedTasksFlatSection`。
 * 必须有样例：归档区为空时若直接不渲染，功能就「看不见」了。
 */
export const SAMPLE_ARCHIVED_SESSIONS: readonly Session[] = [
  s("t-arch-1", "u-content", "zcode", "旧版润色流程（已废弃）", "done", 24 * 34, {
    messages: 21, toolCalls: 14, inputTokens: 41000, outputTokens: 9800, costUsd: 0.198, durationMs: 320000,
  }),
  s("t-arch-2", "u-mmxdaily", "claude-code", "配色方案 A 探索", "done", 24 * 58, {
    messages: 8, toolCalls: 5, inputTokens: 15600, outputTokens: 4200, costUsd: 0.071, durationMs: 140000,
  }),
];

/**
 * 目录不可用的工作单元 —— 对应 ZCode 的 `unavailableLocalDirectory`。
 * 磁盘上路径被删/无权限时会走到这个态，做成可见样例便于确认渲染。
 */
export const UNAVAILABLE_UNIT: WorkUnit = {
  id: asUnitId("u-archive-old"),
  rootPath: "C:/Users/chenziyu/project/Agent/_archived_old",
  name: "旧版内容站（已迁移）",
  kind: "project",
  bindings: [{ runtimeId: asRuntimeId("zcode"), primary: true }],
  assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
  tags: ["目录不可用"],
  lastActiveAt: Date.now() - 1000 * 60 * 60 * 24 * 90,
};

/** 任务分组 —— 对应 ZCode 的 taskGroup（可新建、可折叠） */
export interface TaskGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly collapsed: boolean;
}

export const SAMPLE_TASK_GROUPS: readonly TaskGroup[] = [
  { id: "g-writing", name: "写作", color: "#016a71", collapsed: false },
  { id: "g-scan", name: "巡检", color: "#A855F7", collapsed: false },
];
