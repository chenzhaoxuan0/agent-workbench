/**
 * 目录探测（docs/09 §七 P0-B）——「把已有文件夹认领为 bot」的地基。
 *
 * 纯读，一个字节都不写。导入对话框要靠它决定走三分支里的哪一支，所以它必须
 * 回答四类问题：
 *
 *   这是什么      目录在不在 / 是不是 git 仓库 / AGENTS.md 有没有
 *   能叫什么      从 AGENTS.md 派生 name + role（预填表单用）
 *   会不会出事    路径已注册 / 嵌在别的 bot 里 / 父目录会变成扫描根
 *   安不安全      bot.json 里有渠道密钥，塞进 git 仓库就等于交出去
 *
 * 刻意不做的：替老文件夹做任何决定。脚手架分支要不要补 AGENTS.md 是用户的事，
 * 这里只负责把情况摆清楚。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { BotDefinition } from "./registry.ts";
import { log } from "../log.ts";

/** 认作「技能」的目录名。命中即算资产，导入报告里要列出来。 */
const SKILL_DIR_NAMES = ["skills", ".skills", ".claude/skills", ".agents/skills"];
/** 认作「技能」的根文件。 */
const SKILL_FILES = ["SKILL.md", ".cursorrules", ".windsurfrules"];
/** 认作「人设」的文件（与 AGENTS.md 刻意分开，docs/09 §三第四幕）。 */
const SOUL_FILES = ["SOUL.md", "PERSONA.md"];

export interface InspectReport {
  readonly rootPath: string;
  readonly exists: boolean;
  /** 不可读（权限 / 网络盘断了）——与「不存在」分开，用户看到的提示不同 */
  readonly readable: boolean;
  readonly isGitRepo: boolean;

  readonly hasAgentsMd: boolean;
  readonly hasBotJson: boolean;
  /** 从 AGENTS.md 派生的身份候选。没有 AGENTS.md 就是 null，不瞎猜。 */
  readonly derived: { name: string; role: string } | null;
  /** 建议的 bot id（尚未被占用性校验，仅是给表单的默认值） */
  readonly suggestedId: string;

  readonly assets: {
    readonly skillFiles: readonly string[];
    readonly skillDirs: readonly string[];
    readonly memoryFile: string | null;
    readonly hasSoul: boolean;
    readonly hasAutomations: boolean;
    readonly extraAgentFiles: readonly string[];
  };

  readonly conflicts: {
    /** 同一路径已被另一个 id 注册 */
    readonly alreadyRegistered: { unitId: string; name: string } | null;
    /** 本目录落在另一个已注册 bot 的工作目录内部 */
    readonly nestedInside: { unitId: string; rootPath: string } | null;
  };

  readonly scanRootEffect: {
    readonly parent: string;
    readonly willBecomeScanRoot: boolean;
    /** 父目录下已存在的其他 bot.json 数——导入一个会连带把它们扫出来 */
    readonly siblingsFound: number;
    readonly warning: string | null;
  };

  readonly security: {
    readonly applicable: boolean;
    /** .agent-workbench/ 是否已被 .gitignore 覆盖 */
    readonly agentWorkbenchIgnored: boolean;
    /** 能不能安全提交：没有渠道密钥、或者已被 ignore，都算安全 */
    readonly safe: boolean;
    readonly message: string;
  };
}

/** 目录里已有的 bot 定义（有的话）——「重新连接」分支直接用它，零写入 */
export type InspectExisting = BotDefinition | null;

