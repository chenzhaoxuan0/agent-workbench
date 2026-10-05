import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { formatContext, formatPrice, modelById, type ModelSpec } from "../core/models.ts";
import {
  addCustomModel,
  MAX_CUSTOM_MODEL_SLUG_LENGTH,
  moveModel,
  nextHiddenForBulkToggle,
  prefsOf,
  removeCustomModel,
  resolveVisibleModels,
  toggleFavorite,
  toggleHidden,
  updateCustomModel,
  type ModelPrefError,
  type ProviderModelPrefs,
} from "../core/modelPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 每个 CLI 的模型管理 —— 对齐 T3code 的 `ProviderModelsSection`。
 *
 * 交互照抄它那套，因为这套已经被验证过：
 *   收藏（★）· 上移下移 · 显示/隐藏开关 · 一键全藏全显 · 自定义模型增删改 · 过滤
 *
 * 三条从 T3code 抄来且我认为必须保留的语义：
 *
 * 1. **自定义模型不能被隐藏**。用户亲手加的东西不会自己把它藏掉
 *    （T3code 的 switch 对 isCustom 是 disabled）。
 * 2. **删除要连带清理引用**。删掉一个自定义模型时，把它从排序表和收藏里
 *    一并摘掉 —— 留着悬空引用，排序表会永远占着一个不存在的槽位。
 * 3. **排序只在组内交换**。收藏项与普通项各自成段，上移一项不会把它挪进另一段。
 */
export function ModelSettingsSection() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const [activeId, setActiveId] = useState<string | null>(null);

  const runtime = runtimes.find((r) => r.id === activeId) ?? runtimes[0];
  if (!runtime) return <p className="text-body-sm text-ash">没有已注册的 CLI</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {runtimes.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveId(r.id)}
            aria-current={r.id === runtime.id}
            className={cn(
              "flex items-center gap-1.5 rounded-btn px-2 py-1 text-body-sm",
              r.id === runtime.id ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-caption leading-none font-medium text-white"
              style={{ background: r.presentation.accent }}
              aria-hidden
            >
              {r.presentation.glyph}
            </span>
            {r.presentation.displayName}
          </button>
        ))}
      </div>

      <ProviderModelPanel runtimeId={runtime.id} displayName={runtime.presentation.displayName} />
    </div>
  );
}

