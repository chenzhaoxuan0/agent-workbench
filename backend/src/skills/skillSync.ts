/**
 * 官方技能播种的通用契约（docs/20 渐进式Skill化 × docs/21 P6 收敛）：daemon 持唯一
 * 正本，按版本标记行同步进 bot 工作区的 .agents/skills/（规范位）。两个官方技能
 * （agent-workbench / workbench-context）同走这一条路，作为 bot init 的基础能力。
 *
 * 同步纪律（文件即数据库）：
 * - 版本标记行 `<!-- <name>-skill: vN -->` 是同步契约——daemon 是权威源，**只在**
 *   「不存在 / 版本更旧 / force」三种情形落笔；
 * - 无标记但内容与迁移正本（legacyMd）一致 = 无标记时代 daemon 种的，视同己有可升级；
 * - 无标记且内容不同 = 用户自建技能，**不碰**（skipped-foreign）；
 * - 兼容位（relPaths 第二个起）只升级存量，不新建——新工作区只落规范位。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CanonicalSkill {
  /** 技能目录名（= 标记行前缀） */
  readonly name: string;
  readonly version: number;
  /** 正本（内含标记行）——改内容必须升 version */
  readonly md: string;
  /** 无标记时代的旧正本：内容相等即认领升级（无遗留传 undefined，无标记一律 foreign） */
  readonly legacyMd?: string;
}

export interface SkillSyncResult {
  readonly rootPath: string;
  readonly path: string;
  readonly status: "written" | "updated" | "current" | "skipped-foreign";
  readonly version: number;
}

/** 版本标记行（同步契约）：在正文中出现即认定为 daemon 维护的副本 */
export function markerLine(name: string, version: number): string {
  return `<!-- ${name}-skill: v${version}（daemon 维护，升级会覆盖；自定义请复制改名） -->`;
}

function markerRe(name: string): RegExp {
  return new RegExp(`<!--\\s*${name}-skill:\\s*v(\\d+)[^\\n>]*-->`);
}

function normalize(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

async function writeCanonical(file: string, md: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, md, "utf8");
  await rename(tmp, file);
}

/**
 * 同步一个官方技能到工作区。
 *
 * @param relPaths posix 相对路径；第一个是规范位（缺失则新建），其余是兼容位
 *   （仅当文件已存在且判定为 daemon 所有才升级，缺失/外来都不产生结果行）。
 */
export async function syncCanonicalSkill(
  rootPath: string,
  skill: CanonicalSkill,
  relPaths: readonly string[],
  opts: { force?: boolean } = {},
): Promise<SkillSyncResult[]> {
  const root = path.resolve(rootPath);
  const results: SkillSyncResult[] = [];
  for (let i = 0; i < relPaths.length; i++) {
    const file = path.join(root, ...relPaths[i]!.split("/"));
    if (!existsSync(file)) {
      if (i > 0) continue; // 兼容位不新建
      await writeCanonical(file, skill.md);
      results.push({ rootPath: root, path: file, status: "written", version: skill.version });
      continue;
    }
    const prev = normalize(await readFile(file, "utf8"));
    const m = markerRe(skill.name).exec(prev);
    let status: SkillSyncResult["status"];
    if (m === null) {
      // 无标记：与迁移正本一致 = daemon 无标记时代种的，认领升级；否则用户自建不碰
      if (opts.force !== true && (skill.legacyMd === undefined || prev !== normalize(skill.legacyMd))) {
        results.push({ rootPath: root, path: file, status: "skipped-foreign", version: skill.version });
        continue;
      }
      status = "updated";
    } else if (opts.force !== true && Number(m[1]) >= skill.version) {
      results.push({ rootPath: root, path: file, status: "current", version: Number(m[1]) });
      continue;
    } else {
      status = "updated";
    }
    await writeCanonical(file, skill.md);
    results.push({ rootPath: root, path: file, status, version: skill.version });
  }
  return results;
}
