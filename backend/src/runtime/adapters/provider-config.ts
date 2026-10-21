/**
 * pi / opencode 的供应商级配置 —— cc-switch「累加式」同款：多家供应商共存于
 * CLI 自己的原生配置文件，写入 = 单条目 patch，其余条目与用户的其他键不碰。
 *
 * - pi：`~/.pi/agent/models.json`（PI_CODING_AGENT_DIR 可重定向）的
 *   `providers.<key> = { name, baseUrl, api, apiKey, models: [{id, …}] }`。
 *   保存后 `pi --list-models` 即列出这些模型（闭环可验）。
 * - opencode：`~/.config/opencode/opencode.json(c)` 的 `provider`（V1）/
 *   `providers`（V2）段。V1 最小条目 `{ npm: "@ai-sdk/openai-compatible",
 *   options: { baseURL, apiKey }, models: { <id>: { name } } }`；机器上实际
 *   在用的就是这个形态。保存后 serve `/model` 即列出。
 *
 * 条目级保留：编辑已有供应商时，条目里我们没暴露的字段（headers / compat /
 * sdkOption 一类）原样随行写回；模型条目按 id 匹配保留原有附加字段。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeProvidersInfo, ProviderEntry, ProviderWriteRow } from "./types.ts";
import { atomicWriteText } from "./model-defaults.ts";

// ---- 通用 JSON 条目 patch ----------------------------------------------------------

type RawObj = Record<string, unknown>;

function readJsonObj(path: string): RawObj {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} 不是 JSON 对象，拒绝改写（人工确认后再试）`);
  }
  return { ...(parsed as RawObj) };
}

function writeJsonObj(path: string, obj: RawObj): void {
  atomicWriteText(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/** 内部行：公共提交行 + 每家 CLI 的映射参数（api 字段名 / models 结构重建） */
interface InternalRow extends ProviderWriteRow {
  apiField: string;
  buildModels(prior: unknown): unknown;
}

/** 把提交行并进某个 providers 段：单条目 patch + 未知字段保留，表里没出现的条目删除 */
function patchProviderSection(
  root: RawObj,
  section: "provider" | "providers",
  rows: readonly InternalRow[],
): RawObj {
  const prior = (root[section] && typeof root[section] === "object" ? { ...(root[section] as RawObj) } : {}) as RawObj;
  const priorModels = (key: string): unknown => {
    const e = prior[key];
    return typeof e === "object" && e !== null ? (e as RawObj)["models"] : undefined;
  };
  const next: RawObj = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const base = prior[(row.origKey ?? key).trim()];
    const entry: RawObj = typeof base === "object" && base !== null ? { ...(base as RawObj) } : {};
    entry["name"] = row.name.trim() !== "" ? row.name.trim() : key;
    const urls = row.baseUrl.trim();
    if (urls !== "") entry["baseUrl"] = urls;
    else delete entry["baseUrl"];
    if (row.apiKey.trim() !== "") entry["apiKey"] = row.apiKey.trim();
    else delete entry["apiKey"];
    if (row.api.trim() !== "") entry[row.apiField] = row.api.trim();
    else delete entry[row.apiField];
    if (row.models.length > 0) entry["models"] = row.buildModels(priorModels((row.origKey ?? key).trim()));
    else delete entry["models"];
    next[key] = entry;
    seen.add(key);
  }
  // 删除语义：表里没出现的旧条目不写入（被移除）
  root[section] = next;
  return root;
}

// ---- pi ---------------------------------------------------------------------------

export function piAgentDir(): string {
  const env = process.env["PI_CODING_AGENT_DIR"];
  return env && env.trim() !== "" ? env : join(homedir(), ".pi", "agent");
}

export function piModelsJsonPath(): string {
  return join(piAgentDir(), "models.json");
}

export function readPiProviders(): NativeProvidersInfo {
  const path = piModelsJsonPath();
  const root = existsSync(path) ? readJsonObj(path) : {};
  const section = (typeof root["providers"] === "object" && root["providers"] !== null ? root["providers"] : {}) as RawObj;
  const providers: ProviderEntry[] = [];
  for (const [key, raw] of Object.entries(section)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as RawObj;
    providers.push({
      key,
      name: typeof e["name"] === "string" ? e["name"] : key,
      baseUrl: typeof e["baseUrl"] === "string" ? e["baseUrl"] : "",
      apiKey: typeof e["apiKey"] === "string" ? e["apiKey"] : "",
      api: typeof e["api"] === "string" ? e["api"] : "",
      models: Array.isArray(e["models"])
        ? e["models"].map((m) => (typeof m === "object" && m !== null ? String((m as RawObj)["id"] ?? "") : "")).filter((s) => s !== "")
        : [],
    });
  }
  return {
    configPath: path,
    note: "写入 pi 自己的 models.json（providers 段，多家共存）—— 保存后「探测模型」即列出这些模型（pi --list-models 读同一份文件）。",
    providers,
  };
}

