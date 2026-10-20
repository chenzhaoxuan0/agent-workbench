import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, GitBranch, History, RefreshCw, Search, X } from "lucide-react";
import { useGit } from "../store/useGit.ts";
import { useGitChanges } from "../store/useGitChanges.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { runtimeRegistry } from "../core/registry.ts";
import { asRuntimeId, type UnitId } from "../core/units.ts";
import type { GitDiffResult } from "../core/git.ts";
import { fetchGitDiff } from "../adapters/daemon/client.ts";
import { ChangeFileList } from "./sourceControl/ChangeFileList.tsx";
import { ChangeDiffView } from "./sourceControl/ChangeDiffView.tsx";
import { useFollowedSessionId } from "./useFollowedSessionId.ts";
import { useLastTurnDiff, type LastTurnFile } from "./useLastTurnDiff.ts";
import { cn } from "./cn.ts";

/**
 * 变更审查页（ZCode GitPane 的对位）——「对话在左、改动在右」的审查姿势。
 *
 * 两个来源（ZCode 的 source 下裁剪为两档）：
 * - **工作树**：已暂存 / 未暂存（含未跟踪）分组。数据面复用 useGitChanges 单槽
 *   store（与提交对话框、源代码管理页同一份数据 —— 三处对「改了什么」必须一个
 *   口径，ADR 0010 的原始动机）；分支徽标复用 useGit 的 TTL 缓存；刷新信号不自建
 *   （app 级 installGitAutoRefresh 已订阅 git.changed）。stage/unstage 按钮刻意
 *   不给（undefined）：这是审查视角，写操作留在源代码管理页与提交对话框。
 * - **上一轮**（last-turn）：跟随会话最后一轮的 file.diff 事件（useLastTurnDiff，
 *   会话口径的独立只读路径，不碰单槽）。fileDiff 能力位是执行器声明的 ——
 *   不支持的执行器该档禁用并说明，不装「什么都没有」。
 *
 * 过滤框：两档共用，按路径子串过滤；工作树档命中行自动展开 diff。
 */

type DiffSource = "worktree" | "lastTurn";

/** 「上一轮」档的门控结论：ok=false 时该档禁用并以 why 说明原因 */
type LastTurnGate = { ok: boolean; why: string };

export function DiffPane({ rootPath, unitId, shown }: { rootPath: string; unitId: UnitId; shown: boolean }) {
  const [source, setSource] = useState<DiffSource>("worktree");
  const [filter, setFilter] = useState("");
  // 跟随目标与「上一轮」能力门控收敛在本体算一次：此前 Header（档位禁用）与
  // LastTurnView（取数）各挂一个 useFollowedSessionId，同一 unit 会并发拉两次台账回退
  const { sessionId, live } = useFollowedSessionId(unitId);
  const sessionRuntime = useWorkbench((s) =>
    sessionId === null ? null : (s.sessions.find((x) => String(x.id) === sessionId)?.runtimeId ?? null),
  );
  const lastTurnState = useMemo(() => {
    if (sessionId === null) return { ok: false, why: "还没有可跟随的会话" };
    if (sessionRuntime === null) return { ok: true, why: "" };
    // 注册表键带 daemon: 命名空间（adapters/daemon/adapter.ts 注册的是
    // `daemon:<裸id>`）；sessions 侧的 runtimeId 已被适配器翻成带前缀形态，
    // 裸 id 个别路径再补前缀兜一次 —— 两种口径都命中，fileDiff 门控才不是死代码
    const bare = sessionRuntime.replace(/^daemon:/, "").replace(/:yolo$/, "");
    const caps =
      runtimeRegistry.get(sessionRuntime)?.capabilities ??
      runtimeRegistry.get(asRuntimeId(`daemon:${bare}`))?.capabilities;
    if (caps === undefined) return { ok: true, why: "" }; // 未登记的执行器按支持处理（不误杀）
    return caps.fileDiff ? { ok: true, why: "" } : { ok: false, why: "当前执行器不产出 file.diff 事件（codex / opencode / mcode 支持）" };
  }, [sessionId, sessionRuntime]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffPaneHeader
        rootPath={rootPath}
        source={source}
        onSource={setSource}
        filter={filter}
        onFilter={setFilter}
        lastTurnState={lastTurnState}
      />
      {source === "worktree" ? (
        <WorktreeView rootPath={rootPath} shown={shown} filter={filter} />
      ) : (
        <LastTurnView rootPath={rootPath} sessionId={sessionId} live={live} shown={shown} filter={filter} />
      )}
    </div>
  );
}

