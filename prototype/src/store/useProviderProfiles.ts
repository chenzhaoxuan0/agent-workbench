import { create } from "zustand";

/**
 * 模型供应商 profiles —— 对齐 dsh 的 llm-pi-ai profile + pi models.json。
 *
 * 结构沿用 pi models.json 的 providers 字典（route 为键，条目含
 * baseUrl / api / models），并追加 catalogId / origin 记录来源。
 *
 * ⚠ 凭据边界：dsh 把 secret 存独立凭据库、配置里只留 apiKeyEnv 引用名。
 * 原型期把 key 明文存进 localStorage 是**有意的妥协**（本地单用户、
 * 无服务端），接真运行时后必须改为凭据引用。
 */

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
}

export interface ProviderProfile {
  /** 唯一 route：内置目录 id 或自定义小写连字符 id */
  readonly route: string;
  readonly catalogId?: string;
  readonly origin: "catalog" | "custom";
  readonly displayName?: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  /** 原型期明文存储；真运行时应改为 apiKeyEnv 引用名 + 凭据库 */
  readonly apiKey?: string;
  readonly models: readonly ProviderModelEntry[];
}

interface ProviderProfilesState {
  profiles: Readonly<Record<string, ProviderProfile>>;
  upsert: (profile: ProviderProfile) => void;
  remove: (route: string) => void;
}

const STORAGE_KEY = "agent-workbench:provider-profiles";

function loadProfiles(): Readonly<Record<string, ProviderProfile>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProviderProfile>) : {};
  } catch {
    return {};
  }
}

function saveProfiles(profiles: Readonly<Record<string, ProviderProfile>>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    /* 存储满/隐私模式：静默失败，内存态仍可用 */
  }
}

export const useProviderProfiles = create<ProviderProfilesState>()((set, get) => ({
  profiles: loadProfiles(),
  upsert: (profile) => {
    const next = { ...get().profiles, [profile.route]: profile };
    saveProfiles(next);
    set({ profiles: next });
  },
  remove: (route) => {
    const next = { ...get().profiles };
    delete next[route];
    saveProfiles(next);
    set({ profiles: next });
  },
}));
