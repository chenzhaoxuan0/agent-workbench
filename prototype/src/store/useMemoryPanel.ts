import { create } from "zustand";

/**
 * 记忆三柱面板的数据层（docs/10 §五 WP-8 / §七「前端重做」）。
 *
 * 三柱在 v1 里落在三个不同存储上，所以这里也没有「一张表的三行」：
 *   - 技能（procedural）→ `<rootPath>/skills/`，只读资产，取自 bot.inspect
 *   - 记忆（semantic）→ `<rootPath>/MEMORY.md`，2200 字符上限，取自 memory.project.read
 *   - 会话搜索（episodic）→ CLI 原生会话文件，**默认关**，查 steward.search
 *
 * 全部数据只来自 RPC。daemon 没起 / 调用失败时**不许把界面搞崩** ——
 * 每行各自降级（这一行的旧约定，docs/10 §八 2 的 fail-open 在前端的同构）：
 * 一行坏掉只让那一行显示不出来，头部给一句「未连接」。
 *
 * 本文件是记忆系统 RPC 的**唯一封装处**（client.ts 不归这次改动所有，
 * 所以这里沿用它导出的 DaemonClient / defaultDaemonEndpoint，不往那边加新函数）。
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

/** 注入块的一段来源（「哪份文件贡献了多少字符」） */
export interface DispatchPart {
  readonly scope: string;
  readonly sourcePath: string;
  readonly chars: number;
}

/**
 * memory.dispatches 的一行。
 *
 * 这是 docs/10 §五「必须能看到的：每一轮注入了什么」的唯一依据 ——
 * 记忆有没有起作用、什么时候串了项目，只能查它。
 */
export interface DispatchRecord {
  readonly id: number;
  readonly runtimeId: string;
  readonly rootPath: string;
  readonly userText: string;
  readonly injectedBlock: string;
  readonly injectedChars: number;
  readonly parts: readonly DispatchPart[];
  readonly createdAt: number;
}

/** steward.search 的一条命中（backend/src/memory/steward.ts） */
export interface StewardSearchHit {
  readonly cli: string;
  /** ISO 串 */
  readonly at: string;
  /**
   * 归属项目路径。**mcode 会话没有 cwd，这里是 null** ——
   * 那不是「数据坏了」，是「确实不知道」，UI 必须显式说「未标注项目」，
   * 绝不能因此把整条命中丢掉（docs/10 §4.6：搜到的必须能看清是谁的）。
   */
  readonly project: string | null;
  readonly sessionId: string | null;
  readonly srcPath: string;
  readonly lineNo: number;
  readonly score: number;
  readonly text: string;
  readonly context: readonly string[];
}

