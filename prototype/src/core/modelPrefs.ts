/**
 * 每个 CLI（provider）的模型偏好 —— 对齐 T3code 的
 * `providerModelPreferences` + `customModels` 两组设置。
 *
 * T3code 把它们分开存（前者是 client 偏好，后者是 server 配置），
 * 因为它们的**归属方不同**：偏好跟着实例走，自定义模型是那个 CLI 的配置。
 * 这里合成一份，但语义保持一致，并在字段上标注了这一点。
 *
 * 核心取舍：**隐藏 + 自定义，而不是「改一份全局模型列表」**。
 * 同一个模型在 Claude Code 里要留、在 OpenCode 里要藏 —— 这只有在
 * 「按 provider 记偏好」的前提下才表达得出来。
 *
 * 有几条是从 T3code 抄来并且我认为必须保留的：
 *  1. 自定义模型**不能被隐藏**。用户亲手加的东西不会自己把它藏掉。
 *  2. 删掉自定义模型时要连带清掉它在 order / favorites 里的残留引用。
 *  3. 排序只**在组内**交换（收藏组与普通组各自成段）。
 *  4. 排序表里没提到的模型排在最后，而不是被丢掉。
 */

import {
  defaultModelFor,
  modelById,
  sortModels,
  sortSpecs,
  type ModelId,
  type ModelSpec,
  type ModelTier,
  type ModelVendor,
} from "./models.ts";
import type { RuntimeId } from "./units.ts";

// ---------------------------------------------------------------------------
// 自定义模型
// ---------------------------------------------------------------------------

/**
 * 用户自己加的模型 —— 内置目录里没有、但这个 CLI 认的。
 *
 * 字段全部可选：只填 slug 就得到「一个能选、但没有价格与窗口信息」的模型。
 * 这比逼用户填完一整套才能用要好 —— 多数时候他只是想让那个 id 出现在列表里。
 */
export interface CustomModelEntry {
  readonly slug: ModelId;
  /** 显示名。缺省时用 slug */
  readonly name?: string;
  readonly inputPerMTok?: number;
  readonly outputPerMTok?: number;
  readonly contextWindow?: number;
  /** 缺省 balanced：自定义模型我们不知道它多强，默认别把它当旗舰 */
  readonly tier?: ModelTier;
}

export const MAX_CUSTOM_MODEL_SLUG_LENGTH = 128;

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

export interface ProviderModelPrefs {
  /** 从选择器里隐藏的**内置**模型。自定义模型不在此列（见文件头第 1 条） */
  readonly hiddenModels: readonly ModelId[];
  /** 用户显式排的顺序。没在表里的模型排到最后，而不是被丢 */
  readonly modelOrder: readonly ModelId[];
  readonly favoriteModels: readonly ModelId[];
  readonly customModels: readonly CustomModelEntry[];
}

export const EMPTY_PREFS: ProviderModelPrefs = {
  hiddenModels: [],
  modelOrder: [],
  favoriteModels: [],
  customModels: [],
};

export type ModelPrefsMap = Readonly<Record<string, ProviderModelPrefs>>;

export function prefsOf(map: ModelPrefsMap, runtimeId: RuntimeId | string): ProviderModelPrefs {
  return map[runtimeId] ?? EMPTY_PREFS;
}

// ---------------------------------------------------------------------------
// 自定义模型 → ModelSpec
// ---------------------------------------------------------------------------

export function customToSpec(entry: CustomModelEntry): ModelSpec {
  return {
    id: entry.slug,
    displayName: entry.name ?? entry.slug,
    // 厂商未知就别瞎标 —— 标成「自定义」比挂错一个厂商名诚实
    vendor: "custom" as ModelVendor,
    vendorLabel: "自定义",
    tier: entry.tier ?? "balanced",
    contextWindow: entry.contextWindow ?? 0,
    inputPerMTok: entry.inputPerMTok ?? 0,
    outputPerMTok: entry.outputPerMTok ?? 0,
    multimodal: false,
    note: "用户添加，未核实价格与窗口",
    asOf: "",
    source: "custom",
  };
}

