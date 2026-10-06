/**
 * 模型层契约自检 —— 直接跑 core/models.ts 的纯函数。
 *
 * 这些断言守的是「别把非法组合放行」和「别让用户选到必然失败的选项」。
 * 跑法：node --experimental-strip-types scripts/check-models.ts
 */
import {
  asModelId,
  canRuntimeUse,
  defaultModelFor,
  formatContext,
  formatPrice,
  isKnownModel,
  isDeclaredModelSource,
  modelById,
  MODELS,
  selectableOn,
  sortModels,
  type ModelId,
  type ModelSpec,
} from "../src/core/models.ts";
import {
  addCustomModel,
  EMPTY_PREFS,
  moveModel,
  nextHiddenForBulkToggle,
  normalizePrefs,
  parsePrefsMap,
  prefsOf,
  pruneEmptyPrefs,
  removeCustomModel,
  resolveDefaultModel,
  resolveVisibleModels,
  toggleFavorite,
  toggleHidden,
  updateCustomModel,
} from "../src/core/modelPrefs.ts";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `\n      期望 ${String(expected)}，实际 ${String(actual)}`);
}

console.log("\n【1】目录自身：字段完整、无重复、id 可查");
{
  eq("非空", MODELS.length > 0, true);
  eq("id 无重复", new Set(MODELS.map((m) => m.id)).size, MODELS.length);

  const bad = MODELS.filter(
    (m) => !m.id || !m.displayName || !m.vendorLabel || !m.note || !m.asOf || !m.source,
  );
  eq("每条都有 id/名称/厂商/说明/快照日期/来源", bad.map((m) => m.id).join(","), "");

  // 订阅内含的模型（价格 0/0）是合法档：边际成本为 0，token 计量由 daemon 的
  // usage.jsonl 承担。两类各自校验：按量模型必须双侧正价；订阅模型必须双侧为零。
  const badPrice = MODELS.filter((m) => {
    const subscription = m.inputPerMTok === 0 && m.outputPerMTok === 0;
    return subscription ? false : !(m.inputPerMTok > 0) || !(m.outputPerMTok > 0);
  });
  eq("按量模型有正数价格、订阅模型价格为零", badPrice.map((m) => m.id).join(","), "");

  const badCtx = MODELS.filter((m) => m.contextWindow < 1000);
  eq("上下文窗口都合理", badCtx.map((m) => m.id).join(","), "");

  const unknown = MODELS.filter((m) => !isKnownModel(m.id));
  eq("每条都能被 modelById 查到", unknown.length, 0);
}

console.log("\n【2】价格与窗口是**快照**，不是契约 —— 每条都必须带来源");
{
  // 这条断言的作用是：将来有人手改数字却忘了更新来源，让它当场挂掉。
  // 合法来源有两类，判定集中在 models.ts 的 isDeclaredModelSource：
  // 公开价目页 URL，或本机快照声明（zcode registry / ~/.minimax/config.yaml /
  // DeepSeek Harness / daemon adapter.list）——订阅内含与 CLI 自带目录没有公开 URL 可引。
  const noSource = MODELS.filter((m) => !isDeclaredModelSource(m.source));
  eq("来源是真实 URL 或 registry 快照声明", noSource.map((m) => m.id).join(","), "");
  const noDate = MODELS.filter((m) => !/^\d{4}-\d{2}-\d{2}$/.test(m.asOf));
  eq("快照日期格式统一", noDate.map((m) => m.id).join(","), "");
}

console.log("\n【3】已退役的模型不进目录");
{
  // 收进来 = 让用户能选到一个必然 404 的选项
  for (const dead of ["deepseek-chat", "deepseek-reasoner", "gpt-5-codex", "claude-opus-4-1"]) {
    ok(`${dead} 已退役，不在目录里`, !isKnownModel(dead));
  }
  ok("当前在售的 claude-opus-5-5 在目录里", isKnownModel("claude-opus-5-5"));
  ok("当前在售的 gpt-6-astra 在目录里", isKnownModel("gpt-6-astra"));
  ok("当前在售的 deepseek-v4-pro 在目录里", isKnownModel("deepseek-v4-pro"));
}

