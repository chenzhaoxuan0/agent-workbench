/**
 * ACP 模型清单发现 —— 给走 Agent Client Protocol 的执行器共用（mcode / dsh / grok 一类）。
 *
 * ## 为什么能零用量
 *
 * ACP 的 `session/new` 是**建会话**，不是发消息：它在响应里就把该 agent 当前可选的
 * 模型清单（`configOptions`）一并回给你了。所以只要 initialize + session/new 两个帧，
 * 拿到清单就 kill 进程，全程没有 `session/prompt` —— **零 token、零计费**。
 *
 * 对照：`session/prompt` 才是真正跑一轮对话、会烧额度的那一帧。任何一个适配器往这里
 * 偷偷加 prompt 去"验一下模型能不能用"，就是拿用户的订阅额度做功能测试，绝不允许。
 *
 * ## 为什么形状要兼容两种
 *
 * ACP 规范里模型清单有两种表达：
 *   - 扁平：`options: [{ value, name }]`
 *   - 分组：`options: [{ group, name, options: [{ value, name }] }]`
 * 不同 agent 各选一种（mcode 扁平、dsh 分组），这里统一拍平。
 * 另外 dsh 的 value 是个 JSON 串（如 `["deepseek-official","deepseek-v4-flash"]`），
 * 由各适配器自己按自己的 id 规则还原，这里只负责原样交出。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AcpModelOption {
  /** 原始 value，原样交出（dsh 是 JSON 串，各家 id 规则不同） */
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  /** 分组名（扁平形态为 undefined） */
  readonly group?: string;
  /** 部分 agent 在 _meta 里带上下文窗口（grok 的 totalContextTokens） */
  readonly contextWindow?: number;
  /** 部分 agent 声明支持推理档位 */
  readonly reasoningLevels?: readonly string[];
}

interface AcpFrame {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * 起一个临时 ACP 进程问一次 session/new，拿回原始 result 后立刻杀掉进程。
 *
 * @param file    可执行文件
 * @param prefixArgs resolveCommand 解析出的前缀参数（node 脚本路径等）
 * @param args    ACP 服务入口参数（如 `["acp"]`）
 */
export async function queryAcpSessionNew(
  file: string,
  prefixArgs: readonly string[],
  args: readonly string[],
  opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(file, [...prefixArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
      ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`ACP session/new 超时（${timeoutMs}ms）`))), timeoutMs);

    const waiters = new Map<number, (f: AcpFrame) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      let f: AcpFrame;
      try {
        f = JSON.parse(line) as AcpFrame;
      } catch {
        return;
      }
      // session/update 之类的通知（method 存在）直接忽略，只认响应帧
      if (f.id === undefined) return;
      waiters.get(f.id)?.(f);
      waiters.delete(f.id);
    });
    // stderr 不接管（管道满会反压阻塞 CLI），让它自然丢到 ignore
    child.stderr?.resume();

    let nextId = 0;
    const req = (method: string, params: Record<string, unknown>): Promise<AcpFrame> =>
      new Promise((res) => {
        const id = (nextId += 1);
        waiters.set(id, res);
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    // 进程提前退出（命令错、CLI 没装）时不能永远挂着 —— 补发拒绝
    child.on("exit", () => finish(() => reject(new Error("ACP 进程在返回 session/new 前退出"))));
    child.on("error", (e: Error) => finish(() => reject(e)));

    void (async () => {
      try {
        const init = await req("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        if (init.error !== undefined) throw new Error(init.error.message ?? "initialize failed");
        const sn = await req("session/new", {
          cwd: opts.cwd ?? process.env["USERPROFILE"] ?? ".",
          mcpServers: [],
        });
        if (sn.error !== undefined) throw new Error(sn.error.message ?? "session/new failed");
        finish(() => resolve(sn.result ?? {}));
      } catch (err: unknown) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    })();
  });
}