export async function inspectDirectory(
  rootPath: string,
  ctx: { knownBots: BotDefinition[] },
): Promise<{ report: InspectReport; existing: InspectExisting }> {
  const root = path.resolve(rootPath);
  const parent = path.dirname(root);

  const exists = existsSync(root);
  if (!exists) {
    return {
      report: emptyReport(root, "目录不存在"),
      existing: null,
    };
  }

  let readable = true;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
    const s = await stat(root);
    if (!s.isDirectory()) {
      return { report: emptyReport(root, "这是一个文件，不是文件夹"), existing: null };
    }
  } catch (err: unknown) {
    readable = false;
    log.warn("bot.inspect unreadable", { root, error: err instanceof Error ? err.message : String(err) });
  }

  const hasAgentsMd = entries.includes("AGENTS.md");
  const botJsonPath = path.join(root, ".agent-workbench", "bot.json");
  const hasBotJson = existsSync(botJsonPath);

  let existing: InspectExisting = null;
  if (hasBotJson) {
    try {
      existing = JSON.parse(await readFile(botJsonPath, "utf8")) as BotDefinition;
    } catch (err: unknown) {
      log.warn("bot.inspect: bot.json unreadable", { root, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const agentsMd = hasAgentsMd ? await safeRead(path.join(root, "AGENTS.md")) : null;
  const derived = agentsMd === null ? null : deriveIdentity(agentsMd);
  const isGitRepo = existsSync(path.join(root, ".git"));

  // ---- 冲突 ----
  const samePath = ctx.knownBots.find(
    (b) => typeof b.rootPath === "string" && path.resolve(b.rootPath) === root,
  );
  const parentOf = ctx.knownBots.find((b) => {
    if (typeof b.rootPath !== "string") return false;
    const r = path.resolve(b.rootPath);
    return root !== r && root.startsWith(r + path.sep);
  });

  // ---- 扫描根副作用 ----
  const willBecomeScanRoot = parent !== root;
  const siblingsFound = willBecomeScanRoot ? await countSiblingBots(parent, root) : 0;
  let scanWarning: string | null = null;
  if (parent === root) {
    scanWarning = "这个目录在盘符根下，注册后扫不到——它不能作为 bot 工作目录。";
  } else if (siblingsFound > 0) {
    scanWarning = `导入后「${parent}」会成为扫描根，同级另外 ${siblingsFound} 个 bot 会一并出现在侧栏。`;
  }

  // ---- 安全 ----
  const gitignore = isGitRepo ? await readGitignore(root) : "";
  const ignored = isGitRepo ? isIgnored(gitignore, ".agent-workbench") : true;
  const hasSecrets = existing !== null && channelsCarrySecrets(existing);
  const safe = !isGitRepo || ignored || !hasSecrets;
  const securityMessage = !isGitRepo
    ? "不是 git 仓库，不存在被提交的风险。"
    : ignored
      ? "`.agent-workbench/` 已在 .gitignore 里，密钥不会被提交。"
      : hasSecrets
        ? "⚠ 这个仓库会连带提交 bot.json，里面的渠道密钥会一起进版本库。bot.json 本身是本机私有配置——建议把 .agent-workbench/ 加进 .gitignore。"
        : "`.agent-workbench/` 未被 ignore；目前没有渠道密钥，但以后绑定渠道就会有。";

  return {
    report: {
      rootPath: root,
      exists: true,
      readable,
      isGitRepo,
      hasAgentsMd,
      hasBotJson,
      derived,
      suggestedId: suggestId(derived?.name ?? path.basename(root)),
      assets: await inspectAssets(root, entries),
      conflicts: {
        alreadyRegistered:
          samePath === undefined
            ? null
            : { unitId: String(samePath.id ?? ""), name: String(samePath.name ?? samePath.id ?? "") },
        nestedInside:
          parentOf === undefined ? null : { unitId: String(parentOf.id ?? ""), rootPath: String(parentOf.rootPath ?? "") },
      },
      scanRootEffect: { parent, willBecomeScanRoot, siblingsFound, warning: scanWarning },
      security: { applicable: isGitRepo, agentWorkbenchIgnored: ignored, safe, message: securityMessage },
    },
    existing,
  };
}

function emptyReport(root: string, message: string): InspectReport {
  return {
    rootPath: root,
    exists: false,
    readable: false,
    isGitRepo: false,
    hasAgentsMd: false,
    hasBotJson: false,
    derived: null,
    suggestedId: "",
    assets: { skillFiles: [], skillDirs: [], memoryFile: null, hasSoul: false, hasAutomations: false, extraAgentFiles: [] },
    conflicts: { alreadyRegistered: null, nestedInside: null },
    scanRootEffect: { parent: path.dirname(root), willBecomeScanRoot: false, siblingsFound: 0, warning: message },
    security: { applicable: false, agentWorkbenchIgnored: true, safe: true, message },
  };
}

async function inspectAssets(
  root: string,
  entries: readonly string[],
): Promise<InspectReport["assets"]> {
  const has = (name: string): boolean => entries.includes(name);
  const skillFiles = SKILL_FILES.filter((f) => has(f));
  const skillDirs = SKILL_DIR_NAMES.filter((d) => has(d.split("/")[0]!));
  const soul = SOUL_FILES.find((f) => has(f)) ?? null;
  const memoryFile = has("MEMORY.md") ? "MEMORY.md" : null;
  const hasAutomations = has("automations") || has(".agent-workbench/automations.json");

  // 其余 *.md（CLAUDE.md / README.md …）也列出来：让人看见「导入后会继承什么」
  const extraAgentFiles = entries.filter(
    (e) => e.toUpperCase().endsWith(".MD") && !["AGENTS.md", "MEMORY.md", "README.md", ...SOUL_FILES, ...SKILL_FILES].includes(e.toUpperCase()),
  );
  return { skillFiles, skillDirs, memoryFile, hasSoul: soul !== null, hasAutomations, extraAgentFiles };
}

async function safeRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * 从 AGENTS.md 派生身份。
 *
 * 全仓库此前没有任何代码构造 WorkspaceIdentity——这是第一处。
 * 规则保守：首个一级标题 → name，紧随其后的引言 → role。
 * 都取不到就返回空串，让用户自己填，绝不拿文件夹名冒充角色。
 */
export function deriveIdentity(md: string): { name: string; role: string } {
  const lines = md.split(/\r?\n/);
  let name = "";
  let role = "";
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (name === "" && line.startsWith("# ")) {
      name = line.slice(2).trim();
      // 标题之后的第一段非标题、非空行就是引言
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const next = (lines[j] ?? "").trim();
        if (next === "") continue;
        if (next.startsWith("#")) break;
        role = next.replace(/^>\s*/, "").trim();
        break;
      }
      break;
    }
  }
  return { name, role };
}

/**
 * 目录名/标题 → 可用的 bot id。
 *
 * 关键在**永远不返回空串**：中文名 slug 之后什么都不剩，但 id 是 bot 的主键，
 * 空 id 等于导入表单开天窗。非 ASCII 走内容哈希，稳定且可辨识——
 * 同一个文件夹每次探测都得到同一个 id，不会「重开一次就换了名字」。
 */
export function suggestId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug !== "") return `bot-${slug}`;
  const h = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `bot-${h}`;
}

