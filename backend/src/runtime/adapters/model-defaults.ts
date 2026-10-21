/**
 * 执行器原生模型默认值 —— 字段级读写 CLI 自己的配置文件。
 *
 * 做法照抄 cc-switch 的 live patch 原则（src-tauri/src/live/）：
 *   1. **只动认识的键**：写的是字段级补丁，不是文件模板 —— 用户的 hooks /
 *      permissions / MCP / 手写的任何键一律原样保留；
 *   2. **清空 = 删键**：回到 CLI 自己的默认，不写空串（空串对多数键等于非法值）；
 *   3. **原子写**：临时文件 + rename，中途崩溃不会留半份配置。
 *
 * 覆盖两家（与 cc-switch 的优先级一致）：
 *   - claude：`~/.claude/settings.json` 的 `env` 模型映射 + 窗口键。这份文件同时
 *     是 ClaudeAdapter.syncModels 的读取源 —— 写完立刻重读，模型清单马上反映，
 *     「真实生效」有闭环可验；
 *   - codex：`~/.codex/config.toml`（`CODEX_HOME` 可重定向）的顶层 model_* 键。
 *
 * 其余执行器（ACP 系 mcode/dsh/opencode/hermes/kimi）没有文件级模型默认面，
 * 模型参数随每轮 set_config_option 下发，不在此实现。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NativeModelConfig, NativeModelField } from "./types.ts";

/** 原子写：同目录临时文件 + rename（Windows 上 rename 不能跨卷，同目录即同卷） */
export function atomicWriteText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.awb-tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function codexHome(): string {
  return process.env["CODEX_HOME"] || join(homedir(), ".codex");
}

/** 数字字段校验：非空时必须是正整数（token 数没有小数） */
function normalizeNumber(key: string, label: string, raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) throw new Error(`${label} 需要正整数（token 数），收到「${v}」`);
  return v;
}

/** enum 字段校验：非空时必须在声明档位里（config 值写错 CLI 会静默吞掉） */
function normalizeEnum(key: string, label: string, raw: string | undefined, options: readonly string[]): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (!options.includes(v)) throw new Error(`${label} 只支持 ${options.join(" / ")}，收到「${v}」`);
  return v;
}

// ---- claude：~/.claude/settings.json --------------------------------------------------

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** env 键清单。与 ClaudeAdapter.syncModels 读的键一一对应（那边读 ANTHROPIC_DEFAULT_*_MODEL 与 ANTHROPIC_MODEL） */
const CLAUDE_ENV_FIELDS: readonly {
  key: string;
  envKey: string;
  label: string;
  kind: "text" | "number";
  placeholder?: string;
  hint?: string;
}[] = [
  {
    key: "defaultModel",
    envKey: "ANTHROPIC_MODEL",
    label: "默认模型",
    kind: "text",
    placeholder: "如 kimi-for-coding",
    hint: "不带 --model 时的取值；写入后同步模型清单，列表里会标「默认」",
  },
  {
    key: "sonnetModel",
    envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    label: "Sonnet 档位模型",
    kind: "text",
    placeholder: "别名背后的真实模型 id",
    hint: "四档别名映射 —— 工作台的模型清单就从这里读（网关换模型只改这里）；模型 id 末尾加 [1M]/[256K] 后缀即声明窗口大小",
  },
  { key: "opusModel", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus 档位模型", kind: "text" },
  { key: "haikuModel", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku 档位模型", kind: "text" },
  { key: "fableModel", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", label: "Fable 档位模型", kind: "text" },
  // 显示名后缀（ANTHROPIC_DEFAULT_*_MODEL_NAME）：Claude Code 原生键，工作台清单的标签也读它
  {
    key: "sonnetModelName",
    envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    label: "Sonnet 显示名",
    kind: "text",
    placeholder: "如 Kimi K2 · 网关",
    hint: "可选 —— 只改 TUI 与工作台里这一档的显示名，不动实际模型",
  },
  { key: "opusModelName", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", label: "Opus 显示名", kind: "text" },
  { key: "haikuModelName", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", label: "Haiku 显示名", kind: "text" },
  { key: "fableModelName", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", label: "Fable 显示名", kind: "text" },
  {
    key: "maxContextTokens",
    envKey: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    label: "上下文窗口上限",
    kind: "number",
    placeholder: "如 262144",
    hint: "token 数；留空 = 用模型默认窗口",
  },
  {
    key: "autoCompactWindow",
    envKey: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    label: "自动压缩窗口",
    kind: "number",
    placeholder: "如 262144",
    hint: "超过即触发自动 compact，实际取 min(窗口上限, 此值)",
  },
];

interface ClaudeSettingsShape {
  env?: Record<string, string>;
  [k: string]: unknown;
}

function readClaudeSettings(): { parsed: ClaudeSettingsShape; existed: boolean } {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return { parsed: {}, existed: false };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettingsShape;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`~/.claude/settings.json 不是 JSON 对象，拒绝改写（人工确认后再试）`);
  }
  return { parsed, existed: true };
}

function claudeFieldsFromEnv(env: Readonly<Record<string, string>>): NativeModelField[] {
  return CLAUDE_ENV_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    value: env[f.envKey] ?? "",
    placeholder: f.placeholder,
    hint: f.hint,
  }));
}

export function readClaudeModelDefaults(): NativeModelConfig {
  const { parsed } = readClaudeSettings();
  const env = typeof parsed.env === "object" && parsed.env !== null ? parsed.env : {};
  return {
    configPath: claudeSettingsPath(),
    note: "写入 Claude Code 自己的 settings.json（env）—— TUI 与不带模型参数的新会话都用这份默认；工作台模型清单同步读它，保存后自动刷新。",
    fields: claudeFieldsFromEnv(env),
  };
}

export function writeClaudeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
  const byKey = new Map(CLAUDE_ENV_FIELDS.map((f) => [f.key, f]));
  // 先整体校验再落盘：任何一个字段非法都不写半份配置
  const normalized = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(values)) {
    const f = byKey.get(key);
    if (f === undefined) continue; // 不认识的 key 忽略 —— 字段清单是唯一合法面
    const v =
      f.kind === "number" ? normalizeNumber(key, f.label, raw) : (raw ?? "").trim() || null;
    normalized.set(f.envKey, v);
  }
  const { parsed } = readClaudeSettings();
  const env: Record<string, string> =
    typeof parsed.env === "object" && parsed.env !== null ? { ...parsed.env } : {};
  for (const [envKey, v] of normalized) {
    if (v === null) delete env[envKey];
    else env[envKey] = v;
  }
  parsed.env = env;
  atomicWriteText(claudeSettingsPath(), `${JSON.stringify(parsed, null, 2)}\n`);
  return readClaudeModelDefaults();
}

