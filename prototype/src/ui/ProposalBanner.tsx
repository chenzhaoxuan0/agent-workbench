import { useEffect, useMemo, useState } from "react";
import { AlarmClockCheck, ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import { formatBacklogRelative } from "../core/backlog.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { cn } from "./cn.ts";

/**
 * 待办提议横幅 —— 确认门的载体（共识 Q5/Q11/Q17）。
 *
 * - 跨主视图常驻（WorkspaceShell 挂载），直到确认/拒绝/超时（settled 信号即收起）。
 * - 必须展示将执行的 prompt 全文（盲签不是确认）+ 各订阅执行器余量表。
 * - 用户可在弹窗里直接改选执行器（选零余量/未知的给黄牌警告但放行），选择记忆回待办。
 */

export function ProposalBanner() {
  const proposal = useBacklog((s) => s.proposal);
  const items = useBacklog((s) => s.items);
  const confirm = useBacklog((s) => s.confirmProposal);
  const reject = useBacklog((s) => s.rejectProposal);
  const runtimes = useWorkbench((s) => s.runtimes);

  // 本地选择态：进一条新提议时重置（默认心跳建议 → 待办记忆 → 第一个执行器）
  const [runtimeBare, setRuntimeBare] = useState("");
  const [model, setModel] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const item = useMemo(() => items.find((i) => i.id === proposal?.itemId), [items, proposal]);

  useEffect(() => {
    if (proposal === null) return;
    const preferred = item?.runtimeId ?? proposal.suggestedRuntimeId ?? runtimes[0]?.id.replace(/^daemon:/, "") ?? "";
    setRuntimeBare(preferred);
    setModel(item?.model ?? "");
    setPromptOpen(false);
    // 只在换提议时重置选择（item/runtimes 变化不重置用户已选的执行器）
  }, [proposal?.id]);

  // 倒计时：每秒刷新一次剩余时间展示
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (proposal === null) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [proposal]);

  if (proposal === null) return null;

  const namespaced = runtimeBare === "" ? "" : `daemon:${runtimeBare}`;
  const quota = proposal.quotas.find((q) => q.runtimeId === runtimeBare) ?? null;

  const onConfirm = (): void => {
    if (busy) return;
    setBusy(true);
    void confirm({ ...(runtimeBare === "" ? {} : { runtimeId: runtimeBare }), ...(model === "" ? { model: null } : { model }) })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const onReject = (): void => {
    if (busy) return;
    setBusy(true);
    void reject().finally(() => setBusy(false));
  };

  return (
    <div
      role="alertdialog"
      aria-label="待办启动提议"
      className="fixed bottom-4 right-4 z-50 w-[420px] max-w-[94vw] overflow-hidden rounded-card border border-teal/40 bg-card shadow-2xl"
    >
      {/* 标题带 */}
      <div className="flex items-center gap-2 border-b border-line bg-teal-tint/60 px-3.5 py-2.5">
        <Sparkles size={14} className="shrink-0 text-teal" />
        <p className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">空闲心跳提议：{proposal.title}</p>
        <span className="shrink-0 rounded-chip bg-canvas/70 px-1.5 py-0.5 font-mono text-[10px] text-graphite tnum">
          {formatBacklogRelative(proposal.expiresAt)}
        </span>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-3.5 py-3">
        {/* 心跳 agent 的话 */}
        <p className="text-body-sm leading-relaxed text-ink">{proposal.message}</p>
        {proposal.estimate !== null && (
          <p className="mt-1 text-caption leading-relaxed text-graphite">余量预估：{proposal.estimate}</p>
        )}

        {/* 余量表 */}
        {proposal.quotas.length > 0 && (
          <div className="mt-2.5 space-y-1">
            {proposal.quotas.map((q) => (
              <div key={q.runtimeId} className="flex items-center gap-2 text-caption">
                <button
                  onClick={() => setRuntimeBare(q.runtimeId)}
                  className={cn(
                    "w-16 shrink-0 rounded-chip px-1.5 py-0.5 text-left font-mono transition",
                    runtimeBare === q.runtimeId ? "bg-teal-tint font-medium text-teal" : "text-graphite hover:bg-line-soft",
                  )}
                  title={`选用 ${q.runtimeId}`}
                >
                  {q.runtimeId}
                </button>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line-soft">
                  {q.percent !== null && (
                    <div
                      className={cn("h-full rounded-full", q.percent > 30 ? "bg-gain" : q.percent > 0 ? "bg-amber-500" : "bg-loss")}
                      style={{ width: `${Math.min(100, Math.max(2, q.percent))}%` }}
                    />
                  )}
                </div>
                <span className={cn("tnum shrink-0", q.percent === null ? "text-ash" : q.percent > 30 ? "text-gain" : "text-loss")}>
                  {q.percent !== null ? `${q.percent}%` : "未知"}
                </span>
                {q.resetsAt !== null && (
                  <span className="shrink-0 text-ash" title={q.summary ?? undefined}>
                    {formatBacklogRelative(q.resetsAt)}
                  </span>
                )}
              </div>
            ))}
            <p className="text-[10px] text-ash">余量来自配额探针实时读数；账本估算口径仅含本工作台会话</p>
          </div>
        )}

        {/* 执行器/模型选择 */}
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <select
            value={runtimeBare}
            onChange={(e) => {
              setRuntimeBare(e.target.value);
              setModel("");
            }}
            className={inputCls}
            aria-label="执行器"
          >
            {runtimes.map((r) => (
              <option key={r.id} value={r.id.replace(/^daemon:/, "")}>
                {r.presentation.displayName}
              </option>
            ))}
            {runtimes.length === 0 && <option value="">（无可用执行器）</option>}
          </select>
          <ModelSelect
            runtimeId={namespaced}
            value={model}
            onChange={setModel}
            className={inputCls}
            ariaLabel="模型"
          />
        </div>
        {quota !== null && quota.percent !== null && quota.percent <= 10 && (
          <p className="mt-1.5 rounded-btn bg-amber-500/10 px-2 py-1.5 text-caption text-amber-600">
            注意：{quota.runtimeId} 当前窗口余量仅 {quota.percent}% —— 可以跑，但可能跑不完就撞额度（执行器会自动停）。
          </p>
        )}

        {/* prompt 全文（默认折叠，展开才算「看过」） */}
        <button
          onClick={() => setPromptOpen((v) => !v)}
          className="mt-2.5 flex w-full items-center gap-1 rounded-btn bg-rail px-2 py-1.5 text-caption text-graphite hover:bg-line-soft"
        >
          {promptOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <span>将执行的内容（{proposal.prompt.length} 字）</span>
        </button>
        {promptOpen && (
          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-btn bg-rail px-2.5 py-2 text-caption leading-relaxed text-graphite">
            {proposal.prompt}
          </pre>
        )}
        {item != null && item.goal !== proposal.prompt && (
          <p className="mt-1.5 text-caption leading-relaxed text-ash">目标：{item.goal}</p>
        )}
      </div>

      {/* 动作带 */}
      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
        <button
          onClick={onReject}
          disabled={busy}
          className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-40"
        >
          <X size={12} />
          拒绝（休眠）
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || runtimeBare === ""}
          className="ml-auto flex items-center gap-1.5 rounded-btn bg-teal px-3.5 py-1.5 text-body-sm font-medium text-canvas hover:opacity-90 active:scale-95 transition disabled:opacity-40"
        >
          <AlarmClockCheck size={13} />
          {busy ? "派发中…" : "确认启动"}
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal";