async function countSiblingBots(parent: string, exclude: string): Promise<number> {
  let children: string[];
  try {
    children = await readdir(parent, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return 0;
  }
  let n = 0;
  for (const child of children) {
    if (path.resolve(parent, child) === path.resolve(exclude)) continue;
    if (existsSync(path.join(parent, child, ".agent-workbench", "bot.json"))) n++;
  }
  return n;
}

/** bot.json 里有没有渠道密钥会被提交出去 */
function channelsCarrySecrets(def: BotDefinition): boolean {
  const channels = def.channels as unknown;
  if (!Array.isArray(channels)) return false;
  /** 明文形态 = 会进版本库；SecretRef（env）只在环境变量里，不进文件 */
  const isPlainSecret = (sec: unknown): boolean => {
    if (typeof sec === "string" && sec !== "") return true;
    return sec !== null && typeof sec === "object" && (sec as Record<string, unknown>)["source"] === "literal";
  };
  for (const ch of channels as Array<Record<string, unknown>>) {
    const accounts = Array.isArray(ch["accounts"]) ? (ch["accounts"] as Array<Record<string, unknown>>) : [];
    for (const acc of accounts) {
      if (isPlainSecret(acc["appSecret"] ?? acc["botToken"] ?? acc["secret"])) return true;
    }
    // ⚠ 旧形态（单账号、凭据写在 config 里）telegram 解析器仍然认，
    // 而这里以前只看 accounts —— 于是「配置里明文放着 bot token」的 bot
    // 被报告成「没有渠道密钥」，导入对话框放行，token 跟着 bot.json 进了 git。
    const cfg = ch["config"];
    if (cfg !== null && typeof cfg === "object") {
      const c = cfg as Record<string, unknown>;
      if (isPlainSecret(c["appSecret"] ?? c["botToken"] ?? c["secret"])) return true;
    }
  }
  return false;
}

async function readGitignore(root: string): Promise<string> {
  return (await safeRead(path.join(root, ".gitignore"))) ?? "";
}

/** 极简 .gitignore 匹配：够判 `.agent-workbench` 这一个条目即可 */
export function isIgnored(gitignore: string, rel: string): boolean {
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
  const base = path.basename(rel);
  return lines.some((l) => {
    if (l === "" || l.startsWith("#")) return false;
    // 取反行（`!.agent-workbench`）表达的是「**不**忽略」——它是一条反向规则，
    // 以前只把 `!` 剥掉就当普通规则匹配，于是「用户明确写了不忽略」反而被读成
    // 「已经忽略了」：导入报告说安全、appendGitignore 也不再补规则，
    // 最后把带 token 的目录提交进了 git。
    if (l.startsWith("!")) return false;
    const pat = l.replace(/\/$/, "").replace(/^\//, "");
    if (pat === "") return false;
    if (pat.includes("/")) return false; // 带路径的规则交给 git 自己判，这里不猜
    return pat === base || pat === "*" || (pat.endsWith("/") && pat.slice(0, -1) === base);
  });
}

/** 往 .gitignore 追加一行（幂等）。返回是否真的改了文件。 */
export async function appendGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore");
  const current = (await safeRead(file)) ?? "";
  if (isIgnored(current, ".agent-workbench")) return false;
  const next = current === "" || current.endsWith("\n") ? `${current}.agent-workbench/\n` : `${current}\n.agent-workbench/\n`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, next, "utf8");
  return true;
}
