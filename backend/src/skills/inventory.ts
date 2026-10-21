/**
 * 技能清单与停用管理（Skills Inventory & Toggle）。
 *
 * 领域语言见仓库根 CONTEXT.md「技能与扩展」：
 * - 技能源（Skill Source）：技能被发现的真实目录。本模块持有一张静态
 *   「源 → 读取它的执行器」映射表，与发现层的**文件级扫描段**一一对应
 *   （runtime/adapters/discovery.ts 及各适配器的目录清单，改发现路径必须同步这里）。
 *   协议/服务端段（claude 活会话 supportedCommands、opencode serve /skill）
 *   无法静态枚举，不在管理范围 —— 那些技能只出现在斜杠菜单。
 * - 停用（Disabled）：把技能文件夹移入其技能源内的 `.disabled/` 目录。
 *   安全性三层：发现层跳过点开头条目；一层扫描深度不命中 `.disabled/<name>/SKILL.md`；
 *   ZCode CLI 原生扫描策略同样跳过点目录（见 skill-scan-policy，README 参照表）。
 *
 * 安全纪律：
 * - 开关只接受「已知技能源 + 纯文件夹名」，绝不接受任意路径 —— RPC 面上
 *   没有任何能把任意目录搬走的能力。
 * - `.disabled/` 只进 skills 目录，绝不进 agents/commands 目录（那里的递归扫描
 *   曾不滤点目录，discovery.ts 已加固 hasDotSegment）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "../runtime/adapters/discovery.ts";
import type { SkillEntryInfo, SkillSourceGroupInfo, SkillsInventory } from "../contract.ts";

const DISABLED_DIR = ".disabled";

/** 读取 ~/.agents/skills 与项目 .agents/skills 的全部执行器（.agents 规范公共库） */
const ALL_EXECUTORS: readonly string[] = [
  "zcode", "codex", "claude", "pi", "mcode", "dsh", "opencode", "hermes", "kimi", "agy", "grok", "cursor", "openclaw",
];

interface SourceDef {
  /** 技能源绝对路径（开关动作的定位键） */
  readonly dir: string;
  readonly scope: "user" | "project" | "plugin";
  readonly label: string;
  readonly readers: readonly string[];
  readonly readOnly: boolean;
}

/** 执行器 id → 显示名（RPC 层注入，本模块不依赖 RuntimeHost） */
export type ReaderNameResolver = (id: string) => string;

/**
 * 静态技能源注册表 —— 与发现层的真实扫描路径保持一致：
 * - pi：~/.pi/agent/skills + ~/.pi/skills + 项目 .pi/skills（discovery.ts discoverPiSkillsAndAgents）
 * - cursor：.cursor/.codex/.claude(仅用户级)/.agents（discovery.ts discoverCursorSkillsAndAgents）
 * - claude：~/.claude 与 <root>/.claude（claude.ts readClaudeFileLevel）
 * - grok：~/.grok 与 <root>/.grok + ~/.claude 兼容（grok.ts readGrokSkills）
 * - codex：~/.codex 与 <root>/.codex（cursor 也读，作兼容源）
 * - opencode：~/.opencode 与 <root>/.opencode（opencode.ts fileSkills）
 * - agy：~/.gemini/config 的 skills 与 plugins/<name>/skills + 内置（discovery.ts discoverAgySkillsAndAgents）
 * - 通用系 mcode/dsh/hermes/kimi/openclaw：.<id>/skills 两级（discoverGenericToolSkillsAndAgents）
 */
