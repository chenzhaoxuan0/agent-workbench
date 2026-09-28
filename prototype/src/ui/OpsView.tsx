import { useMemo, useState } from "react";
import { ChevronRight, FlaskConical, Play, Swords } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import {
  useOps,
  totalUsage,
  usageByDay,
  usageByProvider,
  type DeterministicCase,
  type GateRun,
  type JudgeMetric,
} from "../store/useOps.ts";
import { visibleModelsFor, useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * Ops 视图 —— LLM-Ops 仪表盘（对齐 waku-agent dashboard 的 Ops 页签：
 * 发布门结论、eval 历史、花费账本、trace 内联）。
 *
 * 与「对话 | 轨迹」并列的第三个会话页签，占据整个会话视口；它不是会话的
 * 另一种读法，所以不渲染 composer / 权限卡。与轨迹的关系是轻叠加：
 * 右上「打开轨迹」跳回轨迹页签看原始 trace（waku 的"raw traces inline"）。
 *
 * waku 的两条铁律在版面上显式呈现：
 * - 两类 eval 分开两张卡：确定性（0/1，无模型裁判）vs judge（0–1 过阈值）；
 * - 花费账本是追加只写的（usage.jsonl 语义），页脚标注存储键名。
 */

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

const fmtCost = (usd: number) => `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function OpsView() {
  const setConversationView = useShell((s) => s.setConversationView);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏：定位说明 + 轨迹直连（waku：raw traces inline） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-2">
        <p className="text-caption text-graphite">
          Eval 与 LLM 可观测 —— 两类 eval 分开计分，花费账本追加只写
        </p>
        <button
          onClick={() => setConversationView("trajectory")}
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          打开轨迹
          <ChevronRight size={11} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-[980px] space-y-5">
          <GateCard />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <DeterministicCard />
            <JudgeCard />
          </div>
          <ArenaCard />
          <GateHistoryCard />
          <SpendCard />
          <p className="pb-2 text-center text-[10px] text-ash">
            追加只写账本 · localStorage 键 <code className="font-mono">agent-workbench:ops</code>（eval_runs / compare/history / usage.jsonl 语义）
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 发布门 */

function GateCard() {
  const cases = useOps((s) => s.cases);
  const metrics = useOps((s) => s.metrics);
  const history = useOps((s) => s.gateHistory);
  const running = useOps((s) => s.gateRunning);
  const runGate = useOps((s) => s.runGate);

  const latest: GateRun | undefined = history.at(-1);
  const detDone = cases.filter((c) => c.lastResult).length;
  const judgeDone = metrics.filter((m) => m.lastScore !== undefined).length;

  return (
    <section className="rounded-card border border-line bg-canvas">
      <div className="flex items-center gap-3 px-4 py-3">
        {latest ? (
          <>
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                running ? "animate-pulse bg-teal" : latest.verdict === "pass" ? "bg-gain" : "bg-loss",
              )}
            />
            <div className="min-w-0">
              <p className={cn("text-body-sm font-medium", running ? "text-ink" : latest.verdict === "pass" ? "text-gain" : "text-loss")}>
                {running ? "发布门运行中…" : latest.verdict === "pass" ? "发布门 PASS" : "发布门 FAIL"}
              </p>
              <p className="truncate text-caption text-ash">
                {fmtTime(latest.ts)} · 确定性 {latest.detPassed}/{latest.detTotal} · judge 均分 {latest.judgeAvg.toFixed(2)}
                {latest.failReason ? ` · ${latest.failReason}` : ""}
              </p>
            </div>
          </>
        ) : (
          <p className="text-body-sm text-graphite">还没有跑过发布门 —— 确定性 100% 且 judge 全过阈值才算 PASS</p>
        )}
        <button
          onClick={runGate}
          disabled={running}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas",
            running ? "cursor-wait opacity-60" : "hover:bg-graphite",
          )}
        >
          <Play size={11} />
          运行 gate
        </button>
      </div>
      {running && (
        <div className="border-t border-line-soft px-4 py-2">
          <p className="text-caption text-graphite">
            确定性 {detDone}/{cases.length} · judge {judgeDone}/{metrics.length}
            <span className="ml-2 text-ash">judge 每个指标是一次真实的 LLM 调用</span>
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line-soft">
            <div
              className="h-full bg-teal transition-all duration-300"
              style={{ width: `${((detDone + judgeDone) / (cases.length + metrics.length)) * 100}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------- 两类 eval（永不混合） */

function DeterministicCard() {
  const cases = useOps((s) => s.cases);
  return (
    <section className="rounded-card border border-line bg-canvas">
      <CardHead
        icon={<FlaskConical size={12} />}
        title="确定性 eval"
        rule="0 或 1 · 无模型裁判"
        sub="make eval —— 期望的工具触发了吗"
      />
      <div className="border-t border-line-soft">
        {cases.map((c) => (
          <CaseRow key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}

function CaseRow({ c }: { c: DeterministicCase }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line-soft px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "tnum shrink-0 rounded-chip px-1.5 py-px text-[10px] leading-4",
          c.lastResult === "pass" && "bg-gain/10 text-gain",
          c.lastResult === "fail" && "bg-loss/10 text-loss",
          !c.lastResult && "bg-line-soft text-ash",
        )}
      >
        {c.lastResult === "pass" ? "1" : c.lastResult === "fail" ? "0" : "—"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-caption text-ink">{c.input}</p>
        <p className="truncate text-[10px] text-ash">
          <code className="font-mono">{c.id}</code> · 期望：{c.expectTool ? <code className="font-mono">{c.expectTool}</code> : "不调用工具"}
          {Object.entries(c.expectInArgs).map(([k, v]) => (
            <span key={k}>
              {" "}
              · <code className="font-mono">{k}</code>~"{v}"
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

function JudgeCard() {
  const metrics = useOps((s) => s.metrics);
  return (
    <section className="rounded-card border border-line bg-canvas">
      <CardHead icon={<span className="text-[11px] font-serif italic">g</span>} title="LLM-as-judge" rule="0–1 打分 · 过阈值" sub="回复有帮助吗 —— 每次评分是一次 LLM 调用" />
      <div className="space-y-4 border-t border-line-soft px-4 py-3">
        {metrics.map((m) => (
          <MetricBlock key={m.id} m={m} />
        ))}
        <p className="text-[10px] leading-relaxed text-ash">
          真实环境用 DeepEval GEval（evals/judge/）；需要供应商 API key，缺 key 时整层跳过而不是计 0 分。
        </p>
      </div>
    </section>
  );
}

function MetricBlock({ m }: { m: JudgeMetric }) {
  const score = m.lastScore;
  const ok = score !== undefined && score >= m.threshold;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <p className="text-caption font-medium text-ink">{m.name}</p>
        <span className="rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite">阈值 {m.threshold.toFixed(2)}</span>
        <span className={cn("tnum ml-auto text-caption font-medium", score === undefined ? "text-ash" : ok ? "text-gain" : "text-loss")}>
          {score === undefined ? "—" : score.toFixed(2)}
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-line-soft">
        <div
          className={cn("h-full transition-all duration-500", ok ? "bg-teal" : score === undefined ? "bg-transparent" : "bg-loss")}
          style={{ width: score === undefined ? 0 : `${score * 100}%` }}
        />
        {/* 阈值刻度线 */}
        <span className="absolute inset-y-0 w-px bg-ink/50" style={{ left: `${m.threshold * 100}%` }} />
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {m.steps.map((s, i) => (
          <li key={i} className="text-[10px] leading-relaxed text-ash">
            {i + 1}. {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------- Arena */

function ArenaCard() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const runtimePrefs = useWorkbench((s) => s.runtimePrefs);
  const runtimeModels = useWorkbench((s) => s.runtimeModels);
  const history = useOps((s) => s.arenaHistory);
  const running = useOps((s) => s.arenaRunning);
  const runArena = useOps((s) => s.runArena);

  const [prompt, setPrompt] = useState("帮我整理这周的记忆并安排下周一的回顾会");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(runtimes.map((r) => r.id)));

  // 选手 = 启用中的执行器 × 它当前选中的模型（真实环境：各自的 throwaway home 沙箱）
  const candidates = useMemo(
    () =>
      runtimes
        .filter((r) => runtimePrefs[r.id]?.enabled !== false)
        .map((r) => {
          const modelId = runtimeModels[r.id] ?? r.defaultModel;
          const model = visibleModelsFor(useWorkbench.getState(), r.id).find((m) => m.id === modelId);
          return {
            runtimeId: r.id,
            runtimeLabel: r.presentation.displayName,
            modelId,
            modelLabel: model?.displayName ?? modelId,
            accent: r.presentation.accent,
            glyph: r.presentation.glyph,
          };
        }),
    [runtimes, runtimePrefs, runtimeModels],
  );

  const latest = history.at(-1);
  const togglePick = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const done = latest ? latest.contestants.length : 0;
  const pickedCount = candidates.filter((c) => picked.has(c.runtimeId)).length;

  return (
    <section className="rounded-card border border-line bg-canvas">
      <CardHead icon={<Swords size={12} />} title="Arena" rule="同一 prompt · N 个模型" sub="每个选手跑同一条真实链路（沙箱隔离），Completion / Quality 双分分开记" />
      <div className="space-y-3 border-t border-line-soft px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Arena 比赛用 prompt"
            placeholder="给所有选手的同一道题…"
            className="min-w-0 flex-1 rounded-input border border-line bg-rail px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-ash focus:border-teal-edge"
          />
          <button
            onClick={() => runArena(prompt.trim(), candidates.filter((c) => picked.has(c.runtimeId)))}
            disabled={running || pickedCount === 0 || !prompt.trim()}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas",
              running || pickedCount === 0 || !prompt.trim() ? "cursor-not-allowed opacity-50" : "hover:bg-graphite",
            )}
          >
            <Play size={11} />
            {running ? `比赛中 ${done}/${pickedCount}` : `开赛（${pickedCount}）`}
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {candidates.map((c) => {
            const on = picked.has(c.runtimeId);
            return (
              <button
                key={c.runtimeId}
                onClick={() => togglePick(c.runtimeId)}
                aria-pressed={on}
                className={cn(
                  "flex items-center gap-1.5 rounded-chip border px-2 py-1 text-caption",
                  on ? "border-teal-edge bg-teal-tint text-ink" : "border-line text-graphite hover:bg-line-soft",
                )}
              >
                <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] text-[9px] text-canvas" style={{ background: c.accent }}>
                  {c.glyph}
                </span>
                {c.runtimeLabel}
                <span className="text-ash">· {c.modelLabel}</span>
              </button>
            );
          })}
        </div>

        {/* 记分板（compare/history.jsonl 语义：一场一行） */}
        {latest && (
          <div className="overflow-hidden rounded-btn border border-line-soft">
            <div className="flex items-baseline gap-2 border-b border-line-soft bg-rail px-3 py-1.5">
              <span className="shrink-0 text-[10px] text-ash">{fmtTime(latest.ts)}</span>
              <p className="min-w-0 flex-1 truncate text-caption text-graphite">“{latest.prompt}”</p>
            </div>
            {latest.contestants.map((row) => (
              <div key={row.runtimeId} className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5 last:border-b-0">
                <span className="w-36 shrink-0 truncate text-caption text-ink">{row.modelLabel}</span>
                <span className="shrink-0 text-[10px] text-ash">Completion</span>
                <span
                  className={cn(
                    "shrink-0 rounded-chip px-1.5 py-px text-[10px] leading-4",
                    row.completion === "pass" ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss",
                  )}
                >
                  {row.completion === "pass" ? "PASS" : "FAIL"}
                </span>
                <span className="shrink-0 text-[10px] text-ash">Quality</span>
                <span className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-line-soft">
                  <span
                    className={cn("block h-full", row.quality >= 0.6 ? "bg-teal" : "bg-loss")}
                    style={{ width: `${row.quality * 100}%` }}
                  />
                </span>
                <span className="tnum shrink-0 text-caption text-graphite">{row.quality.toFixed(2)}</span>
                <span className="tnum ml-auto shrink-0 text-[10px] text-ash">
                  {(row.latencyMs / 1000).toFixed(1)}s · {fmtTokens(row.tokensOut)} tok
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------- gate 历史 + 花费 */

function GateHistoryCard() {
  const history = useOps((s) => s.gateHistory);
  return (
    <section className="rounded-card border border-line bg-canvas">
      <CardHead icon={<span className="text-[11px]">☰</span>} title="eval 历史" rule={`${history.length} 次 gate`} sub="追加只写 —— 一行一次发布门，FAIL 的原因随行保存" />
      <div className="max-h-56 overflow-y-auto border-t border-line-soft">
        {[...history].reverse().map((r, i) => (
          <div key={`${r.ts}-${i}`} className="flex items-baseline gap-3 border-b border-line-soft px-4 py-1.5 last:border-b-0">
            <span className="tnum w-24 shrink-0 text-[10px] text-ash">{fmtTime(r.ts)}</span>
            <span className="tnum w-16 shrink-0 text-caption text-graphite">
              {r.detPassed}/{r.detTotal}
            </span>
            <span className="tnum w-14 shrink-0 text-caption text-graphite">{r.judgeAvg.toFixed(2)}</span>
            <span
              className={cn(
                "shrink-0 rounded-chip px-1.5 py-px text-[10px] leading-4",
                r.verdict === "pass" ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss",
              )}
            >
              {r.verdict === "pass" ? "PASS" : "FAIL"}
            </span>
            {r.failReason && <span className="min-w-0 flex-1 truncate text-[10px] text-ash">{r.failReason}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function SpendCard() {
  const usage = useOps((s) => s.usage);
  const totals = useMemo(() => totalUsage(usage), [usage]);
  const byDay = useMemo(() => usageByDay(usage), [usage]);
  const byProvider = useMemo(() => usageByProvider(usage), [usage]);
  const maxDay = Math.max(...byDay.map((d) => d.costUsd), 1e-4);

  return (
    <section className="rounded-card border border-line bg-canvas">
      <CardHead icon={<span className="text-[11px] font-mono">$</span>} title="花费账本" rule={`${totals.calls} 次调用`} sub="usage.jsonl 语义 —— 每次 LLM 调用追加一行，重置演示不会清掉；美元由 token 估算" />
      <div className="space-y-4 border-t border-line-soft px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <p className="text-body-sm font-medium text-ink">
            累计 <span className="tnum">{fmtCost(totals.costUsd)}</span>
          </p>
          <p className="tnum text-caption text-graphite">入 {fmtTokens(totals.tokensIn)} tok</p>
          <p className="tnum text-caption text-graphite">出 {fmtTokens(totals.tokensOut)} tok</p>
        </div>

        {/* 近 14 天成本柱状 */}
        <div className="flex h-16 items-end gap-1">
          {byDay.map((d) => (
            <div key={d.day} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.day} · ${fmtCost(d.costUsd)}`}>
              <div
                className={cn("w-full rounded-t-[2px] transition-all", d.costUsd > 0 ? "bg-teal/70 group-hover:bg-teal" : "bg-line-soft")}
                style={{ height: `${Math.max((d.costUsd / maxDay) * 100, 2)}%` }}
              />
            </div>
          ))}
        </div>
        <p className="text-[10px] text-ash">
          {byDay[0]?.day} → {byDay.at(-1)?.day} · 每日成本（悬停看数值）
        </p>

        {/* 按供应商 */}
        <div className="overflow-hidden rounded-btn border border-line-soft">
          {byProvider.map((p) => (
            <div key={p.provider} className="flex items-baseline gap-3 border-b border-line-soft px-3 py-1.5 last:border-b-0">
              <span className="w-24 shrink-0 truncate text-caption text-ink">{p.provider}</span>
              <span className="tnum w-14 shrink-0 text-[10px] text-ash">{p.calls} 次</span>
              <span className="tnum w-28 shrink-0 text-[10px] text-ash">
                {fmtTokens(p.tokensIn)} / {fmtTokens(p.tokensOut)} tok
              </span>
              <span className="tnum ml-auto shrink-0 text-caption text-graphite">{fmtCost(p.costUsd)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- 小件 */

function CardHead({ icon, title, rule, sub }: { icon: React.ReactNode; title: string; rule: string; sub: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-btn bg-line-soft text-graphite">{icon}</span>
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-ink">
          {title}
          <span className="ml-2 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] font-normal text-teal">{rule}</span>
        </p>
        <p className="truncate text-[10px] text-ash">{sub}</p>
      </div>
    </div>
  );
}
