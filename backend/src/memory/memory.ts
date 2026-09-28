/**
 * 记忆编排服务端化（Phase 7）—— 三柱（语义/情节/程序）× 多后端（sqlite / weknora）。
 *
 * 语义对齐 waku 三柱（docs/05 §四）与前端 useMemoryPrefs：
 * - 路由表：pillar → backends[]（写入广播、检索并集），per-bot 调用时覆盖；
 * - sqlite 后端永远可用（LIKE 兜底检索）；weknora 是语义柱的增强（真向量检索，
 *   本地 Docker，客户端契约照抄 prototype/src/core/weknora.ts）；
 * - MEMORY.md 镜像：语义柱落盘时重生成（.waku/memory/MEMORY.md），浏览器里的
 *   localMemorySource/weknora 客户端保持不动（docs/06 §八）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

export type Pillar = "semantic" | "episodic" | "procedural";
export type MemoryBackendKind = "sqlite" | "weknora";

const PILLARS: readonly Pillar[] = ["semantic", "episodic", "procedural"];

interface WeknoraConfig {
  baseUrl: string;
  apiKey: string;
  kbIds: string[];
}

export interface MemoryHit {
  readonly backend: MemoryBackendKind;
  readonly pillar: string;
  readonly content: string;
  readonly score?: number;
  readonly source?: string | null;
  readonly createdAt?: number;
}

// ---- WeKnora 客户端（契约照抄 prototype/src/core/weknora.ts，服务端跑免 CORS） --

function weknoraApi(cfg: WeknoraConfig, p: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/api/v1${p}`;
}

async function weknoraRequest(cfg: WeknoraConfig, p: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(weknoraApi(cfg, p), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { "X-API-Key": cfg.apiKey } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`WeKnora ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as unknown;
}

function pickArray(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  const j = json as { data?: unknown; items?: unknown };
  if (Array.isArray(j.data)) return j.data as Array<Record<string, unknown>>;
  if (Array.isArray(j.items)) return j.items as Array<Record<string, unknown>>;
  const d = j.data as { data?: unknown; items?: unknown; knowledge_bases?: unknown } | undefined;
  if (d && Array.isArray(d.data)) return d.data as Array<Record<string, unknown>>;
  if (d && Array.isArray(d.items)) return d.items as Array<Record<string, unknown>>;
  if (d && Array.isArray(d.knowledge_bases)) return d.knowledge_bases as Array<Record<string, unknown>>;
  return [];
}

async function weknoraSaveFact(cfg: WeknoraConfig, kbId: string, title: string, content: string): Promise<void> {
  await weknoraRequest(cfg, `/knowledge-bases/${kbId}/knowledge/manual`, {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
}

async function weknoraSearch(cfg: WeknoraConfig, kbIds: readonly string[], query: string, topK: number): Promise<MemoryHit[]> {
  const primary = kbIds[0];
  if (primary === undefined) return [];
  const json = await weknoraRequest(cfg, `/knowledge-bases/${primary}/hybrid-search`, {
    method: "POST",
    body: JSON.stringify({
      query_text: query,
      match_count: topK,
      vector_threshold: 0,
      keyword_threshold: 0,
      ...(kbIds.length > 1 ? { knowledge_base_ids: kbIds } : {}),
    }),
  });
  return pickArray(json)
    .map((h) => ({
      backend: "weknora" as const,
      pillar: "semantic",
      content: String(h["content"] ?? h["text"] ?? ""),
      score: typeof h["score"] === "number" ? h["score"] : undefined,
      source: typeof h["source"] === "string" ? h["source"] : null,
    }))
    .filter((h) => h.content.length > 0);
}

// ---- 服务本体 ---------------------------------------------------------------

export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly homeDir: string,
  ) {}

  // ---- 配置 ----

  private routingConfig(): Record<Pillar, MemoryBackendKind[]> {
    const raw = this.store.kvGet("memory.routing");
    const fallback: Record<Pillar, MemoryBackendKind[]> = { semantic: ["sqlite"], episodic: ["sqlite"], procedural: ["sqlite"] };
    if (raw === undefined) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(raw) as Partial<Record<Pillar, MemoryBackendKind[]>>) };
    } catch {
      return fallback;
    }
  }

  getRouting(): Record<Pillar, MemoryBackendKind[]> {
    return this.routingConfig();
  }

  setRouting(routing: Partial<Record<Pillar, MemoryBackendKind[]>>): Record<Pillar, MemoryBackendKind[]> {
    const merged = { ...this.routingConfig(), ...routing };
    for (const [pillar, backends] of Object.entries(merged)) {
      if (!PILLARS.includes(pillar as Pillar) || !Array.isArray(backends)) {
        throw Object.assign(new Error(`bad routing for ${pillar}`), { code: "bad_params" });
      }
    }
    this.store.kvSet("memory.routing", JSON.stringify(merged));
    return merged;
  }

  /** 调用时解析（per-bot 覆盖 → 全局路由），sqlite 永远兜底在场 */
  private resolveBackends(pillar: Pillar, override?: MemoryBackendKind[]): MemoryBackendKind[] {
    const list = override ?? this.routingConfig()[pillar] ?? ["sqlite"];
    return list.includes("sqlite") ? list : [...list, "sqlite"];
  }

  weknoraGetConfig(): { baseUrl: string; apiKeyMasked: string; kbIds: string[] } {
    const raw = this.store.kvGet("memory.weknora");
    if (raw === undefined) return { baseUrl: "", apiKeyMasked: "", kbIds: [] };
    const cfg = JSON.parse(raw) as WeknoraConfig;
    return {
      baseUrl: cfg.baseUrl,
      apiKeyMasked: cfg.apiKey === "" ? "" : `${cfg.apiKey.slice(0, 4)}…`,
      kbIds: cfg.kbIds,
    };
  }

  weknoraSetConfig(input: { baseUrl: string; apiKey?: string; kbIds?: string[] }): void {
    const prev = (() => {
      const raw = this.store.kvGet("memory.weknora");
      return raw === undefined ? { baseUrl: "", apiKey: "", kbIds: [] as string[] } : (JSON.parse(raw) as WeknoraConfig);
    })();
    const cfg: WeknoraConfig = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? prev.apiKey,
      kbIds: input.kbIds ?? prev.kbIds,
    };
    this.store.kvSet("memory.weknora", JSON.stringify(cfg));
  }

  // ---- 写入（广播到路由的后端） ----

  async save(input: {
    pillar: Pillar;
    content: string;
    source?: string;
    backends?: MemoryBackendKind[];
  }): Promise<{ results: Array<{ backend: MemoryBackendKind; ok: boolean; error?: string }> }> {
    if (!PILLARS.includes(input.pillar)) throw Object.assign(new Error(`bad pillar: ${input.pillar}`), { code: "bad_params" });
    if (input.content.trim() === "") throw Object.assign(new Error("content is required"), { code: "bad_params" });
    const backends = this.resolveBackends(input.pillar, input.backends);
    const results: Array<{ backend: MemoryBackendKind; ok: boolean; error?: string }> = [];

    for (const backend of backends) {
      if (backend === "sqlite") {
        this.store.insertMemory(input.pillar, input.content, input.source ?? null);
        results.push({ backend, ok: true });
      } else {
        const cfg = this.weknoraCfg();
        try {
          const kbId = cfg.kbIds[0];
          if (kbId === undefined) throw new Error("weknora kbIds not configured");
          await weknoraSaveFact(cfg, kbId, `${input.pillar}:${input.source ?? "daemon"}`, input.content);
          results.push({ backend, ok: true });
        } catch (err: unknown) {
          results.push({ backend, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (input.pillar === "semantic") await this.regenerateMirror();
    log.info("memory saved", { pillar: input.pillar, backends: backends.join(",") });
    return { results };
  }

  // ---- 检索（路由后端并集） ----

  async search(input: {
    query: string;
    pillars?: readonly Pillar[];
    backends?: MemoryBackendKind[];
    topK?: number;
  }): Promise<{ hits: MemoryHit[]; errors: Array<{ backend: MemoryBackendKind; error: string }> }> {
    if (input.query.trim() === "") throw Object.assign(new Error("query is required"), { code: "bad_params" });
    const pillars = input.pillars ?? PILLARS;
    const topK = input.topK ?? 6;
    const hits: MemoryHit[] = [];
    const errors: Array<{ backend: MemoryBackendKind; error: string }> = [];

    // sqlite：LIKE 兜底，逐柱查
    if (this.resolveBackends("semantic", input.backends).includes("sqlite")) {
      for (const pillar of pillars) {
        for (const r of this.store.searchMemory(pillar, input.query, topK)) {
          hits.push({ backend: "sqlite", pillar, content: r.content, source: r.source, createdAt: r.createdAt });
        }
      }
    }

    // weknora：语义柱增强（未配/不可达 → 记错误不炸检索）
    const semanticBackends = this.resolveBackends("semantic", input.backends);
    if (semanticBackends.includes("weknora") && pillars.includes("semantic")) {
      const cfg = this.weknoraCfg();
      if (cfg.baseUrl === "" || cfg.kbIds.length === 0) {
        errors.push({ backend: "weknora", error: "weknora not configured" });
      } else {
        try {
          hits.push(...(await weknoraSearch(cfg, cfg.kbIds, input.query, topK)));
        } catch (err: unknown) {
          errors.push({ backend: "weknora", error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { hits, errors };
  }

  list(pillar: Pillar): Array<{ id: number; content: string; source: string | null; createdAt: number }> {
    return this.store.listMemory(pillar);
  }

  // ---- MEMORY.md 镜像 ----

  private weknoraCfg(): WeknoraConfig {
    const raw = this.store.kvGet("memory.weknora");
    return raw === undefined ? { baseUrl: "", apiKey: "", kbIds: [] } : (JSON.parse(raw) as WeknoraConfig);
  }

  private mirrorPath(): string {
    return path.join(this.homeDir, "memory", "MEMORY.md");
  }

  async regenerateMirror(): Promise<string> {
    const rows = [...this.store.listMemory("semantic")].reverse(); // 旧 → 新
    const body = [
      "# MEMORY.md（语义记忆镜像 · daemon 生成）",
      "",
      ...rows.map((r) => `- ${new Date(r.createdAt).toISOString().slice(0, 10)} ${r.content}${r.source === null ? "" : `（来源：${r.source}）`}`),
      "",
    ].join("\n");
    const file = this.mirrorPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
    return file;
  }

  async readMirror(): Promise<string> {
    return readFile(this.mirrorPath(), "utf8").catch(() => "");
  }
}