function sourceDefs(rootPath: string | undefined): SourceDef[] {
  const home = homedir();
  const defs: SourceDef[] = [];

  // ---- 用户级（家目录）----
  defs.push(
    { dir: join(home, ".agents", "skills"), scope: "user", label: "公共技能库（.agents）", readers: ALL_EXECUTORS, readOnly: false },
    { dir: join(home, ".zcode", "skills"), scope: "user", label: "zcode 专属", readers: ["zcode"], readOnly: false },
    { dir: join(home, ".claude", "skills"), scope: "user", label: "claude 专属", readers: ["claude", "grok", "cursor"], readOnly: false },
    { dir: join(home, ".codex", "skills"), scope: "user", label: "codex 专属", readers: ["codex", "cursor"], readOnly: false },
    { dir: join(home, ".pi", "agent", "skills"), scope: "user", label: "pi 专属（agent）", readers: ["pi"], readOnly: false },
    { dir: join(home, ".pi", "skills"), scope: "user", label: "pi 专属", readers: ["pi"], readOnly: false },
    { dir: join(home, ".cursor", "skills"), scope: "user", label: "cursor 专属", readers: ["cursor"], readOnly: false },
    { dir: join(home, ".grok", "skills"), scope: "user", label: "grok 专属", readers: ["grok"], readOnly: false },
    { dir: join(home, ".opencode", "skills"), scope: "user", label: "opencode 专属", readers: ["opencode"], readOnly: false },
    { dir: join(home, ".gemini", "config", "skills"), scope: "user", label: "agy 全局定制", readers: ["agy"], readOnly: false },
    // agy 内置与插件目录只展示不给开关：搬内置目录可能破坏 IDE，插件目录由插件机制自管
    { dir: join(home, ".gemini", "antigravity-ide", "builtin", "skills"), scope: "user", label: "agy 内置", readers: ["agy"], readOnly: true },
  );
  // agy 插件技能（每个插件一个源）
  const geminiPlugins = join(home, ".gemini", "config", "plugins");
  if (existsSync(geminiPlugins)) {
    try {
      for (const p of readdirSync(geminiPlugins)) {
        if (p.startsWith(".")) continue;
        defs.push({ dir: join(geminiPlugins, p, "skills"), scope: "plugin", label: `agy 插件 · ${p}`, readers: ["agy"], readOnly: true });
      }
    } catch {
      /* 插件目录不可读 = 没有插件源，不是错误 */
    }
  }
  // zcode 官方插件技能：~/.zcode/cli/plugins/cache/<org>/<plugin>/<version>/skills
  // （zcode 协议面 skills/referenceCatalog 的 plugin scope 就是它们；缓存里常驻多个
  //  历史版本、只有最高版被激活，每个插件只列最新一版，其余是纯噪音——
  //  实测一个 browser-use 就压着 9 个版本目录。停用开关不提供：插件由插件机制自管）
  const zcodePluginsRoot = join(home, ".zcode", "cli", "plugins", "cache");
  if (existsSync(zcodePluginsRoot)) {
    try {
      for (const org of readdirSync(zcodePluginsRoot)) {
        if (org.startsWith(".")) continue;
        const orgDir = join(zcodePluginsRoot, org);
        for (const plugin of readdirSync(orgDir)) {
          if (plugin.startsWith(".")) continue;
          const pluginDir = join(orgDir, plugin);
          let best: string | null = null;
          for (const version of readdirSync(pluginDir)) {
            if (version.startsWith(".")) continue;
            if (best === null || cmpSemver(version, best) > 0) best = version;
          }
          if (best !== null) {
            defs.push({
              dir: join(pluginDir, best, "skills"),
              scope: "plugin",
              label: `zcode 插件 · ${plugin} ${best}`,
              readers: ["zcode"],
              readOnly: true,
            });
          }
        }
      }
    } catch {
      /* 插件缓存结构异常 = 没有插件源，不是错误 */
    }
  }
  // 通用系专属目录
  for (const id of ["mcode", "dsh", "hermes", "kimi", "openclaw"]) {
    defs.push({ dir: join(home, `.${id}`, "skills"), scope: "user", label: `${id} 专属`, readers: [id], readOnly: false });
  }

  // ---- 项目级（只在给了 rootPath 时纳入）----
  if (rootPath !== undefined && rootPath.trim() !== "") {
    defs.push(
      { dir: join(rootPath, ".agents", "skills"), scope: "project", label: "公共技能库（项目）", readers: ALL_EXECUTORS, readOnly: false },
      { dir: join(rootPath, ".zcode", "skills"), scope: "project", label: "zcode 专属（项目）", readers: ["zcode"], readOnly: false },
      { dir: join(rootPath, ".claude", "skills"), scope: "project", label: "claude 专属（项目）", readers: ["claude"], readOnly: false },
      { dir: join(rootPath, ".codex", "skills"), scope: "project", label: "codex 专属（项目）", readers: ["codex", "cursor"], readOnly: false },
      { dir: join(rootPath, ".pi", "skills"), scope: "project", label: "pi 专属（项目）", readers: ["pi"], readOnly: false },
      { dir: join(rootPath, ".cursor", "skills"), scope: "project", label: "cursor 专属（项目）", readers: ["cursor"], readOnly: false },
      { dir: join(rootPath, ".grok", "skills"), scope: "project", label: "grok 专属（项目）", readers: ["grok"], readOnly: false },
      { dir: join(rootPath, ".opencode", "skills"), scope: "project", label: "opencode 专属（项目）", readers: ["opencode"], readOnly: false },
      { dir: join(rootPath, "skills"), scope: "project", label: "工作区 skills/（agy）", readers: ["agy"], readOnly: false },
    );
    for (const id of ["mcode", "dsh", "hermes", "kimi", "openclaw"]) {
      defs.push({ dir: join(rootPath, `.${id}`, "skills"), scope: "project", label: `${id} 专属（项目）`, readers: [id], readOnly: false });
    }
  }

  return defs;
}

