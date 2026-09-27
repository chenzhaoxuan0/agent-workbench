/**
 * 模型目录 —— 执行器是「哪个 CLI」，模型是「这个 CLI 这次用哪个大脑」。
 *
 * 为什么单独一层、而不是在 RuntimeCapabilities 里加个 `model: string`：
 * 两者是**正交的两个维度**。Claude Code 只吃 Anthropic 的模型，
 * Codex 只吃 OpenAI 的，OpenCode / pi / ZCode 是厂商中立的。
 * 所以「可选模型集」必须由适配器**逐家声明**（同 capabilities 的强制声明口径），
 * 而模型本身的元数据属于厂商事实，不该塞进执行器的 SPI 里。
 *
 * ⚠⚠ 价格与上下文窗口是**快照**，不是契约。
 * 厂商调价、换窗口的频率远高于我们发版。以下数字的 asOf 是 2026-09-27，
 * 每条都带 source。真要拿它做预算，必须先刷新 —— 尤其 OpenAI 那几条
 * 采自第三方聚合站（官方快通道价与标准价不同，别混用）。
 */

// ModelId 品牌声明在 units.ts —— 那是所有品牌化 id 的唯一出处。
// 这里只做再导出，免得出现第二份 `string & {__brand:"ModelId"}`。
import { asModelId, type ModelId } from "./units.ts";

export { asModelId };
export type { ModelId };

export type ModelVendor = "anthropic" | "openai" | "deepseek";

/** 档位。决定菜单排序，也决定它在列表里的位置（先按档位再按价格）。 */
export type ModelTier = "frontier" | "balanced" | "fast";

export interface ModelSpec {
  readonly id: ModelId;
  /** 给人看的名字 */
  readonly displayName: string;
  readonly vendor: ModelVendor;
  readonly vendorLabel: string;
  readonly tier: ModelTier;
  /** 上下文窗口（token） */
  readonly contextWindow: number;
  /** 每百万 token 输入 / 输出美元 */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** 是否支持图像输入 */
  readonly multimodal: boolean;
  /**
   * 是否**只能**处理图像。
   *
   * 这个字段才决定「能不能选」，`multimodal` 不能。
   * 视觉能力的模型在只走文本的 CLI 上照样能跑绝大多数 agent 任务，
   * 拿「模型支持视觉」去禁选整个模型，等于把 Codex 这类
   * 「CLI 没多模态通道但模型全都能看图」的执行器变成一个模型都选不了的死路。
   * 只有纯视觉模型才真的不可选。今天目录里没有，但字段留着。
   */
  readonly visionOnly?: boolean;
  /** 一句话定位 */
  readonly note: string;
  readonly asOf: string;
  readonly source: string;
}

const T = "2026-09-27";

/**
 * 目录只收**当前在售**的模型。
 * 已退役的不收 —— 收进来就是让用户能选到一个必然失败的选项。
 * 已知退役：`deepseek-chat` / `deepseek-reasoner`（2026-07-24）、
 * `gpt-5-codex`（2026-07-23）、Claude Opus 4.1 及更早。
 */
export const MODELS: readonly ModelSpec[] = [
  // ---- Anthropic ----
  {
    id: asModelId("claude-opus-5-5"),
    displayName: "Claude Opus 5.5",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "frontier",
    contextWindow: 1_000_000,
    inputPerMTok: 4,
    outputPerMTok: 20,
    multimodal: true,
    note: "长程 agentic 编码与知识工作",
    asOf: T,
    source: "https://docs.anthropic.com/claude/docs/models-overview",
  },
  {
    id: asModelId("claude-fable-5-1"),
    displayName: "Claude Fable 5.1",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "frontier",
    contextWindow: 1_000_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
    multimodal: true,
    note: "最难的推理与长程 agentic 任务",
    asOf: T,
    source: "https://docs.anthropic.com/claude/docs/models-overview",
  },
  {
    id: asModelId("claude-sonnet-5"),
    displayName: "Claude Sonnet 5",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "balanced",
    contextWindow: 1_000_000,
    inputPerMTok: 2,
    outputPerMTok: 10,
    multimodal: true,
    note: "速度与智能的最佳平衡，日常主力",
    asOf: T,
    source: "https://docs.anthropic.com/claude/docs/models-overview",
  },
  {
    id: asModelId("claude-haiku-4-5"),
    displayName: "Claude Haiku 4.5",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "fast",
    contextWindow: 200_000,
    inputPerMTok: 1,
    outputPerMTok: 5,
    multimodal: true,
    note: "最快，接近前沿水平",
    asOf: T,
    source: "https://docs.anthropic.com/claude/docs/models-overview",
  },

  // ---- OpenAI ----
  {
    id: asModelId("gpt-6-astra"),
    displayName: "GPT-6 Astra",
    vendor: "openai",
    vendorLabel: "OpenAI",
    tier: "frontier",
    contextWindow: 1_100_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
    multimodal: true,
    note: "当前旗舰",
    asOf: T,
    source: "https://cloudprice.net/models/openai/gpt-6-astra",
  },
  {
    id: asModelId("gpt-5-1-codex"),
    displayName: "GPT-5.1 Codex",
    vendor: "openai",
    vendorLabel: "OpenAI",
    tier: "balanced",
    contextWindow: 400_000,
    inputPerMTok: 2.5,
    outputPerMTok: 20,
    multimodal: true,
    note: "为 agentic 编码优化，Codex 默认",
    asOf: T,
    source: "https://developers.openai.com/api/docs/models",
  },
  {
    id: asModelId("gpt-5-6-luna"),
    displayName: "GPT-5.6 Luna",
    vendor: "openai",
    vendorLabel: "OpenAI",
    tier: "fast",
    contextWindow: 1_100_000,
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    multimodal: true,
    note: "最快最便宜，适合跑量任务",
    asOf: T,
    source: "https://cloudprice.net/models/openai",
  },

  // ---- DeepSeek ----
  {
    id: asModelId("deepseek-v4-pro"),
    displayName: "DeepSeek V4 Pro",
    vendor: "deepseek",
    vendorLabel: "DeepSeek",
    tier: "frontier",
    contextWindow: 1_000_000,
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    multimodal: false,
    note: "深思模式，最便宜的旗舰推理",
    asOf: T,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
  },
  {
    id: asModelId("deepseek-v4-flash"),
    displayName: "DeepSeek V4 Flash",
    vendor: "deepseek",
    vendorLabel: "DeepSeek",
    tier: "fast",
    contextWindow: 1_000_000,
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    multimodal: false,
    note: "默认档，通话与工具调用够用",
    asOf: T,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
  },
];

