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
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
  UnitId,
} from "../../contract.ts";

export interface ExecutorModelInfo {
  readonly id: ModelId;
  readonly displayName: string;
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
}

export type AdapterSink = (event: RuntimeEvent) => void;

export interface AdapterSession {
  readonly id: SessionId;
  /** 再发一轮（多轮会话由适配器自己决定怎么续：同会话追加或 --resume） */
  send(text: string): Promise<void>;
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
  /** 非空硬要求（契约原文）：空清单的执行器注册即拒 */
  readonly models: readonly ExecutorModelInfo[];
  readonly capabilities: RuntimeCapabilities;
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
