/**
 * 记忆系统 RPC 的**唯一封装处**。三柱面板（MemoryPanel）已移除，
 * 这里只剩设置页「记忆」分区还在用的四个入口：
 * 读项目记忆 / 记忆日 digest 试跑 / 守护者配置读写。
 *
 * 全部数据只来自 RPC。daemon 没起 / 调用失败时调用方自行降级，
 * 不许把界面搞崩。
 */

/* ------------------------------------------------------------- 后端返回形状 */

/** memory.project.read —— 项目长期记忆（上限见 backend/src/memory/limits.ts） */
export interface MemoryFileInfo {
  readonly path: string;
  readonly content: string;
  readonly chars: number;
  readonly limit: number;
  readonly exists: boolean;
  readonly mtimeMs: number;
}

/** memory.digest.run 的返回（backend/src/memory/dailyDigest.ts） */
export interface DigestResult {
  readonly ran: boolean;
  readonly date: string;
  readonly scannedFiles: number;
  readonly freshFiles: number;
  readonly freshBlocks: number;
  readonly wrote: readonly string[];
  readonly skipped: readonly { readonly project: string; readonly reason: string }[];
  readonly skipReason?: string;
  readonly error?: string;
}

/* ------------------------------------------------------------- RPC 封装 */

/** 全量扫源目录是秒级到数十秒（docs/10 §4.4），超时必须比别的调用宽 */
const SEARCH_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;

/** 沿用既有调用风格：DaemonClient 单例 + rpc<T>(method, params, timeout) */
async function call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
  const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
  return DaemonClient.get(defaultDaemonEndpoint()).rpc<T>(method, params, timeoutMs);
}

/** 读一个项目的长期记忆（设置页记忆分区用） */
export async function readProjectMemory(rootPath: string): Promise<MemoryFileInfo> {
  return call<MemoryFileInfo>("memory.project.read", { rootPath }, READ_TIMEOUT_MS);
}

/**
 * 每日总结的试跑（dryRun = 只报不写）。
 * 设置页的「立即运行」按钮用；放在这层是因为这里是记忆 RPC 的集中地。
 */
export async function runDigestDryRun(): Promise<DigestResult> {
  return call<DigestResult>("memory.digest.run", { dryRun: true }, SEARCH_TIMEOUT_MS);
}

export interface GuardianConfigInfo {
  readonly runner: "zcode" | "claude" | "codex" | "pi" | "mcode" | "custom";
  readonly customCommand?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly autoConsolidate: boolean;
  readonly consolidateThresholdRatio: number;
  readonly contentScannerEnabled: boolean;
}

export async function setGuardianConfigRpc(patch: Partial<GuardianConfigInfo>): Promise<GuardianConfigInfo> {
  return call<GuardianConfigInfo>("memory.guardian.set", patch, READ_TIMEOUT_MS);
}