export function writePiProviders(rows: readonly ProviderWriteRow[]): NativeProvidersInfo {
  const path = piModelsJsonPath();
  const root = existsSync(path) ? readJsonObj(path) : {};
  const patched = patchProviderSection(root, "providers", rows.map((r): InternalRow => ({
    ...r,
    apiField: "api",
    // pi 的 models 是数组：按 id 保留旧条目的附加字段（compat 一类），新 id 建最小条目
    buildModels: (prior): unknown[] =>
      r.models.map((id) => {
        const hit = Array.isArray(prior)
          ? prior.find((m) => typeof m === "object" && m !== null && String((m as RawObj)["id"]) === id)
          : undefined;
        return hit ?? { id };
      }),
  })));
  writeJsonObj(path, patched);
  return readPiProviders();
}

// ---- opencode ----------------------------------------------------------------------

export function opencodeConfigDir2(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "opencode");
}

function opencodeConfigFile(): { path: string; existed: boolean } {
  const dir = opencodeConfigDir2();
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(jsonc)) return { path: jsonc, existed: true };
  return { path: join(dir, "opencode.json"), existed: existsSync(join(dir, "opencode.json")) };
}

export function readOpencodeProviders(): NativeProvidersInfo {
  const { path, existed } = opencodeConfigFile();
  if (!existed) {
    return { configPath: path, note: "尚未找到 opencode 配置 —— 保存将创建它并写入 provider 段（V1 兼容形态）。", providers: [] };
  }
  let root: RawObj;
  try {
    root = readJsonObj(path);
  } catch {
    return {
      configPath: path,
      note: `${path} 含注释（JSONC）或不是合法 JSON —— 为不丢你的注释，暂不支持就地编辑。`,
      providers: [],
      managedByExternal: "注释文件",
    };
  }
  const useV2 = typeof root["providers"] === "object" && root["providers"] !== null;
  const section = (useV2 ? root["providers"] : root["provider"] ?? {}) as RawObj;
  const providers: ProviderEntry[] = [];
  for (const [key, raw] of Object.entries(section)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as RawObj;
    const opts = (typeof e["options"] === "object" && e["options"] !== null ? e["options"] : {}) as RawObj;
    providers.push({
      key,
      name: typeof e["name"] === "string" ? e["name"] : key,
      baseUrl: typeof opts["baseURL"] === "string" ? opts["baseURL"] : "",
      apiKey: typeof opts["apiKey"] === "string" ? opts["apiKey"] : "",
      api: typeof e["npm"] === "string" ? e["npm"] : "",
      models: typeof e["models"] === "object" && e["models"] !== null && !Array.isArray(e["models"])
        ? Object.keys(e["models"] as RawObj)
        : [],
    });
  }
  return {
    configPath: path,
    note: `写入 opencode 配置的 ${useV2 ? "providers（V2）" : "provider（V1 兼容）"} 段 —— 保存后「探测模型」即列出（serve /model 读同一份文件）。模型 id 就是 "供应商/模型" 的后半段。`,
    providers,
  };
}

export function writeOpencodeProviders(rows: readonly ProviderWriteRow[]): NativeProvidersInfo {
  const { path } = opencodeConfigFile();
  const root = existsSync(path) ? readJsonObj(path) : {};
  const useV2 = typeof root["providers"] === "object" && root["providers"] !== null;
  const section = useV2 ? "providers" : "provider";
  const patched = patchProviderSection(root, section, rows.map((r): InternalRow => ({
    ...r,
    // opencode 无 api 字段；api 输入框在这个卡里当 npm 包名用（默认 openai-compatible）
    apiField: "npm",
    api: r.api.trim() !== "" ? r.api : "@ai-sdk/openai-compatible",
    buildModels: (prior): RawObj => {
      const out: RawObj = {};
      const priorObj = (prior && !Array.isArray(prior) ? prior : {}) as RawObj;
      for (const id of r.models) {
        const hit = priorObj[id];
        out[id] = typeof hit === "object" && hit !== null ? hit : { name: id };
      }
      return out;
    },
  })));
  // V1 条目把 baseURL/apiKey 放进 options（patchProviderSection 写在了顶层）
  for (const row of rows) {
    const entry = ((patched[section] as RawObj) ?? {})[row.key.trim()] as RawObj | undefined;
    if (entry === undefined) continue;
    const opts = { ...(typeof entry["options"] === "object" && entry["options"] !== null ? entry["options"] : {}) } as RawObj;
    if (entry["baseUrl"] !== undefined) {
      opts["baseURL"] = entry["baseUrl"];
      delete entry["baseUrl"];
    }
    if (entry["apiKey"] !== undefined) {
      opts["apiKey"] = entry["apiKey"];
      delete entry["apiKey"];
    }
    entry["options"] = opts;
  }
  writeJsonObj(path, patched);
  return readOpencodeProviders();
}
