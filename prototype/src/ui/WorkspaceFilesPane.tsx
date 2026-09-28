import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, FolderOpen as FolderPicker, RefreshCw } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 工作区文件 —— 浏览当前工作单元 rootPath 下的真实文件。
 *
 * 浏览器沙箱不能直接读磁盘，走 File System Access API（Chromium）：
 * 用户对工作目录授权一次，之后本页签内可刷新浏览/预览文本文件。
 * 授权句柄按工作单元根路径缓存在内存（刷新页面后需重新授权一次）。
 *
 * 这是「功能不能因为为空而消失」的又一处：未授权时给出明确的
 * 授权入口与浏览器兼容提示，而不是渲染一个空页签。
 */

const MAX_DEPTH = 5;
const MAX_ENTRIES = 600;
const MAX_PREVIEW_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo"]);

const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "css", "scss",
  "html", "txt", "yml", "yaml", "toml", "svg", "xml", "py", "rs", "go", "sh",
]);

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

interface FsDirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FsEntry>;
  getDirectoryHandle?(name: string): Promise<FsDirHandle>;
  getFileHandle?(name: string): Promise<FsFileHandle>;
  queryPermission?(d: { mode: string }): Promise<PermissionState>;
  requestPermission?(d: { mode: string }): Promise<PermissionState>;
}
interface FsFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type FsEntry = FsDirHandle | FsFileHandle;

interface FsNode {
  name: string;
  kind: "dir" | "file";
  size?: number;
  children?: FsNode[];
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FsDirHandle>;
};

/** 授权句柄按根路径缓存：切页签/切单元不丢连接 */
const handleCache = new Map<string, FsDirHandle>();

