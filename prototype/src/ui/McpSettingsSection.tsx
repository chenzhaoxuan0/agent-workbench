/**
 * 设置页「MCP 服务」分区 —— 分执行器管理各家原生配置里的 MCP 服务。
 *
 * 领域语义（CONTEXT.md「技能与扩展」+ ADR 0004）：
 * - 原生配置文件是唯一真相源：打开页面实时读盘，用户在原生 TUI 里的手改天然被尊重；
 * - 停用 = 条目从原生文件移除并存入停用库（不是镜像，只是留档）；恢复即写回；
 * - 乐观锁：每次变更带读盘时的指纹，盘上被外部改过 → 冲突三选一（覆盖 / 重载 / 取消）；
 * - 跨执行器复制是一次性动作：读源 → 格式转换 → 写目标，此后各家独立演化。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { McpInventory, McpMutationResult, McpServerEntry, McpServerInstance, McpServerRow } from "../core/mcp.ts";
import {
  mcpCopyRpc,
  mcpInventoryRpc,
  mcpReadFileRpc,
  mcpRemoveRpc,
  mcpSaveRpc,
  mcpSetEnabledRpc,
} from "../adapters/daemon/client.ts";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

type LoadStatus = "loading" | "ready" | "error";

interface ConflictState {
  readonly message: string;
  /** 覆盖重试：同一操作但不带指纹（用户已知晓盘上变化，选择以工作台为准） */
  readonly retry: () => Promise<void>;
}