export function ProviderModelPanel({ runtimeId, displayName }: { runtimeId: string; displayName: string }) {
  const declared = useWorkbench((s) => s.runtimes.find((r) => r.id === runtimeId)?.models ?? EMPTY_SPECS);
  const prefs = useWorkbench((s) => prefsOf(s.modelPrefs, runtimeId));
  const apply = useWorkbench((s) => s.applyModelPrefs);

  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // 多行草稿 —— 对齐 dsh CustomProviderCard 的 models 数组形态：一次可连加多个
  const [drafts, setDrafts] = useState<DraftRow[]>([emptyDraft(nextDraftKey())]);
  const [draftErrors, setDraftErrors] = useState<Record<number, string>>({});

  const visible = useMemo(() => resolveVisibleModels(declared, prefs, { groupFavorites: true }), [declared, prefs]);
  const hiddenSet = useMemo(() => new Set<string>(prefs.hiddenModels), [prefs.hiddenModels]);
  const favSet = useMemo(() => new Set<string>(prefs.favoriteModels), [prefs.favoriteModels]);
  const customSet = useMemo(() => new Set<string>(prefs.customModels.map((c) => c.slug)), [prefs.customModels]);

  const shown = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    return q
      ? visible.filter((m) => `${m.displayName} ${m.id} ${m.vendorLabel}`.toLocaleLowerCase().includes(q))
      : visible;
  }, [visible, filter]);

  const hiddenDeclared = declared.filter((m) => hiddenSet.has(m.id));
  const isFavoriteGroup = (id: string) => favSet.has(id as never);

  // T3 的 groupModelsForDisplay：收藏 → 全部 → 已隐藏 三组，组标题只做展示
  const matchesFilter = (m: ModelSpec) => {
    const q = filter.trim().toLocaleLowerCase();
    return !q || `${m.displayName} ${m.id} ${m.vendorLabel}`.toLocaleLowerCase().includes(q);
  };
  const favShown = shown.filter((m) => isFavoriteGroup(m.id));
  const plainShown = shown.filter((m) => !isFavoriteGroup(m.id));
  const hiddenShown = hiddenDeclared.filter(matchesFilter);

  // 配置预览 —— 展示成 pi models.json 的 providers 形态（dsh 同源），
  // 强化「加模型 = 往配置里写一条」的直觉；仅作预览，实际写入走 store。
  const draftsJson = useMemo(
    () =>
      JSON.stringify(
        {
          providers: {
            [runtimeId]: {
              models: drafts
                .filter((r) => r.id.trim().length > 0)
                .map((r) => ({
                  id: r.id.trim(),
                  ...(r.name.trim() ? { name: r.name.trim() } : {}),
                  ...(parseCapacity(r.ctx) ? { contextWindow: parseCapacity(r.ctx) } : {}),
                })),
            },
          },
        },
        null,
        2,
      ),
    [drafts, runtimeId],
  );

  const submitDrafts = () => {
    const declaredIds = new Set<string>(declared.map((m) => m.id));
    const existing = new Set<string>(prefs.customModels.map((c) => c.slug));
    const errors: Record<number, string> = {};
    const valid: DraftRow[] = [];
    const seen = new Set<string>();
    for (const r of drafts) {
      const id = r.id.trim();
      if (id.length === 0) {
        errors[r.key] = "模型 id 不能为空";
        continue;
      }
      if (declaredIds.has(id) || existing.has(id) || seen.has(id)) {
        errors[r.key] = `${id} 已存在（内置或已添加）`;
        continue;
      }
      const ctx = r.ctx.trim() ? parseCapacity(r.ctx) : 0;
      if (r.ctx.trim() && ctx === undefined) {
        errors[r.key] = "窗口格式非法（支持 256K / 1M 速记）";
        continue;
      }
      seen.add(id);
      valid.push(r);
    }
    if (valid.length === 0) {
      setDraftErrors(errors);
      return;
    }
    apply(
      runtimeId,
      valid.map((r) => (p: ProviderModelPrefs) => {
        const res = addCustomModel(p, r.id.trim());
        if (!res.ok) return p;
        return updateCustomModel(res.prefs, r.id.trim() as never, {
          name: r.name.trim() || undefined,
          contextWindow: parseCapacity(r.ctx) ?? undefined,
          inputPerMTok: numOrUndef(r.priceIn),
          outputPerMTok: numOrUndef(r.priceOut),
        });
      }),
    );
    const failedKeys = Object.keys(errors).map(Number);
    setDraftErrors(errors);
    setDrafts(failedKeys.length > 0 ? drafts.filter((r) => failedKeys.includes(r.key)) : [emptyDraft(nextDraftKey())]);
  };

  const renderRow = (m: ModelSpec, group: "fav" | "all" | "hidden", groupRows: readonly ModelSpec[], index: number) => {
    const isCustom = customSet.has(m.id);
    const fav = favSet.has(m.id);
    const prev = groupRows[index - 1];
    const next = groupRows[index + 1];
    const canUp = Boolean(prev) && isFavoriteGroup(m.id) === isFavoriteGroup(prev!.id);
    const canDown = Boolean(next) && isFavoriteGroup(m.id) === isFavoriteGroup(next!.id);

    return (
      <li key={m.id} className="flex items-center gap-2 rounded-btn px-2 py-1.5 hover:bg-line-soft">
        {group !== "hidden" && (
          <button
            onClick={() => apply(runtimeId, [(p) => toggleFavorite(p, m.id)])}
            aria-label={fav ? `取消收藏 ${m.displayName}` : `收藏 ${m.displayName}`}
            title={fav ? "取消收藏" : "收藏（置顶显示）"}
            className={cn("shrink-0 rounded p-0.5", fav ? "text-teal" : "text-ash hover:text-ink")}
          >
            <Star size={12} fill={fav ? "currentColor" : "none"} />
          </button>
        )}

        <span className="min-w-0 flex-1">
          {editing === m.id ? (
            <EditRow
              spec={m}
              onCancel={() => setEditing(null)}
              onSave={(patch) => {
                apply(runtimeId, [(p) => updateCustomModel(p, m.id as never, patch)]);
                setEditing(null);
              }}
            />
          ) : (
            <>
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className={cn("truncate text-body-sm font-medium", group === "hidden" ? "text-graphite line-through opacity-75" : "text-ink")}>
                  {m.displayName}
                </span>
                {m.contextWindow > 0 && (
                  <span className="shrink-0 rounded-chip border border-line bg-canvas px-1.5 py-px font-mono text-[10px] text-teal font-medium">
                    {formatContext(m.contextWindow)}
                  </span>
                )}
                {m.reasoningLevels && m.reasoningLevels.length > 0 && (
                  <span className="shrink-0 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal font-medium">
                    推理
                  </span>
                )}
                {m.multimodal && (
                  <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite font-medium">
                    视觉
                  </span>
                )}
                {isCustom && <span className="shrink-0 text-caption text-teal">自定义</span>}
                {m.source === "custom" && !isCustom && (
                  <span className="shrink-0 text-caption text-ash">未核实</span>
                )}
              </span>
              <span className="tnum mt-0.5 block truncate font-mono text-caption text-ash">
                {m.inputPerMTok > 0
                  ? `${formatPrice(m.inputPerMTok)}/${formatPrice(m.outputPerMTok)}`
                  : "订阅内含 / CLI 托管"} · {m.vendorLabel}
              </span>
            </>
          )}
        </span>

        {editing !== m.id && (
          <span className="flex shrink-0 items-center gap-0.5">
            {group !== "hidden" && (
              <>
                <IconBtn
                  label={`上移 ${m.displayName}`}
                  disabled={!canUp}
                  onClick={() => apply(runtimeId, [(p) => moveModel(p, m.id, -1, (id) => favSet.has(id))])}
                >
                  <ArrowUp size={12} />
                </IconBtn>
                <IconBtn
                  label={`下移 ${m.displayName}`}
                  disabled={!canDown}
                  onClick={() => apply(runtimeId, [(p) => moveModel(p, m.id, 1, (id) => favSet.has(id))])}
                >
                  <ArrowDown size={12} />
                </IconBtn>
              </>
            )}
            {isCustom ? (
              group !== "hidden" && (
                <>
                  <IconBtn label={`编辑 ${m.displayName}`} onClick={() => setEditing(m.id)}>
                    <Check size={12} />
                  </IconBtn>
                  <IconBtn
                    label={`删除 ${m.displayName}`}
                    onClick={() => apply(runtimeId, [(p) => removeCustomModel(p, m.id as never)])}
                  >
                    <Trash2 size={12} />
                  </IconBtn>
                </>
              )
            ) : (
              // 内置模型不能删，只能藏/显 —— 目录是我们维护的事实
              <button
                onClick={() => apply(runtimeId, [(p) => toggleHidden(p, m.id)])}
                title={hiddenSet.has(m.id) ? "重新在选择器中显示" : "从选择器中隐藏"}
                aria-label={hiddenSet.has(m.id) ? `显示 ${m.displayName}` : `隐藏 ${m.displayName}`}
                className={cn(
                  "rounded px-2 py-0.5 text-caption font-medium transition",
                  hiddenSet.has(m.id)
                    ? "bg-teal-tint text-teal hover:bg-teal/20"
                    : "text-ash hover:bg-line hover:text-ink",
                )}
              >
                {hiddenSet.has(m.id) ? "恢复显示" : "隐藏"}
              </button>
            )}
          </span>
        )}
      </li>
    );
  };

  const GroupTitle = ({ children, n }: { children: React.ReactNode; n: number }) => (
    <p className="px-2 pb-0.5 pt-2 text-[11px] text-ash">
      {children} · {n}
    </p>
  );

  return (
    <div className="rounded-card border border-line bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <p className="tnum text-body-sm text-ink">
          {visible.length} 模型 · {prefs.favoriteModels.length} 收藏 · {hiddenDeclared.length} 隐藏
        </p>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤模型"
          aria-label="过滤模型"
          className="ml-auto w-40 rounded-input bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash"
        />
        <button
          onClick={() => apply(runtimeId, [(p) => nextHiddenForBulkToggle(declared, p)])}
          className="rounded-btn px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          {hiddenDeclared.length === declared.length ? "全部显示" : "全部隐藏"}
        </button>
      </div>

      {/* 三组列表：收藏 → 全部 → 已隐藏（T3 的 groupModelsForDisplay） */}
      <ul className="px-2 pb-1.5 pt-1">
        {favShown.length === 0 && plainShown.length === 0 && hiddenShown.length === 0 && (
          <li className="px-2 py-3 text-body-sm text-ash">
            {filter ? "没有匹配的模型" : "这个 CLI 一个可选模型都没有了 —— 至少要留一个"}
          </li>
        )}
        {favShown.length > 0 && (
          <>
            <GroupTitle n={favShown.length}>收藏</GroupTitle>
            {favShown.map((m, i) => renderRow(m, "fav", favShown, i))}
          </>
        )}
        {plainShown.length > 0 && (
          <>
            <GroupTitle n={plainShown.length}>全部</GroupTitle>
            {plainShown.map((m, i) => renderRow(m, "all", plainShown, i))}
          </>
        )}
        {hiddenShown.length > 0 && (
          <>
            <GroupTitle n={hiddenShown.length}>已隐藏 · 不在选择器中出现</GroupTitle>
            {hiddenShown.map((m, i) => renderRow(m, "hidden", hiddenShown, i))}
          </>
        )}
      </ul>

      {/* 添加自定义模型 —— dsh CustomProviderCard 的多行形态 + pi models.json 配置预览 */}
      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-caption text-ash">
            添加这个 CLI 认、内置目录里没有的模型。id 必填；窗口支持 256K / 1M 速记；价格不填显示「未知」。
          </p>
          <button
            onClick={() => setDrafts((d) => [...d, emptyDraft(nextDraftKey())])}
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <Plus size={12} />
            添加一行
          </button>
        </div>

        <div className="mt-2 space-y-1.5">
          {drafts.map((r, i) => (
            <div key={r.key} className="flex flex-wrap items-center gap-1.5">
              <span className="tnum w-5 shrink-0 text-caption text-ash">{i + 1}.</span>
              <input
                value={r.id}
                onChange={(e) => setDrafts((d) => d.map((x) => (x.key === r.key ? { ...x, id: e.target.value } : x)))}
                placeholder="模型 id *"
                aria-label={`第 ${i + 1} 行模型 id`}
                maxLength={MAX_CUSTOM_MODEL_SLUG_LENGTH}
                spellCheck={false}
                className={cn(
                  "w-44 rounded-input border bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash",
                  draftErrors[r.key] ? "border-loss" : "border-transparent focus:border-teal",
                )}
              />
              <input
                value={r.name}
                onChange={(e) => setDrafts((d) => d.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
                placeholder="显示名（可选）"
                aria-label={`第 ${i + 1} 行显示名`}
                className="w-32 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.ctx}
                onChange={(e) => setDrafts((d) => d.map((x) => (x.key === r.key ? { ...x, ctx: e.target.value } : x)))}
                placeholder="窗口 256K"
                aria-label={`第 ${i + 1} 行上下文窗口`}
                className="w-24 rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.priceIn}
                onChange={(e) => setDrafts((d) => d.map((x) => (x.key === r.key ? { ...x, priceIn: e.target.value } : x)))}
                placeholder="输入价"
                aria-label={`第 ${i + 1} 行输入单价`}
                inputMode="decimal"
                className="w-20 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.priceOut}
                onChange={(e) => setDrafts((d) => d.map((x) => (x.key === r.key ? { ...x, priceOut: e.target.value } : x)))}
                placeholder="输出价"
                aria-label={`第 ${i + 1} 行输出单价`}
                inputMode="decimal"
                className="w-20 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              {draftErrors[r.key] && <span className="text-caption text-loss">{draftErrors[r.key]}</span>}
              <button
                onClick={() => setDrafts((d) => (d.length > 1 ? d.filter((x) => x.key !== r.key) : d))}
                aria-label={`移除第 ${i + 1} 行`}
                title="移除这一行"
                className="shrink-0 rounded p-0.5 text-ash hover:bg-line hover:text-loss"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        <details className="mt-2">
          <summary className="cursor-pointer text-caption text-ash hover:text-graphite">
            配置预览（pi models.json 形态）
          </summary>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-btn bg-rail p-2 font-mono text-caption leading-relaxed text-graphite">
            {draftsJson}
          </pre>
        </details>

        <div className="mt-2 flex items-center justify-end gap-2">
          {Object.keys(draftErrors).length > 0 && (
            <p className="text-caption text-loss">
              有 {Object.keys(draftErrors).length} 行未通过校验，修正后再添加
            </p>
          )}
          <button
            onClick={submitDrafts}
            disabled={drafts.every((r) => r.id.trim().length === 0)}
            className="flex items-center gap-1 rounded-btn bg-ink px-2.5 py-1.5 text-body-sm text-canvas hover:bg-black disabled:opacity-30"
          >
            <Plus size={12} />
            全部添加（{drafts.filter((r) => r.id.trim().length > 0).length}）
          </button>
        </div>
      </div>
    </div>
  );
}

/** 多行草稿的一行（dsh CustomProviderCard 的 models 数组形态） */
interface DraftRow {
  key: number;
  id: string;
  name: string;
  ctx: string;
  priceIn: string;
  priceOut: string;
}

let draftKeySeq = 0;
const emptyDraft = (key?: number): DraftRow => ({ key: key ?? ++draftKeySeq, id: "", name: "", ctx: "", priceIn: "", priceOut: "" });
const nextDraftKey = () => ++draftKeySeq;

/** 容量速记解析：256K / 1M / 4096（dsh parseCapacity 同款，1K=1000、1M=1_000_000） */
export function parseCapacity(raw: string): number | undefined {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  const unit = m[2]?.toLowerCase();
  const mult = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return Math.round(n * mult);
}

const EMPTY_SPECS: readonly ModelSpec[] = [];

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "rounded p-1",
        disabled ? "cursor-not-allowed text-line" : "text-ash hover:bg-line hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** 自定义模型的价格 / 窗口 / 显示名编辑。slug 不可改 —— 改了等于换一个模型 */
function EditRow({
  spec,
  onSave,
  onCancel,
}: {
  spec: ModelSpec;
  onSave: (patch: { name?: string; inputPerMTok?: number; outputPerMTok?: number; contextWindow?: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(spec.displayName);
  const [inp, setInp] = useState(spec.inputPerMTok > 0 ? String(spec.inputPerMTok) : "");
  const [out, setOut] = useState(spec.outputPerMTok > 0 ? String(spec.outputPerMTok) : "");
  const [ctx, setCtx] = useState(spec.contextWindow > 0 ? String(spec.contextWindow) : "");

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="显示名"
        placeholder="显示名"
        className="w-28 rounded-input bg-rail px-1.5 py-0.5 text-caption text-ink outline-none"
      />
      <input
        value={inp}
        onChange={(e) => setInp(e.target.value)}
        inputMode="decimal"
        aria-label="输入单价（每百万 token）"
        placeholder="输入价"
        className="w-16 rounded-input bg-rail px-1.5 py-0.5 text-caption text-ink outline-none"
      />
      <input
        value={out}
        onChange={(e) => setOut(e.target.value)}
        inputMode="decimal"
        aria-label="输出单价（每百万 token）"
        placeholder="输出价"
        className="w-16 rounded-input bg-rail px-1.5 py-0.5 text-caption text-ink outline-none"
      />
      <input
        value={ctx}
        onChange={(e) => setCtx(e.target.value)}
        inputMode="numeric"
        aria-label="上下文窗口（token）"
        placeholder="窗口"
        className="w-20 rounded-input bg-rail px-1.5 py-0.5 text-caption text-ink outline-none"
      />
      <button
        onClick={() =>
          onSave({
            name: name.trim() || spec.id,
            inputPerMTok: numOrUndef(inp),
            outputPerMTok: numOrUndef(out),
            contextWindow: numOrUndef(ctx),
          })
        }
        aria-label="保存"
        className="rounded p-1 text-teal hover:bg-line"
      >
        <Check size={12} />
      </button>
      <button onClick={onCancel} aria-label="取消" className="rounded p-1 text-ash hover:bg-line hover:text-ink">
        <X size={12} />
      </button>
    </span>
  );
}

function numOrUndef(v: string): number | undefined {
  const n = Number.parseFloat(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