/** Windows 路径比较：大小写与斜杠方向归一 */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replaceAll("/", "\\").replace(/\\+$/, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** 语义化版本比较（'0.5.10' > '0.5.9'）；非数字段按字符串比兜底 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return 0;
}

/** 读取一个技能文件夹的 frontmatter 展示信息（读不了就退化为目录名） */
function readSkillMeta(dirName: string, skillDir: string): { name: string; description?: string } {
  try {
    const fm = parseFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
    return { name: fm.name && fm.name !== "" ? fm.name : dirName, description: fm.description };
  } catch {
    return { name: dirName };
  }
}

/** 枚举一个技能源里的全部技能（active + .disabled 内的已停用条目） */
function listSkills(dir: string): SkillEntryInfo[] {
  const out: SkillEntryInfo[] = [];
  if (!existsSync(dir)) return out;

  // 单技能形态：<源>/SKILL.md 直挂（整个源目录就是一个技能，discoverSkillsInDir 同款短路）。
  // 列出但不可开关 —— 搬运目标在自己内部，物理不可行；列出是为了管理页不出现
  // 「菜单里有、这里没有」的盲区（fallback 名与发现层同规则：目录叫 skills 用父目录名）。
  if (existsSync(join(dir, "SKILL.md"))) {
    const fallback = basename(dir).toLowerCase() === "skills" ? basename(dirname(dir)) : basename(dir);
    const meta = readSkillMeta(fallback, dir);
    return [{ dirName: basename(dir), name: meta.name, description: meta.description, disabled: false, singleForm: true }];
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sub of entries) {
    if (sub.startsWith(".")) continue; // 点开头条目不是技能（.disabled 本身也在这里被跳过）
    const skillDir = join(dir, sub);
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    const meta = readSkillMeta(sub, skillDir);
    out.push({ dirName: sub, name: meta.name, description: meta.description, disabled: false });
  }

  // 已停用条目：.disabled/ 下一层里含 SKILL.md 的文件夹
  const disabledDir = join(dir, DISABLED_DIR);
  if (existsSync(disabledDir)) {
    let disabledEntries: string[];
    try {
      disabledEntries = readdirSync(disabledDir);
    } catch {
      disabledEntries = [];
    }
    for (const sub of disabledEntries) {
      if (sub.startsWith(".")) continue;
      const skillDir = join(disabledDir, sub);
      if (!existsSync(join(skillDir, "SKILL.md"))) continue;
      const meta = readSkillMeta(sub, skillDir);
      out.push({ dirName: sub, name: meta.name, description: meta.description, disabled: true });
    }
  }
  return out;
}

/**
 * 构建技能清单 —— 只返回「存在且有技能（含已停用）」的源分组。
 * 空源不出现：设置页不该有一排「0 个技能」的空卡片。
 */
export function buildSkillsInventory(
  rootPath: string | undefined,
  resolveName: ReaderNameResolver,
): SkillsInventory {
  const groups: SkillSourceGroupInfo[] = [];
  const seenDirs = new Set<string>();
  for (const def of sourceDefs(rootPath)) {
    // rootPath 恰为家目录等重合场景，去重（先注册的用户级胜出）。toLowerCase 是
    // Windows 大小写不敏感口径；大小写敏感盘上仅大小写不同的两个源会被过度合并（极端场景，接受）
    if (seenDirs.has(def.dir.toLowerCase())) continue;
    seenDirs.add(def.dir.toLowerCase());
    const skills = listSkills(def.dir);
    if (skills.length === 0) continue;
    groups.push({
      id: `${def.scope}:${def.dir}`,
      dir: def.dir,
      scope: def.scope,
      label: def.label,
      readOnly: def.readOnly,
      readers: def.readers.map((id) => ({ id, name: resolveName(id) })),
      skills,
    });
  }
  return { ...(rootPath !== undefined && rootPath.trim() !== "" ? { rootPath } : {}), groups };
}

/** 开关动作的结果：受影响的执行器（调用方拿去失效命令缓存） */
export interface ToggleResult {
  readonly readers: readonly string[];
}

