/**
 * MCP 管理服务层 —— 原生配置文件的外科手术式读写编排。
 *
 * 两个"home"刻意分开：
 * - configHome：执行器配置所在的家目录（真实 ~，冒烟时可注入临时目录）
 * - stateHome：daemon 家目录（~/.agent-workbench）—— 停用库与首写备份住这里
 *
 * 每次变更的护栏顺序（ADR 0004 的后果条款）：
 *   乐观锁比对 → 首写字节备份 → fail-stop 解析 → 定点变换 → 原子写 → 停用库维护。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  McpCopyOutcome,
  McpFileStatus,
  McpInventory,
  McpMutationResult,
  McpServerEntry,
  McpServerInstance,
} from "../contract.ts";
import { findExecutorDef, MCP_EXECUTORS, MCP_UNSUPPORTED_EXECUTORS, unwrapCmd, wrapCmd, type McpExecutorDef } from "./executors.ts";
import { assertSha, fingerprint, firstWriteBackup, readTextOrNull, writeTextAtomic } from "./fsx.ts";

export interface McpServiceDeps {
  /** 执行器配置的家目录（默认 os.homedir()） */
  readonly configHome: string;
  /** daemon 家目录：停用库 + 首写备份所在 */
  readonly stateHome: string;
}

// ---- 停用库（Disabled Vault）：只留档被移除的条目，不是账本 -------------------

type VaultShape = Record<string, Record<string, McpServerEntry>>;

function vaultPath(deps: McpServiceDeps): string {
  return join(deps.stateHome, "mcp-disabled.json");
}

function loadVault(deps: McpServiceDeps): VaultShape {
  const text = readTextOrNull(vaultPath(deps));
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as VaultShape;
  } catch {
    // 停用库坏了不阻断读取（展示层照常），但写入前会被 saveVault 的 fail-stop 拦住
    return {};
  }
}

async function saveVault(deps: McpServiceDeps, vault: VaultShape): Promise<void> {
  const path = vaultPath(deps);
  const existing = readTextOrNull(path);
  if (existing !== null) {
    // fail-stop：库文件本身坏了就拒绝覆写（否则静默清空用户留档）
    JSON.parse(existing);
  }
  mkdirSync(dirname(path), { recursive: true });
  await writeTextAtomic(path, JSON.stringify(vault, null, 2) + "\n");
}

/**
 * 停用库互斥：vault 的 load→modify→save 之间隔着 await，事件循环可插入并发 RPC，
 * 后写者用旧快照覆盖会把先写者的条目静默抹掉。所有含 vault 变更的序列都在
 * 这条单飞链上串行执行（低频操作，串行无感）。
 */
const vaultChain: { p: Promise<unknown> } = { p: Promise.resolve() };
function withVault<T>(fn: () => Promise<T>): Promise<T> {
  const run = vaultChain.p.then(fn, fn);
  vaultChain.p = run.catch(() => undefined);
  return run;
}

// ---- 内部件 -------------------------------------------------------------------

function pathOf(def: McpExecutorDef, deps: McpServiceDeps): string {
  return def.configPath(deps.configHome);
}

/**
 * 读某执行器的 live 条目（文件不存在 → 空表；解析失败 → 抛 parse_error）。
 * 统一在这里拆 cmd /c 包装：所有执行器一个口径，清单/复制/停用库里的条目
 * 都是裸命令形态（写入侧再由 wrap 套回）。
 */
function readLive(def: McpExecutorDef, deps: McpServiceDeps): { text: string | null; entries: Map<string, McpServerEntry> } {
  const path = pathOf(def, deps);
  const text = readTextOrNull(path);
  if (text === null) return { text: null, entries: new Map() };
  const entries = new Map<string, McpServerEntry>();
  for (const [name, entry] of def.readServers(text)) entries.set(name, unwrapCmd(entry));
  return { text, entries };
}

/** 校验条目形态（写入前的最后防线）；def 给定时附带该执行器的传输能力校验 */
function validateEntry(entry: McpServerEntry, def?: McpExecutorDef): void {
  const name = entry.name.trim();
  if (name === "" || /[\\/]/.test(name) || name.startsWith(".")) {
    throw Object.assign(new Error("服务名不能为空、不能以点开头、不能含路径分隔符"), { code: "bad_params" });
  }
  if (entry.name !== name) {
    throw Object.assign(new Error("服务名前后不能有空白"), { code: "bad_params" });
  }
  if (entry.transport === "stdio" && (entry.command === undefined || entry.command.trim() === "")) {
    throw Object.assign(new Error("stdio 服务必须提供 command"), { code: "bad_params" });
  }
  if (entry.transport !== "stdio" && (entry.url === undefined || entry.url.trim() === "")) {
    throw Object.assign(new Error(`${entry.transport} 服务必须提供 url`), { code: "bad_params" });
  }
  if (def?.disallowedTransports?.includes(entry.transport)) {
    throw Object.assign(new Error(`${def.name} 不支持 ${entry.transport} 传输，请换一种连接方式`), { code: "bad_params" });
  }
}

