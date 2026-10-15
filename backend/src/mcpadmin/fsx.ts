/**
 * 配置文件写入基建 —— MCP 管理的护栏层（借鉴 ZCode atomicFileUtils 与 cc-switch live/engine）。
 *
 * 三条铁律（源码走查实证，见 README 参照表）：
 * 1. fail-stop：解析失败绝不 当空对象 继续 —— 否则会静默清空用户其余配置
 *    （ZCode mcpSyncService 与 cc-switch mcp/codex 的注释都是血泪教训）。
 * 2. 原子写：同目录临时文件 + rename；Windows 上 EPERM/EBUSY（Defender/索引器
 *    短暂占用）指数退避重试，真权限错误仍然抛出。
 * 3. 首写字节级备份：每个文件第一次被工作台改写前留一份原始快照 ——
    「直写别人地盘」的最后一道后悔药。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** 文件字节指纹（sha256 前 16 位足够本地乐观锁），文件不存在返回 null */
export function fingerprint(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 原子写文本：tmp（同目录、点前缀隐藏）→ rename，Windows EPERM/EBUSY/EACCES
 * 指数退避（50ms → 3.2s，共 ~6 次）。失败时清理临时文件再抛。
 * 异步退避 —— daemon 是多连接常驻进程，绝不能为重试同步阻塞事件循环。
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const cleanup = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清不掉就算了：点前缀临时文件，下次首写备份扫描时可顺手清 */
    }
  };
  try {
    writeFileSync(tmp, text, "utf8");
  } catch (err: unknown) {
    cleanup();
    throw err;
  }
  const delays = [50, 100, 200, 400, 800, 3200];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  cleanup();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 首写字节级备份：某文件第一次被改写前，把原始字节复制到
 * `<homeDir>/mcp-backups/<safe-name>.orig`（只此一份，不滚动）。
 * 备份失败不阻断写入 —— 它是后悔药，不是门禁；但要点出问题便于排查。
 */
export function firstWriteBackup(path: string, homeDir: string): void {
  try {
    if (!existsSync(path)) return;
    const backupDir = join(homeDir, "mcp-backups");
    const safe = path.replaceAll(/[\\/:*?"<>|]/g, "_");
    const target = join(backupDir, `${safe}.orig`);
    if (existsSync(target)) return; // 只留第一次的
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(path, target);
  } catch {
    /* 见上：后悔药不是门禁 */
  }
}

/**
 * 读文本（utf8）；文件不存在返回 null（调用方区分 missing 与 parse_error）。
 * 剥 UTF-8 BOM —— Windows 上 Notepad/PowerShell 产物常带 BOM，JSON.parse 与
 * 表头正则都会被它咬到；写回不重新引入（对各家解析器均无害）。
 */
export function readTextOrNull(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return null;
  }
}

/** 乐观锁检查：expectedSha 给了且与盘上不一致 → conflict（不比对 null=文件刚出现/消失也算变） */
export function assertSha(path: string, expectedSha: string | undefined): void {
  if (expectedSha === undefined) return; // 未带指纹 = 不设防（低摩擦路径，UI 总是会带）
  const cur = fingerprint(path);
  if (cur !== expectedSha) {
    throw Object.assign(new Error("配置文件在读取后被外部修改（执行器 CLI 或手工编辑）"), { code: "conflict" });
  }
}
