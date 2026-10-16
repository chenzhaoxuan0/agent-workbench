import { create } from "zustand";
import type { GitBranchesResult, GitStatusResult, GitWorktree } from "../core/git.ts";
import {
  fetchGitBranches,
  fetchGitStatus,
  fetchGitWorktrees,
} from "../adapters/daemon/client.ts";

/**
 * 源代码管理 store —— 「源代码管理」主视图的数据面。
 *
 * 操作（建/删/切）不在 store 里包一层：组件直接调 client 包装并 catch RPC 错误
 * （错误码决定确认流，这是 UI 交互，不是共享状态），成功后调 refresh() 收敛。
 * store 只持有**列表数据**与侧栏分支标记缓存 —— 这些才是多处消费的共享状态。
 */

export type GitPendingDialog = "createBranch" | "createWorktree";

/** 面板错误横幅的形状：code/data 来自 daemon GitError，供「放弃合并」「打开那个工作树」这类出口按钮判断 */
export interface GitPanelError {
  readonly text: string;
  readonly code?: string;
  readonly data?: { readonly path?: string };
}

interface GitState {
  /** 面板当前指向的仓库（激活单元 rootPath）。null = 面板没开过 */
  rootPath: string | null;
  status: GitStatusResult | null;
  branches: GitBranchesResult | null;
  worktrees: readonly GitWorktree[] | null;
  loading: boolean;
  /** 最近一次刷新/操作的失败信息（面板顶部条展示；成功操作后清空） */
  error: GitPanelError | null;

  /** CommandCenter 等入口「打开面板并直接弹对话框」的一次性请求 */
  pendingDialog: GitPendingDialog | null;

  /** 侧栏 unit 行的分支名缓存：rootPath → 分支名（非 git 仓库为 null） */
  branchByRoot: Record<string, string | null>;

  /** 换仓库（切单元）或首次进入面板时重置并拉全量 */
  openRepo: (rootPath: string) => void;
  refresh: () => Promise<void>;
  /** 侧栏标记：轻量只拉 status；面板 refresh 时顺带覆盖同一缓存 */
  refreshBranchBadge: (rootPath: string) => Promise<void>;
  setPendingDialog: (d: GitPendingDialog | null) => void;
  setError: (err: GitPanelError | null) => void;
}

/** 徽章缓存的最小刷新间隔：切单元来回点不该每次都起 git 进程 */
const BADGE_TTL_MS = 15000;
const badgeFetchedAt = new Map<string, number>();

/** 同仓库 refresh 的代际计数（见 refresh 注释） */
let refreshGen = 0;

/** 旧 daemon（没有 git.* 方法）的报错翻成人话，其余原样 */
function friendlyGitError(err: unknown): GitPanelError {
  if (err instanceof Error && (err as { code?: string }).code === "unknown_method") {
    return { text: "当前 daemon 版本不支持源代码管理（git.*）—— 请重启新版 daemon 后再试", code: "unknown_method" };
  }
  return { text: err instanceof Error ? err.message : String(err) };
}

export const useGit = create<GitState>((set, get) => ({
  rootPath: null,
  status: null,
  branches: null,
  worktrees: null,
  loading: false,
  error: null,
  pendingDialog: null,
  branchByRoot: {},

  openRepo: (rootPath) => {
    if (get().rootPath === rootPath) {
      void get().refresh();
      return;
    }
    set({ rootPath, status: null, branches: null, worktrees: null, error: null });
    void get().refresh();
  },

  refresh: async () => {
    const rootPath = get().rootPath;
    if (rootPath === null) return;
    // 代际计数：同仓库内 checkout 后的 refresh 可能被更早一轮慢响应覆盖
    // （rootPath 守卫只挡换仓库，挡不住同仓库的乱序）—— 每轮自增，结算时
    // 只有最新一代允许写入，过期响应（含错误）整轮丢弃
    const gen = ++refreshGen;
    set({ loading: true });
    const stale = (): boolean => get().rootPath !== rootPath || gen !== refreshGen;
    try {
      // 非 git 仓库是正常态（诚实缺席），不是错误：status 先行判定，
      // 不再让后续 branches/worktrees 的 not_a_repo 把整个面板打成错误横幅
      const status = await fetchGitStatus(rootPath);
      if (stale()) return;
      if (!status.isRepo) {
        set({
          status,
          branches: { current: null, detached: true, branches: [] },
          worktrees: [],
          loading: false,
          error: null,
          branchByRoot: { ...get().branchByRoot, [rootPath]: null },
        });
        badgeFetchedAt.set(rootPath, Date.now());
        return;
      }
      const [branches, worktreesRes] = await Promise.all([
        fetchGitBranches(rootPath),
        fetchGitWorktrees(rootPath),
      ]);
      if (stale()) return;
      set({
        status,
        branches,
        worktrees: worktreesRes.worktrees,
        loading: false,
        error: null,
        branchByRoot: {
          ...get().branchByRoot,
          [rootPath]: status.branch,
        },
      });
      badgeFetchedAt.set(rootPath, Date.now());
    } catch (err: unknown) {
      if (stale()) return;
      set({ loading: false, error: friendlyGitError(err) });
    }
  },

  refreshBranchBadge: async (rootPath) => {
    const last = badgeFetchedAt.get(rootPath) ?? 0;
    if (Date.now() - last < BADGE_TTL_MS) return;
    try {
      const status = await fetchGitStatus(rootPath);
      // 只在成功后占坑：冷启动时 UnitRow 早于 daemon WS 就绪挂载，第一次调用
      // 会静默失败 —— 失败若也记时间戳，这个会话期内的重试全被 TTL 挡死
      badgeFetchedAt.set(rootPath, Date.now());
      // 徽章路径**只写 branchByRoot**：写 status 会用跨越用户操作的旧快照
      // 覆盖面板头部（checkout 成功后头部倒退回旧分支名），status 归 refresh() 管
      set({ branchByRoot: { ...get().branchByRoot, [rootPath]: status.isRepo ? status.branch : null } });
    } catch (err: unknown) {
      // unknown_method = daemon 是没有 git.* 的旧版本：负缓存满 TTL，
      // 别让 60s 轮询每轮都去撞一个注定失败的 RPC
      if (err instanceof Error && (err as { code?: string }).code === "unknown_method") {
        badgeFetchedAt.set(rootPath, Date.now());
      } else {
        badgeFetchedAt.delete(rootPath); // daemon 不在 / 目录消失：留空位给下次重试
      }
    }
  },

  setPendingDialog: (pendingDialog) => set({ pendingDialog }),
  setError: (error) => set({ error }),
}));