/**
 * 每 bot 技能目录的枚举（ADR 0014 D8 / docs/20 P4）——供上下文注入器做
 * openclaw 式「目录注入」（name + 路径，不注 SKILL.md 全文，agent 按需读）。
 *
 * 口径：全部技能源（用户级 + 该 rootPath 的项目级）里**启用中**（不在 .disabled/）
 * 的技能；跨源同 dirName 去重（先见先得，用户级在前）。绑定名单过滤在注入器做，
 * 这里给全量——调用方还要拿它做「名单里但已找不到」的差异提示。
 */
export interface CatalogSkillEntry {
  /** 技能文件夹名（绑定名单的匹配键，跨源稳定） */
  readonly dirName: string;
  /** 展示名（frontmatter name，缺省同 dirName） */
  readonly name: string;
  /** SKILL.md 所在目录的绝对路径（注入给 agent 的「去哪读」） */
  readonly path: string;
}

export function listCatalogSkills(rootPath: string | undefined): CatalogSkillEntry[] {
  const out: CatalogSkillEntry[] = [];
  const seen = new Set<string>();
  // 项目级源先于用户级（预算截断时最相关的先活下来——这台机器实测用户级
  // 公共库有 400+ 技能，先用户级的话项目级必被截掉，恰好是最不该丢的那批）。
  const ordered = [...sourceDefs(rootPath)].sort((a, b) => scopeRank(b.scope) - scopeRank(a.scope));
  for (const def of ordered) {
    for (const skill of listSkills(def.dir)) {
      if (skill.disabled) continue; // 已停用的技能对所有 bot 都不可见（全局层先过滤）
      if (seen.has(skill.dirName)) continue; // 跨源同名：先见先得（项目级胜出）
      seen.add(skill.dirName);
      // 单技能形态（SKILL.md 直挂源目录）：技能目录就是源目录本身
      out.push({ dirName: skill.dirName, name: skill.name, path: skill.singleForm === true ? def.dir : join(def.dir, skill.dirName) });
    }
  }
  return out;
}

function scopeRank(scope: "user" | "project" | "plugin"): number {
  return scope === "project" ? 2 : scope === "user" ? 1 : 0;
}

/**
 * 停用/恢复一个技能：在**已知技能源内部**做文件夹搬运。
 *
 * 冲突语义（rename 在 Windows 上目标存在即失败，正好是我们的检测器）：
 * - 停用时 .disabled/ 里已有同名 → conflict；
 * - 恢复时源目录里已有同名新技能 → conflict（不能悄悄覆盖用户后建的同名技能）。
 */
export function setSkillDisabled(
  sourceDir: string,
  dirName: string,
  disabled: boolean,
  rootPath: string | undefined,
): ToggleResult {
  const def = sourceDefs(rootPath).find((d) => sameDir(d.dir, sourceDir));
  if (def === undefined) {
    throw Object.assign(new Error(`not a known skill source: ${sourceDir}`), { code: "unknown_source" });
  }
  if (def.readOnly) {
    throw Object.assign(new Error(`skill source is read-only: ${def.label}`), { code: "read_only_source" });
  }
  // 单技能形态（源目录即技能）：搬不进自己内部，物理不可行
  if (existsSync(join(def.dir, "SKILL.md"))) {
    throw Object.assign(new Error("单技能形态的源（SKILL.md 直挂源目录）不可开关"), { code: "single_form_source" });
  }
  if (typeof dirName !== "string" || dirName === "" || dirName.startsWith(".") || /[\\/]/.test(dirName)) {
    throw Object.assign(new Error("dirName must be a plain folder name"), { code: "bad_params" });
  }

  if (disabled) {
    const from = join(def.dir, dirName);
    const to = join(def.dir, DISABLED_DIR, dirName);
    if (!isDirectory(from)) {
      throw Object.assign(new Error(`skill folder not found: ${dirName}`), { code: "missing_skill" });
    }
    ensureDisabledDirUsable(def.dir);
    if (existsSync(to)) {
      throw Object.assign(new Error(`.disabled/ 已有同名文件夹：${dirName}`), { code: "conflict" });
    }
    renameOrThrow(from, to);
  } else {
    const from = join(def.dir, DISABLED_DIR, dirName);
    const to = join(def.dir, dirName);
    if (!isDirectory(from)) {
      throw Object.assign(new Error(`disabled skill folder not found: ${dirName}`), { code: "missing_skill" });
    }
    if (existsSync(to)) {
      throw Object.assign(new Error(`技能源里已有同名文件夹（可能是停用期间新建的）：${dirName}`), { code: "conflict" });
    }
    renameOrThrow(from, to);
  }
  return { readers: def.readers };
}