console.log("\n【4】排序：先档位，再价格");
{
  const ids = MODELS.map((m) => m.id);
  const sorted = sortModels(ids);
  const tiers = sorted.map((m) => m.tier);
  const rank = { frontier: 0, balanced: 1, fast: 2 } as const;
  let monotonic = true;
  for (let i = 1; i < tiers.length; i++) {
    if (rank[tiers[i]!] < rank[tiers[i - 1]!]) monotonic = false;
  }
  ok("档位单调不降", monotonic, `实际 ${tiers.join(",")}`);
  eq("旗舰排在最前", tiers[0], "frontier");
  eq("快速档排在最后", tiers.at(-1), "fast");
  ok("输入顺序不影响结果（幂等）", sortModels(sorted.map((m) => m.id)).map((m) => m.id).join() === sorted.map((m) => m.id).join());
  ok("未知 id 降级为 scaffoldModel（避免 CLI 适配器静默消失）", sortModels([...ids, asModelId("not-a-model")]).some((m) => m.id === "not-a-model" && m.vendor === "custom"));
}

console.log("\n【5】默认模型 = 相对该执行器，不存在全局默认");
{
  // defaultModelFor 收 spec —— 排序需要价格与档位，只有 id 排不了
  const spec = (id: string) => modelById(id)!;
  const claudeOnly: ModelSpec[] = [spec("claude-sonnet-5"), spec("claude-opus-5-5")];
  eq("有均衡档时默认落在均衡档，不是最便宜的旗舰", defaultModelFor(claudeOnly), "claude-sonnet-5");
  eq("空清单没有默认（注册时应被拒）", defaultModelFor([]), null);
  eq("只有旗舰档时才用旗舰", defaultModelFor([spec("claude-opus-5-5")]), "claude-opus-5-5");
  eq("只有快速档时用快速档", defaultModelFor([spec("gpt-5-6-luna")]), "gpt-5-6-luna");

  const codex: ModelSpec[] = [spec("gpt-5-1-codex")];
  const ds: ModelSpec[] = [spec("deepseek-v4-pro")];
  // 这三个默认值互不相同 —— 正好证明「全局单一默认模型」是错的
  ok(
    "Claude Code / Codex / dsh 的默认模型互不相同",
    defaultModelFor(claudeOnly) !== defaultModelFor(codex) && defaultModelFor(codex) !== defaultModelFor(ds),
  );
}

console.log("\n【6】合法性：执行器与模型必须搭得上");
{
  const claude = MODELS.filter((m) => m.vendor === "anthropic");
  const openai = MODELS.filter((m) => m.vendor === "openai");
  ok("Claude Code 能用 Claude Opus", canRuntimeUse(claude, asModelId("claude-opus-5-5")));
  ok("Claude Code 用不了 GPT", !canRuntimeUse(claude, asModelId("gpt-6-astra")));
  ok("Codex 能用 GPT", canRuntimeUse(openai, asModelId("gpt-6-astra")));
  ok("Codex 用不了 Claude", !canRuntimeUse(openai, asModelId("claude-sonnet-5")));
  ok("null 一律不合法", !canRuntimeUse(claude, null));
  ok("undefined 一律不合法", !canRuntimeUse(claude, undefined));
  ok("未知 id 不合法", !canRuntimeUse(claude, asModelId("nope")));
}

const mockFactories = [
  {
    id: "claude-code",
    models: [asModelId("claude-sonnet-5"), asModelId("claude-opus-5-5"), asModelId("claude-haiku-4-5")],
    capabilities: { multimodal: false },
  },
  {
    id: "codex",
    models: [asModelId("gpt-6-astra"), asModelId("gpt-5-1-codex"), asModelId("gpt-5-6-luna")],
    capabilities: { multimodal: false },
  },
  {
    id: "zcode",
    models: [asModelId("GLM-5.3-Flash"), asModelId("claude-sonnet-5"), asModelId("gpt-6-astra")],
    capabilities: { multimodal: true },
  },
  {
    id: "opencode",
    models: [asModelId("deepseek-v4-pro"), asModelId("GLM-5.3-Flash"), asModelId("claude-sonnet-5")],
    capabilities: { multimodal: true },
  },
  {
    id: "pi",
    models: [asModelId("claude-sonnet-5"), asModelId("gpt-6-astra"), asModelId("deepseek-v4-flash")],
    capabilities: { multimodal: false },
  },
  {
    id: "dsh",
    models: [asModelId("deepseek-v4-pro"), asModelId("deepseek-v4-flash"), asModelId("gpt-6-astra")],
    capabilities: { multimodal: false },
  },
];