/** configOptions 里的一项（宽松读视角） */
interface AcpConfigOption {
  readonly id?: string;
  readonly category?: string;
  readonly currentValue?: string;
  readonly options?: readonly unknown[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 从 session/new 的 result 里抽出某个 configOption 的选项。
 *
 * key 通常是 `"model"`，也可用 `"thinkingEffort"` 之类取推理档位。
 * 认两种形态：options 数组可能是扁平的，也可能是 `{group, options:[...]}` 分组的，逐层拍平。
 */
export function pickAcpSelectOption(
  result: unknown,
  key: string,
): { current?: string; options: readonly AcpModelOption[] } {
  const cfg = (result as { readonly configOptions?: readonly AcpConfigOption[] } | undefined)?.configOptions;
  if (!Array.isArray(cfg)) return { options: [] };
  const want = key.toLowerCase();
  const modelOpt = cfg.find(
    (c) => (c.id ?? "").toLowerCase() === want || (c.category ?? "").toLowerCase() === want,
  );
  if (modelOpt === undefined) return { options: [] };

  const out: AcpModelOption[] = [];
  const visit = (raw: unknown, group?: string): void => {
    if (raw === null || typeof raw !== "object") return;
    const o = raw as { readonly value?: unknown; readonly name?: unknown; readonly description?: unknown; readonly options?: unknown; readonly group?: unknown };
    // 分组项：自己没有 value，只有子 options
    if (Array.isArray(o.options)) {
      const g = asString(o.group) ?? group;
      for (const child of o.options) visit(child, g);
      return;
    }
    const value = asString(o.value);
    if (value === undefined) return;
    const name = asString(o.name) ?? value;
    const item: AcpModelOption = { value, name, description: asString(o.description), group };
    // 去重（同一档位可能在多个分组里各出现一次）
    if (!out.some((x) => x.value === value)) out.push(item);
  };
  for (const raw of modelOpt.options ?? []) visit(raw);

  return { current: asString(modelOpt.currentValue), options: out };
}

/**
 * 抽模型选单 —— 兼容 ACP 两种版本的表达：
 *
 * 1. 新版 `configOptions[category=model]`（mcode / dsh 用，选项可能扁平也可能分组）
 * 2. 旧版 `models.availableModels`（grok / hermes / kimi 用，条目带 _meta 元数据）
 *
 * 新版优先：它带 `currentValue`，能判断「当前正在用的是哪个变体」。
 */
export function pickAcpModelOptions(result: unknown): { current?: string; options: readonly AcpModelOption[] } {
  const viaConfigOption = pickAcpSelectOption(result, "model");
  if (viaConfigOption.options.length > 0) return viaConfigOption;
  return pickAcpAvailableModels(result);
}

/** 旧版 ACP 的 `models.availableModels` 形态 */
export function pickAcpAvailableModels(result: unknown): { current?: string; options: readonly AcpModelOption[] } {
  const models = (result as { readonly models?: { readonly availableModels?: readonly unknown[]; readonly currentModelId?: string } } | undefined)?.models;
  const list = models?.availableModels;
  if (!Array.isArray(list)) return { options: [] };
  const out: AcpModelOption[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const m = raw as {
      readonly modelId?: unknown;
      readonly name?: unknown;
      readonly _meta?: {
        readonly totalContextTokens?: unknown;
        readonly supportsReasoningEffort?: unknown;
        readonly reasoningEfforts?: unknown;
      };
    };
    const id = asString(m.modelId);
    if (id === undefined) continue;
    const meta = m._meta;
    const ctx = typeof meta?.totalContextTokens === "number" && meta.totalContextTokens > 0 ? meta.totalContextTokens : undefined;
    const efforts =
      Array.isArray(meta?.reasoningEfforts)
        ? meta.reasoningEfforts.filter((x): x is string => typeof x === "string")
        : undefined;
    out.push({
      value: id,
      name: asString(m.name) ?? id,
      contextWindow: ctx,
      reasoningLevels: meta?.supportsReasoningEffort === true ? efforts : undefined,
    });
  }
  return { current: asString(models?.currentModelId), options: out };
}
