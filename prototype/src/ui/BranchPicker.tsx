import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Loader2, Plus } from "lucide-react";
import { validateBranchName, type GitBranchInfo } from "../core/git.ts";
import { checkoutGitBranch, createGitBranch, fetchGitBranches } from "../adapters/daemon/client.ts";
import { useGit } from "../store/useGit.ts";
import { cn } from "./cn.ts";

/**
 * 对话输入框顶栏的分支选择器（ZCode GitBranchSwitcher 同款交互，分支面循
 * ADR 0009 窄模型）：芯片显示当前分支（useGit 侧栏徽章缓存，TTL 节流），
 * 非 git 仓库 / detached 时整个隐藏。点击向上弹出：
 * - 搜索过滤 + 本地分支列表，点击即切换（当前分支禁选高亮）
 * - 底部「新建分支」内联输入，新建即切换
 * - 失败（dirty_worktree / branch_checked_out_elsewhere 等）在面板内联报错；
 *   引导性出口（打开那个工作树）在「源代码管理」面板，这里只报事实
 */
export function BranchPicker(props: { rootPath: string | undefined; showFooterActions?: boolean }) {
  const rootPath = props.rootPath;
  // 提交对话框里内嵌的是精简版：不带「新建分支」底栏（那里是干正事的，不是切分支）
  const showFooterActions = props.showFooterActions !== false;
  const branchName = useGit((s) => (rootPath === undefined ? undefined : s.badgeByRoot[rootPath]?.branch));
  const refreshBadge = useGit((s) => s.refreshBranchBadge);

  // 侧栏同款口径：徽章缓存 TTL 节流（切单元来回点不重复起 git 进程）
  useEffect(() => {
    if (rootPath !== undefined) void refreshBadge(rootPath);
  }, [rootPath, refreshBadge]);

  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<readonly GitBranchInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const locals = branches === null ? [] : branches.filter((b) => b.kind === "local");
  const v = validateBranchName(newName, locals.map((b) => b.name));
  const q = query.trim().toLowerCase();
  const filtered = q === "" ? locals : locals.filter((b) => b.name.toLowerCase().includes(q));

  // 面板内的动作成功后也走这里收敛（列表不吃徽章缓存）
  async function load(): Promise<void> {
    if (rootPath === undefined) return;
    try {
      const r = await fetchGitBranches(rootPath);
      setBranches(r.branches);
      setCurrent(r.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // 每次打开都重拉分支列表并复位临时态
  useEffect(() => {
    if (!open) return;
    setError(null);
    setQuery("");
    setCreating(false);
    setNewName("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load 闭包取当下的 rootPath，无需追
  }, [open]);

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (rootPath === undefined || branchName == null) return null;

  const act = async (label: string, resultBranch: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      // 同步写徽章缓存（绕过 TTL）：芯片与侧栏立刻跟上，不等下一轮节流拉取
      useGit.getState().markBranch(rootPath, resultBranch);
      setOpen(false);
    } catch (err) {
      const e = err as { message?: string };
      setError(`${label}失败：${e.message ?? "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md border border-line/60 bg-line-soft/60 px-2 py-0.5 text-[11px] font-mono text-graphite transition select-none hover:text-ink active:scale-95"
        title={`当前分支 ${branchName}，点击切换或新建`}
      >
        <GitBranch size={11} className="text-teal shrink-0" />
        <span className="max-w-[140px] truncate">{branchName}</span>
        {busy ? (
          <Loader2 size={10} className="shrink-0 animate-spin" />
        ) : (
          <ChevronDown size={10} className="shrink-0" />
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-line bg-card shadow-md">
          <div className="border-b border-line-soft p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索分支…"
              className="w-full rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {branches === null ? (
              <div className="flex items-center gap-2 px-2 py-3 text-caption text-ash">
                <Loader2 size={12} className="animate-spin" /> 读取中…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-caption text-ash">
                {q !== "" ? "没有匹配的分支" : "没有任何本地分支"}
              </div>
            ) : (
              filtered.map((b) => {
                const isCurrent = b.name === (current ?? branchName);
                return (
                  <button
                    key={b.name}
                    type="button"
                    disabled={busy || isCurrent}
                    onClick={() => void act(`切换到 ${b.name}`, b.name, () => checkoutGitBranch({ rootPath, name: b.name }))}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-body-sm",
                      isCurrent ? "bg-teal-tint text-ink" : "text-ink hover:bg-line-soft disabled:opacity-40",
                    )}
                    title={isCurrent ? "当前分支" : `切换到 ${b.name}`}
                  >
                    <GitBranch size={12} className={cn("shrink-0", isCurrent ? "text-teal" : "text-graphite")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-caption">{b.name}</span>
                    {isCurrent && <Check size={12} className="shrink-0 text-teal" />}
                  </button>
                );
              })
            )}
          </div>
          {showFooterActions && (
            <div className="border-t border-line-soft p-2">
              {creating ? (
                <div className="flex flex-col gap-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && v.ok && !busy) {
                      void act("新建分支", newName.trim(), () => createGitBranch({ rootPath, name: newName.trim() }));
                    }
                  }}
                  placeholder="新分支名，如 feat/xxx"
                  className="w-full rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
                />
                {!v.ok && newName.trim() !== "" && <p className="text-caption text-loss">{v.reason}</p>}
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                    className="rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={!v.ok || busy || newName.trim() === ""}
                    onClick={() => void act("新建分支", newName.trim(), () => createGitBranch({ rootPath, name: newName.trim() }))}
                    className="flex items-center gap-1 rounded-btn bg-ink px-2.5 py-1 text-caption font-medium text-canvas hover:opacity-90 disabled:opacity-40"
                  >
                    {busy && <Loader2 size={10} className="animate-spin" />}
                    新建并切换
                  </button>
                </div>
              </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-body-sm text-ink hover:bg-line-soft"
                >
                  <Plus size={12} className="text-graphite" />
                  <span>新建分支</span>
                </button>
              )}
            </div>
          )}
          {error !== null && <div className="break-all border-t border-line-soft px-2.5 py-2 text-caption text-loss">{error}</div>}
        </div>
      )}
    </div>
  );
}