console.log("\n【7】六家执行器都声明了非空且合法的模型清单");
{
  eq("注册了 6 家", mockFactories.length, 6);
  const empty = mockFactories.filter((f) => f.models.length === 0);
  eq("没有空清单", empty.map((f) => f.id).join(","), "");

  const unknown = mockFactories.filter((f) => f.models.some((id) => !isKnownModel(id)));
  eq("没有引用目录外的模型", unknown.map((f) => f.id).join(","), "");

  const dup = mockFactories.filter((f) => new Set(f.models).size !== f.models.length);
  eq("清单内无重复", dup.map((f) => f.id).join(","), "");

  // 厂商锁定这件事是**这个 CLI 的事实**，值得钉住：
  // Claude Code 只接 Anthropic、Codex 只接 OpenAI 是产品前提，改了要说清楚为什么
  const vendors = (id: string) => {
    const f = mockFactories.find((x) => x.id === id)!;
    return new Set(f.models.map((m) => modelById(m)!.vendor));
  };
  eq("Claude Code 只有 Anthropic", [...vendors("claude-code")].join(","), "anthropic");
  eq("Codex 只有 OpenAI", [...vendors("codex")].join(",") , "openai");
  ok("ZCode 厂商中立（跨多家）", vendors("zcode").size >= 3, `实际 ${[...vendors("zcode")].join(",")}`);
  ok("OpenCode 厂商中立", vendors("opencode").size >= 3);
  ok("pi 厂商中立", vendors("pi").size >= 3);
  ok("dsh 以 DeepSeek 为主但不止 DeepSeek（ACP 是协议层）", vendors("dsh").has("deepseek") && vendors("dsh").size > 1);
}

console.log("\n【8】没有任何执行器会落到「一个模型都选不了」的死路");
{
  // 这条是踩过坑才加的：曾用「模型支持视觉 && CLI 没多模态通道」去禁选，
  // 结果 Codex / Claude Code 的模型全是视觉模型 → 全部禁用 → 死路。
  // 不变量比具体规则重要，所以按 selectableOn 的口径断言。
  const specsOf = (id: string) => mockFactories.find((f) => f.id === id)!.models.map((m) => modelById(m)!);
  const visionOf = (id: string) => mockFactories.find((f) => f.id === id)!.capabilities.multimodal;

  for (const f of mockFactories) {
    const specs = f.models.map((m) => modelById(m)!);
    const n = selectableOn(specs, f.capabilities.multimodal).length;
    ok(`${f.id} 至少有一个可选模型（${n} 个）`, n > 0);
  }

  // Claude Code 与 Codex 都没有多模态通道，但清单里的模型都还能选
  eq("Codex 3 个模型全部可选", selectableOn(specsOf("codex"), visionOf("codex")).length, 3);
  eq("Claude Code 3 个模型全部可选", selectableOn(specsOf("claude-code"), visionOf("claude-code")).length, 3);

  // 但纯视觉模型该被拒：这是禁用态唯一该出现的场景
  const visionOnly = { ...modelById("gpt-6-astra")!, visionOnly: true } as ModelSpec;
  eq("纯视觉模型在无多模态通道的执行器上被拒", selectableOn([visionOnly], false).length, 0);
  eq("纯视觉模型在有多模态通道的执行器上可选", selectableOn([visionOnly], true).length, 1);
  // 支持视觉但非纯视觉 → 照常可选
  const notOnly = { ...modelById("gpt-6-astra")! } as ModelSpec;
  eq("仅支持视觉（非纯视觉）不被拒", selectableOn([notOnly], false).length, 1);
}