export interface StewardSearchResponse {
  readonly query: string;
  readonly hits: readonly StewardSearchHit[];
  readonly scannedBlocks: number;
  readonly elapsedMs: number;
  readonly byCli: Readonly<Record<string, number>>;
  /** 搜索范围被 pathHint 收窄过 */
  readonly scoped: boolean;
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

/**
 * 技能资产。daemon 的 bot.inspect 只到**目录 / 根文件**这一层
 * （inspect.ts 的 SKILL_DIR_NAMES + SKILL_FILES），不逐个枚举 skills/*.md。
 * 所以「已装载 N 个」是 N 个技能资产，不是 N 个 SKILL.md。
 */
export interface SkillEntry {
  readonly name: string;
  readonly kind: "file" | "dir";
}

/* ------------------------------------------------------------- RPC 封装 */

const SEARCH_LIMIT = 20;
/** 全量扫源目录是秒级到数十秒（docs/10 §4.4），超时必须比别的调用宽 */
const SEARCH_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;

/** 沿用既有调用风格：DaemonClient 单例 + rpc<T>(method, params, timeout) */
async function call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
  const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
  return DaemonClient.get(defaultDaemonEndpoint()).rpc<T>(method, params, timeoutMs);
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 一次调用的成败包起来：一行坏掉不许塌掉整块面板 */
async function attempt<T>(task: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await task };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** bot.inspect 的返回值里，面板只认 assets 这一小块 */
interface InspectLike {
  readonly report: {
    readonly assets: {
      readonly skillFiles: readonly string[];
      readonly skillDirs: readonly string[];
    };
  };
}

/** 读一个项目的长期记忆（面板与设置页共用同一个入口） */
export async function readProjectMemory(rootPath: string): Promise<MemoryFileInfo> {
  return call<MemoryFileInfo>("memory.project.read", { rootPath }, READ_TIMEOUT_MS);
}

/** 写一个项目的长期记忆 */
export async function writeProjectMemory(rootPath: string, content: string): Promise<unknown> {
  return call("memory.project.write", { rootPath, content }, READ_TIMEOUT_MS);
}

/** 读一个项目的红线禁令（上下文编辑器用；与 readProjectMemory 同一口径） */
export async function readStandingMemory(rootPath: string): Promise<MemoryFileInfo> {
  return call<MemoryFileInfo>("memory.standing.read", { rootPath }, READ_TIMEOUT_MS);
}

/** 写一个项目的红线禁令（备份 + 1000 上限硬校验在 daemon 侧） */
export async function writeStandingMemory(rootPath: string, content: string): Promise<unknown> {
  return call("memory.standing.write", { rootPath, content }, READ_TIMEOUT_MS);
}

/** 列出一个项目的每日总结列表 */
export async function listDailyMemory(rootPath: string): Promise<readonly string[]> {
  return call<readonly string[]>("memory.project.daily", { rootPath }, READ_TIMEOUT_MS);
}

/** 跨项目搜索记忆 */
export async function stewardSearchMemory(params: {
  botId?: string;
  query: string;
  limit?: number;
  withContext?: boolean;
}): Promise<StewardSearchResponse> {
  return call<StewardSearchResponse>("steward.search", params, SEARCH_TIMEOUT_MS);
}

/**
 * 每日总结的试跑（dryRun = 只报不写）。
 * 设置页的「立即运行」按钮用；放在这层是因为这里是记忆 RPC 的集中地。
 */
export async function runDigestDryRun(): Promise<DigestResult> {
  return call<DigestResult>("memory.digest.run", { dryRun: true }, SEARCH_TIMEOUT_MS);
}

export interface GuardianConfigInfo {
  readonly runner: "zcode" | "claude" | "codex" | "pi" | "mcode" | "agy" | "custom";
  readonly customCommand?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly autoConsolidate: boolean;
  readonly consolidateThresholdRatio: number;
  readonly contentScannerEnabled: boolean;
  /** 每日总结定时任务开关（kv 权威值；设置页开关写穿到 daemon） */
  readonly digestEnabled: boolean;
}

export interface ConsolidationResultInfo {
  readonly ran: boolean;
  readonly success: boolean;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly backupPath?: string | null;
  readonly reason?: string;
}

export async function getGuardianConfigRpc(): Promise<GuardianConfigInfo> {
  return call<GuardianConfigInfo>("memory.guardian.get", {}, READ_TIMEOUT_MS);
}

export async function setGuardianConfigRpc(patch: Partial<GuardianConfigInfo>): Promise<GuardianConfigInfo> {
  return call<GuardianConfigInfo>("memory.guardian.set", patch, READ_TIMEOUT_MS);
}

export async function runConsolidationRpc(rootPath: string, force = true): Promise<ConsolidationResultInfo> {
  return call<ConsolidationResultInfo>("memory.consolidate", { rootPath, force }, 180_000);
}

/* ------------------------------------------------------------- 持久化 */

const STORAGE_KEY = "agent-workbench:memory-panel";

function loadSearchOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function saveSearchOn(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* 隐私模式 / 存储满：静默失败，内存态仍可用 */
  }
}