/** .disabled 路径被普通文件占据时给可操作的报错（mkdirSync 的 EEXIST 原始错误没法看） */
function ensureDisabledDirUsable(sourceDir: string): void {
  const disabledDir = join(sourceDir, DISABLED_DIR);
  if (existsSync(disabledDir) && !isDirectory(disabledDir)) {
    throw Object.assign(new Error(`.disabled 被同名普通文件占用，请先处理：${disabledDir}`), { code: "conflict" });
  }
  mkdirSync(disabledDir, { recursive: true });
}

/**
 * 搬运 + 错误翻译：目录被占用（编辑器/杀软）报 locked、目标已有内容报 conflict，
 * 其余原样抛 —— 检查与 rename 之间的竞态窗口里 Windows 的真实行为并不总是
 * 「目标存在即失败」（目录→同名文件会静默覆盖），这里兜底成可读错误。
 */
function renameOrThrow(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      throw Object.assign(new Error("目录被占用（编辑器/杀毒扫描中？），请稍后重试"), { code: "locked" });
    }
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      throw Object.assign(new Error("目标位置已有同名内容"), { code: "conflict" });
    }
    throw err;
  }
}

/** 只有目录才能被搬运：源里恰好有个同名普通文件（如 README）时明确拒绝，不搬文件 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 跨技能源复制一个技能（矩阵视图「打钩到某源」的落点）：把源里启用中的技能
 * 文件夹**复制**到目标源（源不动 —— 复制不是移动，多源共存各自演化）。
 * 目标源已有同名（启用或 .disabled 里）即冲突：不覆盖用户后放的版本。
 */
export function copySkill(
  fromSourceDir: string,
  dirName: string,
  toSourceDir: string,
  rootPath: string | undefined,
): ToggleResult {
  const defs = sourceDefs(rootPath);
  const from = defs.find((d) => sameDir(d.dir, fromSourceDir));
  const to = defs.find((d) => sameDir(d.dir, toSourceDir));
  if (from === undefined || to === undefined) {
    throw Object.assign(new Error(`not a known skill source: ${from === undefined ? fromSourceDir : toSourceDir}`), { code: "unknown_source" });
  }
  if (to.readOnly) {
    throw Object.assign(new Error(`skill source is read-only: ${to.label}`), { code: "read_only_source" });
  }
  if (typeof dirName !== "string" || dirName === "" || dirName.startsWith(".") || /[\\/]/.test(dirName)) {
    throw Object.assign(new Error("dirName must be a plain folder name"), { code: "bad_params" });
  }
  // 单技能形态的源不可作为复制源或目标（SKILL.md 直挂，没有可定位的技能子目录）
  if (existsSync(join(from.dir, "SKILL.md")) || existsSync(join(to.dir, "SKILL.md"))) {
    throw Object.assign(new Error("单技能形态的源（SKILL.md 直挂源目录）不支持跨源复制"), { code: "single_form_source" });
  }
  let srcDir = join(from.dir, dirName);
  if (!isDirectory(srcDir)) {
    const disabledDir = join(from.dir, DISABLED_DIR, dirName);
    if (isDirectory(disabledDir)) {
      srcDir = disabledDir;
    } else {
      throw Object.assign(new Error(`skill folder not found: ${dirName}`), { code: "missing_skill" });
    }
  }
  const dstDir = join(to.dir, dirName);
  if (existsSync(dstDir) || existsSync(join(to.dir, DISABLED_DIR, dirName))) {
    throw Object.assign(new Error(`目标源已有同名技能（${to.label}）：${dirName}`), { code: "conflict" });
  }
  mkdirSync(to.dir, { recursive: true });
  try {
    cpSync(srcDir, dstDir, { recursive: true });
  } catch (err: unknown) {
    // 半成品必须清掉：留着的话，上面的 existsSync 冲突预检会让此后每一次
    // 复制到该目标都永久 conflict，直到用户手删残留目录
    try {
      rmSync(dstDir, { recursive: true, force: true });
    } catch {
      /* 清理失败只能如实报错，别用清理异常盖掉原始错误 */
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      throw Object.assign(new Error("复制时目录被占用（编辑器/杀毒扫描中？），请稍后重试"), { code: "locked" });
    }
    throw err;
  }
  // 源没变化，只需失效目标源的读取方
  return { readers: to.readers };
}
