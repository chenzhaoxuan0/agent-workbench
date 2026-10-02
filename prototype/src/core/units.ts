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

/**
 * 密钥**引用**而非明文。对齐 openclaw 的 `SecretRef`（extensions/feishu/src/accounts.ts
 * 用 `coerceSecretRef`）：配置里只存「去哪取」，不存值。
 *
 * 形态上的好处是 push 泄漏时密钥根本不在文件里——docs/09 7.5 节的 git 泄漏检查
 * 从「安全前提」降级为「仍值得做的兜底」。
 */
export interface SecretRef {
  /** env = 进程环境变量；file = 相对 rootPath 的文件 */
  readonly source: "env" | "file";
  /** env 模式下的变量名 / file 模式下的相对路径 */
  readonly id: string;
}

/**
 * 一个 bot 在某个渠道上的**一个账号**。
 *
 * 为什么是「多账号」而不是「多渠道」：飞书一个应用 = 一个机器人。想让每个 bot 对应
 * 一个飞书机器人，就是给每个 bot 挂一个飞书账号。这与 openclaw 的
 * `channels.feishu.accounts.<accountId>` 同一套结构（monitor.ts 逐账号起连接），
 * 只是方向相反——openclaw 是一个 agent 收多个渠道，这里是一个 bot 挂一个渠道。
 */
export interface ChannelAccount {
  /** 账号 id，同一渠道内唯一。缺省 "default"。 */
  readonly id: string;
  /** 凭据。appSecret 走 SecretRef，不落明文 */
  readonly appId: string;
  readonly appSecret?: SecretRef;
  /** 海外站走 Lark。默认飞书国内站 */
  readonly domain?: "feishu" | "lark";
  /** 允许响应的发送者 open_id 白名单。空 = 不限（⚠️ 意味着任何人都能驱动这个 bot） */
  readonly allowFrom?: readonly string[];
  /** 群聊里只在被 @ 时响应。默认 true；单聊不受影响 */
  readonly mentionOnly?: boolean;
  /** 渠道自身的能力位（对齐 openclaw ChannelPlugin 的可选槽，只实现用得上的） */
  readonly options?: Readonly<Record<string, string>>;
}

/**
 * bot 的外联渠道——"bot 找得到你"的声明面。
 *
 * `config` 是**旧形态**（单账号、凭据明文），只为不打断已落盘的 bot.json 保留；
 * 新写入一律走 `accounts`。
 */
export interface BotChannel {
  readonly kind: "telegram" | "feishu" | "webhook";
  readonly enabled: boolean;
  readonly accounts?: readonly ChannelAccount[];
  /** @deprecated 单账号旧形态。读时若 accounts 缺省则由它归一出一个 default 账号 */
  readonly config?: Readonly<Record<string, string>>;
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
   * AGENTS.md 的内容。**不是副本的真相**——真相在 `rootPath/<identity.sourcePath>` 那个文件里，
   * daemon 的 listBots 每次重扫盘时读回来填这里。所以在 VS Code 里改那个文件，下次打开
   * agent-workbench（或点重新加载）就会看到新内容；反过来设置页保存也直接写进同一个文件。
   *
   * 指针在、文件被删 → 这里是空串，UI 显示"文件缺失"而不是假装还有内容。
   */
  readonly agentsMd?: string;
  /**
   * 那个文件的当前状态。设置页要显示**路径**（用户才知道去 VS Code 改哪个文件），
   * 保存时把它当乐观锁基线传回 daemon。
   */
  readonly agentsMdMeta?: {
    readonly path: string;
    readonly relPath: string;
    /** sha256 前 16 hex；保存时与盘上比对，不符即报冲突 */
    readonly hash: string;
    readonly mtimeMs: number;
    readonly bytes: number;
  };
  /** bot.json 自增版本号（daemon 维护）。第二个乐观锁维度，抓 UI 侧并发。 */
  readonly revision?: number;
  /**
   * 记忆接入策略（对齐 waku 的记忆三柱，创建 bot 时声明）。
   * 真实运行时据此接入对应后端；原型期仅作为声明保存。
   */
  readonly memory?: {
    readonly semantic: boolean;
    readonly episodic: boolean;
    readonly procedural: boolean;
  };
  /**
   * 外联渠道（docs/08 WP-5）：IM / webhook 绑定。daemon 的渠道网关据此把
   * "消息进来 → 会话 → 回出去"接到具体 bot 上；缺省 = 纯工作台内 bot。
   */
  readonly channels?: readonly BotChannel[];
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

/**
 * 会话来源。四个端是同一个 bot 的四扇窗口，来源不同**只**体现在这个字段上
 * （docs/09 §二推论 1：会话归属 bot，不归属端）——不产生第二套会话体系。
 */
export type SessionSource = "workbench" | "feishu" | "telegram" | "webhook" | "mcp" | "automation";

export const SESSION_SOURCE_LABEL: Record<SessionSource, string> = {
  workbench: "工作台",
  feishu: "飞书",
  telegram: "Telegram",
  webhook: "webhook",
  mcp: "MCP",
  automation: "自动化",
};

export interface Session {
  readonly id: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: RuntimeId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** 缺省 = 工作台 Composer 起的。IM/webhook/MCP 起的带各自标记，时间轴上显示徽标 */
  readonly source?: SessionSource;
  /** 实际生效的模型。hint 指向该 CLI 不接的模型时，这是回落后的那一个 */
  readonly modelActual?: string;
  /**
   * 被丢掉的 modelHint（docs/09 §六.1）。
   * 契约原文说它「会被静默忽略」——要补掉的正是这个静默：用户以为在用便宜模型，
   * 实际在烧贵的。非空 = 界面上必须弱提示一次。
   */
  readonly modelHintDropped?: string;
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
