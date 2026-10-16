/**
 * 凭证保险库（Credential Vault）—— 保存动态获取的敏感令牌（如微信 iLink 扫码凭证）。
 *
 * 遵循领域铁律：不在 bot.json 中存入明文，而是落到用户私有目录 ~/.agent-workbench/credentials/
 * 以 0600 权限单独持久化，并通过 SecretRef { source: "vault", id: "..." } 进行软链接引用。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SecretRef } from "../../../prototype/src/core/units.ts";
import { log } from "../log.ts";

export interface VaultItem {
  readonly id: string;
  readonly secret: string;
  readonly updatedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class CredentialVault {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = path.join(homeDir, "credentials");
  }

  private filePath(id: string): string {
    // 过滤安全字符，防路径遍历
    const safeId = id.replace(/[^a-zA-Z0-9_\-.:]/g, "_");
    return path.join(this.dir, `${safeId}.json`);
  }

  private async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      // 忽略目录已存在
    }
  }

  async save(id: string, secret: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.ensureDir();
    const item: VaultItem = {
      id,
      secret,
      updatedAt: Date.now(),
      metadata,
    };
    const target = this.filePath(id);
    await fs.writeFile(target, JSON.stringify(item, null, 2), { encoding: "utf8", mode: 0o600 });
    log.info("credential saved to vault", { id });
  }

  async load(id: string): Promise<VaultItem | null> {
    const target = this.filePath(id);
    try {
      const content = await fs.readFile(target, "utf8");
      return JSON.parse(content) as VaultItem;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      log.warn("failed to read credential from vault", { id, error: String(err) });
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const target = this.filePath(id);
    try {
      await fs.unlink(target);
      log.info("credential deleted from vault", { id });
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    await this.ensureDir();
    try {
      const files = await fs.readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
}

/** 解析 SecretRef 引用的真实密钥值 */
export async function resolveSecret(
  refOrRaw: string | SecretRef | undefined | null,
  vault: CredentialVault,
  cwd?: string,
): Promise<string> {
  if (!refOrRaw) return "";
  if (typeof refOrRaw === "string") return refOrRaw;

  if (refOrRaw.source === "env") {
    return process.env[refOrRaw.id] ?? "";
  }

  if (refOrRaw.source === "literal") {
    return refOrRaw.id;
  }

  if (refOrRaw.source === "vault") {
    const item = await vault.load(refOrRaw.id);
    return item?.secret ?? "";
  }

  if (refOrRaw.source === "file") {
    const filePath = cwd ? path.resolve(cwd, refOrRaw.id) : path.resolve(refOrRaw.id);
    try {
      const content = await fs.readFile(filePath, "utf8");
      return content.trim();
    } catch {
      return "";
    }
  }

  return "";
}
