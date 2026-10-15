/**
 * 技能管理契约（Skills Management）—— 设置页「技能」分区与 daemon `skills.*` RPC 的共享形态。
 *
 * 领域语言见仓库根 CONTEXT.md「技能与扩展」：
 * - 技能源（Skill Source）：技能被发现的真实目录；对某技能做停用的影响范围
 *   等于其技能源的可见范围（readers 就是这个「范围」的数据形态）。
 * - 停用（Disabled）：技能文件夹被移入技能源内的 `.disabled/` 目录；恢复即搬回。
 */

/** 单个技能条目（一个含 SKILL.md 的文件夹） */
export interface SkillEntryInfo {
  /** 技能源内的文件夹名（开关动作的定位键，与显示名无关） */
  readonly dirName: string;
  /** 显示名：SKILL.md frontmatter 的 name，缺省回落目录名 */
  readonly name: string;
  readonly description?: string;
  /** true = 文件夹现在位于技能源的 .disabled/ 内（对一切执行器不可见） */
  readonly disabled: boolean;
  /**
   * true = 单技能形态（SKILL.md 直挂源目录，源目录本身即技能）：
   * 列出供盘点，但不可开关 —— 搬运目标在自己内部，物理不可行。
   */
  readonly singleForm?: boolean;
}

/** 读取某技能源的执行器引用（id = daemon 裸执行器 id） */
export interface SkillReaderRef {
  readonly id: string;
  readonly name: string;
}

/** 一个技能源分组 = 设置页里的一个可折叠卡片 */
export interface SkillSourceGroupInfo {
  /** 稳定 id：`"<scope>:<dir>"`（React key 用） */
  readonly id: string;
  /** 技能源绝对路径（开关动作的定位键之一） */
  readonly dir: string;
  readonly scope: "user" | "project" | "plugin";
  /** 短标签（如「公共技能库」「zcode 专属」「agy 内置」） */
  readonly label: string;
  /**
   * 只读源（agy 内置 / agy 插件目录）：展示但不给开关 ——
   * 搬动内置目录可能破坏 IDE 自身，插件目录由插件机制自管。
   */
  readonly readOnly: boolean;
  /** 读取该源的执行器（影响范围提示：「停用将影响这些执行器」） */
  readonly readers: readonly SkillReaderRef[];
  /** 源内技能（含已停用条目，disabled 标记区分） */
  readonly skills: readonly SkillEntryInfo[];
}

/** `skills.inventory` 的返回：全量技能源分组（只含有技能的源） */
export interface SkillsInventory {
  /** 传了 rootPath 才有：项目级源的定位上下文 */
  readonly rootPath?: string;
  readonly groups: readonly SkillSourceGroupInfo[];
}
