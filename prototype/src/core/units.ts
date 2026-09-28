/**
 * 领域原语：一个文件夹 = 一个工作单元，两种身份。
 *
 * 设计要点：bot模式与项目模式不是两类软件，而是同一个 WorkUnit 的两种 kind。
 * 运行时原语（目录 / agent 定义 / 会话 / 技能 / 权限）对两者完全一致。
 */

// ---------------------------------------------------------------------------
// 品牌化 ID
// ---------------------------------------------------------------------------

export type UnitId = string & { readonly __brand: "UnitId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type RuntimeId = string & { readonly __brand: "RuntimeId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const asUnitId = (v: string): UnitId => v as UnitId;
export const asSessionId = (v: string): SessionId => v as SessionId;
export const asRuntimeId = (v: string): RuntimeId => v as RuntimeId;
export const asModelId = (v: string): ModelId => v as ModelId;
// ---------------------------------------------------------------------------
// 工作单元
// ---------------------------------------------------------------------------

/**
 * 身份模型。两者共享同一套运行时原语，只是"关注点"不同：
 * - bot 关心：人设、日程、渠道、长期记忆、产出归档（招聘）
 * - project  关心：看板、diff、PR、会话短寿、worktree 隔离（组队施工）
 */
export type UnitKind = "bot" | "project";

/** 从 AGENTS.md 派生的身份定义。零迁移的关键：文件即数据库。 */
export interface WorkspaceIdentity {
  /** 人设/岗位说明书摘要 */
  readonly role: string;
  /** 头像或 emoji */
  readonly avatar?: string;
  /** 主动人格提示词 */
  readonly persona?: string;
  /** 来源文件路径（相对单元根目录） */
  readonly sourcePath: string;
  /** 最后一次解析时间 */
  readonly loadedAt: number;
}

export interface UnitSchedule {
  /** 下一次自动触发时间戳 */
  readonly nextRunAt?: number;
  /** 最近一次触发 */
  readonly lastRunAt?: number;
  /** 人类可读的 cron / 自然语言描述 */
  readonly description: string;
  readonly enabled: boolean;
}

/** 运行时绑定：一个工作单元可以同时挂多个工具。 */
export interface RuntimeBinding {
  readonly runtimeId: RuntimeId;
  /**
   * 该单元在此运行时下的默认模型。
   *
   * 存在的意义：**同一个执行器，不同岗位该用不同的大脑**。
   * 写公众号的bot用 Haiku 跑量，写代码的项目用 Opus —— 都是 ZCode，但不该同价。
   *
   * 它是 hint 不是命令：指向一个该 CLI 不接的模型时会被静默忽略，
   * 回落顺序是 用户所选 → 本 hint → 执行器默认。
   */
  readonly modelHint?: ModelId;
  /** 是否为该单元的主要执行器 */
  readonly primary: boolean;
}

export interface WorkUnit {
  readonly id: UnitId;
  /** 一级身份就是文件夹。绝对路径。 */
  readonly rootPath: string;
  readonly name: string;
  readonly kind: UnitKind;
  readonly identity?: WorkspaceIdentity;
  readonly schedule?: UnitSchedule;
  readonly bindings: readonly RuntimeBinding[];
  /** AGENTS.md / SKILL.md / automations 继续可用，UI 只是渲染层 */
  readonly assets: {
    readonly agentFiles: readonly string[];
    readonly skillDirs: readonly string[];
  };
  /**
   * AGENTS.md 的内容。从磁盘扫描来的单元不带这个字段（文件即数据库，
   * 内容在 rootPath/AGENTS.md 里）；通过「添加 bot」创建的单元在此
   * 携带用户写的岗位说明书——真接入运行时后应落盘为 rootPath/AGENTS.md。
   */
  readonly agentsMd?: string;
  readonly lastActiveAt?: number;
  readonly tags: readonly string[];
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_permission"
  | "awaiting_input"
  | "failed"
  | "done";

export interface Session {
  readonly id: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: RuntimeId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** 是否为项目模式下的短寿会话（worktree 隔离） */
  readonly ephemeral: boolean;
  readonly worktree?: { readonly path: string; readonly branch: string };
  readonly stats: SessionStats;
}

export interface SessionStats {
  readonly messages: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 估算成本（USD），用于按执行器 / 工作单元做用量统计 */
  readonly costUsd: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// 产出归档
// ---------------------------------------------------------------------------

export interface Deliverable {
  readonly id: string;
  readonly unitId: UnitId;
  readonly sessionId?: SessionId;
  readonly title: string;
  readonly kind: "file" | "diff" | "pr" | "report" | "image";
  readonly path?: string;
  readonly url?: string;
  readonly createdAt: number;
  readonly summary?: string;
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

/** 本条消息携带的附件。类型住 core —— ui 依赖 core，不能反过来 */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "image";
  /** 原型期只有相对路径，真实实现走 Electron 的 file dialog 拿绝对路径 */
  readonly path: string;
}
