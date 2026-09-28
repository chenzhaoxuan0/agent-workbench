/**
 * WeKnora HTTP 客户端 —— 语义记忆后端（本地 Docker 部署）。
 *
 * API 面对齐 WeKnora internal/router：
 * - 鉴权：X-API-Key 头（CORS AllowOrigins *，浏览器可直连）；
 * - 知识库列表：GET  /knowledge-bases；
 * - 事实写入：POST /knowledge-bases/:id/knowledge/manual
 *   （ManualKnowledgePayload {title, content}，异步解析入库）；
 * - 语义检索：POST /knowledge-bases/:id/hybrid-search
 *   （SearchParams {query_text, match_count…}，向量 + 关键词混合）。
 *
 * 响应解析做了防御式兼容（data 包裹 / 裸数组两种形态都认）。
 */

export interface WeknoraConfig {
  baseUrl: string;
  apiKey: string;
}

const api = (cfg: WeknoraConfig, path: string): string =>
  `${cfg.baseUrl.replace(/\/+$/, "")}/api/v1${path}`;

async function request<T>(cfg: WeknoraConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(cfg, path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { "X-API-Key": cfg.apiKey } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`WeKnora ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  return (await res.json()) as T;
}

/** 从 WeKnora 的多种响应包裹形态里抠出数组 */
function pickArray<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  const j = json as { data?: unknown; items?: unknown };
  if (Array.isArray(j.data)) return j.data as T[];
  if (Array.isArray(j.items)) return j.items as T[];
  const d = j.data as { data?: unknown; items?: unknown; knowledge_bases?: unknown } | undefined;
  if (d && Array.isArray(d.data)) return d.data as T[];
  if (d && Array.isArray(d.items)) return d.items as T[];
  if (d && Array.isArray(d.knowledge_bases)) return d.knowledge_bases as T[];
  return [];
}

export interface WeknoraKb {
  id: string;
  name: string;
}

export async function weknoraPing(cfg: WeknoraConfig): Promise<boolean> {
  const res = await fetch(api(cfg, "/health"));
  return res.ok;
}

export async function weknoraListKb(cfg: WeknoraConfig): Promise<WeknoraKb[]> {
  const json = await request<unknown>(cfg, "/knowledge-bases");
  return pickArray<WeknoraKb>(json).map((k) => ({
    id: String((k as { id?: unknown }).id ?? ""),
    name: String((k as { name?: unknown }).name ?? ""),
  }));
}

export async function weknoraCreateKb(cfg: WeknoraConfig, name: string): Promise<string> {
  const json = await request<{ data?: { id?: string } }>(cfg, "/knowledge-bases", {
    method: "POST",
    body: JSON.stringify({ name, description: "Agent Workbench · 语义记忆" }),
  });
  const id = (json as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error("创建知识库成功但未返回 id");
  return id;
}

/** 事实写入：manual knowledge（title=前缀标签，content=事实正文），异步解析入库 */
export async function weknoraSaveFact(
  cfg: WeknoraConfig,
  kbId: string,
  title: string,
  content: string,
): Promise<void> {
  await request(cfg, `/knowledge-bases/${kbId}/knowledge/manual`, {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
}

export interface WeknoraHit {
  content: string;
  score?: number;
  source?: string;
}

/** 语义 + 关键词混合检索。多来源：knowledge_base_ids 一次跨多库（WeKnora SearchParams 原生支持） */
export async function weknoraSearch(
  cfg: WeknoraConfig,
  kbIds: readonly string[],
  query: string,
  topK = 4,
): Promise<WeknoraHit[]> {
  const primary = kbIds[0];
  if (!primary) return [];
  const json = await request<unknown>(cfg, `/knowledge-bases/${primary}/hybrid-search`, {
    method: "POST",
    body: JSON.stringify({
      query_text: query,
      match_count: topK,
      vector_threshold: 0,
      keyword_threshold: 0,
      // 跨库检索：空数组 = 仅主库
      ...(kbIds.length > 1 ? { knowledge_base_ids: kbIds } : {}),
    }),
  });
  return pickArray<WeknoraHit>(json)
    .map((h) => {
      const o = h as { content?: string; text?: string; score?: number; source?: string };
      return { content: String(o.content ?? o.text ?? ""), score: o.score, source: o.source };
    })
    .filter((h) => h.content.length > 0);
}