function DiffPaneHeader({
  rootPath,
  source,
  onSource,
  filter,
  onFilter,
  lastTurnState,
}: {
  rootPath: string;
  source: DiffSource;
  onSource: (s: DiffSource) => void;
  filter: string;
  onFilter: (f: string) => void;
  lastTurnState: LastTurnGate;
}) {
  const branch = useGit((s) => s.badgeByRoot[rootPath]?.branch);

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
      <FileDiff size={13} className="shrink-0 text-teal" />
      <span className="shrink-0 text-caption font-medium text-ink">变更审查</span>
      {/* 来源切换：工作树（git 口径）/ 上一轮（会话口径） */}
      <div className="flex shrink-0 items-center rounded-btn bg-line-soft p-0.5">
        <button
          type="button"
          onClick={() => onSource("worktree")}
          aria-pressed={source === "worktree"}
          className={cn(
            "rounded-[5px] px-1.5 py-0.5 text-[10px] transition",
            source === "worktree" ? "bg-card text-ink shadow-sm" : "text-graphite hover:text-ink",
          )}
        >
          工作树
        </button>
        <button
          type="button"
          onClick={() => onSource("lastTurn")}
          disabled={!lastTurnState.ok}
          title={lastTurnState.ok ? "活跃会话上一轮改了什么" : lastTurnState.why}
          aria-pressed={source === "lastTurn"}
          className={cn(
            "flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] transition",
            source === "lastTurn" ? "bg-card text-ink shadow-sm" : "text-graphite hover:text-ink",
            !lastTurnState.ok && "cursor-not-allowed opacity-40 hover:text-graphite",
          )}
        >
          <History size={9} />
          上一轮
        </button>
      </div>
      {branch != null && source === "worktree" && (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-ash" title={`当前分支 ${branch}`}>
          <GitBranch size={9} />
          {branch}
        </span>
      )}
      {/* 过滤框：路径子串过滤，工作树档命中自动展开 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 rounded-btn border border-line bg-canvas px-1.5">
        <Search size={10} className="shrink-0 text-ash" />
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="过滤路径…"
          aria-label="过滤改动文件"
          className="min-w-0 flex-1 bg-transparent py-1 text-[11px] text-ink outline-none placeholder:text-ash"
        />
        {filter !== "" && (
          <button
            type="button"
            onClick={() => onFilter("")}
            aria-label="清除过滤"
            className="shrink-0 rounded p-0.5 text-ash hover:text-ink"
          >
            <X size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 工作树档 */

function WorktreeView({ rootPath, shown, filter }: { rootPath: string; shown: boolean; filter: string }) {
  const openRepo = useGitChanges((s) => s.openRepo);
  const reload = useGitChanges((s) => s.reload);
  // 作用域读：单槽 store 只在槽位确实指向本仓库时才采信（防未来某个消费面
  // 把槽切到别的仓库时，这里闪现一份外仓库的文件清单）
  const changes = useGitChanges((s) => (s.rootPath === rootPath ? s.changes : null));
  const loading = useGitChanges((s) => s.loading && s.rootPath === rootPath);
  const error = useGitChanges((s) => (s.rootPath === rootPath ? s.error : null));

  // 槽位不匹配才 openRepo：same-root 的 openRepo 会无条件 reload（每次
  // tab 切换/面板开合都白起一个 git 进程）；匹配时靠全局刷新 + 手动按钮
  useEffect(() => {
    if (!shown) return;
    if (useGitChanges.getState().rootPath !== rootPath) openRepo(rootPath);
  }, [shown, rootPath, openRepo]);

  const staged = changes?.staged ?? [];
  const unstaged = [...(changes?.unstaged ?? []), ...(changes?.untracked ?? [])];
  const total = staged.length + unstaged.length;
  const f = filter.trim().toLowerCase();
  const hit =
    f === ""
      ? total
      : staged.filter((e) => e.path.toLowerCase().includes(f)).length +
        unstaged.filter((e) => e.path.toLowerCase().includes(f)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <span className="tnum shrink-0 text-[10px] text-ash">
          {f === "" ? `${total} 个文件` : `命中 ${hit} / ${total}`}
        </span>
        <span className="flex-1" />
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
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error !== null ? (
          <p className="px-2 py-3 text-caption text-loss">读取改动失败：{error.text}</p>
        ) : changes === null && loading ? (
          <p className="px-2 py-3 text-caption text-ash">读取改动…</p>
        ) : hit === 0 && f !== "" ? (
          <p className="px-2 py-3 text-center text-caption text-ash">没有路径包含「{filter.trim()}」的改动</p>
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
                <ChangeFileList rootPath={rootPath} entries={staged} sourceId="staged" emptyText="暂存区是空的" filter={filter} />
              </section>
            )}
            <section className="overflow-hidden rounded-card border border-line bg-card">
              <header className="flex h-6 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2">
                <span className="text-[11px] font-medium text-ink">未暂存</span>
                <span className="tnum text-[10px] text-ash">({unstaged.length})</span>
              </header>
              <ChangeFileList rootPath={rootPath} entries={unstaged} sourceId="unstaged" emptyText="没有未暂存的改动" filter={filter} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 上一轮档 */

function LastTurnView({
  rootPath,
  sessionId,
  live,
  shown,
  filter,
}: {
  rootPath: string;
  sessionId: string | null;
  live: boolean;
  shown: boolean;
  filter: string;
}) {
  const { files, turn, loading, error, running } = useLastTurnDiff(sessionId, shown);
  const f = filter.trim().toLowerCase();
  const matched = f === "" ? files : files.filter((x) => x.path.toLowerCase().includes(f));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <span className="shrink-0 text-[10px] text-ash">
          {sessionId === null
            ? "没有可跟随的会话"
            : running
              ? `${live ? "跟随活跃会话" : "最近会话"} · 本轮进行中`
              : live
                ? `跟随活跃会话 · 第 ${turn ?? "?"} 轮`
                : `最近会话 · 第 ${turn ?? "?"} 轮`}
        </span>
        {f !== "" && (
          <span className="tnum shrink-0 text-[10px] text-ash">
            命中 {matched.length} / {files.length}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error !== null ? (
          <p className="px-2 py-3 text-caption text-loss">读取上一轮改动失败：{error}</p>
        ) : loading ? (
          <p className="px-2 py-3 text-caption text-ash">读取上一轮改动…</p>
        ) : files.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-6 text-center">
            {running ? (
              // 两种空分开说：轮次还在跑是「等一等」，轮次已落定才是「没记录到」
              <>
                <p className="text-caption font-medium text-graphite">这一轮还没落定</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ash">
                  当前轮还在跑——本轮落定后这里会出现它的改动。
                </p>
              </>
            ) : (
              <>
                <p className="text-caption font-medium text-graphite">这一轮没有记录到文件改动</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ash">
                  上一轮来源是会话的 file.diff 事件；执行器没报 diff（或确实没改文件）都会是空。
                  工作树档看的是 git 口径，两者可能不同。
                </p>
              </>
            )}
          </div>
        ) : matched.length === 0 ? (
          <p className="px-2 py-3 text-center text-caption text-ash">没有路径包含「{filter.trim()}」的改动</p>
        ) : (
          <section className="overflow-hidden rounded-card border border-line bg-card">
            {matched.map((file) => (
              <LastTurnFileRow key={file.path} rootPath={rootPath} file={file} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** 上一轮的文件行：patch 直接来自事件（无 patch 时如实说，不拿工作树 diff 冒充） */
function LastTurnFileRow({ rootPath, file }: { rootPath: string; file: LastTurnFile }) {
  const [open, setOpen] = useState(false);
  // 兜底存整个 GitDiffResult 而非只存 patch 文本：binary / truncated 信号
  // 丢了会把二进制文件渲染成空白 patch
  const [fallback, setFallback] = useState<GitDiffResult | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const Arrow = open ? ChevronDown : ChevronRight;
  // 事件没带 patch 时兜底拉一次工作树未暂存 diff（口径差异已在展开区说明）。
  // 展开态的取数条件只在行点击时评估，所以重试按钮要自己调它，不能只清错误
  const fetchFallback = (): void => {
    void fetchGitDiff({ rootPath, path: file.path, sourceId: "unstaged" })
      .then((r) => setFallback(r))
      .catch((err: unknown) => setFallbackError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open && file.patch === undefined && fallback === null && fallbackError === null) fetchFallback();
        }}
        className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-line-soft/50"
      >
        <Arrow size={11} className="shrink-0 text-ash" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink" title={file.path}>
          {file.path}
        </span>
        <span className="tnum shrink-0 font-mono text-[10px]">
          {file.additions > 0 && <span className="text-gain">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && <span className="text-ash"> </span>}
          {file.deletions > 0 && <span className="text-loss">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-line-soft bg-rail/40">
          {file.patch !== undefined ? (
            <ChangeDiffView patch={file.patch} binary={false} truncated={false} loading={false} />
          ) : fallback !== null ? (
            <>
              <p className="px-3 pt-1.5 text-[10px] text-ash">事件未带 patch，以下是工作树未暂存口径的兜底：</p>
              <ChangeDiffView
                patch={fallback.patch}
                binary={fallback.binary === true}
                truncated={fallback.truncated === true}
                loading={false}
              />
            </>
          ) : fallbackError !== null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-caption text-loss">
              <span className="min-w-0 flex-1 break-all">兜底拉取失败：{fallbackError}</span>
              <button
                type="button"
                onClick={() => {
                  setFallbackError(null);
                  fetchFallback();
                }}
                className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                重试
              </button>
            </div>
          ) : (
            <p className="px-3 py-2 text-caption text-ash">读取中…</p>
          )}
        </div>
      )}
    </div>
  );
}