const BY_ID = new Map<string, ModelSpec>(MODELS.map((m) => [m.id, m]));

export function modelById(id: ModelId | string | null | undefined): ModelSpec | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isKnownModel(id: string): boolean {
  return BY_ID.has(id);
}

/** 菜单排序：档位 → 价格。便宜的档位在前，符合「先看能不能用，再看贵不贵」 */
const TIER_ORDER: Record<ModelTier, number> = { frontier: 0, balanced: 1, fast: 2 };

/** spec 版排序器。`sortModels` 与「按偏好重排」共用它，避免两套排序口径 */
export function sortSpecs(specs: readonly ModelSpec[]): ModelSpec[] {
  return [...specs].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      a.inputPerMTok + a.outputPerMTok - (b.inputPerMTok + b.outputPerMTok),
  );
}

export function sortModels(ids: readonly ModelId[]): readonly ModelSpec[] {
  return sortSpecs(ids.map((id) => modelById(id)).filter((m): m is ModelSpec => m !== undefined));
}

/**
 * 某执行器的默认模型 = 它的清单里**优先取均衡档**。
 *
 * 为什么不直接取菜单第一个（那是最便宜的旗舰）：
 * 旗舰档默认等于每次都按 4~40 倍价跑，用户不会预期到；
 * 而最便宜的档又可能不够干 agent 的活。所以默认落在「大多数 agent 任务的起点」——
 * 有均衡档就用它，没有才退到旗舰。
 *
 * 刻意不搞「全局默认模型」：换了执行器还能沿用上一个的模型，
 * 就会出现「ZCode 选了 claude-sonnet-5，切到 Codex 还在选它」这种非法组合。
 * 默认必须是**相对于这个执行器**的。
 */
const DEFAULT_TIER_PREFERENCE: readonly ModelTier[] = ["balanced", "frontier", "fast"];

/** 收 ModelSpec 而不是 ModelId —— 排序需要价格与档位，只有 id 排不了 */
export function defaultModelFor(specs: readonly ModelSpec[]): ModelId | null {
  if (specs.length === 0) return null;
  const ordered = sortModels(specs.map((s) => s.id));
  for (const tier of DEFAULT_TIER_PREFERENCE) {
    const hit = ordered.find((s) => s.tier === tier);
    if (hit) return hit.id;
  }
  return ordered[0]?.id ?? null;
}

/** 该模型与该执行器是否搭配合法 —— 唯一的合法性判据 */
export function canRuntimeUse(
  runtimeModels: readonly ModelSpec[],
  model: ModelId | null | undefined,
): boolean {
  return model !== null && model !== undefined && runtimeModels.some((m) => m.id === model);
}

/**
 * 这个模型在该执行器上**能不能被选中**。
 *
 * 只有纯视觉模型会被拒（CLI 没有多模态通道，选了也跑不了）。
 * 支持视觉的普通模型照常可选 —— 文本任务本来就用不到图像。
 *
 * 返回可选项的集合，UI 禁用态和「每家至少有一个能选」的断言共用它，
 * 避免 UI 与自检各写一套口径又各自漂移。
 */
export function selectableOn(
  runtimeModels: readonly ModelSpec[],
  supportsVisionChannel: boolean,
): readonly ModelSpec[] {
  return runtimeModels.filter((m) => supportsVisionChannel || m.visionOnly !== true);
}

/** 格式化，给 UI 用。200K / 1.0M 而不是 200000 / 1000000 */
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(n / 1000)}K`;
}

/** 价格显示。$0.14 这种小的保留两位，大的去掉多余的零 */
export function formatPrice(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`;
}