/**
 * 通用变更骨架：乐观锁 → 备份 → 读 → 变换 → 原子写。
 * mutate 返回新全文；text 为 null 表示文件本来不存在（新建文件不做备份）。
 */
async function mutateFile(
  def: McpExecutorDef,
  deps: McpServiceDeps,
  expectedSha: string | undefined,
  mutate: (text: string | null) => string,
): Promise<McpMutationResult> {
  const path = pathOf(def, deps);
  assertSha(path, expectedSha);
  const text = readTextOrNull(path);
  if (text !== null) firstWriteBackup(path, deps.stateHome);
  const newText = mutate(text);
  mkdirSync(dirname(path), { recursive: true });
  await writeTextAtomic(path, newText);
  return { ok: true, newText, newSha: fingerprint(path) ?? "" };
}

// ---- 对外操作 -------------------------------------------------------------------

/**
 * 线上参数净化：RPC 的 entry 是未信任 JSON，先收窄到 McpServerEntry 形状
 * （字段类型不对直接丢，不做隐式转换 —— 错得越早越好）。
 */
export function sanitizeEntry(raw: unknown): McpServerEntry {
  if (raw === null || typeof raw !== "object") {
    throw Object.assign(new Error("entry must be an object"), { code: "bad_params" });
  }
  const r = raw as Record<string, unknown>;
  // transport 只认三种：未知值直接拒绝（静默收窄成 stdio 会产出误导性报错）
  const transport: McpServerEntry["transport"] =
    r.transport === "http" || r.transport === "sse" ? r.transport
      : r.transport === undefined || r.transport === "stdio" ? "stdio"
        : (() => { throw Object.assign(new Error(`未知 transport：${String(r.transport)}`), { code: "bad_params" }); })();
  const args = Array.isArray(r.args) ? r.args.filter((x): x is string => typeof x === "string") : undefined;
  const pick = (v: unknown): Record<string, string> | undefined => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  };
  return {
    name: typeof r.name === "string" ? r.name : "",
    transport,
    ...(typeof r.command === "string" ? { command: r.command } : {}),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(pick(r.env) !== undefined ? { env: pick(r.env) } : {}),
    ...(typeof r.url === "string" ? { url: r.url } : {}),
    ...(pick(r.headers) !== undefined ? { headers: pick(r.headers) } : {}),
  };
}