export function WorkspaceFilesPane() {
  const rootPath = useWorkbench(selectActiveUnit)?.rootPath;
  const supported = useMemo(() => typeof window !== "undefined" && "showDirectoryPicker" in window, []);
  const [dir, setDir] = useState<FsDirHandle | null>(() => (rootPath ? handleCache.get(rootPath) ?? null : null));
  const [nodes, setNodes] = useState<readonly FsNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    setDir(rootPath ? handleCache.get(rootPath) ?? null : null);
    setNodes(null);
    setPreview(null);
  }, [rootPath]);

  const enumerate = useCallback(async (handle: FsDirHandle) => {
    setLoading(true);
    setError(null);
    try {
      setNodes(await readDir(handle, 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const connect = async () => {
    setError(null);
    if (!rootPath) return;
    const picker = (window as unknown as PickerWindow).showDirectoryPicker;
    if (!picker) return;
    try {
      const handle = await picker({ mode: "read" });
      handleCache.set(rootPath, handle);
      setDir(handle);
      await enumerate(handle);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const refresh = async () => {
    if (!dir) return;
    const perm = (await dir.queryPermission?.({ mode: "read" })) ?? "granted";
    if (perm !== "granted") {
      const granted = (await dir.requestPermission?.({ mode: "read" })) ?? perm;
      if (granted !== "granted") return setError("授权被拒绝，无法读取该目录");
    }
    await enumerate(dir);
  };

  const openFile = async (node: FsNode, path: string) => {
    if (!dir) return;
    const ext = extOf(node.name);
    if (!TEXT_EXT.has(ext)) {
      return setPreview({ name: path, text: `（不支持预览 .${ext} —— 二进制或未知格式）` });
    }
    if ((node.size ?? 0) > MAX_PREVIEW_BYTES) {
      return setPreview({ name: path, text: "（文件超过 256KB，不予预览）" });
    }
    setPreviewLoading(true);
    try {
      const handle = await resolveFile(dir, path.split("/"));
      const text = await (await handle.getFile()).text();
      setPreview({ name: path, text: text.slice(0, MAX_PREVIEW_BYTES) });
    } catch (e) {
      setPreview({ name: path, text: `读取失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setPreviewLoading(false);
    }
  };

  if (!rootPath) {
    return (
      <Notice text="未选择工作单元。" sub="先在左侧选择一个 bot 或项目，这里会浏览它的工作目录。" />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-graphite" title={rootPath}>
          {rootPath}
        </span>
        {dir && (
          <button
            onClick={refresh}
            title="刷新目录"
            aria-label="刷新目录"
            className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          </button>
        )}
      </div>

      {!supported ? (
        <Notice
          text="当前浏览器不支持目录读取。"
          sub="文件浏览基于 File System Access API，请使用 Chrome / Edge 打开。"
        />
      ) : !dir ? (
        <div className="rounded-card border border-dashed border-line px-4 py-5 text-center">
          <FolderPicker size={20} className="mx-auto text-ash" />
          <p className="mt-2 text-body-sm text-ink">连接工作目录</p>
          <p className="mx-auto mt-1 max-w-[240px] text-caption leading-relaxed text-ash">
            授权浏览器读取「{rootPath}」后，这里会列出真实文件树；纯本地授权，不经任何服务器。
          </p>
          <button
            onClick={connect}
            className="mt-3 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black"
          >
            选择文件夹
          </button>
          {error && <p className="mt-2 text-caption text-loss">{error}</p>}
        </div>
      ) : (
        <>
          {error && <p className="rounded-btn bg-loss/10 px-2 py-1 text-caption text-loss">{error}</p>}
          {loading && nodes === null ? (
            <p className="px-2 py-2 text-caption text-ash">读取中…</p>
          ) : nodes && nodes.length > 0 ? (
            <div className="-mx-1 overflow-y-auto">
              <Tree
                nodes={nodes}
                depth={0}
                prefix=""
                expanded={expanded}
                previewPath={preview?.name ?? null}
                onToggle={toggleKey}
                onOpen={openFile}
              />
            </div>
          ) : (
            <p className="px-2 py-2 text-caption text-ash">
              目录为空（或全部被过滤：node_modules / .git / dist）。
            </p>
          )}

          {previewLoading && <p className="px-2 py-1 text-caption text-ash">读取文件…</p>}
          {preview && (
            <div className="rounded-card border border-line bg-canvas">
              <p className="truncate border-b border-line-soft px-2.5 py-1.5 font-mono text-caption text-ink">
                {preview.name}
              </p>
              <pre className="max-h-72 overflow-auto whitespace-pre p-2.5 font-mono text-caption leading-relaxed text-graphite">
                {preview.text}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );

  function toggleKey(key: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
}

/* ------------------------------------------------------------- 目录树 */

async function readDir(dir: FsDirHandle, depth: number): Promise<FsNode[]> {
  const out: FsNode[] = [];
  let count = 0;
  for await (const entry of dir.values()) {
    if (count >= MAX_ENTRIES) break;
    count += 1;
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) {
        out.push({ name: entry.name, kind: "dir", children: [] });
        continue;
      }
      out.push({ name: entry.name, kind: "dir", children: await readDir(entry as FsDirHandle, depth + 1) });
    } else {
      let size: number | undefined;
      try {
        size = (await (entry as FsFileHandle).getFile()).size;
      } catch {
        /* 拿不到大小就空着 */
      }
      out.push({ name: (entry as FsFileHandle).name, kind: "file", size });
    }
  }
  return out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
}

async function resolveFile(root: FsDirHandle, segments: string[]): Promise<FsFileHandle> {
  let current: FsDirHandle = root;
  for (const seg of segments.slice(0, -1)) {
    const next = await current.getDirectoryHandle?.(seg);
    if (!next) throw new Error(`目录不存在：${seg}`);
    current = next;
  }
  const handle = await current.getFileHandle?.(segments[segments.length - 1]!);
  if (!handle) throw new Error("文件不存在");
  return handle;
}

function Tree({
  nodes,
  depth,
  prefix,
  expanded,
  previewPath,
  onToggle,
  onOpen,
}: {
  nodes: readonly FsNode[];
  depth: number;
  prefix: string;
  expanded: ReadonlySet<string>;
  previewPath: string | null;
  onToggle: (key: string) => void;
  onOpen: (node: FsNode, path: string) => void;
}) {
  return (
    <ul className="space-y-px">
      {nodes.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        const key = path;
        const isDir = node.kind === "dir";
        const isOpen = expanded.has(key);
        return (
          <li key={key}>
            <button
              onClick={() => (isDir ? onToggle(key) : onOpen(node, path))}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-btn py-0.5 pr-1 text-left text-caption hover:bg-line-soft",
                previewPath === path && "bg-teal-tint",
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              {isDir ? (
                <>
                  {isOpen ? (
                    <ChevronDown size={10} className="shrink-0 text-ash" />
                  ) : (
                    <ChevronRight size={10} className="shrink-0 text-ash" />
                  )}
                  <FolderOpen size={11} className="shrink-0 text-graphite" />
                  <span className="truncate font-medium text-ink">{node.name}</span>
                  {node.children?.length === 0 && <span className="text-ash">(空)</span>}
                </>
              ) : (
                <>
                  <span className="w-[10px] shrink-0" />
                  <span className="truncate text-graphite">{node.name}</span>
                  {node.size !== undefined && (
                    <span className="tnum ml-auto shrink-0 text-ash">{formatSize(node.size)}</span>
                  )}
                </>
              )}
            </button>
            {isDir && isOpen && node.children && node.children.length > 0 && (
              <Tree
                nodes={node.children}
                depth={depth + 1}
                prefix={path}
                expanded={expanded}
                previewPath={previewPath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Notice({ text, sub }: { text: string; sub: string }) {
  return (
    <div className="px-1 py-4 text-center">
      <p className="text-body-sm text-graphite">{text}</p>
      <p className="mx-auto mt-1 max-w-[240px] text-caption leading-relaxed text-ash">{sub}</p>
    </div>
  );
}