// ---- codex：~/.codex/config.toml ------------------------------------------------------

export function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

const CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const CODEX_TOP_FIELDS: readonly {
  key: string;
  tomlKey: string;
  label: string;
  kind: "text" | "number" | "enum";
  options?: readonly string[];
  placeholder?: string;
  hint?: string;
}[] = [
  {
    key: "model",
    tomlKey: "model",
    label: "默认模型",
    kind: "text",
    placeholder: "如 gpt-5.5",
    hint: "config.toml 顶层 model 键 —— TUI 与新会话不带模型参数时的取值",
  },
  {
    key: "reasoningEffort",
    tomlKey: "model_reasoning_effort",
    label: "思考强度",
    kind: "enum",
    options: CODEX_EFFORT_LEVELS,
    hint: "留空 = 跟随模型默认；工作台选择器里选的思考强度按轮覆盖它",
  },
  {
    key: "contextWindow",
    tomlKey: "model_context_window",
    label: "上下文窗口",
    kind: "number",
    placeholder: "如 1000000",
    hint: "token 数；留空 = 用 codex 内置目录里该模型的窗口",
  },
  {
    key: "autoCompactLimit",
    tomlKey: "model_auto_compact_token_limit",
    label: "自动压缩点",
    kind: "number",
    placeholder: "如 900000",
    hint: "占用超过即触发压缩，需小于上下文窗口",
  },
];

/** TOML 标量序列化：字符串走基础双引号（JSON 转义是 TOML basic string 的子集），数字原样 */
function tomlScalar(v: string): string {
  return JSON.stringify(v);
}

/**
 * 顶层键的行级补丁 —— 只动「第一个 `[table]` 头之前」的 `key = value` 行。
 *
 * 局限（接受并注明）：顶层的多行数组值会被只认首行 —— codex 顶层键全是标量
 * （model / model_*_effort / 窗口数字），用户手写顶层多行数组时这些键会错位；
 * 整份重写能避开但要吞掉用户全部注释与排版，取舍后选保留用户文件。
 */
