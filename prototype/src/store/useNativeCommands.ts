/**
 * 执行器原生斜杠命令 store —— 菜单数据的唯一来源。
 *
 * 为什么独立成 store 而不塞进 useWorkbench：命令清单是「按 (执行器, rootPath)
 * 惰性拉取 + TTL 缓存」的旁路数据，与会话/时间线生命周期完全正交。挂在
 * workbench 上会让每次 run()/切执行器都背上它的刷新逻辑。
 *
 * 语义：空清单 = 该执行器没有原生命令面（菜单只显示工作台本地命令）；
 * 拉取失败 = 保留上次结果（没有上次就空），菜单照常可用 —— 命令面板永远不该
 * 因为 daemon 抖一下就打不开。
 */
import { create } from "zustand";
import type { NativeCommandInfo } from "../core/adapter.ts";

export type NativeCommandsStatus = "idle" | "loading" | "ready" | "error";

interface NativeCommandsEntry {
  readonly commands: readonly NativeCommandInfo[];
  readonly status: NativeCommandsStatus;
  /** ready 的时间戳（TTL 判定用） */
  readonly at: number;
  readonly error?: string;
}

interface NativeCommandsState {
  /** key = `${bareRuntimeId}|${rootPath}`（daemon 侧裸 id；清单依赖项目级自定义命令） */
  readonly entries: Record<string, NativeCommandsEntry>;
  /**
   * 拉取（菜单打开/切执行器时调用）。freshMs 内不重拉；在途去重。
   * force = 无视 TTL 强刷（用户明确点了刷新时用）。
   */
  ensure: (runtimeId: string, rootPath: string, opts?: { force?: boolean; freshMs?: number }) => Promise<void>;
}

/** 与后端适配器缓存 TTL 同口径（10 分钟）；菜单每次打开都可能命中前端缓存 */
const DEFAULT_FRESH_MS = 10 * 60 * 1000;

const inflight = new Map<string, Promise<void>>();

export const useNativeCommands = create<NativeCommandsState>((set, get) => ({
  entries: {},

  ensure: async (runtimeId, rootPath, opts) => {
    const key = `${runtimeId}|${rootPath}`;
    const freshMs = opts?.freshMs ?? DEFAULT_FRESH_MS;
    const cur = get().entries[key];
    if (!opts?.force && cur !== undefined && (cur.status === "ready" || cur.status === "loading")) {
      if (cur.status === "loading") return;
      if (Date.now() - cur.at < freshMs) return;
    }

    const pending = inflight.get(key);
    if (pending !== undefined) return pending;

    set((s) => ({
      entries: {
        ...s.entries,
        [key]: { commands: cur?.commands ?? [], status: "loading", at: cur?.at ?? 0 },
      },
    }));

    const job = (async () => {
      try {
        const { fetchExecutorCommands } = await import("../adapters/daemon/client.ts");
        const commands = await fetchExecutorCommands(runtimeId, rootPath);
        set((s) => ({ entries: { ...s.entries, [key]: { commands, status: "ready", at: Date.now() } } }));
      } catch (err: unknown) {
        // 失败保留旧清单：菜单退化但不空转（旧数据好过没有数据）
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: {
              commands: cur?.commands ?? [],
              status: "error",
              at: cur?.at ?? 0,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        }));
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    await job;
  },
}));

/** 便捷选择器：拿某执行器在当前状态下的命令条目（缺省 idle/空） */
export function nativeCommandsFor(
  s: NativeCommandsState,
  runtimeId: string,
  rootPath: string,
): NativeCommandsEntry {
  return s.entries[`${runtimeId}|${rootPath}`] ?? { commands: [], status: "idle", at: 0 };
}

/** 当前执行器是否有**已加载**的原生命令面（去遮挡判定：拉到了才算数） */
export function hasLoadedNativeCommands(s: NativeCommandsState, runtimeId: string, rootPath: string): boolean {
  const e = nativeCommandsFor(s, runtimeId, rootPath);
  return e.status === "ready" && e.commands.length > 0;
}
