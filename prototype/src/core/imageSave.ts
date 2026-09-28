/**
 * 出图保存位置 —— File System Access API（与 core/localMemorySource.ts
 * 的本地文件夹来源同一套句柄持久化模式）。
 *
 * 用户在设置页「出图 → 保存位置」选定一个真实文件夹：
 * - 句柄存 IndexedDB（db `agent-workbench:image-fs`，store `handles`，键 `saveDir`）；
 * - 显示名同步进 localStorage（image-studio store 的 saveDirName）；
 * - 自动保存：生成成功后逐张写入文件夹（autoSave 开启且权限 granted）；
 * - 页面刷新后句柄仍在，但需要用户点一次「重新授权」
 *   （requestPermission 必须由用户手势触发，浏览器安全约束）。
 *
 * 文件名：`img-<日期时间>-<序号>-<prompt 短语>.<格式>`。
 */

const DB_NAME = "agent-workbench:image-fs";
const STORE = "handles";
const HANDLE_KEY = "saveDir";

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "readwrite" | "read" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" | "read" }) => Promise<PermissionState>;
};

type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<DirHandle>;
};

export const SAVE_DIR_SUPPORT =
  typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
  });
}

/** 打开系统文件夹选择器（必须由用户手势调用）；返回显示名 */
export async function pickSaveFolder(): Promise<string | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  const handle = await picker({ id: "agent-workbench-image-save", mode: "readwrite" });
  if (!handle) return null;
  await idbPut(handle);
  return handle.name;
}

async function idbPut(handle: DirHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(): Promise<DirHandle | undefined> {
  const db = await openDb();
  const handle = await new Promise<DirHandle | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result as DirHandle | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

async function idbDel(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

/** 恢复已保存的文件夹句柄；返回显示名与权限态（granted / prompt / denied / none） */
export async function loadSaveFolder(): Promise<{ name: string | null; permission: "granted" | "prompt" | "denied" | "none" }> {
  const handle = await idbGet();
  if (!handle) return { name: null, permission: "none" };
  const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  return { name: handle.name, permission: state };
}

/** 清除保存位置（句柄 + 名称由调用方同步清 store） */
export async function clearSaveFolder(): Promise<void> {
  await idbDel();
}

/** 重新授权（必须由用户手势调用，如「重新授权」按钮） */
export async function ensureSavePermission(): Promise<boolean> {
  const handle = await idbGet();
  if (!handle) return false;
  const current = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (current === "granted") return true;
  if (current === "denied") return false;
  const next = (await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
  return next === "granted";
}

/** dataURL → Blob */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** prompt → 文件名安全短语（去路径分隔/控制符，压空白，截 24 字符） */
export function promptSlug(prompt: string): string {
  const cleaned = prompt
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned || "image";
}

const stamp = () =>
  new Date()
    .toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .replace(/\D/g, "");

/** 单张写入保存文件夹；返回落盘文件名 */
export async function saveImageToFolder(dataUrl: string, prompt: string, index: number, ext: string): Promise<string> {
  const dir = await idbGet();
  if (!dir) throw new Error("未设置保存文件夹");
  const fileName = `img-${stamp()}-${index + 1}-${promptSlug(prompt)}.${ext}`;
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(await dataUrlToBlob(dataUrl));
  await writable.close();
  return fileName;
}