export function patchTomlTopLevel(text: string, updates: Map<string, string | null>): string {
  const lines = text.split(/\r?\n/);
  let topEnd = lines.findIndex((l) => /^\s*\[/.test(l));
  if (topEnd < 0) topEnd = lines.length;

  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i < topEnd) {
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (m !== null && updates.has(m[1]!)) {
        const key = m[1]!;
        const v = updates.get(key)!;
        seen.add(key);
        if (v !== null) out.push(`${key} = ${v}`); // 替换；清除则整行移除
        continue;
      }
    }
    out.push(line);
  }

  // 没出现过的键插到顶层区末尾（保持所有 [table] 分节完整）
  const missing: string[] = [];
  for (const [key, v] of updates) {
    if (v !== null && !seen.has(key)) missing.push(`${key} = ${v}`);
  }
  if (missing.length > 0) {
    // 无表头时不能 append 到末尾 —— 空文件/纯注释文件的末尾空行会把键挤到
    // 第二行起头；锚到「最后一个非空行之后」（全空则文件头）
    let insertAt = out.findIndex((l) => /^\s*\[/.test(l));
    if (insertAt < 0) {
      insertAt = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i]!.trim() !== "") insertAt = i + 1;
      }
    }
    // 落在表头前：表头前留一个空行分隔（已有空行就不重复加）
    const prev = insertAt > 0 ? out[insertAt - 1] : "";
    const withBlank = prev !== undefined && prev.trim() !== "" ? ["", ...missing] : missing;
    out.splice(insertAt, 0, ...withBlank);
  }

  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/** 读顶层键的当前值：字符串取引号内，裸词（enum）与数字取到行尾/注释前 */
export function readTomlTopLevel(text: string, tomlKey: string): string {
  const lines = text.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const m = line.match(new RegExp(`^${tomlKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`));
    if (m === null) continue;
    const raw = m[1]!.trim();
    const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    if (quoted !== null) return quoted[1]!;
    return raw.split(/\s+#/)[0]!.trim();
  }
  return "";
}

export function readCodexModelDefaults(): NativeModelConfig {
  const path = codexConfigPath();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    configPath: path,
    note: "写入 Codex 自己的 config.toml 顶层键 —— TUI 与新会话生效（已开的会话不变）；只改这几个键，其余配置原样保留。",
    fields: CODEX_TOP_FIELDS.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      options: f.options,
      value: readTomlTopLevel(text, f.tomlKey),
      placeholder: f.placeholder,
      hint: f.hint,
    })),
  };
}

export function writeCodexModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
  const byKey = new Map(CODEX_TOP_FIELDS.map((f) => [f.key, f]));
  const updates = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(values)) {
    const f = byKey.get(key);
    if (f === undefined) continue;
    let v: string | null;
    if (f.kind === "number") v = normalizeNumber(key, f.label, raw);
    else if (f.kind === "enum") v = normalizeEnum(key, f.label, raw, f.options ?? []);
    else v = (raw ?? "").trim() || null;
    // 数字键裸写（TOML integer），文本/枚举走带引号的基本字符串
    updates.set(f.tomlKey, v === null ? null : f.kind === "number" ? v : tomlScalar(v));
  }
  const path = codexConfigPath();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWriteText(path, patchTomlTopLevel(text, updates));
  return readCodexModelDefaults();
}

// ---- 通用 YAML 标量补丁（mcode / hermes 一类：只动认识的键，其余行原样） ------

/** YAML 双引号标量（JSON 字符串序列化是合法的 YAML double-quoted scalar） */
function yamlScalar(v: string): string {
  return JSON.stringify(v);
}

/**
 * 顶层**标量**键补丁：只替换/删除/新增 indent-0 的 `key: 值` 行。
 * 块映射键（`custom_provider:` 后跟嵌套行）与流式映射（`provider: { … }` 整行）
 * 一概不碰 —— 我们管理的键（defaultModel 一类）都是标量键。
 * 缺失键插到文件头（YAML 不在乎顶层顺序；插头部不会落进任何块映射）。
 */
export function patchYamlTopLevelScalars(text: string, updates: Map<string, string | null>): string {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/);
    if (m !== null && updates.has(m[1]!)) {
      const key = m[1]!;
      const v = updates.get(key)!;
      seen.add(key);
      if (v !== null) out.push(`${key}: ${yamlScalar(v)}`);
      continue;
    }
    out.push(line);
  }
  const missing: string[] = [];
  for (const [key, v] of updates) {
    if (v !== null && !seen.has(key)) missing.push(`${key}: ${yamlScalar(v)}`);
  }
  if (missing.length > 0) {
    // 文档头是 `---` 时插在它后面，否则插在最前
    let at = 0;
    if (out[0] !== undefined && out[0]!.trim() === "---") at = 1;
    out.splice(at, 0, ...missing);
  }
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/**
 * 顶层段（`section:` 块映射）内的标量键补丁。段不存在则整段新建（追加到文件尾）；
 * 清空后段里只剩注释/空行时连段头一起移除，不留空段。
 */
