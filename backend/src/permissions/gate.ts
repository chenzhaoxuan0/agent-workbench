/**
 * 权限闸（Phase 4）—— 规则表驱动的审批决策器。
 *
 * 语义（对齐 docs/06 Phase 4）：
 * - permission.requested 挂起 → 有规则命中就自动放行/拒绝（不打扰人）；
 * - 没规则就等人：REST/WS 的 resolve 送 decision；
 * - decision = "always" 时落规则表，同类请求下次不再问。
 *
 * 匹配口径（刻意从简，避免第二套 glob 方言）：pattern 对工具名/详情做
 * 「去分隔符小写包含」匹配 —— "npm install" 命中 "Run npm install --save dev"。
 * runtimeId / kind 缺省 = 通配。规则按 id 倒序（新规则优先）。
 */

import type { Store } from "../store/db.ts";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  readonly id: number;
  readonly runtimeId: string | null;
  readonly kind: string | null;
  readonly pattern: string;
  readonly decision: PermissionDecision;
  readonly createdAt: number;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export class PermissionGate {
  constructor(private readonly store: Store) {}

  /** 命中返回决策；无命中返回 null（= 问人） */
  evaluate(runtimeId: string, kind: string, toolName: string, detail: string): PermissionDecision | null {
    const haystack = normalize(`${toolName} ${detail}`);
    for (const rule of this.store.listPermissionRules()) {
      if (rule.runtimeId !== null && rule.runtimeId !== runtimeId) continue;
      if (rule.kind !== null && rule.kind !== kind) continue;
      // ⚠ 归一化后为空串的 pattern（"*" / "**" / "--" 这类只有非字母数字的写法）
      // 会让 `includes("")` 恒为 true —— 一条看起来「只匹配某类」的规则会变成
      // 该 runtime 下**所有**请求的全局自动放行/拒绝。空归一化一律视为无规则。
      const needle = normalize(rule.pattern);
      if (needle === "") continue;
      if (haystack.includes(needle)) return rule.decision === "deny" ? "deny" : "allow";
    }
    return null;
  }

  addRule(input: { runtimeId?: string | null; kind?: string | null; pattern: string; decision: PermissionDecision }): number {
    if (input.pattern.trim() === "") throw Object.assign(new Error("pattern is required"), { code: "bad_params" });
    // 与 evaluate 同一口径：归一化后没剩下任何字母数字的 pattern 匹配一切，不许入库
    if (normalize(input.pattern) === "") {
      throw Object.assign(new Error("pattern must contain at least one letter or digit"), { code: "bad_params" });
    }
    return this.store.addPermissionRule({
      runtimeId: input.runtimeId ?? null,
      kind: input.kind ?? null,
      pattern: input.pattern.trim(),
      decision: input.decision,
    });
  }

  listRules(): PermissionRule[] {
    return this.store.listPermissionRules() as PermissionRule[];
  }

  deleteRule(id: number): boolean {
    return this.store.deletePermissionRule(id);
  }
}
