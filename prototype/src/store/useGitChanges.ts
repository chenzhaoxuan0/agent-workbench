import { create } from "zustand";
import type { GitChangesResult } from "../core/git.ts";
import { fetchGitChanges, stageGitPaths, unstageGitPaths } from "../adapters/daemon/client.ts";

/**
 * 改动列表 store —— 「改了什么」这一个数据面的共享状态（ADR 0010）。
 *
 * 两个消费面读**同一个** store：Composer 顶栏的提交对话框与源代码管理页的「改动」
 * 区。两边各拉一份 git.changes 就会出现「对话框说 3 个文件、面板说 4 个」这种
 * 说不清的现象 —— 数据源必须只有一处。
 *
 * 单槽位（只跟踪一个 rootPath）：两个消费面绑的都是激活单元的 rootPath，
 * 一个槽位刚好；换代计数挡的是同仓库内乱序响应，rootPath 守卫挡换仓库。
 */

export interface GitChangesError {
  readonly text: string;
  readonly code?: string;
}

interface GitChangesState {
  rootPath: string | null;
  changes: GitChangesResult | null;
  loading: boolean;
  /** stage / unstage / 提交这类写操作的进行中标记（避免重复点击） */
  busy: boolean;
  error: GitChangesError | null;

  /** 打开/切到某个仓库：换仓库就重置，同仓库则刷新 */
  openRepo: (rootPath: string) => void;
  reload: () => Promise<void>;
  stage: (paths: readonly string[]) => Promise<boolean>;
  unstage: (paths: readonly string[]) => Promise<boolean>;
  clearError: () => void;
}

let gen = 0;

function asError(err: unknown): GitChangesError {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return { text: err.message, ...(code !== undefined ? { code } : {}) };
  }
  return { text: String(err) };
}

export const useGitChanges = create<GitChangesState>((set, get) => ({
  rootPath: null,
  changes: null,
  loading: false,
  busy: false,
  error: null,

  openRepo: (rootPath) => {
    if (get().rootPath === rootPath) {
      void get().reload();
      return;
    }
    set({ rootPath, changes: null, error: null });
    void get().reload();
  },

  reload: async () => {
    const rootPath = get().rootPath;
    if (rootPath === null) return;
    const my = ++gen;
    const stale = (): boolean => get().rootPath !== rootPath || my !== gen;
    set({ loading: true });
    try {
      const changes = await fetchGitChanges(rootPath);
      if (stale()) return;
      set({ changes, loading: false, error: null });
    } catch (err: unknown) {
      if (stale()) return;
      set({ loading: false, error: asError(err) });
    }
  },

  // 写操作统一外壳：成功就重拉（暂存意图不缓存，agent 可能正在同时改文件）
  stage: async (paths) => await mutate(set, get, stageGitPaths, paths),
  unstage: async (paths) => await mutate(set, get, unstageGitPaths, paths),

  clearError: () => set({ error: null }),
}));

type Mutator = (
  params: { rootPath: string; paths: readonly string[] },
) => Promise<null>;

async function mutate(
  set: (partial: Partial<GitChangesState>) => void,
  get: () => GitChangesState,
  fn: Mutator,
  paths: readonly string[],
): Promise<boolean> {
  const rootPath = get().rootPath;
  if (rootPath === null || paths.length === 0 || get().busy) return false;
  set({ busy: true, error: null });
  try {
    await fn({ rootPath, paths });
    await get().reload();
    return true;
  } catch (err: unknown) {
    set({ error: asError(err) });
    return false;
  } finally {
    set({ busy: false });
  }
}
