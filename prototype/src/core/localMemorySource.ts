/**
 * 本地文件记忆来源 —— 不经 WeKnora，把本地文件夹直连为语义记忆来源。
 *
 * 形态对齐 waku 的 MEMORY.md / skills/ 的「文件即记忆」精神：
 * 用户授权一个本地文件夹（File System Access API），索引其中的
 * markdown / 文本文件；检索 = 关键词评分（文件名加权 + 正文命中数），
 * 命中片段随文件路径返回。真运行时接入后，检索门控命中即走这里。
 *
 * 句柄持久化：FileSystemDirectoryHandle 可结构化克隆存入 IndexedDB
 * （Chromium），跨刷新恢复；授权过期时行上显示「重新授权」。
 */

const DB_NAME = "agent-workbench-fs";
const STORE = "handles";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

const TEXT_EXT = new Set(["md", "mdx", "txt"]);

export interface LocalDirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<LocalEntry>;
  queryPermission?(d: { mode: string }): Promise<PermissionState>;
  requestPermission?(d: { mode: string }): Promise<PermissionState>;
}
export interface LocalFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type LocalEntry = LocalDirHandle | LocalFileHandle;

type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<LocalDirHandle>;
};

/* ------------------------------------------------------------- IDB 句柄仓 */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
  });
}

async function idbPut(id: string, handle: LocalDirHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 外部保存句柄（后端「更换文件夹」用：新句柄存同一键位） */
export async function saveHandle(id: string, handle: LocalDirHandle): Promise<void> {
  await idbPut(id, handle);
}

async function idbGet(id: string): Promise<LocalDirHandle | undefined> {
  const db = await openDb();
  const handle = await new Promise<LocalDirHandle | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as LocalDirHandle | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

async function idbDel(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

/* ------------------------------------------------------------- 来源管理 */

export interface LocalSourceHandle {
  id: string;
  handle: LocalDirHandle;
}

export async function pickLocalFolder(): Promise<{ id: string; name: string; handle: LocalDirHandle } | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持目录读取（需 Chrome / Edge）");
  try {
    const handle = await picker({ mode: "read" });
    const id = `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await idbPut(id, handle);
    return { id, name: handle.name, handle };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function loadLocalHandle(id: string): Promise<LocalDirHandle | undefined> {
  return idbGet(id);
}

export async function dropLocalHandle(id: string): Promise<void> {
  await idbDel(id);
  cache.delete(id);
}

/** 授权是否仍然有效（false = 需要用户点一次「重新授权」） */
export async function sourcePermission(handle: LocalDirHandle): Promise<"granted" | "prompt" | "denied"> {
  return (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
}

export async function requestPermission(handle: LocalDirHandle): Promise<boolean> {
  const state = (await handle.requestPermission?.({ mode: "read" })) ?? "granted";
  return state === "granted";
}

/* ------------------------------------------------------------- 索引与检索 */

export interface LocalFileEntry {
  path: string;
  size: number;
}

interface IndexedSource {
  files: LocalFileEntry[];
  contents: Map<string, string>;
}

/** 索引缓存在内存：页内切换免费；刷新后走「重新索引」（句柄还在 IDB） */
const cache = new Map<string, IndexedSource>();

export async function indexLocalSource(id: string, handle: LocalDirHandle): Promise<number> {
  const files = await walk(handle, "", 0);
  const contents = new Map<string, string>();
  for (const f of files) {
    try {
      const fh = await resolveFile(handle, f.path.split("/"));
      contents.set(f.path, await (await fh.getFile()).text());
    } catch {
      /* 单个文件读失败不阻塞整源 */
    }
  }
  cache.set(id, { files, contents });
  return files.length;
}

export function indexedFileCount(id: string): number {
  return cache.get(id)?.files.length ?? 0;
}

export function isIndexed(id: string): boolean {
  return cache.has(id);
}

async function walk(dir: LocalDirHandle, prefix: string, depth: number): Promise<LocalFileEntry[]> {
  const out: LocalFileEntry[] = [];
  if (depth > MAX_DEPTH) return out;
  let count = 0;
  for await (const entry of dir.values()) {
    if (count >= MAX_FILES) break;
    count += 1;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(entry as LocalDirHandle, path, depth + 1)));
    } else if (TEXT_EXT.has(entry.name.split(".").pop()?.toLowerCase() ?? "")) {
      const size = (await (entry as LocalFileHandle).getFile()).size;
      if (size <= MAX_FILE_BYTES) out.push({ path, size });
    }
  }
  return out;
}

async function resolveFile(root: LocalDirHandle, segments: string[]): Promise<LocalFileHandle> {
  let current: LocalDirHandle = root;
  for (const seg of segments.slice(0, -1)) {
    const next = await (
      current as unknown as { getDirectoryHandle?: (n: string) => Promise<LocalDirHandle> }
    ).getDirectoryHandle?.(seg);
    if (!next) throw new Error(`目录不存在：${seg}`);
    current = next;
  }
  const handle = await (
    current as unknown as { getFileHandle?: (n: string) => Promise<LocalFileHandle> }
  ).getFileHandle?.(segments[segments.length - 1]!);
  if (!handle) throw new Error("文件不存在");
  return handle;
}

export interface LocalHit {
  path: string;
  excerpt: string;
  score: number;
}

/** 关键词检索：文件名命中加权 + 正文命中计数；返回带上下文摘录的 top K */
export function searchLocalSource(id: string, query: string, topK = 4): LocalHit[] {
  const src = cache.get(id);
  if (!src) return [];
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const hits: LocalHit[] = [];
  for (const file of src.files) {
    const content = src.contents.get(file.path);
    if (content === undefined) continue;
    const lower = content.toLowerCase();
    const nameLower = file.path.toLowerCase();
    let score = 0;
    let firstPos = -1;
    for (const term of terms) {
      const inName = nameLower.includes(term) ? 3 : 0;
      let inBody = 0;
      let pos = lower.indexOf(term);
      while (pos !== -1) {
        inBody += 1;
        if (firstPos === -1) firstPos = pos;
        pos = lower.indexOf(term, pos + term.length);
      }
      // 所有词都命中才算相关（AND），避免单字误报
      if (inBody === 0 && inName === 0) {
        score = 0;
        break;
      }
      score += inName + inBody;
    }
    if (score <= 0) continue;

    const excerpt =
      firstPos === -1
        ? content.slice(0, 80)
        : content.slice(Math.max(0, firstPos - 30), firstPos + 60).replace(/\s+/g, " ").trim();
    hits.push({ path: file.path, excerpt, score: score + (nameLower.includes(terms[0]!) ? 5 : 0) });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 跨全部已索引来源检索 */
export function searchAllLocal(sourceIds: readonly string[], query: string, topK = 4): LocalHit[] {
  const merged: LocalHit[] = [];
  for (const id of sourceIds) merged.push(...searchLocalSource(id, query, topK));
  return merged.sort((a, b) => b.score - a.score).slice(0, topK);
}
