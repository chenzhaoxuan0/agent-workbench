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

export type ModelVendor = "anthropic" | "openai" | "deepseek" | "glm" | "mock" | "custom" | "minimax";

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
  /** 单轮最大输出限制（token） */
  readonly maxOutput?: number;
  /** 支持的推理档位（low, medium, high, max, ultra 等） */
  readonly reasoningLevels?: readonly string[];
  /** 默认推理档位 */
  readonly defaultReasoningLevel?: string;
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
    contextWindow: 272_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
    multimodal: true,
    note: "当前旗舰（标准默认 272K；长窗口需双倍价格）",
    asOf: T,
    source: "https://cloudprice.net/models/openai/gpt-6-astra",
  },
  {
    id: asModelId("gpt-5-1-codex"),
    displayName: "GPT-5.1 Codex",
    vendor: "openai",
    vendorLabel: "OpenAI",
    tier: "balanced",
    contextWindow: 272_000,
    inputPerMTok: 2.5,
    outputPerMTok: 20,
    multimodal: true,
    note: "为 agentic 编码优化，Codex 默认（标准 272K 窗口）",
    asOf: T,
    source: "https://developers.openai.com/api/docs/models",
  },
  {
    id: asModelId("gpt-5-6-luna"),
    displayName: "GPT-5.6 Luna",
    vendor: "openai",
    vendorLabel: "OpenAI",
    tier: "fast",
    contextWindow: 272_000,
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    multimodal: true,
    note: "最快最便宜，适合跑量任务（标准 272K 窗口）",
    asOf: T,
    source: "https://cloudprice.net/models/openai",
  },

  // ---- Claude Code（经 daemon 执行器；本机网关别名，订阅内含）----
  {
    id: asModelId("sonnet"),
    displayName: "Claude Sonnet（网关）",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "balanced",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: true,
    note: "claude CLI 网关别名，日常主力档，支持多模态与推理思考",
    asOf: T,
    source: "zcode registry（claude settings.json 别名，订阅内含）",
  },
  {
    id: asModelId("opus"),
    displayName: "Claude Opus（网关）",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "frontier",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: true,
    note: "claude CLI 网关别名，旗舰档，支持多模态",
    asOf: T,
    source: "zcode registry（claude settings.json 别名，订阅内含）",
  },
  {
    id: asModelId("haiku"),
    displayName: "Claude Haiku（网关）",
    vendor: "anthropic",
    vendorLabel: "Anthropic",
    tier: "fast",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "claude CLI 网关别名，最快纯文本档（无视觉）",
    asOf: T,
    source: "zcode registry（claude settings.json 别名，订阅内含）",
  },

  // ---- GLM（Z.AI / bigmodel coding plan，经 daemon 的 zcode 执行器）----
  {
    id: asModelId("GLM-5.3-Flash"),
    displayName: "GLM-5.3 Flash",
    vendor: "glm",
    vendorLabel: "GLM",
    tier: "fast",
    contextWindow: 1_000_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: true,
    note: "zcode 唯一具备多模态视觉的模型，1M 窗口，订阅内含",
    asOf: T,
    source: "zcode registry（daemon adapter.list）",
  },
  {
    id: asModelId("GLM-5.3"),
    displayName: "GLM-5.3",
    vendor: "glm",
    vendorLabel: "GLM",
    tier: "frontier",
    contextWindow: 1_000_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "深思旗舰档，1M 窗口（纯文本，无视觉），订阅内含",
    asOf: T,
    source: "zcode registry（daemon adapter.list）",
  },
  {
    id: asModelId("GLM-5-Turbo"),
    displayName: "GLM-5 Turbo",
    vendor: "glm",
    vendorLabel: "GLM",
    tier: "balanced",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "速度与智能平衡，200K 窗口（纯文本，无视觉），订阅内含",
    asOf: T,
    source: "zcode registry（daemon adapter.list）",
  },

  // ---- MiniMax Code（经 daemon 的 mcode 执行器，支持多模态与推理）----
  {
    id: asModelId("MiniMax-M3.1-Flash-Preview"),
    displayName: "M3.1 Flash Preview",
    vendor: "minimax",
    vendorLabel: "MiniMax",
    tier: "balanced",
    contextWindow: 512_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: true,
    note: "MiniMax Code 托管默认模型，512K 窗口，支持多模态视觉与深思推理",
    asOf: T,
    source: "~/.minimax/config.yaml（mcode 官方模型生态）",
  },
  {
    id: asModelId("MiniMax-M3"),
    displayName: "MiniMax M3",
    vendor: "minimax",
    vendorLabel: "MiniMax",
    tier: "frontier",
    contextWindow: 512_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: true,
    note: "MiniMax Code 旗舰模型，512K 窗口，支持多模态视觉与深度思考",
    asOf: T,
    source: "~/.minimax/config.yaml（mcode 官方模型生态）",
  },
  {
    id: asModelId("MiniMax-M2.7-highspeed"),
    displayName: "MiniMax M2.7 Highspeed",
    vendor: "minimax",
    vendorLabel: "MiniMax",
    tier: "fast",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "极速响应轻量模型，200K 窗口（纯文本，无视觉）",
    asOf: T,
    source: "~/.minimax/config.yaml（mcode 官方模型生态）",
  },
  {
    id: asModelId("MiniMax-M2.7"),
    displayName: "MiniMax M2.7",
    vendor: "minimax",
    vendorLabel: "MiniMax",
    tier: "balanced",
    contextWindow: 200_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "高性价比编程模型，200K 窗口（纯文本，无视觉）",
    asOf: T,
    source: "~/.minimax/config.yaml（mcode 官方模型生态）",
  },

  // ---- mock（daemon 的 mockperm 执行器：权限闸试金石，零成本走全流程）----
  {
    id: asModelId("mock-1"),
    displayName: "Mock-1",
    vendor: "mock",
    vendorLabel: "Mock",
    tier: "fast",
    contextWindow: 8_000,
    inputPerMTok: 0,
    outputPerMTok: 0,
    multimodal: false,
    note: "每轮必发权限请求 —— 权限卡与闸的端到端试金石",
    asOf: T,
    source: "zcode registry（daemon mockperm adapter，无外部来源）",
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
    note: "DeepSeek Harness 官方长程架构，1M 窗口，支持深度思考",
    asOf: T,
    source: "DeepSeek Harness（ACP 官方长程端点）",
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
    note: "DeepSeek Harness 默认轻量档，1M 窗口",
    asOf: T,
    source: "DeepSeek Harness（ACP 官方长程端点）",
  },
];

