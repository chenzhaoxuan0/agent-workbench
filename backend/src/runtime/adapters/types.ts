/**
 * daemon 侧执行器适配器 SPI —— prototype/src/core/adapter.ts 的服务端对应物。
 *
 * 形态刻意对齐前端契约（同名的 probe / start / send / cancel / resolvePermission），
 * 但职责收窄：适配器只做「原生协议 → RuntimeEvent 流」的翻译，
 * 会话台账、事件盖章（TraceRecord）、广播由 RuntimeHost 统一管。
 *
 * 验收标准沿用契约原文：新增一家工具 = 一个 adapter 文件 + host 注册一行，
 * core（host/wsd/trace）不改。
 */

import type {
  ConnectionState,
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
  UnitId,
} from "../../contract.ts";

export interface ExecutorModelInfo {
  readonly id: ModelId;
  readonly displayName: string;
  /** 上下文限制（token） */
  readonly contextWindow?: number;
  /** 最大单轮输出限制（token） */
  readonly maxOutput?: number;
  /** 支持的推理档位（low, medium, high, max, ultra 等） */
  readonly reasoningLevels?: readonly string[];
  /** 默认推理档位 */
  readonly defaultReasoningLevel?: string;
  /** CLI 声明的可选上下文长度档（value 原样透传回 set_config_option，绝不本地换算） */
  readonly contextLengths?: readonly { readonly value: string; readonly label: string }[];
  /** 探测那一刻执行器正生效的上下文档 value */
  readonly defaultContextLength?: string;
  /** 是否支持多模态输入（图片/附件） */
  readonly multimodal?: boolean;
  /** 输入价格（美元/百万 token） */
  readonly inputPerMTok?: number;
  /** 输出价格（美元/百万 token） */
  readonly outputPerMTok?: number;
}

/**
 * 一次模型同步的结果。
 *
 * ## 为什么要带 source
 *
 * `models` 光秃秃一个数组没法回答用户最常问的那句「它到底刷新了没」——
 * 拿回来的既可能是刚从 CLI 问到的实时清单，也可能是一份从没动过的静态兜底，
 * 两者长得一模一样。所以同步必须**如实标记来源**，界面照实显示，别让人
 * 对着一个没刷新的列表以为「刷新过了就是这样」。
 */
export interface ModelSyncOutcome {
  readonly models: readonly ExecutorModelInfo[];
  /** live = 这次真的问过 CLI；static = 实时源不可用，用的是内置兜底清单 */
  readonly source: "live" | "static";
  /** source=static 时的原因（超时/未安装/命令不存在…）。UI 拿它当 tooltip */
  readonly reason?: string;
  readonly elapsedMs: number;
}

export interface StartRequest {
  readonly unitId: UnitId;
  readonly unitName: string;
  /** 工作目录（agent 在这里干活） */
  readonly rootPath: string;
  readonly prompt: string;
  /** null = 用执行器自己的默认模型 */
  readonly model: ModelId | null;
  /** 权限模式（zcode 语义：yolo 不问权限，build 问） */
  readonly mode?: "plan" | "build" | "edit" | "yolo";
  /** 推理力度（zcode → model.options.reasoningLevel；codex → model_reasoning_effort） */
  readonly reasoningLevel?: string;
  /** 上下文长度档（执行器侧原始 value）：仅声明了可选档的执行器应用，其余忽略 */
  readonly contextLength?: string;
}

export type AdapterSink = (event: RuntimeEvent) => void;

export interface AdapterSession {
  readonly id: SessionId;
  /**
   * 再发一轮（多轮会话由适配器自己决定怎么续：同会话追加或 --resume）。
   * loop = 本轮的参数覆盖（推理力度 / 上下文长度 / 采样），不改变会话级配置。
   */
  send(text: string, loop?: { readonly reasoningLevel?: string; readonly contextLength?: string }): Promise<void>;
  cancel(): Promise<void>;
  resolvePermission(requestId: string, decision: "allow" | "deny" | "always"): Promise<void>;
  /**
   * 执行器侧的原生会话引用（zcode 的 --resume id / codex 的 thread id）。
   * daemon 把它存进 state.db，重启后 reattach 用 —— 会话续命的关键。
   * 首轮结束前是 null。
   */
  externalRef(): string | null;
}

