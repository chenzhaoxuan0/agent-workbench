/**
 * codex 模型目录 —— 清单级读/写 CLI 自己的 model-catalogs 文件。
 *
 * 机制（与 cc-switch 同源）：`~/.codex/config.toml` 顶层键 `model_catalog_json`
 * 指向一份 JSON 目录（`{ "models": [...] }`，条目含 slug / display_name /
 * context_window / supported_reasoning_levels / visibility / priority…）。
 * codex 每个新进程（TUI 重启、`codex debug models`）启动时读一次 —— 目录里
 * 没有的内置模型仍由 codex 自带，同名 slug 的条目**覆盖**内置。
 *
 * 两条原则：
 *  1. **尊重现有指针**：config.toml 已指向某份目录（哪怕是 cc-switch 生成的
 *     ccs-*.json）就在那份文件上就地编辑，不抢指针、不改别人文件名；
 *     是外部工具管的文件时如实上报 managedByExternal，让 UI 提示
 *     「对方重新生成会覆盖你的编辑」。
 *  2. **条目级保留**：编辑只改认识的键，条目里其余字段（model_messages /
 *     service_tiers / priority…）原样随行写回 —— 不认识的键不是我们的就别动。
 *
 * 未配置目录时：read 用 `codex debug models` 的当前生效清单作种子（保存才创建
 * 工作台自己的目录文件并接管指针）—— 用户看到的初始表就是真实清单，不是空表。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ModelCatalogEntry, ModelCatalogInfo, ModelCatalogWriteRow } from "./types.ts";
import {
  atomicWriteText,
  codexConfigPath,
  codexHome,
  patchTomlTopLevel,
  readTomlTopLevel,
} from "./model-defaults.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

/** 工作台接管时创建的目录文件（相对 codex home；名字避开 cc-switch 的 ccs-* 习惯） */
const AWB_CATALOG_REL = "model-catalogs/agent-workbench-catalog.json";

/** 原始目录条目（宽松类型）：值原样保留，只改认识的键 */
type RawEntry = Record<string, unknown> & { slug?: string };

interface RawCatalog {
  models?: RawEntry[];
}

function catalogRefFromConfig(): string | null {
  const configPath = codexConfigPath();
  if (!existsSync(configPath)) return null;
  const ref = readTomlTopLevel(readFileSync(configPath, "utf8"), "model_catalog_json");
  return ref === "" ? null : ref;
}

function catalogPathOf(ref: string): string {
  return isAbsolute(ref) ? ref : join(codexHome(), ref);
}

/** 是否外部工具（cc-switch）生成并管理的目录文件 —— 就地编辑可以，但要提示会被重生成 */
function externalManagerOf(path: string): string | undefined {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  if (/^ccs-/i.test(name)) return "cc-switch";
  return undefined;
}

function readRawCatalog(path: string): RawCatalog {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RawCatalog;
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.models)) return parsed;
  } catch (err: unknown) {
    log.debug("codex 目录文件解析失败，按无目录处理", { path, error: err instanceof Error ? err.message : err });
  }
  return {};
}

/** 原始条目 → 可编辑条目（effort 对象/字符串都归一成 effort id 列表） */
function normalizeEntry(raw: RawEntry): ModelCatalogEntry | null {
  const slug = typeof raw.slug === "string" ? raw.slug : "";
  if (slug === "") return null;
  const efforts = Array.isArray(raw.supported_reasoning_levels)
    ? raw.supported_reasoning_levels
        .map((r) =>
          typeof r === "string"
            ? r
            : typeof r === "object" && r !== null && "effort" in r
              ? String((r as { effort: unknown }).effort)
              : "",
        )
        .filter((s) => s !== "")
    : undefined;
  const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities.map(String) : undefined;
  return {
    slug,
    display_name: typeof raw.display_name === "string" ? raw.display_name : slug,
    context_window: typeof raw.context_window === "number" ? raw.context_window : undefined,
    supported_reasoning_levels: efforts !== undefined && efforts.length > 0 ? efforts : undefined,
    default_reasoning_level: typeof raw.default_reasoning_level === "string" ? raw.default_reasoning_level : undefined,
    visibility: typeof raw.visibility === "string" && raw.visibility !== "" ? raw.visibility : "list",
    multimodal: modalities !== undefined ? modalities.includes("image") : undefined,
  };
}

/** debug models 输出 → 种子条目（未配置目录时的「当前生效清单」副本） */
async function effectiveEntries(): Promise<ModelCatalogEntry[]> {
  try {
    const cmd = await resolveCommand("codex");
    const out = await execLines(cmd, ["debug", "models"], 8000);
    const parsed = JSON.parse(out) as RawCatalog;
    const entries: ModelCatalogEntry[] = [];
    for (const raw of parsed.models ?? []) {
      const e = normalizeEntry(raw);
      if (e !== null) entries.push(e);
    }
    return entries;
  } catch (err: unknown) {
    log.debug("codex debug models 失败，未配置目录时给空种子", { error: err instanceof Error ? err.message : err });
    return [];
  }
}

/** debug models 的**原始**条目数组（新条目的模板来源；normalize 只用于界面形态） */
async function rawEffectiveModels(): Promise<RawEntry[]> {
  try {
    const cmd = await resolveCommand("codex");
    const out = await execLines(cmd, ["debug", "models"], 8000);
    const parsed = JSON.parse(out) as RawCatalog;
    return parsed.models ?? [];
  } catch {
    return [];
  }
}