export function patchYamlSectionScalars(
  text: string,
  section: string,
  updates: Map<string, string | null>,
): string {
  const lines = text.split(/\r?\n/);
  const headerRe = new RegExp(`^${section}:\\s*(#.*)?$`);
  let headerIdx = lines.findIndex((l) => headerRe.test(l));
  if (headerIdx < 0) {
    // 段不存在：有要写的键才建段（全是清除则无需动文件）
    const toWrite = [...updates.entries()].filter(([, v]) => v !== null);
    if (toWrite.length === 0) return text.endsWith("\n") || text === "" ? text : `${text}\n`;
    const block = [``, `${section}:`, ...toWrite.map(([k, v]) => `  ${k}: ${yamlScalar(v as string)}`)];
    let result = `${lines.join("\n")}${block.join("\n")}\n`;
    if (!text.endsWith("\n") && text !== "") result = `${text}\n${block.slice(1).join("\n")}\n`;
    return result;
  }
  // 段范围：从段头下一行到下一个 indent-0 非空行（含注释行归段内）
  let end = headerIdx + 1;
  while (end < lines.length && !/^\S/.test(lines[end]!)) end++;
  const body = lines.slice(headerIdx + 1, end);
  const seen = new Set<string>();
  const newBody: string[] = [];
  for (const line of body) {
    const m = line.match(/^(\s+)([A-Za-z0-9_.-]+):(?:\s|$)/);
    if (m !== null && updates.has(m[2]!)) {
      const key = m[2]!;
      const v = updates.get(key)!;
      seen.add(key);
      if (v !== null) newBody.push(`${m[1]}${key}: ${yamlScalar(v)}`);
      continue;
    }
    newBody.push(line);
  }
  for (const [key, v] of updates) {
    if (v !== null && !seen.has(key)) newBody.unshift(`  ${key}: ${yamlScalar(v)}`);
  }
  const bodyHasContent = newBody.some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const next: string[] = [
    ...lines.slice(0, headerIdx),
    ...(bodyHasContent ? [lines[headerIdx]!, ...newBody] : []),
    ...lines.slice(end),
  ];
  let result = next.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/** 读顶层标量键当前值（裸标量或引号内） */
export function readYamlTopLevelScalar(text: string, key: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (m === null) continue;
    const raw = (m[1] ?? "").trim();
    const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    if (quoted !== null) return JSON.parse(`"${quoted[1]!}"`) as string;
    return raw.split(/\s+#/)[0]!.trim();
  }
  return "";
}

/** 读顶层段内的标量键当前值 */
export function readYamlSectionScalar(text: string, section: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const headerRe = new RegExp(`^${section}:\\s*(#.*)?$`);
  let idx = lines.findIndex((l) => headerRe.test(l));
  if (idx < 0) return "";
  for (let i = idx + 1; i < lines.length && !/^\S/.test(lines[i]!); i++) {
    const m = lines[i]!.match(new RegExp(`^\\s+${key}:\\s*(.*)$`));
    if (m === null) continue;
    const raw = (m[1] ?? "").trim();
    const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    if (quoted !== null) return JSON.parse(`"${quoted[1]!}"`) as string;
    return raw.split(/\s+#/)[0]!.trim();
  }
  return "";
}

// ---- mcode：~/.minimax/config.yaml 的顶层默认模型键 -----------------------------

export function mcodeConfigPath(): string {
  const dir = process.env["MINIMAX_DATA_DIR"] || process.env["MAVIS_DATA_DIR"] || join(homedir(), ".minimax");
  return join(dir, "config.yaml");
}

const MCODE_FIELDS: readonly { key: string; yamlKey: string; label: string; placeholder: string; hint: string }[] = [
  {
    key: "defaultModel",
    yamlKey: "defaultModel",
    label: "默认模型",
    placeholder: "如 minimax/MiniMax-M3.1-Flash",
    hint: "格式 <provider>/<model>，必须是 mcode 认的模型（写不认识的值 mcode 会起不来）；作用于 TUI 与后台任务的默认。ACP 会话的当前模型由 mcode 运行态管理，不跟随此键",
  },
  {
    key: "defaultLightModel",
    yamlKey: "defaultLightModel",
    label: "轻量档模型",
    placeholder: "可选",
    hint: "后台轻任务（标题生成一类）用的模型；留空 = 未设置",
  },
];

export function readMcodeModelDefaults(): NativeModelConfig {
  const path = mcodeConfigPath();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    configPath: path,
    note: "写入 mcode 自己的 config.yaml（顶层键）—— 对 TUI 与后台任务生效；只改这两个键，provider 定义与其余配置原样保留。",
    fields: MCODE_FIELDS.map((f) => ({
      key: f.key,
      label: f.label,
      kind: "text" as const,
      value: readYamlTopLevelScalar(text, f.yamlKey),
      placeholder: f.placeholder,
      hint: f.hint,
    })),
  };
}

export function writeMcodeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
  const byKey = new Map(MCODE_FIELDS.map((f) => [f.key, f]));
  const updates = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(values)) {
    const f = byKey.get(key);
    if (f === undefined) continue;
    updates.set(f.yamlKey, (raw ?? "").trim() || null);
  }
  const path = mcodeConfigPath();
  if (!existsSync(path)) throw new Error(`未找到 ${path} —— 先用 mcode 登录一次再改默认模型`);
  atomicWriteText(path, patchYamlTopLevelScalars(readFileSync(path, "utf8"), updates));
  return readMcodeModelDefaults();
}

