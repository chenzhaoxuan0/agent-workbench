/**
 * 对话分叉的历史条目折叠（ADR 0013 P2）：同一锚点（forkOf + forkAtSeq）的
 * revision 兄弟段折叠为一个家族槽位 —— 代表行 = 最新版本，其余成员可展开导航
 * （Maka session-revisions 的「version X of Y」模式）。branch 段不折叠：
 * 它们是平行的探索方向，不是同一句话的改写，平铺即可。
 *
 * 两个消费方：HistoryPane（完整折叠 + 展开导航）、Sidebar 历史子列表
 * （只用 versionBadge 摘要，不展开）。
 */

export interface ForkVersionSlot<T> {
  /** 家族代表行（最新版本；单条目家族 = 它自己） */
  readonly entry: T;
  /** 同锚点全部 revision（含代表行，按 startedAt 旧 → 新）。undefined = 非家族行 */
  readonly family: readonly T[] | undefined;
  /** 代表行在家族里的版本号（1 起，新 → 旧计数：最新 = N） */
  readonly versionFrom: number;
  readonly versionCount: number;
}

interface ForkFields {
  readonly forkOf?: string | null;
  readonly forkAtSeq?: number | null;
  readonly forkKind?: string | null;
  readonly startedAt: number;
}

/**
 * 输入应已按 startedAt 降序排好（unit.history 的天然顺序）。
 * 输出保持降序；家族占据其最新成员的位置。
 */
export function collapseForkVersions<T extends ForkFields>(entries: readonly T[]): ForkVersionSlot<T>[] {
  // 家族键 → 成员（降序输入，收集后反转成旧 → 新）
  const families = new Map<string, T[]>();
  const familyKeyOf = (e: T): string | null =>
    e.forkKind === "revision" && typeof e.forkOf === "string" && typeof e.forkAtSeq === "number"
      ? `${e.forkOf}@${e.forkAtSeq}`
      : null;

  for (const e of entries) {
    const key = familyKeyOf(e);
    if (key === null) continue;
    const list = families.get(key);
    if (list !== undefined) list.push(e);
    else families.set(key, [e]);
  }

  const out: ForkVersionSlot<T>[] = [];
  const emitted = new Set<string>();
  for (const e of entries) {
    const key = familyKeyOf(e);
    if (key === null) {
      out.push({ entry: e, family: undefined, versionFrom: 1, versionCount: 1 });
      continue;
    }
    if (emitted.has(key)) continue; // 家族已在其最新成员的位置折叠
    emitted.add(key);
    const family = [...(families.get(key) ?? [])].sort((a, b) => a.startedAt - b.startedAt); // 旧 → 新
    out.push({
      entry: e, // 降序遍历里第一个 = 最新
      family,
      versionFrom: family.length, // 最新 = 第 N 版
      versionCount: family.length,
    });
  }
  return out;
}

/** 行内摘要徽标文案：普通分叉 → 「分叉」；revision 家族 → 「v2/3」 */
export function forkVersionBadge<T extends ForkFields>(slot: ForkVersionSlot<T>): string | null {
  if (slot.family !== undefined) return `v${slot.versionFrom}/${slot.versionCount}`;
  if (slot.entry.forkKind === "branch") return "分叉";
  if (slot.entry.forkKind === "revision") return "重发";
  return null;
}