export interface ExecutorAdapter {
  readonly id: string;
  readonly displayName: string;
  /** 单字符徽标（与前端 RuntimePresentation.glyph 同语义） */
  readonly glyph: string;
  /**
   * 标了就是**测试夹具**，不是真的 CLI 工具。界面要照实显示出来。
   *
   * 目前只有 mockperm（见 adapters/mockperm.ts）：它每轮都真的挂起等审批，
   * 是权限闸唯一的端到端验收手段 —— 真执行器启动时就把权限定死了，中途不问你。
   */
  readonly testOnly?: true;
  /** 非空硬要求（契约原文）：空清单的执行器注册即拒 */
  readonly models: readonly ExecutorModelInfo[];
  readonly capabilities: RuntimeCapabilities;
  /**
   * 动态对齐/刷新模型清单与上下文参数（支持的 CLI 会实时查询，失败时保留 fallback）。
   *
   * ## 零用量硬约束
   *
   * 这条路径**绝不允许**发 prompt、起 turn 或调用任何会话创建接口去「试一下模型好不好用」。
   * 合法实现只有两类：跑 CLI 的只读列清单命令，或读 CLI 自带的本地目录/配置文件。
   * 违反这条约束 = 用户点一下刷新按钮就烧掉一次订阅额度，比不刷新还糟。
   */
  syncModels?(): Promise<ModelSyncOutcome>;
  /** 该执行器是否实现了 syncModels（没实现的界面要标「无动态探测源」，别让人空按） */
  readonly modelsDiscoverable?: boolean;
  /**
   * 列出该执行器在 rootPath 下的**原生斜杠命令**（可选能力）。
   *
   * - 命令来自执行器自己的声明面（Claude SDK supportedCommands / Codex prompts
   *   目录 / OpenCode GET /command），不是工作台编的静态表；
   * - 执行是透传语义：调用方把 "/name args" 当普通 turn 文本发进会话，
   *   分发由执行器完成（个别 CLI —— codex/opencode —— 由适配器在 send 里
   *   做与 TUI 等价的展开/路由，见各自实现）；
   * - rootPath 影响命令清单（项目级自定义命令）；适配器自定缓存与 TTL；
   * - 没有原生命令面的执行器不实现此方法，UI 菜单只显示工作台本地命令。
   */
  listCommands?(rootPath: string): Promise<readonly NativeCommandInfo[]>;
  /**
   * 使 listCommands 的适配器内部缓存全部失效（可选能力）。
   * 技能停用/恢复后 host 会调用它 —— 只清 host 侧落盘缓存不够：适配器自己
   * 还有 10 分钟 TTL 的内存缓存，不清的话旧清单会被原样返回并**重新落盘**，
   * 斜杠菜单最长 10 分钟还显示已停用的技能。实现方应清空全部 rootPath 条目。
   */
  invalidateCommands?(): void;
  /**
   * 交互式 TUI 的启动命令名（可选）。终端「一键直启」拼 pwsh 命令时用它
   * 替换裸 id —— 适用于「TUI 由另一个 shim 拉起」的执行器（dsh 的 TUI 走
   * dst shim，裸 dsh 是 automation/web 入口不是 TUI）。缺省 = 裸 id 即命令。
   */
  readonly tuiCommand?: string;
  /** 探测本机是否可用（版本/认证），结果缓存与否由适配器自己定 */
  probe(): Promise<ProbeResult>;
  /** 建会话并开始把翻译好的事件喂给 sink；返回后 host 补发 session.started */
  start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession>;
  /**
   * 把一个已存在的外部会话接回 daemon（Phase 3 resumeSession 的执行器侧）。
   * sessionId 是 daemon 侧稳定 id（事件全用它），ref 是 externalRef 存的值，
   * rootPath 是会话原工作目录（执行器冷恢复常需要 workspace 才能找到会话）。
   */
  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession;
  /** daemon 关停时回收子进程 */
  disconnect(): Promise<void>;
}

/** 会话未找到等通用错误的便捷构造 */
export function adapterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