// ---- hermes：config.yaml 顶层 model: 段 -----------------------------------------

export function hermesConfigPath(): string {
  if (process.env["HERMES_HOME"] && process.env["HERMES_HOME"].trim() !== "") {
    return join(process.env["HERMES_HOME"], "config.yaml");
  }
  return process.platform === "win32"
    ? join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "hermes", "config.yaml")
    : join(homedir(), ".hermes", "config.yaml");
}

export function readHermesModelDefaults(): NativeModelConfig {
  const path = hermesConfigPath();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    configPath: path,
    note: "写入 hermes 自己的 config.yaml（model: 段的 default 键）—— TUI 与新会话的默认模型；段内其余键与其余段落原样保留。",
    fields: [
      {
        key: "modelDefault",
        label: "默认模型",
        kind: "text",
        value: readYamlSectionScalar(text, "model", "default"),
        placeholder: "如 anthropic/claude-opus-4-8（provider/model）",
        hint: "provider/model 形式；清空 = 删除该键（hermes 回落到它自己的默认）",
      },
    ],
  };
}

export function writeHermesModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
  const v = (values["modelDefault"] ?? "").trim() || null;
  const path = hermesConfigPath();
  if (!existsSync(path)) throw new Error(`未找到 ${path} —— 先运行一次 hermes 生成配置再改默认模型`);
  atomicWriteText(path, patchYamlSectionScalars(readFileSync(path, "utf8"), "model", new Map([["default", v]])));
  return readHermesModelDefaults();
}

// ---- opencode：opencode.jsonc（优先）/ opencode.json 顶层 model 键 ----------------

export function opencodeConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "opencode");
}

/** opencode 优先读 .jsonc（cc-switch 同规则）；两份都在时编辑 .jsonc */
function opencodeConfigFile(): { path: string; existed: boolean } {
  const dir = opencodeConfigDir();
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(jsonc)) return { path: jsonc, existed: true };
  const json = join(dir, "opencode.json");
  return { path: json, existed: existsSync(json) };
}

export function readOpencodeModelDefaults(): NativeModelConfig {
  const { path, existed } = opencodeConfigFile();
  let text = existed ? readFileSync(path, "utf8") : "";
  let parsed: Record<string, unknown> = {};
  if (existed) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {
        configPath: path,
        note: `${path} 含注释（JSONC）或不是合法 JSON —— 为不丢你的注释，暂不支持就地编辑；把注释挪走后再来。`,
        fields: [],
      };
    }
  }
  const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    configPath: path,
    note: "写入 opencode 自己的配置（顶层 model / small_model 键）—— TUI 与不带模型参数的新会话用；provider 定义与其余键原样保留。",
    fields: [
      {
        key: "model",
        label: "默认模型",
        kind: "text",
        value: asStr(parsed["model"]),
        placeholder: "如 zhipuai-coding-plan/glm-4.6（provider/model）",
        hint: "provider/model 形式",
      },
      {
        key: "small_model",
        label: "轻量档模型",
        kind: "text",
        value: asStr(parsed["small_model"]),
        placeholder: "可选",
        hint: "标题生成等轻任务的模型；留空 = 未设置",
      },
    ],
  };
}

export function writeOpencodeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
  const { path, existed } = opencodeConfigFile();
  let text = existed ? readFileSync(path, "utf8") : "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} 含注释（JSONC）或不是合法 JSON —— 为不丢你的注释，拒绝就地编辑`);
  }
  const setOrDelete = (key: string, raw: string | undefined): void => {
    const v = (raw ?? "").trim();
    if (v === "") delete parsed[key];
    else parsed[key] = v;
  };
  setOrDelete("model", values["model"]);
  setOrDelete("small_model", values["small_model"]);
  atomicWriteText(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return readOpencodeModelDefaults();
}
