/**
 * 后台守护链路配置（Guardian Configuration）。
 *
 * 负责后台轻量任务（合并压缩 Auto-Consolidation、每日总结 Daily Digest、Curator 巡检）
 * 的执行引擎 (CLI runner)、模型选型 (model)、超时与策略。
 *
 * 持久化存入 store 的 kv 表 key="memory.guardian"。
 */

import type { Store } from "../store/db.ts";

export type GuardianRunner = "zcode" | "claude" | "codex" | "pi" | "mcode" | "agy" | "custom";

export interface MemoryGuardianConfig {
  /** 调度哪家 CLI 执行后台轻量任务，默认 "zcode" */
  readonly runner: GuardianRunner;
  /** 自定义 CLI 执行命令（当 runner 为 custom 时使用） */
  readonly customCommand?: string;
  /** 指定使用的模型名称。留空 = 跟随总管（不传 --model，用该 CLI 自己的默认模型） */
  readonly model: string;
  /** 单次后台任务超时时间（毫秒），默认 180,000 (3 分钟) */
  readonly timeoutMs: number;
  /** 是否开启记忆超限自动合并压缩（Auto-Consolidation） */
  readonly autoConsolidate: boolean;
  /** 触发自动合并压缩的容量比例阈值（如 0.95 = 95% 容量时触发） */
  readonly consolidateThresholdRatio: number;
  /** 是否开启写入时的安全威胁与敏感凭据拦截（Content Scanner） */
  readonly contentScannerEnabled: boolean;
  /** 是否启用每日总结定时任务（设置页开关的权威值；关掉只停定时跑，手动试跑不受影响） */
  readonly digestEnabled: boolean;
}

/**
 * 与总管同款默认执行器（memory/steward.ts 的 STEWARD_RUNTIME_ID）。
 * 两处刻意不共享 import（steward 链路拉一串依赖），改任一处须同步另一处。
 */
const STEWARD_DEFAULT_RUNNER: GuardianRunner = "mcode";

export const DEFAULT_GUARDIAN_CONFIG: MemoryGuardianConfig = {
  runner: STEWARD_DEFAULT_RUNNER,
  // 留空 = 跟随总管：不向 CLI 传 --model，用该执行器自己的默认模型
  //（llm.ts 对空 model 就是不拼 flag）。绝不写死示例名——占位名会被当真存进
  // 配置里，用户看到「deepseek-chat」以为是自己选的。
  model: "",
  timeoutMs: 180_000,
  autoConsolidate: true,
  consolidateThresholdRatio: 0.95,
  contentScannerEnabled: true,
  digestEnabled: true,
};

const KV_KEY = "memory.guardian";

export function getGuardianConfig(store: Store): MemoryGuardianConfig {
  const raw = store.kvGet(KV_KEY);
  if (raw === undefined) return DEFAULT_GUARDIAN_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryGuardianConfig>;
    return {
      runner: parsed.runner ?? DEFAULT_GUARDIAN_CONFIG.runner,
      ...(typeof parsed.customCommand === "string" && parsed.customCommand !== "" ? { customCommand: parsed.customCommand } : {}),
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_GUARDIAN_CONFIG.model,
      timeoutMs: typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : DEFAULT_GUARDIAN_CONFIG.timeoutMs,
      autoConsolidate: typeof parsed.autoConsolidate === "boolean" ? parsed.autoConsolidate : DEFAULT_GUARDIAN_CONFIG.autoConsolidate,
      consolidateThresholdRatio:
        typeof parsed.consolidateThresholdRatio === "number" && parsed.consolidateThresholdRatio > 0 && parsed.consolidateThresholdRatio <= 1
          ? parsed.consolidateThresholdRatio
          : DEFAULT_GUARDIAN_CONFIG.consolidateThresholdRatio,
      contentScannerEnabled:
        typeof parsed.contentScannerEnabled === "boolean" ? parsed.contentScannerEnabled : DEFAULT_GUARDIAN_CONFIG.contentScannerEnabled,
      digestEnabled: typeof parsed.digestEnabled === "boolean" ? parsed.digestEnabled : DEFAULT_GUARDIAN_CONFIG.digestEnabled,
    };
  } catch {
    return DEFAULT_GUARDIAN_CONFIG;
  }
}

export function setGuardianConfig(store: Store, patch: Partial<MemoryGuardianConfig>): MemoryGuardianConfig {
  const current = getGuardianConfig(store);
  const next: MemoryGuardianConfig = {
    ...current,
    ...patch,
  };
  store.kvSet(KV_KEY, JSON.stringify(next));
  return getGuardianConfig(store);
}

