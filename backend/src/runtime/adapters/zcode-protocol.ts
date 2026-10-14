/**
 * ZCode Protocol 类型面（docs/13 Phase 4 zcode 客户端抽取，b1 方案）。
 *
 * 从 zai-org/ZCode（Apache-2.0）的 packages/shared/src/zcode-protocol/index.ts
 * 抽取 agent-workbench 实际使用的子集：方法名常量 + 帧/事件/反向请求类型。
 * 刻意不 vendoring @zcode/shared 全量 zod schema（41k 行 + zod 依赖）——
 * 漂移检测覆盖「我们用的面」：上游改名/改形在编译期或这层报错，而不是
 * 散在适配器里的字符串比较里悄悄失效。
 *
 * 抽取基线：ZCode main v3.15.1（2026-10-10）。
 */

/** 客户端→服务器方法（zcodeProtocolMethods 的使用子集，wire 名原样） */
export const ZCODE_METHODS = {
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionSubscribe: "session/subscribe",
  sessionSend: "session/send",
  sessionClose: "session/close",
  sessionSetModel: "session/setModel",
  sessionSetMode: "session/setMode",
  sessionCompact: "session/compact",
  providerList: "provider/list",
  workspaceReadPresentation: "workspace/readPresentation",
} as const;

export type ZcodeMethod = (typeof ZCODE_METHODS)[keyof typeof ZCODE_METHODS];

/** 协议帧（NDJSON，一行一帧；JSON-RPC 方言：请求带 id，通知不带，响应无 method） */
export interface ZcodeFrameRequest<P = unknown> {
  readonly id: string | number;
  readonly method: string;
  readonly params?: P;
}
export interface ZcodeFrameNotification<P = unknown> {
  readonly method: string;
  readonly params?: P;
}
export interface ZcodeFrameResponse {
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}
export type ZcodeFrame = ZcodeFrameRequest | ZcodeFrameNotification | ZcodeFrameResponse;

/** 帧的宽松读视角：解析入口（handleLine）用——帧种类未知时可安全访问任意判别字段 */
export interface ZcodeFrameLoose {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** session/event 通知信封（订阅后的事件流载体） */
export interface ZcodeSessionEventEnvelope<P = Record<string, unknown>> {
  readonly sessionId?: string;
  readonly seq?: number;
  readonly type?: string;
  readonly payload?: P;
}

/** 事件 type 值（使用子集） */
export const ZCODE_EVENTS = {
  modelStreaming: "model.streaming",
  toolUpdated: "tool.updated",
  turnStarted: "turn.started",
  turnEnded: "turn.ended",
  sessionUsage: "session/usage",
} as const;

/** model.streaming payload 的 delta 块（kind 判别） */
export interface ZcodeModelStreamingPayload {
  readonly messageId?: string;
  readonly kind?: "text" | "reasoning" | "reasoning_start" | "reasoning_end" | string;
  readonly delta?: string;
  readonly model?: string;
}

/** tool.updated payload（scheduled → result/error） */
export interface ZcodeToolUpdatedPayload {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly status?: "scheduled" | "running" | "result" | "error" | string;
  readonly title?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly isError?: boolean;
}

/** 服务器→客户端反向请求：interaction/requestPermission（审批） */
export const ZCODE_REVERSE = {
  requestPermission: "interaction/requestPermission",
  requestUserInput: "interaction/requestUserInput",
  requestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
} as const;

export interface ZcodeRequestPermissionParams {
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly riskLevel?: "low" | "medium" | "high" | "critical" | string;
  readonly input?: unknown;
  readonly options?: readonly { readonly optionId?: string; readonly kind?: string }[];
}

/** 权限应答（按原帧 id 回 result） */
export interface ZcodePermissionDecisionResult {
  readonly decision: "allow" | "deny";
}