// ---------------------------------------------------------------------------
// 归一 —— 读入时的唯一入口
// ---------------------------------------------------------------------------

/**
 * 把落盘的偏好收拾干净。
 *
 * 存在的理由跟 ZCode 的 `normalizeWorkspaceSidePaneState` 一样：
 * **归一必须发生在边界，不能散落在渲染时**。落盘的东西可能来自旧版本、
 * 手工编辑、或某个已经被删掉的模型 —— 渲染时才过滤，就会漏。
 *
 * 具体做四件事：
 *  1. order / favorite 里**已知不存在**的 id 全清掉
 *  2. 同一 id 重复出现时保留第一次
 *  3. hidden 里混进来的自定义模型 / 未声明模型一并清掉
 *  4. 补上「至少留一个可见」的兜底
 */
export function normalizePrefs(prefs: ProviderModelPrefs, declared: readonly ModelSpec[]): ProviderModelPrefs {
  const declaredIds = new Set<string>(declared.map((m) => m.id));
  const customIds = new Set<string>(prefs.customModels.map((c) => c.slug));
  const known = new Set<string>([...declaredIds, ...customIds]);

  const hiddenModels = dedupe(prefs.hiddenModels).filter(
    (id) => declaredIds.has(id) && !customIds.has(id),
  );
  const modelOrder = dedupe(prefs.modelOrder).filter((id) => known.has(id));
  const favoriteModels = dedupe(prefs.favoriteModels).filter((id) => known.has(id));

  // 兜底：全藏起来了就把第一个藏的放回来。
  // 藏光 = 那个 CLI 一个模型都选不了 = 死路（这个坑在「多模态禁选」那次已经踩过一回）。
  const declaredVisible = declared.filter((m) => !hiddenModels.includes(m.id)).length;
  const restored = declaredVisible === 0 && customIds.size === 0 && hiddenModels.length > 0
    ? hiddenModels.slice(1)
    : hiddenModels;

  return { hiddenModels: restored, modelOrder, favoriteModels, customModels: normalizeCustom(prefs.customModels) };
}

function dedupe(ids: readonly ModelId[]): ModelId[] {
  return [...new Set(ids)];
}

function normalizeCustom(list: readonly CustomModelEntry[]): CustomModelEntry[] {
  const seen = new Set<string>();
  const out: CustomModelEntry[] = [];
  for (const raw of list) {
    const slug = raw.slug.trim().slice(0, MAX_CUSTOM_MODEL_SLUG_LENGTH) as ModelId;
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...raw, slug });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 有效清单 —— 选择器唯一该读的东西
// ---------------------------------------------------------------------------

/**
 * 某个 CLI 在选择器里**实际可选**的模型。
 *
 * 口径 = 适配器声明的内置模型 + 用户自定义 − 被隐藏的，
 * 再按 modelOrder 排（收藏可选择提到最前）。
 *
 * 关键点：**可见性判定全部走这一个函数**，UI 不自己 filter。
 * 上次「多模态禁选」出死路，就是因为 UI 和自检各写了一套口径又各自漂移。
 */