/* ------------------------------------------------------------- store */

/**
 * 会话切换比请求快，用自增令牌丢弃过期响应 ——
 * 否则 A 会话的分发日志会盖到 B 上，「本轮注入了什么」就成了假话。
 */
let loadToken = 0;
let searchToken = 0;

interface MemoryPanelState {
  /** episodic 柱的开关。**默认关**（docs/10 §三）：全局记忆曾经让 A 项目冒出 B 项目的记忆 */
  sessionSearchOn: boolean;
  setSessionSearchOn: (on: boolean) => void;

  loading: boolean;
  /** 任一行调用失败时的说明。null = 三行都拿到了 */
  error: string | null;
  memory: MemoryFileInfo | null;
  dispatches: readonly DispatchRecord[];
  skills: readonly SkillEntry[];

  query: string;
  setQuery: (q: string) => void;
  searching: boolean;
  searchError: string | null;
  result: StewardSearchResponse | null;

  load: (target: { sessionId: string | null; rootPath: string | null }) => Promise<void>;
  runSearch: (target: { botId: string; query: string }) => Promise<void>;
  clearSearch: () => void;
}

export const useMemoryPanel = create<MemoryPanelState>()((set) => ({
  sessionSearchOn: loadSearchOn(),

  setSessionSearchOn: (on) => {
    set({ sessionSearchOn: on });
    saveSearchOn(on);
    // 关掉顺手撤结果：留着上一轮的命中会让人以为「已经查过了」
    if (!on) set({ result: null, searchError: null, query: "" });
  },

  loading: false,
  error: null,
  memory: null,
  dispatches: [],
  skills: [],

  query: "",
  setQuery: (q) => set({ query: q }),
  searching: false,
  searchError: null,
  result: null,

  load: async ({ sessionId, rootPath }) => {
    const token = ++loadToken;
    set({ loading: true, error: null });

    const [mem, disp, skill] = await Promise.all([
      rootPath === null ? null : attempt(readProjectMemory(rootPath)),
      sessionId === null ? null : attempt(call<readonly DispatchRecord[]>("memory.dispatches", { sessionId }, READ_TIMEOUT_MS)),
      rootPath === null ? null : attempt(call<InspectLike>("bot.inspect", { rootPath }, READ_TIMEOUT_MS)),
    ]);
    if (token !== loadToken) return;

    const errors = [mem, disp, skill]
      .filter((r): r is { readonly ok: false; readonly error: string } => r !== null && !r.ok)
      .map((r) => r.error);
    const a = skill !== null && skill.ok ? skill.value.report.assets : null;

    set({
      loading: false,
      error: errors.length > 0 ? (errors[0] ?? null) : null,
      memory: mem !== null && mem.ok ? mem.value : null,
      dispatches: disp !== null && disp.ok ? disp.value : [],
      skills: a === null ? [] : [...a.skillDirs.map((n) => ({ name: n, kind: "dir" as const })), ...a.skillFiles.map((n) => ({ name: n, kind: "file" as const }))],
    });
  },

  runSearch: async ({ botId, query }) => {
    const q = query.trim();
    if (q === "") return;
    const token = ++searchToken;
    set({ searching: true, searchError: null, result: null });

    const r = await attempt(
      call<StewardSearchResponse>("steward.search", { botId, query: q, limit: SEARCH_LIMIT, withContext: true }, SEARCH_TIMEOUT_MS),
    );
    if (token !== searchToken) return;

    if (r.ok) set({ searching: false, searchError: null, result: r.value });
    else set({ searching: false, searchError: r.error, result: null });
  },

  clearSearch: () => set({ result: null, searchError: null, searching: false }),
}));

/** 「已注入 N 条」= 本会话所有分发日志里注入来源的条目总数 */
export function injectedCount(dispatches: readonly DispatchRecord[]): number {
  return dispatches.reduce((n, d) => n + d.parts.length, 0);
}
