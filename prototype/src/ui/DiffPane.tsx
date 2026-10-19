import { useEffect } from "react";
import { FileDiff, GitBranch, RefreshCw } from "lucide-react";
import { useGit } from "../store/useGit.ts";
import { useGitChanges } from "../store/useGitChanges.ts";
import { ChangeFileList } from "./sourceControl/ChangeFileList.tsx";
import { cn } from "./cn.ts";

/**
 * 变更审查页（ZCode git 的对位）——「对话在左、改动在右」的审查姿势。
 *
 * 数据面完全复用 useGitChanges 单槽 store（与提交对话框、源代码管理页同一份
 * 数据 —— 三处对「改了什么」必须一个口径，ADR 0010 的原始动机）；分支徽标复
 * 用 useGit 的 TTL 缓存。**刷新信号不自建**：app 级的 installGitAutoRefresh
 * 已订阅 git.changed 并在槽位匹配时 reload（这里再订一份只会双倍 RPC，且它
 * 按事件里的 resolve 后路径比对，手写 === 还会漏前斜杠/大小写形态）。
 * stage/unstage 按钮刻意不给（undefined）：这是审查视角，写操作留在源代码
 * 管理页与提交对话框，防止在「看 diff」的地方误碰暂存区。
 */
export function DiffPane({ rootPath, shown }: { rootPath: string; shown: boolean }) {
  const openRepo = useGitChanges((s) => s.openRepo);
  const reload = useGitChanges((s) => s.reload);
  // 作用域读：单槽 store 只在槽位确实指向本仓库时才采信（防未来某个消费面
  // 把槽切到别的仓库时，这里闪现一份外仓库的文件清单）
  const changes = useGitChanges((s) => (s.rootPath === rootPath ? s.changes : null));
  const loading = useGitChanges((s) => s.loading && s.rootPath === rootPath);
  const error = useGitChanges((s) => (s.rootPath === rootPath ? s.error : null));
  const branch = useGit((s) => s.badgeByRoot[rootPath]?.branch);

  // 槽位不匹配才 openRepo：same-root 的 openRepo 会无条件 reload（每次
  // tab 切换/面板开合都白起一个 git 进程）；匹配时靠全局刷新 + 手动按钮
  useEffect(() => {
    if (!shown) return;
    if (useGitChanges.getState().rootPath !== rootPath) openRepo(rootPath);
  }, [shown, rootPath, openRepo]);

  const staged = changes?.staged ?? [];
  const unstaged = [...(changes?.unstaged ?? []), ...(changes?.untracked ?? [])];
  const total = staged.length + unstaged.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <FileDiff size={13} className="shrink-0 text-teal" />
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink">变更审查</span>
        {branch != null && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-ash" title={`当前分支 ${branch}`}>
            <GitBranch size={9} />
            {branch}
          </span>
        )}
        <span className="tnum shrink-0 text-[10px] text-ash">{total} 个文件</span>
        <button
          type="button"
          onClick={() => {
            // 槽位被别处切走时先夺回，再刷本仓库
            if (useGitChanges.getState().rootPath !== rootPath) openRepo(rootPath);
            else void reload();
          }}
          aria-label="刷新改动"
          title="重新读取 git.changes"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      {/* 改动清单 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error !== null ? (
          <p className="px-2 py-3 text-caption text-loss">读取改动失败：{error.text}</p>
        ) : changes === null && loading ? (
          <p className="px-2 py-3 text-caption text-ash">读取改动…</p>
        ) : total === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-6 text-center">
            <p className="text-caption font-medium text-graphite">工作树干净</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ash">
              这个 bot 的工作目录没有未提交的改动；会话里改了文件会自动出现在这里。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {staged.length > 0 && (
              <section className="overflow-hidden rounded-card border border-line bg-card">
                <header className="flex h-6 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2">
                  <span className="text-[11px] font-medium text-ink">已暂存</span>
                  <span className="tnum text-[10px] text-ash">({staged.length})</span>
                </header>
                <ChangeFileList rootPath={rootPath} entries={staged} sourceId="staged" emptyText="暂存区是空的" />
              </section>
            )}
            <section className="overflow-hidden rounded-card border border-line bg-card">
              <header className="flex h-6 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2">
                <span className="text-[11px] font-medium text-ink">未暂存</span>
                <span className="tnum text-[10px] text-ash">({unstaged.length})</span>
              </header>
              <ChangeFileList rootPath={rootPath} entries={unstaged} sourceId="unstaged" emptyText="没有未暂存的改动" />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