export function resolveVisibleModels(
  declared: readonly ModelSpec[],
  prefs: ProviderModelPrefs,
  options?: { readonly groupFavorites?: boolean },
): readonly ModelSpec[] {
  const custom = prefs.customModels.map(customToSpec);
  const all = sortSpecs([...declared, ...custom]);

  const hidden = new Set<string>(prefs.hiddenModels);
  const visible = all.filter((m) => !hidden.has(m.id));

  const rank = new Map(prefs.modelOrder.map((id, i) => [id, i]));
  // 没排过的排到最后（不是保持原序插在中间）：用户的排序意图是「我排的在前」，
  // 剩下那些是「懒得排」，放最后最不打扰。
  const ordered = [...visible].sort((a, b) => {
    if (options?.groupFavorites === true) {
      const fa = prefs.favoriteModels.includes(a.id) ? 0 : 1;
      const fb = prefs.favoriteModels.includes(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return 0; // 都没排过 → 保持目录原序
  });

  return ordered;
}

/** 该 CLI 现在的默认模型（受偏好影响：藏掉默认就得换） */
export function resolveDefaultModel(
  declared: readonly ModelSpec[],
  prefs: ProviderModelPrefs,
): ModelId | null {
  const visible = resolveVisibleModels(declared, prefs);
  if (visible.length === 0) return null;
  const builtinDefault = defaultModelFor(declared);
  // 声明的默认还可见就继续用它 —— 别因为排序偏好就换掉默认模型
  if (builtinDefault && visible.some((m) => m.id === builtinDefault)) return builtinDefault;
  return visible[0]!.id;
}

// ---------------------------------------------------------------------------
// 编辑动作 —— 全部返回新对象，不改入参
// ---------------------------------------------------------------------------

export type ModelPrefError = { readonly code: "duplicate" | "empty" | "too-long"; readonly message: string };

export type AddResult =
  | { readonly ok: true; readonly prefs: ProviderModelPrefs }
  | { readonly ok: false; readonly error: ModelPrefError };

/** 加自定义模型。重复 / 空 / 超长都拒绝并给出人话原因 */
export function addCustomModel(prefs: ProviderModelPrefs, raw: string): AddResult {
  const slug = raw.trim();
  if (slug.length === 0) return { ok: false, error: { code: "empty", message: "模型 id 不能为空" } };
  if (slug.length > MAX_CUSTOM_MODEL_SLUG_LENGTH) {
    return { ok: false, error: { code: "too-long", message: `模型 id 超过 ${MAX_CUSTOM_MODEL_SLUG_LENGTH} 字符` } };
  }
  const id = slug as ModelId;
  if (prefs.customModels.some((c) => c.slug === id) || modelById(id)) {
    return { ok: false, error: { code: "duplicate", message: `${slug} 已存在（内置或已添加）` } };
  }
  return { ok: true, prefs: { ...prefs, customModels: [...prefs.customModels, { slug: id }] } };
}

/**
 * 删自定义模型，并连带清掉 order / favorites 里的残留引用。
 * 留着悬空引用的话，`modelOrder` 会永远占着一个不存在的槽位，
 * 用户下次排序时看不出哪里不对。
 */
export function removeCustomModel(prefs: ProviderModelPrefs, slug: ModelId): ProviderModelPrefs {
  return {
    ...prefs,
    customModels: prefs.customModels.filter((c) => c.slug !== slug),
    modelOrder: prefs.modelOrder.filter((id) => id !== slug),
    favoriteModels: prefs.favoriteModels.filter((id) => id !== slug),
  };
}

export function updateCustomModel(
  prefs: ProviderModelPrefs,
  slug: ModelId,
  patch: Omit<Partial<CustomModelEntry>, "slug">,
): ProviderModelPrefs {
  return {
    ...prefs,
    customModels: prefs.customModels.map((c) => (c.slug === slug ? { ...c, ...patch } : c)),
  };
}

/** 显示 / 隐藏切换。自定义模型不参与隐藏（T3code 同款） */
export function toggleHidden(prefs: ProviderModelPrefs, id: ModelId): ProviderModelPrefs {
  return {
    ...prefs,
    hiddenModels: prefs.hiddenModels.includes(id)
      ? prefs.hiddenModels.filter((x) => x !== id)
      : [...prefs.hiddenModels, id],
  };
}

export function toggleFavorite(prefs: ProviderModelPrefs, id: ModelId): ProviderModelPrefs {
  return {
    ...prefs,
    favoriteModels: prefs.favoriteModels.includes(id)
      ? prefs.favoriteModels.filter((x) => x !== id)
      : [...prefs.favoriteModels, id],
  };
}

/**
 * 一键全藏 / 全显。
 *
 * 判定条件是**当前可见数 ≤ 1**，不是 T3code 那个「是否全藏」
 * （`allBuiltInModelsHidden`）。原因：我们的 `normalizePrefs` 有一个
 * 「至少留一个可见」的兜底，所以「全藏」这个状态**根本存不住** ——
 * 存进去就被放回一个。按 T3code 的原判定点第二次，会走进「全藏」分支，
 * 然后又被兜底放回一个，于是「全部显示」这个按钮永远点不动。
 */
export function nextHiddenForBulkToggle(
  declared: readonly ModelSpec[],
  prefs: ProviderModelPrefs,
): ProviderModelPrefs {
  const ids = declared.map((m) => m.id);
  const visible = ids.filter((id) => !prefs.hiddenModels.includes(id)).length;
  return {
    ...prefs,
    hiddenModels: visible <= 1 ? [] : [...new Set([...prefs.hiddenModels, ...ids])],
  };
}

/**
 * 上移 / 下移。**只在同一组内交换**（对齐 T3code：
 * 「moves only swap rows within the same group」），否则收藏项会混进普通段。
 *
 * `displayOrder` 是「用户当前看到的顺序」（调用方把渲染出来的行按序传进来）。
 * 没排过的 id 必须先按它补进 modelOrder，否则 rank 是 Infinity、append 之后
 * 变 0 —— 点「下移」会把这一行送到该组**最前面**，按钮语义整个反过来。
 */
export function moveModel(
  prefs: ProviderModelPrefs,
  id: ModelId,
  dir: -1 | 1,
  groupOf: (id: ModelId) => boolean,
  displayOrder: readonly ModelId[] = [],
): ProviderModelPrefs {
  const order = prefs.modelOrder;
  // 补全：已有 rank 保留，显示序里还没排过的一律追加到末尾（顺序 = 当前所见）
  const filled = displayOrder.reduce<ModelId[]>((acc, x) => (acc.includes(x) ? acc : [...acc, x]), [...order]);
  const idx = filled.indexOf(id);
  if (idx < 0) return { ...prefs, modelOrder: [...order, id] };

  const target = idx + dir;
  if (target < 0 || target >= filled.length) return prefs;
  if (groupOf(filled[idx]!) !== groupOf(filled[target]!)) return prefs;

  const next = [...filled];
  const a = next[idx]!;
  next[idx] = next[target]!;
  next[target] = a;
  return { ...prefs, modelOrder: next };
}

/** 持久化用：丢掉所有空偏好，避免 localStorage 里堆一堆 `{}` */
export function pruneEmptyPrefs(map: ModelPrefsMap): ModelPrefsMap {
  const out: Record<string, ProviderModelPrefs> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    if (
      v.hiddenModels.length === 0 &&
      v.modelOrder.length === 0 &&
      v.favoriteModels.length === 0 &&
      v.customModels.length === 0
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 落盘读取。只挑认识的字段，其余丢弃 —— 旧版本/手改的脏数据不该进内存 */
export function parsePrefsMap(raw: unknown): ModelPrefsMap {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ProviderModelPrefs> = {};
  for (const [runtimeId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const arr = (k: string): ModelId[] =>
      Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is ModelId => typeof x === "string") : [];
    out[runtimeId] = {
      hiddenModels: arr("hiddenModels"),
      modelOrder: arr("modelOrder"),
      favoriteModels: arr("favoriteModels"),
      customModels: Array.isArray(v.customModels)
        ? (v.customModels as unknown[])
            .map((c) => (typeof c === "string" ? { slug: c as ModelId } : (c as CustomModelEntry)))
            .filter((c): c is CustomModelEntry => Boolean(c) && typeof c.slug === "string")
        : [],
    };
  }
  return out;
}