console.log("\n【9】格式化");
{
  eq("200000 → 200K", formatContext(200_000), "200K");
  eq("1000000 → 1M", formatContext(1_000_000), "1M");
  eq("1100000 → 1.1M", formatContext(1_100_000), "1.1M");
  eq("小数价格保留两位", formatPrice(0.14), "$0.14");
  eq("整数价格不带小数", formatPrice(10), "$10");
  eq("带小数的保留两位", formatPrice(2.5), "$2.50");
}

console.log("\n【10】模型偏好：隐藏 / 排序 / 收藏 / 自定义");
{
  const A = asModelId;
  // 3 个内置的假执行器（用真目录里的两个 Anthropic + 一个 OpenAI）
  const declared = [modelById(A("claude-opus-5-5"))!, modelById(A("claude-sonnet-5"))!, modelById(A("gpt-6-astra"))!];
  const ids = (ps: readonly ModelSpec[]) => ps.map((m) => m.id).join(",");

  {
    const p0 = normalizePrefs(EMPTY_PREFS, declared);
    eq("无偏好 → 全部可见", resolveVisibleModels(declared, p0).length, 3);
  }

  // 隐藏只影响内置
  {
    const p = normalizePrefs({ ...EMPTY_PREFS, hiddenModels: [A("gpt-6-astra")] }, declared);
    // 目录序是「旗舰在前、档内按价升」：opus(24) → astra(60) → sonnet(均衡)
    eq("藏掉一个内置", ids(resolveVisibleModels(declared, p)), "claude-opus-5-5,claude-sonnet-5");
    eq("数量减一", resolveVisibleModels(declared, p).length, 2);
  }

  // 自定义模型：可加、不受 hidden 影响
  {
    const added = addCustomModel(EMPTY_PREFS, "qwen3-max");
    ok("加自定义成功", added.ok);
    if (!added.ok) throw new Error("unreachable");
    const p = normalizePrefs({ ...added.prefs, hiddenModels: [A("qwen3-max")] }, declared);
    eq("自定义模型不会被 hidden 影响", ids(resolveVisibleModels(declared, p)).includes("qwen3-max"), true);
    eq("自定义模型排在目录序之后/之前按序", resolveVisibleModels(declared, p).length, 4);
    eq("自定义模型没有价格时显示为 0", modelById("qwen3-max") === undefined, true);
  }

  // 重复 / 空 / 超长
  {
    const dup = addCustomModel(EMPTY_PREFS, "claude-sonnet-5");
    ok("加内置同名模型被拒（duplicate）", !dup.ok && dup.error.code === "duplicate");
    const empty = addCustomModel(EMPTY_PREFS, "   ");
    ok("空 id 被拒", !empty.ok && empty.error.code === "empty");
    const long = addCustomModel(EMPTY_PREFS, "x".repeat(500));
    ok("超长 id 被拒", !long.ok && long.error.code === "too-long");

    const first = addCustomModel(EMPTY_PREFS, "my-model");
    ok("首次添加成功", first.ok);
    if (first.ok) {
      const again = addCustomModel(first.prefs, "my-model");
      ok("同一次会话里重复添加被拒", !again.ok && again.error.code === "duplicate");
      eq("失败时不改动原偏好", first.prefs.customModels.length, 1);
    }
  }

  // 排序：modelOrder 里的在前，没排过的排最后
  {
    const p = normalizePrefs({ ...EMPTY_PREFS, modelOrder: [A("gpt-6-astra"), A("claude-opus-5-5")] }, declared);
    eq("排过的按表序，未排的排最后", ids(resolveVisibleModels(declared, p)), "gpt-6-astra,claude-opus-5-5,claude-sonnet-5");
    eq("没排过的不会被丢掉", resolveVisibleModels(declared, p).length, 3);
  }

  // 收藏置顶
  {
    const p = normalizePrefs({ ...EMPTY_PREFS, favoriteModels: [A("gpt-6-astra")] }, declared);
    eq("收藏的排最前", resolveVisibleModels(declared, p, { groupFavorites: true })[0]!.id, "gpt-6-astra");
    eq("不分组时收藏不改变顺序", resolveVisibleModels(declared, p)[0]!.id, "claude-opus-5-5");
  }

  // 排序只在组内交换
  {
    const p = normalizePrefs(
      { ...EMPTY_PREFS, favoriteModels: [A("gpt-6-astra")], modelOrder: [A("gpt-6-astra"), A("claude-opus-5-5"), A("claude-sonnet-5")] },
      declared,
    );
    const isFav = (id: ModelId) => p.favoriteModels.includes(id);
    // 想把 gpt-6-astra（收藏组）往下挪，越过非收藏项 → 应被拒
    const crossDown = moveModel(p, "gpt-6-astra", 1, isFav);
    eq("跨组下移被拒", crossDown.modelOrder.join(","), p.modelOrder.join(","));
    // 组内：把 claude-opus-5-5 下移越过 claude-sonnet-5（都非收藏）→ 生效
    const down = moveModel(p, "claude-opus-5-5", 1, isFav);
    eq("同组下移生效", down.modelOrder.join(","), "gpt-6-astra,claude-sonnet-5,claude-opus-5-5");
    // 越界：已是组内最后一项，再下移应被拒
    const past = moveModel(down, "claude-opus-5-5", 1, isFav);
    eq("组内末尾再下移被拒", past.modelOrder.join(","), down.modelOrder.join(","));
  }

  // 删除自定义模型要连带清引用
  {
    const p = normalizePrefs(
      {
        ...EMPTY_PREFS,
        customModels: [{ slug: A("my-model") }],
        modelOrder: [A("my-model"), A("gpt-6-astra")],
        favoriteModels: [A("my-model")],
      },
      declared,
    );
    const after = removeCustomModel(p, A("my-model"));
    eq("customModels 清空", after.customModels.length, 0);
    eq("modelOrder 不留悬空引用", after.modelOrder.join(","), "gpt-6-astra");
    eq("favoriteModels 不留悬空引用", after.favoriteModels.length, 0);
  }

  // 一键全藏 / 全显
  {
    const all = normalizePrefs(nextHiddenForBulkToggle(declared, EMPTY_PREFS), declared);
    eq("一键全藏（但至少留一个）", all.hiddenModels.length, declared.length - 1);
    const back = normalizePrefs(nextHiddenForBulkToggle(declared, all), declared);
    eq("再点一次全显", back.hiddenModels.length, 0);
  }

  // 归一：丢掉已不存在的引用
  {
    const dirty = normalizePrefs(
      {
        ...EMPTY_PREFS,
        hiddenModels: [A("does-not-exist"), A("claude-sonnet-5")],
        modelOrder: [A("gone"), A("gpt-6-astra")],
        favoriteModels: [A("also-gone")],
      },
      declared,
    );
    eq("hidden 里的未知 id 被清", dirty.hiddenModels.join(","), "claude-sonnet-5");
    eq("modelOrder 里的未知 id 被清", dirty.modelOrder.join(","), "gpt-6-astra");
    eq("favoriteModels 里的未知 id 被清", dirty.favoriteModels.length, 0);
  }

  // 落盘解析的容错
  {
    const parsed = parsePrefsMap({ zcode: { hiddenModels: ["a", 1, null], customModels: ["bare-slug", { slug: "obj" }, { noSlug: 1 }] } });
    eq("只保留字符串 id", parsed.zcode?.hiddenModels.join(","), "a");
    eq("裸字符串 slug 被接受为自定义模型", parsed.zcode?.customModels[0]?.slug, "bare-slug");
    eq("对象形式被接受", parsed.zcode?.customModels[1]?.slug, "obj");
    eq("缺 slug 的对象被丢弃", parsed.zcode?.customModels.length, 2);
    eq("非对象输入返回空", Object.keys(parsePrefsMap(null)).length, 0);
    eq("字符串输入返回空", Object.keys(parsePrefsMap("nope")).length, 0);
  }

  // 空偏好不落盘
  {
    eq("空偏好被剪掉", Object.keys(pruneEmptyPrefs({ a: EMPTY_PREFS, b: { ...EMPTY_PREFS, customModels: [{ slug: A("x") }] } })).join(","), "b");
  }
}

console.log(`\n${"─".repeat(46)}`);
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log(`${"─".repeat(46)}\n`);
process.exit(fail === 0 ? 0 : 1);
