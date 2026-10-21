/**
 * 冒烟：执行器原生模型默认值 —— claude settings.json / codex config.toml 的字段级补丁。
 *
 * 全程在临时目录里造假配置（USERPROFILE / CODEX_HOME 重定向），绝不碰真的
 * ~/.claude 与 ~/.codex。验证三件事：
 *   1. 我们的键写进去了、清空即删键；
 *   2. 用户自己的键（permissions / hooks / 表 / 注释）原样保留 —— 字段级补丁不是整份覆盖；
 *   3. 非法值（小数 token、未知档位）整体拒绝，不留半份配置。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClaudeModelDefaults,
  readCodexModelDefaults,
  writeClaudeModelDefaults,
  writeCodexModelDefaults,
  patchYamlSectionScalars,
  patchYamlTopLevelScalars,
  readHermesModelDefaults,
  readMcodeModelDefaults,
  readOpencodeModelDefaults,
  writeHermesModelDefaults,
  writeMcodeModelDefaults,
  writeOpencodeModelDefaults,
} from "../src/runtime/adapters/model-defaults.ts";
import { readCodexModelCatalog, writeCodexModelCatalog } from "../src/runtime/adapters/codex-catalog.ts";
import { readPiProviders, writePiProviders, readOpencodeProviders, writeOpencodeProviders } from "../src/runtime/adapters/provider-config.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.info(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` —— ${detail}` : ""}`);
  }
}

// ---- claude：settings.json 的 env 补丁 --------------------------------------------------

const fakeHome = mkdtempSync(join(tmpdir(), "awb-claude-"));
// node:os 的 homedir() 在 Windows 上按调用时读 USERPROFILE，unix 读 HOME —— 两个都指过去
process.env["USERPROFILE"] = fakeHome;
process.env["HOME"] = fakeHome;
mkdirSync(join(fakeHome, ".claude"), { recursive: true });
const settingsPath = join(fakeHome, ".claude", "settings.json");
writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      // 用户键：补丁绝不能碰
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-model",
      },
    },
    null,
    2,
  ),
);

console.info("claude settings.json 补丁：");
const claudeWritten = writeClaudeModelDefaults({
  defaultModel: "kimi-for-coding",
  sonnetModel: "new-model",
  maxContextTokens: "262144",
  haikuModel: "",
});
const claudeAfter = JSON.parse(readFileSync(settingsPath, "utf8")) as {
  permissions?: unknown;
  hooks?: unknown;
  env?: Record<string, string>;
};
check("默认模型写入 env.ANTHROPIC_MODEL", claudeAfter.env?.["ANTHROPIC_MODEL"] === "kimi-for-coding");
check("档位模型覆盖 env.ANTHROPIC_DEFAULT_SONNET_MODEL", claudeAfter.env?.["ANTHROPIC_DEFAULT_SONNET_MODEL"] === "new-model");
check("窗口键写入 env.CLAUDE_CODE_MAX_CONTEXT_TOKENS", claudeAfter.env?.["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] === "262144");
check("用户键 permissions 原样保留", claudeAfter.permissions !== undefined);
check("用户键 hooks 原样保留", claudeAfter.hooks !== undefined);
check("用户 env.ANTHROPIC_BASE_URL 原样保留", claudeAfter.env?.["ANTHROPIC_BASE_URL"] === "https://gw.example");
check("返回值与文件一致（读回闭环）", claudeWritten.fields.find((f) => f.key === "defaultModel")?.value === "kimi-for-coding");

const claudeCleared = writeClaudeModelDefaults({ maxContextTokens: "" });
const claudeClearedEnv = (JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: Record<string, string> }).env ?? {};
check("清空 = 删键（CLAUDE_CODE_MAX_CONTEXT_TOKENS 消失）", claudeClearedEnv["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] === undefined);
check("未提交的键不动（ANTHROPIC_MODEL 保留）", claudeClearedEnv["ANTHROPIC_MODEL"] === "kimi-for-coding");
check("读接口同样看得到清除", claudeCleared.fields.find((f) => f.key === "maxContextTokens")?.value === "");

let rejected = false;
try {
  writeClaudeModelDefaults({ maxContextTokens: "12.5" });
} catch {
  rejected = true;
}
check("非法 token 数（小数）整体拒绝", rejected);

// 空目录（settings.json 不存在）也能直接建
const fakeHomeEmpty = mkdtempSync(join(tmpdir(), "awb-claude-empty-"));
process.env["USERPROFILE"] = fakeHomeEmpty;
process.env["HOME"] = fakeHomeEmpty;
const claudeFresh = writeClaudeModelDefaults({ defaultModel: "m1" });
const freshParsed = JSON.parse(readFileSync(join(fakeHomeEmpty, ".claude", "settings.json"), "utf8")) as { env?: Record<string, string> };
check("settings.json 不存在时新建并只写目标键", freshParsed.env?.["ANTHROPIC_MODEL"] === "m1" && Object.keys(freshParsed).length === 1);

// ---- codex：config.toml 顶层键补丁 -------------------------------------------------------

const fakeCodexHome = mkdtempSync(join(tmpdir(), "awb-codex-"));
process.env["CODEX_HOME"] = fakeCodexHome;
const tomlPath = join(fakeCodexHome, "config.toml");
writeFileSync(
  tomlPath,
  [
    "# 用户注释 —— 补丁必须保留",
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "NewAPI"',
    'base_url = "https://example/v1"',
    "",
  ].join("\n"),
);

console.info("codex config.toml 补丁：");
const codexWritten = writeCodexModelDefaults({
  model: "gpt-6",
  reasoningEffort: "high",
  contextWindow: "1000000",
});
const toml = readFileSync(tomlPath, "utf8");
check("顶层 model 替换", /^model = "gpt-6"$/m.test(toml));
check("新增 model_reasoning_effort 插在顶层区", /^model_reasoning_effort = "high"$/m.test(toml) && toml.indexOf("model_reasoning_effort") < toml.indexOf("[model_providers.custom]"));
check("新增 model_context_window 为裸数字", /^model_context_window = 1000000$/m.test(toml));
check("用户注释保留", toml.includes("# 用户注释 —— 补丁必须保留"));
check("用户顶层键 model_provider 保留", /^model_provider = "custom"$/m.test(toml));
check("[model_providers.custom] 表完整保留", toml.includes("[model_providers.custom]") && toml.includes('name = "NewAPI"'));
check("返回值与文件一致（读回闭环）", codexWritten.fields.find((f) => f.key === "model")?.value === "gpt-6");

const codexCleared = writeCodexModelDefaults({ model: "" });
const tomlCleared = readFileSync(tomlPath, "utf8");
check("清空 model = 删行", !/^model\s*=/m.test(tomlCleared));
check("其余键保留", /^model_reasoning_effort = "high"$/m.test(tomlCleared));
check("读接口看得到清除", codexCleared.fields.find((f) => f.key === "model")?.value === "");

let enumRejected = false;
try {
  writeCodexModelDefaults({ reasoningEffort: "ultra" });
} catch {
  enumRejected = true;
}
check("未知思考档位整体拒绝", enumRejected);

// config.toml 不存在 → 新建只含目标键
const fakeCodexEmpty = mkdtempSync(join(tmpdir(), "awb-codex-empty-"));
process.env["CODEX_HOME"] = fakeCodexEmpty;
writeCodexModelDefaults({ model: "gpt-6" });
const tomlFresh = readFileSync(join(fakeCodexEmpty, "config.toml"), "utf8");
check("config.toml 不存在时新建", tomlFresh === 'model = "gpt-6"\n');

// ---- codex：model-catalogs 目录编辑 ------------------------------------------------------

console.info("codex 模型目录：");
const catHome = mkdtempSync(join(tmpdir(), "awb-codex-cat-"));
process.env["CODEX_HOME"] = catHome;
const catDir = join(catHome, "model-catalogs");
mkdirSync(catDir, { recursive: true });
const ccsPath = join(catDir, "ccs-fake123.json");
writeFileSync(
  ccsPath,
  JSON.stringify(
    {
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          context_window: 272000,
          supported_reasoning_levels: [
            { effort: "low", description: "keep me" },
            { effort: "high", description: "keep me too" },
          ],
          visibility: "list",
          priority: 1001,
          model_messages: { instructions_template: "用户内容 —— 必须随行保留" },
          input_modalities: ["text", "image"],
        },
        { slug: "gpt-5.4-mini", display_name: "Mini", visibility: "list" },
      ],
    },
    null,
    2,
  ),
);
writeFileSync(join(catHome, "config.toml"), `model = "gpt-6-astra"\nmodel_catalog_json = "model-catalogs/ccs-fake123.json"\n`);

const catRead = await readCodexModelCatalog();
check("读：就着现有指针（ccs 文件）", catRead.activePath === ccsPath);
check("读：识别外部管理（cc-switch）", catRead.managedByExternal === "cc-switch");
check("读：effort 对象归一成 id 列表", (catRead.entries.find((e) => e.slug === "gpt-6-astra")?.supported_reasoning_levels ?? []).join(",") === "low,high");
check("读：multimodal 从 input_modalities 推出", catRead.entries.find((e) => e.slug === "gpt-6-astra")?.multimodal === true);

// 编辑：改名+改窗口+增档位+隐藏 mini+新增一条+删除…… 这里不删，保留两条并加一条
const catWritten = await writeCodexModelCatalog([
  { origSlug: "gpt-6-astra", slug: "gpt-6-astra", display_name: "GPT-6 改名", context_window: 1000000, supported_reasoning_levels: ["low", "high", "max"], visibility: "list", multimodal: true },
  { origSlug: "gpt-5.4-mini", slug: "gpt-5.4-mini", display_name: "Mini", visibility: "hide" },
  { slug: "my-gateway-model", display_name: "网关模型", context_window: 256000, supported_reasoning_levels: ["medium"], visibility: "list", multimodal: false },
]);
const catFile = JSON.parse(readFileSync(ccsPath, "utf8")) as { models: Array<Record<string, unknown>> };
const astra = catFile.models.find((m) => m.slug === "gpt-6-astra")!;
check("写：显示名与窗口更新", astra.display_name === "GPT-6 改名" && astra.context_window === 1000000);
check("写：已有档位保留原描述对象", Array.isArray(astra.supported_reasoning_levels) && (astra.supported_reasoning_levels as unknown[])[0] !== undefined && typeof (astra.supported_reasoning_levels as { effort?: unknown }[])[0] === "object");
check("写：新档位合成 {effort} 对象补入", (astra.supported_reasoning_levels as unknown[]).some((e) => typeof e === "object" && e !== null && (e as { effort?: unknown }).effort === "max"));
check("写：不认识的字段随行保留（model_messages/priority）", astra.priority === 1001 && typeof astra.model_messages === "object");
check("写：隐藏 = visibility hide", catFile.models.find((m) => m.slug === "gpt-5.4-mini")?.visibility === "hide");
check("写：新增条目落盘", catFile.models.some((m) => m.slug === "my-gateway-model"));
check("写：新增条目从模板克隆必填结构（继承 priority）", catFile.models.find((m) => m.slug === "my-gateway-model")?.priority === 1001);
check("写：指针未被抢动（还是 ccs 文件）", readFileSync(join(catHome, "config.toml"), "utf8").includes("ccs-fake123.json"));
check("写：返回值与文件一致", (catWritten.entries.find((e) => e.slug === "gpt-6-astra")?.context_window ?? 0) === 1000000 && catWritten.entries.length === 3);

// 删除语义：只提交一条 → 其余从目录移除
const catDeleted = await writeCodexModelCatalog([
  { origSlug: "gpt-6-astra", slug: "gpt-6-astra", display_name: "GPT-6 改名", visibility: "list" },
]);
check("删：表里没出现的条目被移除", (JSON.parse(readFileSync(ccsPath, "utf8")) as { models: unknown[] }).models.length === 1);
check("删：读回一致", catDeleted.entries.length === 1 && catDeleted.entries[0]?.slug === "gpt-6-astra");

// 重复 slug 拒绝
let dupRejected = false;
try {
  await writeCodexModelCatalog([
    { slug: "dup", display_name: "a", visibility: "list" },
    { slug: "dup", display_name: "b", visibility: "list" },
  ]);
} catch {
  dupRejected = true;
}
check("重复 slug 整体拒绝", dupRejected);
check("拒绝时文件未被改写", (JSON.parse(readFileSync(ccsPath, "utf8")) as { models: unknown[] }).models.length === 1);

// 未配置目录 → 首次保存创建工作台目录并接管指针
const catHomeFresh = mkdtempSync(join(tmpdir(), "awb-codex-catfresh-"));
process.env["CODEX_HOME"] = catHomeFresh;
const freshRead = await readCodexModelCatalog();
check("未配置目录：activePath 为 null", freshRead.activePath === null);
await writeCodexModelCatalog([{ slug: "only-one", display_name: "Only", visibility: "list" }]);
const freshConfig = readFileSync(join(catHomeFresh, "config.toml"), "utf8");
const freshCatalog = JSON.parse(readFileSync(join(catHomeFresh, "model-catalogs", "agent-workbench-catalog.json"), "utf8")) as { models: string[] };
check("首次保存：接管 model_catalog_json 指针", freshConfig.includes('model_catalog_json = "model-catalogs/agent-workbench-catalog.json"'));
check("首次保存：目录文件就位", freshCatalog.models.length === 1);
rmSync(catHome, { recursive: true, force: true });
rmSync(catHomeFresh, { recursive: true, force: true });

// ---- YAML 标量补丁（mcode / hermes）--------------------------------------------

console.info("YAML 标量补丁：");
const yamlSample = [
  "logLevel: info",
  "provider: { minimax: { name: MiniMax, models: { M3: { limit: { context: 512000 } } } } }",
  "defaultModel: minimax/MiniMax-M3.1-Flash",
  "permissionMode: bypassPermissions",
  "custom_provider:",
  "  minimax-legacy:",
  "    name: MiniMax",
  "    models:",
  "      MiniMax-M2.7:",
  "        name: M2.7",
  "# 用户注释",
].join("\n");
const yamlPatched = patchYamlTopLevelScalars(yamlSample, new Map([
  ["defaultModel", "minimax/MiniMax-M3"],
  ["defaultLightModel", "minimax/MiniMax-M2.7"],
]));
check("YAML 顶层：替换标量键", /^defaultModel: "minimax\/MiniMax-M3"$/m.test(yamlPatched));
check("YAML 顶层：缺失键插到文件头（不落进块映射）", yamlPatched.startsWith('defaultLightModel: "minimax/MiniMax-M2.7"'));
check("YAML 顶层：流式映射整行原样保留", yamlPatched.includes("provider: { minimax:"));
check("YAML 顶层：块映射与其嵌套行原样保留", yamlPatched.includes("custom_provider:") && yamlPatched.includes("        name: M2.7"));
check("YAML 顶层：注释与其他键保留", yamlPatched.includes("# 用户注释") && yamlPatched.includes("logLevel: info"));
const yamlCleared = patchYamlTopLevelScalars(yamlPatched, new Map([["defaultLightModel", null]]));
check("YAML 顶层：清空 = 删行", !/^defaultLightModel:/m.test(yamlCleared) && /^defaultModel: "minimax\/MiniMax-M3"$/m.test(yamlCleared));

const hermesYaml = ["mcp_servers:", "  a:", "    command: node", "display:", "  language: zh"].join("\n");
const hermesCreated = patchYamlSectionScalars(hermesYaml, "model", new Map([["default", "anthropic/claude-opus-4-8"]]));
check("YAML 段：不存在则整段新建", /^model:\n  default: "anthropic\/claude-opus-4-8"$/m.test(hermesCreated));
check("YAML 段：其余段落保留", hermesCreated.includes("mcp_servers:") && hermesCreated.includes("  language: zh"));
const hermesPatched = patchYamlSectionScalars(
  'model:\n  default: "old/model"\n  context_length: 200000\nother: 1\n',
  "model",
  new Map([["default", "new/model"]]),
);
check("YAML 段：已有键就地替换、段内其余键保留", hermesPatched.includes('  default: "new/model"') && hermesPatched.includes("  context_length: 200000"));
const hermesCleared = patchYamlSectionScalars("model:\n  default: \"x/y\"\nother: 1\n", "model", new Map([["default", null]]));
check("YAML 段：清空后空段连段头一起移除", !/^model:/m.test(hermesCleared) && hermesCleared.includes("other: 1"));

// ---- mcode / hermes / opencode：round-trip（临时家目录）-------------------------

console.info("mcode / hermes / opencode 默认模型：");
const mcodeDir = mkdtempSync(join(tmpdir(), "awb-mcode-"));
process.env["MINIMAX_DATA_DIR"] = mcodeDir;
mkdirSync(join(mcodeDir), { recursive: true });
writeFileSync(
  join(mcodeDir, "config.yaml"),
  "provider: { minimax: { models: { M3: { limit: { context: 512000 } } } } }\ndefaultModel: minimax/MiniMax-M3.1-Flash\npermissionMode: bypassPermissions\n",
);
const mcodeWritten = writeMcodeModelDefaults({ defaultModel: "minimax/MiniMax-M3", defaultLightModel: "" });
const mcodeText = readFileSync(join(mcodeDir, "config.yaml"), "utf8");
check("mcode：默认模型写入", /^defaultModel: "minimax\/MiniMax-M3"$/m.test(mcodeText));
check("mcode：流式 provider 行与权限键保留", mcodeText.includes("provider: { minimax:") && mcodeText.includes("permissionMode:"));
check("mcode：读回闭环", mcodeWritten.fields.find((f) => f.key === "defaultModel")?.value === "minimax/MiniMax-M3");
rmSync(mcodeDir, { recursive: true, force: true });

const hermesDir = mkdtempSync(join(tmpdir(), "awb-hermes-"));
process.env["HERMES_HOME"] = hermesDir;
writeFileSync(join(hermesDir, "config.yaml"), "# hermes\nmcp_servers:\n  a:\n    command: node\n");
const hermesWritten = writeHermesModelDefaults({ modelDefault: "openrouter/anthropic/claude-opus-4-8" });
const hermesText = readFileSync(join(hermesDir, "config.yaml"), "utf8");
check("hermes：model 段创建并写入 default", hermesText.includes('model:') && hermesText.includes('  default: "openrouter/anthropic/claude-opus-4-8"'));
check("hermes：注释与 mcp 段保留", hermesText.includes("# hermes") && hermesText.includes("mcp_servers:"));
check("hermes：读回闭环", hermesWritten.fields.find((f) => f.key === "modelDefault")?.value === "openrouter/anthropic/claude-opus-4-8");
rmSync(hermesDir, { recursive: true, force: true });

const ocDir = mkdtempSync(join(tmpdir(), "awb-opencode-"));
process.env["XDG_CONFIG_HOME"] = ocDir;
mkdirSync(join(ocDir, "opencode"), { recursive: true });
writeFileSync(
  join(ocDir, "opencode", "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "zhipuai-coding-plan/glm-4.6", provider: { qwen: { npm: "@ai-sdk/openai-compatible" } } }, null, 2),
);
const ocWritten = writeOpencodeModelDefaults({ model: "qwen/qwen-latest", small_model: "qwen/qwen-latest" });
const ocParsed = JSON.parse(readFileSync(join(ocDir, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
check("opencode：model/small_model 写入", ocParsed["model"] === "qwen/qwen-latest" && ocParsed["small_model"] === "qwen/qwen-latest");
check("opencode：provider 与 $schema 保留", ocParsed["provider"] !== undefined && ocParsed["$schema"] !== undefined);
check("opencode：读回闭环", ocWritten.fields.find((f) => f.key === "model")?.value === "qwen/qwen-latest");
writeOpencodeModelDefaults({ model: "", small_model: "" });
const ocCleared = JSON.parse(readFileSync(join(ocDir, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
check("opencode：清空 = 删键", ocCleared["model"] === undefined && ocCleared["provider"] !== undefined);
rmSync(ocDir, { recursive: true, force: true });

// ---- pi / opencode 供应商 round-trip（临时家目录）-------------------------------

console.info("供应商配置：");
const piDir = mkdtempSync(join(tmpdir(), "awb-pi-"));
process.env["PI_CODING_AGENT_DIR"] = piDir;
mkdirSync(join(piDir), { recursive: true });
writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { old: { name: "Old", baseUrl: "https://old/v1", apiKey: "k1", api: "openai-completions", models: [{ id: "old-m", compat: { keep: true } }] } }, other: 1 }, null, 2));
const piWritten = writePiProviders([
  { origKey: "old", key: "new", name: "改名", baseUrl: "https://new/v1", apiKey: "k2", api: "openai-responses", models: ["old-m", "added-m"] },
]);
const piParsed = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8")) as { providers?: Record<string, Record<string, unknown>>; other?: number };
const piEntry = piParsed.providers?.["new"]!;
check("pi：改名/改 baseURL/加模型", piEntry.baseUrl === "https://new/v1" && Array.isArray(piEntry.models) && (piEntry.models as { id: string }[]).some((m) => m.id === "added-m"));
check("pi：旧模型附加字段保留（compat）", (piEntry.models as { id: string; compat?: unknown }[]).find((m) => m.id === "old-m")?.compat !== undefined);
check("pi：旧键删除 + 其余顶层键保留", piParsed.providers?.["old"] === undefined && piParsed.other === 1);
check("pi：读回闭环", piWritten.providers.length === 1 && piWritten.providers[0]?.key === "new");
rmSync(piDir, { recursive: true, force: true });

const ocDir2 = mkdtempSync(join(tmpdir(), "awb-oc2-"));
process.env["XDG_CONFIG_HOME"] = ocDir2;
mkdirSync(join(ocDir2, "opencode"), { recursive: true });
writeFileSync(join(ocDir2, "opencode", "opencode.json"), JSON.stringify({ model: "keep/model", provider: { qwen: { name: "Qwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://qwen/v1", apiKey: "k" }, models: { "qwen-m": { name: "Qwen M", extra: true } } } } }, null, 2));
const ocProvWritten = writeOpencodeProviders([
  { origKey: "qwen", key: "qwen", name: "Qwen2", baseUrl: "https://qwen2/v1", apiKey: "k2", api: "", models: ["qwen-m", "new-m"] },
]);
const ocProvParsed = JSON.parse(readFileSync(join(ocDir2, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, Record<string, unknown>>; model?: string };
const ocEntry = ocProvParsed.provider?.["qwen"]!;
check("opencode：V1 条目改 baseURL/apiKey 进 options", String((ocEntry.options as Record<string, unknown>)?.baseURL) === "https://qwen2/v1" && String((ocEntry.options as Record<string, unknown>)?.apiKey) === "k2");
check("opencode：模型字典增删 + 旧模型附加字段保留", (ocEntry.models as Record<string, unknown>)["new-m"] !== undefined && ((ocEntry.models as Record<string, { extra?: unknown }>)["qwen-m"]?.extra === true));
check("opencode：顶层 model 等其余键保留", ocProvParsed.model === "keep/model");
check("opencode：读回闭环", ocProvWritten.providers.length === 1 && ocProvWritten.providers[0]?.models.includes("new-m") === true);
rmSync(ocDir2, { recursive: true, force: true });

// ---- 收尾 --------------------------------------------------------------------------------

rmSync(fakeHome, { recursive: true, force: true });
rmSync(fakeHomeEmpty, { recursive: true, force: true });
rmSync(fakeCodexHome, { recursive: true, force: true });
rmSync(fakeCodexEmpty, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.info("\n原生模型默认值冒烟全部通过");