/** 全量清单：十二家的文件状态 + live/vault 条目按名聚行 */
export function mcpInventory(deps: McpServiceDeps): McpInventory {
  const vault = loadVault(deps);
  const files: McpFileStatus[] = [];
  const byName = new Map<string, McpServerInstance[]>();

  for (const def of MCP_EXECUTORS) {
    const path = pathOf(def, deps);
    const sha = fingerprint(path);
    let count: number | undefined;
    let error: string | undefined;
    if (existsSync(path)) {
      const text = readTextOrNull(path);
      if (text !== null) {
        try {
          const entries = readLive(def, deps).entries;
          count = entries.size;
          for (const [name, entry] of entries) {
            push(byName, name, { executorId: def.id, entry, disabled: false });
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
    }
    files.push({
      executorId: def.id,
      executorName: def.name,
      path,
      exists: existsSync(path),
      ...(count !== undefined ? { count } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(sha !== null ? { sha } : {}),
    });
    const vaultEntries = vault[def.id];
    if (vaultEntries !== undefined) {
      for (const [name, entry] of Object.entries(vaultEntries)) {
        push(byName, name, { executorId: def.id, entry, disabled: true });
      }
    }
  }

  const rows = [...byName.entries()]
    .map(([name, instances]) => ({ name, instances: instances.sort((a, b) => a.executorId.localeCompare(b.executorId)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { files, rows, unsupported: MCP_UNSUPPORTED_EXECUTORS };
}

function push(map: Map<string, McpServerInstance[]>, name: string, inst: McpServerInstance): void {
  const arr = map.get(name);
  if (arr === undefined) map.set(name, [inst]);
  else arr.push(inst);
}

/** 新增/编辑一条（编辑保留条目上的未知扩展键；写入侧统一套 cmd /c 包装） */
export async function mcpSave(deps: McpServiceDeps, executorId: string, entry: McpServerEntry, expectedSha?: string): Promise<McpMutationResult> {
  const def = findExecutorDef(executorId);
  validateEntry(entry, def);
  const result = await mutateFile(def, deps, expectedSha, (text) => def.writeServer(text ?? def.emptySeed, wrapCmd(entry)));
  // 编辑时条目名若在停用库也有一份（先停用后改名重建），从库里清掉，避免双份。
  // 注意：不能在这里失败回滚 live —— vault 残留只是清单双实例，下次操作自愈；
  // 反过来（live 已删 vault 没写进）才是两头落空，那个顺序问题在 mcpRemove 里管。
  await withVault(async () => {
    const vault = loadVault(deps);
    if (vault[executorId]?.[entry.name] !== undefined) {
      const bucket = vault[executorId];
      if (bucket !== undefined) delete bucket[entry.name];
      await saveVault(deps, vault);
    }
  });
  return result;
}

/**
 * 删除：toVault=true 移入停用库（默认）；false = 连停用库一起彻底删除。
 * 停用顺序铁律：**先把条目写进停用库，再从 live 删除** —— 库写失败立即中止
 * （live 未动，用户零损失）；反过来则是「live 已删、库没写进」的两头落空。
 */
export async function mcpRemove(deps: McpServiceDeps, executorId: string, name: string, opts: { toVault?: boolean; expectedSha?: string } = {}): Promise<McpMutationResult> {
  const def = findExecutorDef(executorId);
  const toVault = opts.toVault !== false;

  return withVault(async () => {
    const vault = loadVault(deps);
    const live = readLive(def, deps);
    const entry = live.entries.get(name) ?? vault[executorId]?.[name];
    if (entry === undefined) {
      throw Object.assign(new Error(`找不到服务：${name}`), { code: "not_found" });
    }
    const inLive = live.text !== null && live.entries.has(name);

    if (toVault) {
      vault[executorId] = { ...(vault[executorId] ?? {}), [name]: entry };
      await saveVault(deps, vault);
    }
    let result: McpMutationResult | null = null;
    if (inLive) {
      // 用 mutateFile 现场重读的最新文本做变换（预读快照只用于存在性判断），
      // 不带指纹时也不回滚并发写入
      result = await mutateFile(def, deps, opts.expectedSha, (fresh) => def.removeServer(fresh ?? def.emptySeed, name));
    }
    if (!toVault && vault[executorId]?.[name] !== undefined) {
      const bucket = vault[executorId];
      if (bucket !== undefined) delete bucket[name];
      await saveVault(deps, vault);
    }
    if (result === null) {
      // 只动停用库（live 里本来就没有）：回执给当前 live 文件状态
      const path = pathOf(def, deps);
      result = { ok: true, newText: readTextOrNull(path) ?? "", newSha: fingerprint(path) ?? "" };
    }
    return result;
  });
}

/** 启停：停用 = live → 停用库（先入库再删）；启用 = 停用库 → live（写回后出库） */
export async function mcpSetEnabled(deps: McpServiceDeps, executorId: string, name: string, enabled: boolean, expectedSha?: string): Promise<McpMutationResult> {
  const def = findExecutorDef(executorId);
  if (!enabled) {
    return mcpRemove(deps, executorId, name, { toVault: true, expectedSha });
  }
  // 启用不走 mcpSave：它的 vault 清理自己带互斥，嵌套会排队等自己（死锁）；
  // 这里在同一互斥段内完成 读库 → 写 live → 出库 的完整序列
  return withVault(async () => {
    const vault = loadVault(deps);
    const entry = vault[executorId]?.[name];
    if (entry === undefined) {
      throw Object.assign(new Error(`停用库里没有 ${name}（可能从未停用，或已从库里删除）`), { code: "not_in_vault" });
    }
    validateEntry(entry, def);
    const result = await mutateFile(def, deps, expectedSha, (text) => def.writeServer(text ?? def.emptySeed, wrapCmd(entry)));
    const bucket = vault[executorId];
    if (bucket !== undefined) {
      delete bucket[name];
      await saveVault(deps, vault);
    }
    return result;
  });
}

/**
 * 跨执行器复制：读源（live 优先，vault 兜底）→ 逐家转换写入。
 * 目标已有同名 live 条目 → 跳过（不覆盖用户在另一家的手工定义）；
 * 每家独立成败，单家失败不阻断其余（cc-switch 同款容错口径）。
 */
export async function mcpCopy(
  deps: McpServiceDeps,
  fromExecutorId: string,
  name: string,
  toExecutorIds: readonly string[],
  expectedShas: Record<string, string> = {},
): Promise<McpCopyOutcome[]> {
  const fromDef = findExecutorDef(fromExecutorId);
  const { entries } = readLive(fromDef, deps);
  const vault = loadVault(deps);
  const entry = entries.get(name) ?? vault[fromExecutorId]?.[name];
  if (entry === undefined) {
    throw Object.assign(new Error(`源执行器上找不到服务：${name}`), { code: "not_found" });
  }

  const outcomes: McpCopyOutcome[] = [];
  for (const targetId of toExecutorIds) {
    if (targetId === fromExecutorId) {
      outcomes.push({ executorId: targetId, ok: false, error: "源与目标相同" });
      continue;
    }
    try {
      const def = findExecutorDef(targetId);
      const { text, entries: targetEntries } = readLive(def, deps);
      if (targetEntries.has(name)) {
        outcomes.push({ executorId: targetId, ok: false, error: "已有同名服务，跳过（不覆盖）" });
        continue;
      }
      await mcpSave(deps, targetId, entry, expectedShas[targetId]);
      outcomes.push({ executorId: targetId, ok: true });
    } catch (e) {
      outcomes.push({ executorId: targetId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

/** 读配置文件原文（「查看原文」按钮 —— 真相源就是它，所见即真相） */
export function mcpReadFile(deps: McpServiceDeps, executorId: string): { text: string; sha: string } | { missing: true } {
  const def = findExecutorDef(executorId);
  const path = pathOf(def, deps);
  const text = readTextOrNull(path);
  if (text === null) return { missing: true };
  return { text, sha: fingerprint(path) ?? "" };
}