const BY_ID = new Map<string, ModelSpec>(MODELS.map((m) => [m.id, m]));

export function modelById(id: ModelId | string | null | undefined): ModelSpec | undefined {
  if (!id) return undefined;
  const direct = BY_ID.get(id);
  if (direct !== undefined) return direct;
  // daemon 常报「厂商/模型」的完整 id（实测 `deepseek-official/deepseek-v4-flash`），
  // 本地目录记的是裸 id。这里按「去掉厂商前缀」回退匹配一次 —— 取最后一段是
  // 有据的猜测，不是模糊匹配。
  //
  // 命中时**用传入的 id 覆盖目录里的**：传回 daemon 的必须是它认识的那个字符串，
  // 换成裸 id 会让它回落成默认模型（host 的 resolveModelFor 会静默丢弃用户选择）。
  // 覆盖只改 id，规格（价格/档位/窗口）沿用目录里的。
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : "";
  const hit = tail === "" ? undefined : BY_ID.get(tail);
  return hit === undefined ? undefined : { ...hit, id: id as ModelId };
}

export function isKnownModel(id: string): boolean {
  return BY_ID.has(id);
}

/** 菜单排序：档位 → 价格。便宜的档位在前，符合「先看能不能用，再看贵不贵」 */
const TIER_ORDER: Record<ModelTier, number> = { frontier: 0, balanced: 1, fast: 2 };

/**
 * 本地目录里没有这条模型时，构造一个「规格未知」的占位。
 *
 * ## 为什么不直接丢掉它
 *
 * daemon 才是「这个执行器支持哪些模型」的**权威来源**；这个目录只是补充信息
 * （价格 / 档位 / 上下文窗口）。所以查不到应该**降级显示**，不是丢弃。
 *
 * 丢弃的实际后果比看上去严重：`sortModels` 一滤，`defaultModelFor` 就返回
 * null，`RuntimeEntry` 整个变成 null，**执行器从列表里消失** —— 而且是静默的，
 * 连个警告都没有。实测踩过：daemon 注册了 8 个执行器，界面只显示 4 个，消失的
 * 四个全是模型 id 不在本地目录里的（pi / mcode / dsh / opencode）。
 * 新加一个执行器不会顺手更新前端目录，于是这个执行器等于没接。
 *
 * ## 价格为什么记 0
 *
 * 这是本目录已有的约定，不是偷懒：订阅内含的模型（claude 网关别名、GLM 三档）
 * 同样记 0，note 写明原因。真实成本由 daemon 侧 `usage` 事件报 `costUsd`，
 * 用量统计不读这里的数字，所以这里填 0 不会让统计出错。
 *
 * 档位缺省 `balanced`：与「用户添加的自定义模型」同一处理 —— 我们不知道它多强，
 * 就别默认它是旗舰。
 */
export function scaffoldModel(
  id: ModelId,
  displayName?: string,
  overrides?: {
    readonly contextWindow?: number;
    readonly maxOutput?: number;
    readonly reasoningLevels?: readonly string[];
    readonly defaultReasoningLevel?: string;
    readonly multimodal?: boolean;
    readonly inputPerMTok?: number;
    readonly outputPerMTok?: number;
  },
): ModelSpec {
  const hasDynamicCtx = overrides?.contextWindow !== undefined && overrides.contextWindow > 0;
  return {
    id,
    displayName: displayName ?? id,
    vendor: "custom",
    vendorLabel: hasDynamicCtx ? "CLI 动态发现" : "未收录",
    tier: "balanced",
    contextWindow: overrides?.contextWindow ?? 0,
    inputPerMTok: overrides?.inputPerMTok ?? 0,
    outputPerMTok: overrides?.outputPerMTok ?? 0,
    multimodal: overrides?.multimodal ?? false,
    maxOutput: overrides?.maxOutput,
    reasoningLevels: overrides?.reasoningLevels,
    defaultReasoningLevel: overrides?.defaultReasoningLevel,
    note: hasDynamicCtx
      ? `由本机 Agent CLI 动态对齐（上下文 ${formatContext(overrides!.contextWindow!)}）`
      : "本地没有这条模型的价格与窗口资料（由 daemon 报告，目录未收录）",
    asOf: "",
    source: hasDynamicCtx ? "daemon adapter.list" : "",
  };
}

/** spec 版排序器。`sortModels` 与「按偏好重排」共用它，避免两套排序口径 */
export function sortSpecs(specs: readonly ModelSpec[]): ModelSpec[] {
  return [...specs].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      a.inputPerMTok + a.outputPerMTok - (b.inputPerMTok + b.outputPerMTok),
  );
}

export function sortModels(ids: readonly ModelId[]): readonly ModelSpec[] {
  return sortSpecs(ids.map((id) => modelById(id) ?? scaffoldModel(id)));
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
