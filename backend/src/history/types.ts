/**
 * 会话事实源层（docs/13 Phase 1）—— 只读浏览各 CLI 的原生会话存储。
 *
 * pi-web 的核心资产之一：会话事实源在磁盘上，Web/工作台是另一个读者。
 * 历史浏览零进程成本（不启动引擎、不 spawn CLI）；富下钻读转录。
 *
 * 纪律：
 * - 只读。绝不写任何 CLI 的数据目录。
 * - 宽容解析。原生格式大多无稳定性承诺（claude/mcode/kimi 尤甚），
 *   未知行/坏行跳过，坏一个会话不坏整个列表。
 * - 不 promise 会话格式的长期稳定：reader 按「字段名习惯」 defensively 取值。
 */

/** 会话摘要 —— history.native.list 的行 */
export interface NativeSessionSummary {
  readonly executorId: string;
  /** CLI 原生会话 id（claude sessionId / codex thread id / pi uuid…） */
  readonly sessionId: string;
  /** 会话的工作目录（格式里带了才有；null = 未知，不过滤也不显示路径徽标） */
  readonly rootPath: string | null;
  readonly title: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** 转录条目数（粗略，列表页徽标用） */
  readonly messageCount: number;
  /** 来源标识（文件路径 / db 表），下钻与调试用 */
  readonly source: string;
}

/** 转录条目 —— history.native.detail 的行 */
export interface NativeTranscriptEntry {
  readonly kind: "user" | "assistant" | "tool" | "thinking" | "system" | "compaction";
  readonly text: string;
  readonly toolName?: string;
  readonly at?: number;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export interface NativeSessionDetail extends NativeSessionSummary {
  readonly transcript: readonly NativeTranscriptEntry[];
}

/**
 * 单个执行器的原生会话读取器。
 * list 按 rootPath 过滤（null = 不过滤取全量）；read 读单个会话富转录。
 */
export interface SessionReader {
  readonly executorId: string;
  list(rootPath: string | null, limit: number): Promise<readonly NativeSessionSummary[]>;
  read(sessionId: string): Promise<NativeSessionDetail | null>;
}