export function McpSettingsSection() {
  const [inv, setInv] = useState<McpInventory | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  /** 拉取错误（load 自管：成功清、失败设；有旧数据时不清屏只挂横幅） */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 操作错误（启停/编辑/删除/复制）——与 loadErr 分离，清单重载不会把它冲掉 */
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("claude");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [lastMutation, setLastMutation] = useState<{ executorId: string; text: string } | null>(null);
  /** 编辑器（新建/编辑）与复制面板互斥展开 */
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; entry: McpServerEntry } | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  /** 请求序号：并发 load 时只有最新一次允许写状态（旧响应后到不得覆盖新数据） */
  const reqSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++reqSeq.current;
    try {
      const data = await mcpInventoryRpc();
      if (seq !== reqSeq.current) return;
      setInv(data);
      setStatus("ready");
      setLoadErr(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // 拉取失败保留旧清单（好过清屏），只在从没成功过时进 error 态
      setStatus((s) => (s === "ready" ? "ready" : "error"));
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const file = inv?.files.find((f) => f.executorId === selected);
  const sha = file?.sha;

  /** 统一变更出口：成功 → 记录落盘预览 + 就地更新指纹 + 重载；conflict → 三选一；其余 → 红条 */
  const runMutation = useCallback(
    (label: string, op: (expectedSha?: string) => Promise<McpMutationResult>): Promise<void> => {
      const attempt = async (withSha: boolean): Promise<void> => {
        try {
          const r = await op(withSha ? sha : undefined);
          setLastMutation({ executorId: selected, text: r.newText });
          setConflict(null);
          setRawText(null); // 原文已过期（刚被改写），别和落盘预览打架
          // 回执的新指纹先就地更新：不等全量重载，紧接着的下一次操作就不会
          // 拿着旧 sha 撞出「自己和自己冲突」
          setInv((prev) =>
            prev === null
              ? prev
              : { ...prev, files: prev.files.map((f) => (f.executorId === selected ? { ...f, sha: r.newSha } : f)) },
          );
          await load();
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "conflict") {
            const name = inv?.files.find((f) => f.executorId === selected)?.executorName ?? selected;
            setConflict({
              message: `${label}（${name}）：${e instanceof Error ? e.message : String(e)}`,
              retry: () => attempt(false),
            });
          } else {
            setErr(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };
      return attempt(true);
    },
    [sha, selected, load, inv],
  );

  const rowsOf = (executorId: string): McpServerRow[] =>
    (inv?.rows ?? []).filter((r) => r.instances.some((i) => i.executorId === executorId));
  const instOf = (row: McpServerRow): McpServerInstance | undefined =>
    row.instances.find((i) => i.executorId === selected);

  const toggle = (name: string, disabled: boolean): void => {
    // enabled 的「下一态」恰是当前 disabled 位：live(disabled=false)点关 → enabled=false 停用；
    // 停用库(disabled=true)点开 → enabled=true 恢复
    void runMutation(disabled ? `恢复 ${name}` : `停用 ${name}`, (s) => mcpSetEnabledRpc(selected, name, disabled, s));
  };

  const purge = (name: string): void => {
    void runMutation(`彻底删除 ${name}`, (s) => mcpRemoveRpc(selected, name, { toVault: false, expectedSha: s }));
  };

  const showRaw = (): void => {
    void (async () => {
      try {
        const r = await mcpReadFileRpc(selected);
        setRawText("missing" in r ? "（配置文件还不存在 —— 添加第一个服务时将创建）" : r.text);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  if (status === "loading") return <p className="text-body-sm text-ash">正在读取各执行器的 MCP 配置…</p>;
  if (inv === null) {
    return (
      <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">
        MCP 清单拉取失败：{loadErr ?? "daemon 未响应"}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        直接读写各执行器自己的配置文件（唯一真相源，原生 TUI 里改的这里也看得到）。
        停用 = 条目移出配置文件并存入停用库，恢复即写回；改对新会话生效，运行中的会话不受影响。
      </p>

      {/* 执行器 tab */}
      <div className="flex flex-wrap items-center gap-1.5">
        {inv.files.map((f) => (
          <button
            key={f.executorId}
            onClick={() => {
              setSelected(f.executorId);
              setEditing(null);
              setCopyOpen(false);
              setRawText(null);
              // 上家的冲突提示/错误/落盘预览不带过来：留着的话「覆盖重试」
              // 的闭包还绑着旧执行器，会在 B 家页面上覆写 A 家的配置文件
              setConflict(null);
              setErr(null);
              setLastMutation(null);
            }}
            className={cn(
              "rounded-chip border px-2.5 py-1 text-body-sm transition",
              f.executorId === selected
                ? "border-teal bg-teal-tint font-medium text-ink"
                : "border-line text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            {f.executorName}
            {f.count !== undefined && <span className="ml-1 tnum text-caption">{f.count}</span>}
          </button>
        ))}
      </div>

      {/* 文件状态行 */}
      {file !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="truncate font-mono text-caption text-ash" title={file.path}>{file.path}</span>
          {!file.exists && <span className="text-caption text-ash">（文件不存在，首次写入时创建）</span>}
          {file.error !== undefined && <span className="text-caption text-loss">{file.error}（修复前写入被拒绝）</span>}
          <button
            onClick={showRaw}
            className="ml-auto rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            查看原文
          </button>
        </div>
      )}

      {/* 工具行 */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setCopyOpen(false);
            setEditing({ mode: "create" });
          }}
          className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas"
        >
          添加服务
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setCopyOpen((v) => !v);
          }}
          className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite transition hover:bg-line-soft hover:text-ink"
        >
          从其他执行器复制…
        </button>
      </div>

      {editing !== null && (
        <EntryEditor
          initial={editing.mode === "edit" ? editing.entry : undefined}
          onCancel={() => setEditing(null)}
          onSubmit={(entry) => {
            const label = editing.mode === "edit" ? `编辑 ${entry.name}` : `添加 ${entry.name}`;
            setEditing(null);
            void runMutation(label, (s) => mcpSaveRpc(selected, entry, s));
          }}
        />
      )}

      {copyOpen && (
        <CopyPanel
          inv={inv}
          targetId={selected}
          expectedSha={sha}
          onDone={async (outcomes) => {
            setCopyOpen(false);
            const fails = outcomes.filter((o) => !o.ok);
            if (fails.length > 0) setErr(`复制部分未完成：${fails.map((f) => `${f.executorId}（${f.error}）`).join("、")}`);
            else setLastMutation(null);
            await load();
          }}
        />
      )}

      {/* 冲突三选一 */}
      {conflict !== null && (
        <div className="rounded-btn border border-loss/40 bg-card px-3 py-2 text-caption leading-relaxed text-loss">
          <p>{conflict.message}</p>
          <div className="mt-1.5 flex gap-2">
            <button
              onClick={() => void conflict.retry()}
              className="rounded-btn bg-ink px-2.5 py-1 text-caption text-canvas"
            >
              覆盖重试
            </button>
            <button
              onClick={() => {
                setConflict(null);
                void load();
              }}
              className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite"
            >
              重载清单
            </button>
            <button onClick={() => setConflict(null)} className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite">
              取消
            </button>
          </div>
        </div>
      )}

      {loadErr !== null && (
        <p className="flex items-center gap-2 rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          <span className="min-w-0 flex-1">清单刷新失败（保留上次内容）：{loadErr}</span>
          <button
            onClick={() => void load()}
            className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            重试
          </button>
        </p>
      )}

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}

      {/* 服务清单 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <ul className="divide-y divide-line-soft">
          {rowsOf(selected).length === 0 && (
            <li className="px-4 py-3 text-caption text-ash">这家还没有 MCP 服务。添加、或从其他执行器复制一份。</li>
          )}
          {rowsOf(selected).map((row) => {
            const inst = instOf(row);
            if (inst === undefined) return null;
            return (
              <McpRow
                key={row.name}
                name={row.name}
                inst={inst}
                onToggle={() => toggle(row.name, inst.disabled)}
                onPurge={() => purge(row.name)}
                onEdit={() => setEditing({ mode: "edit", entry: inst.entry })}
              />
            );
          })}
        </ul>
      </div>

      {/* 原文 / 落盘预览 */}
      {rawText !== null && (
        <details className="rounded-card border border-line bg-card px-4 py-2" open>
          <summary className="cursor-pointer text-caption font-medium text-graphite">配置文件原文</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-btn bg-canvas p-3 font-mono text-caption leading-relaxed text-ink">{rawText}</pre>
        </details>
      )}
      {lastMutation !== null && (
        <details className="rounded-card border border-line bg-card px-4 py-2" open>
          <summary className="cursor-pointer text-caption font-medium text-graphite">
            落盘后的内容（{inv.files.find((f) => f.executorId === lastMutation.executorId)?.executorName ?? lastMutation.executorId}）
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-btn bg-canvas p-3 font-mono text-caption leading-relaxed text-ink">{lastMutation.text}</pre>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 行 */

function McpRow({
  name,
  inst,
  onToggle,
  onPurge,
  onEdit,
}: {
  name: string;
  inst: McpServerInstance;
  onToggle: () => void;
  onPurge: () => void;
  onEdit: () => void;
}) {
  const [confirmPurge, setConfirmPurge] = useState(false);
  useEffect(() => {
    if (!confirmPurge) return;
    const t = setTimeout(() => setConfirmPurge(false), 3000);
    return () => clearTimeout(t);
  }, [confirmPurge]);

  const summary =
    inst.entry.transport === "stdio"
      ? [inst.entry.command, ...(inst.entry.args ?? [])].join(" ")
      : (inst.entry.url ?? "");

  return (
    <li className={cn("flex items-center gap-3 px-4 py-2.5", inst.disabled && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-body-sm", inst.disabled ? "text-graphite" : "text-ink")}>{name}</span>
          <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">{inst.entry.transport}</span>
          {inst.disabled && <span className="shrink-0 text-caption text-ash">停用库</span>}
        </div>
        <p className="truncate font-mono text-caption text-ash" title={summary}>{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Toggle on={!inst.disabled} onChange={onToggle} />
        {!inst.disabled ? (
          <button onClick={onEdit} className="rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink">
            编辑
          </button>
        ) : null}
        <button
          onClick={() => {
            if (confirmPurge) {
              setConfirmPurge(false); // 立即复位：3 秒窗口内连点不得重复触发删除
              onPurge();
            } else {
              setConfirmPurge(true);
            }
          }}
          className={cn(
            "rounded-btn border px-2 py-1 text-caption transition",
            confirmPurge ? "border-loss text-loss" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          {confirmPurge ? "确认删除？" : "彻底删除"}
        </button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------- 编辑器 */

function EntryEditor({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerEntry;
  onSubmit: (entry: McpServerEntry) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpServerEntry["transport"]>(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join(" "));
  const [env, setEnv] = useState(kvToText(initial?.env));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState(kvToText(initial?.headers));
  const [formErr, setFormErr] = useState<string | null>(null);

  const submit = (): void => {
    const n = name.trim();
    if (n === "") { setFormErr("服务名不能为空"); return; }
    // 镜像后端 validateEntry 的名称规则：提前拦下，省一趟 bad_params 往返
    if (n.startsWith(".")) { setFormErr("服务名不能以点开头"); return; }
    if (/[\\/]/.test(n)) { setFormErr("服务名不能包含 / 或 \\"); return; }
    if (transport === "stdio" && command.trim() === "") { setFormErr("stdio 服务必须填 command"); return; }
    if (transport !== "stdio" && url.trim() === "") { setFormErr(`${transport} 服务必须填 url`); return; }
    const parsedEnv = textToKv(env, setFormErr);
    const parsedHeaders = textToKv(headers, setFormErr);
    if (parsedEnv === null || parsedHeaders === null) return;
    onSubmit({
      name: n,
      transport,
      ...(transport === "stdio"
        ? { command: command.trim(), ...(args.trim() !== "" ? { args: args.trim().split(/\s+/) } : {}), ...(parsedEnv !== undefined ? { env: parsedEnv } : {}) }
        : { url: url.trim(), ...(parsedHeaders !== undefined ? { headers: parsedHeaders } : {}) }),
    });
  };

  const input = "h-8 w-full rounded-btn border border-line bg-canvas px-2.5 font-mono text-body-sm text-ink focus:border-teal focus:outline-none";

  return (
    <div className="space-y-2.5 rounded-card border border-line bg-card p-4">
      <p className="text-caption font-medium text-graphite">{initial === undefined ? "添加服务" : `编辑 ${initial.name}`}</p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_128px]">
        <input
          className={input}
          placeholder="服务名（如 web-reader）"
          value={name}
          disabled={initial !== undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={cn(input, "font-sans")}
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpServerEntry["transport"])}
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </div>
      {transport === "stdio" ? (
        <>
          <input className={input} placeholder="command（如 npx —— Windows 下 npx 等会自动包 cmd /c）" value={command} onChange={(e) => setCommand(e.target.value)} />
          <input className={input} placeholder="args（空格分隔，如 -y zread-mcp）" value={args} onChange={(e) => setArgs(e.target.value)} />
          <textarea className={cn(input, "h-16 py-1.5")} placeholder={"env 每行一个 KEY=VALUE"} value={env} onChange={(e) => setEnv(e.target.value)} />
        </>
      ) : (
        <>
          <input className={input} placeholder="url（如 https://open.bigmodel.cn/api/mcp/xxx/mcp）" value={url} onChange={(e) => setUrl(e.target.value)} />
          <textarea className={cn(input, "h-16 py-1.5")} placeholder={"headers 每行一个 KEY=VALUE"} value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </>
      )}
      {formErr !== null && <p className="text-caption text-loss">{formErr}</p>}
      <div className="flex gap-2">
        <button onClick={submit} className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas">保存</button>
        <button onClick={onCancel} className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite">取消</button>
      </div>
    </div>
  );
}

function kvToText(kv: Readonly<Record<string, string>> | undefined): string {
  if (kv === undefined) return "";
  return Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** KEY=VALUE 逐行解析；坏行返回 null 并把错误写进 setErr */
function textToKv(text: string, setErr: (m: string) => void): Record<string, string> | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const out: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      setErr(`这行不是 KEY=VALUE：${line}`);
      return null;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

/* ------------------------------------------------------------- 复制面板 */

function CopyPanel({
  inv,
  targetId,
  expectedSha,
  onDone,
}: {
  inv: McpInventory;
  targetId: string;
  expectedSha?: string;
  onDone: (outcomes: readonly { executorId: string; ok: boolean; error?: string }[]) => Promise<void>;
}) {
  // 源候选是挂载时的快照（inv 刷新后不追新）；count 缺省 = 解析失败的家，排除出复制源是保护
  const sources = inv.files.filter((f) => f.executorId !== targetId && (f.count ?? 0) > 0);
  const [src, setSrc] = useState(sources[0]?.executorId ?? "");
  const srcRows = inv.rows.filter((r) => r.instances.some((i) => i.executorId === src && !i.disabled));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const selectCls = "h-8 w-full rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none";

  useEffect(() => {
    setName("");
  }, [src]);

  return (
    <div className="space-y-2.5 rounded-card border border-line bg-card p-4">
      <p className="text-caption font-medium text-graphite">
        从其他执行器复制到 {inv.files.find((f) => f.executorId === targetId)?.executorName}
        （一次性拷贝，此后两家各自演化；目标已有同名时跳过不覆盖）
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <select className={selectCls} value={src} onChange={(e) => setSrc(e.target.value)}>
          {sources.length === 0 && <option value="">（没有其他家有服务）</option>}
          {sources.map((f) => (
            <option key={f.executorId} value={f.executorId}>{f.executorName}（{f.count} 个）</option>
          ))}
        </select>
        <select className={selectCls} value={name} onChange={(e) => setName(e.target.value)}>
          <option value="">选择服务…</option>
          {srcRows.map((r) => (
            <option key={r.name} value={r.name}>{r.name}</option>
          ))}
        </select>
      </div>
      <button
        disabled={src === "" || name === "" || busy}
        onClick={() => {
          setBusy(true);
          void (async () => {
            // 指纹只在真拿到时才带 —— 空 sha 会被 daemon 当成"必然冲突"
            const expectedShas = expectedSha !== undefined ? { [targetId]: expectedSha } : {};
            const outcomes = await mcpCopyRpc(src, name, [targetId], expectedShas);
            await onDone(outcomes);
          })().finally(() => setBusy(false));
        }}
        className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
      >
        {busy ? "复制中…" : "复制"}
      </button>
    </div>
  );
}