export async function readCodexModelCatalog(): Promise<ModelCatalogInfo> {
  const ref = catalogRefFromConfig();
  if (ref === null) {
    return {
      activePath: null,
      note: "尚未配置模型目录（codex 用内置清单）—— 下表是当前生效清单的副本，保存将创建工作台目录并接管 config.toml 的 model_catalog_json。",
      entries: await effectiveEntries(),
    };
  }
  const path = catalogPathOf(ref);
  const raw = readRawCatalog(path);
  const entries: ModelCatalogEntry[] = [];
  for (const r of raw.models ?? []) {
    const e = normalizeEntry(r);
    if (e !== null) entries.push(e);
  }
  const external = externalManagerOf(path);
  return {
    activePath: path,
    note: "保存写回这份正在生效的目录文件，codex 新进程（TUI 重启 / 模型刷新）即生效；隐藏的模型不再出现在选择面，删掉的条目回落 codex 内置。",
    entries,
    ...(external !== undefined ? { managedByExternal: external } : {}),
  };
}

/**
 * 提交编辑：按行重建 models 数组 —— 表里没出现的旧条目视为删除（内置同名模型
 * 会重新回到 codex 自带清单）。编辑已有条目时其余字段（model_messages / priority…）
 * 随行保留；推理档位尽量保留原对象的描述，只按新清单增删。
 */
export async function writeCodexModelCatalog(rows: readonly ModelCatalogWriteRow[]): Promise<ModelCatalogInfo> {
  // 先整体校验：slug 空/重复直接拒，不写半份目录
  const seen = new Set<string>();
  for (const r of rows) {
    const slug = r.slug.trim();
    if (slug === "") throw new Error("模型 slug 不能为空");
    if (seen.has(slug)) throw new Error(`模型 slug 重复：${slug}`);
    seen.add(slug);
  }

  const configPath = codexConfigPath();
  const ref = catalogRefFromConfig();
  const target = ref !== null ? catalogPathOf(ref) : catalogPathOf(AWB_CATALOG_REL);
  const priorRaw = new Map<string, RawEntry>();
  for (const r of readRawCatalog(target).models ?? []) {
    if (typeof r.slug === "string") priorRaw.set(r.slug, r);
  }

  const out: RawEntry[] = [];
  // 新条目（目录里没有同源条目的）从模板克隆：codex 的条目结构必填字段一大串
  //（shell_type / priority / support_verbosity / model_messages…，e2e 逐个试出来的），
  // 手拼最小对象永远追不上版本；拿一份真实条目当模板、只覆写我们要改的键，
  // 结构永远合法。模板优先取当前目录的第一条，目录为空退 codex 内置清单第一条。
  let tpl: RawEntry | undefined = priorRaw.values().next().value;
  if (tpl === undefined) tpl = (await rawEffectiveModels())[0];
  const hasNew = rows.some((r) => priorRaw.get((r.origSlug ?? r.slug).trim()) === undefined);
  if (tpl === undefined && hasNew) {
    throw new Error("没有可用的条目模板（当前目录为空且 codex debug models 不可用）—— 先装好 codex 或在已有条目的基础上新增");
  }
  for (const row of rows) {
    const slug = row.slug.trim();
    const base = priorRaw.get((row.origSlug ?? slug).trim());
    const next: RawEntry = base !== undefined ? { ...base } : { ...(tpl as RawEntry) };
    next.slug = slug;
    next.display_name = row.display_name.trim() !== "" ? row.display_name.trim() : slug;
    // codex 只认 list/hide/none —— 写非法变体会让它拒掉**整份**目录（e2e 实测），
    // 所以这里白名单归一，而不是原样透传提交值
    next.visibility =
      row.visibility === "hide" || row.visibility === "none"
        ? row.visibility
        : row.visibility === "hidden"
          ? "hide"
          : "list";
    if (row.context_window !== undefined && Number.isFinite(row.context_window) && row.context_window > 0) {
      next.context_window = row.context_window;
    } else {
      delete next.context_window;
    }
    if (row.default_reasoning_level !== undefined && row.default_reasoning_level !== "") {
      next.default_reasoning_level = row.default_reasoning_level;
    } else {
      delete next.default_reasoning_level;
    }
    if (row.supported_reasoning_levels !== undefined && row.supported_reasoning_levels.length > 0) {
      // codex 要求档位是 ReasoningEffortPreset **结构体**，且 description 必填
      // （e2e 实测：纯字符串或缺 description 都会让它拒掉整份目录）。原条目能对上
      // effort 的保留整个对象（含描述），新档位合成最小合法对象。
      const priorEfforts = Array.isArray(base?.supported_reasoning_levels)
        ? (base!.supported_reasoning_levels as unknown[])
        : [];
      next.supported_reasoning_levels = row.supported_reasoning_levels.map((id) => {
        const hit = priorEfforts.find(
          (e) => typeof e === "object" && e !== null && String((e as { effort?: unknown }).effort) === id,
        );
        return hit ?? { effort: id, description: "" };
      });
    } else {
      delete next.supported_reasoning_levels;
    }
    if (row.multimodal !== undefined) {
      next.input_modalities = row.multimodal ? ["text", "image"] : ["text"];
    }
    out.push(next);
  }

  atomicWriteText(target, `${JSON.stringify({ models: out }, null, 2)}\n`);

  // 未配置目录（首次保存）：把指针指向工作台目录。只在 ref 为空时写 —— 已有指针
  // 一律不动，哪怕它指向别家工具的文件（就地编辑，不抢）。
  if (ref === null) {
    const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    atomicWriteText(
      configPath,
      patchTomlTopLevel(text, new Map([["model_catalog_json", JSON.stringify(AWB_CATALOG_REL)]])),
    );
  }
  return readCodexModelCatalog();
}
