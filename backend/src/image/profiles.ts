/**
 * 出图供应商 profile 存储 —— 出图工作台的密钥层（docs 决策：密钥挪进 daemon）。
 *
 * 之前 profile（含 apiKey 明文）整体存浏览器 localStorage：同源任意脚本可读、
 * 清站点数据即丢、浏览器直连供应商还受 CORS 折磨。现在唯一真相是
 * `<homeDir>/image-profiles.json`：agent 可用 Read/Write 直接改，浏览器侧
 * 只拿到脱敏形态（apiKey 永不下发，换成 hasKey 布尔）。
 *
 * 形态对齐 prototype/src/core/imageApi.ts 的 ImageProfile（去掉未用族）。
 */

import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";

export interface ImageProfileRow {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly imageGenerationModel?: string;
  /** 秒 */
  readonly timeout: number;
  readonly apiMode: "images" | "responses";
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
  readonly codexCli: boolean;
  readonly responseFormatB64Json?: boolean;
  readonly streamImages?: boolean;
  readonly streamPartialImages?: number;
  readonly transparentBackgroundMethod: "api" | "local";
}

/** 浏览器可见的脱敏形态：密钥换成 hasKey */
export interface MaskedImageProfile {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly imageGenerationModel?: string;
  readonly timeout: number;
  readonly apiMode: "images" | "responses";
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
  readonly codexCli: boolean;
  readonly responseFormatB64Json?: boolean;
  readonly streamImages?: boolean;
  readonly streamPartialImages?: number;
  readonly transparentBackgroundMethod: "api" | "local";
  /** 密钥已配置（值本身永不下发浏览器） */
  readonly hasKey: boolean;
}

interface FileShape {
  profiles?: unknown;
}

const DEFAULTS = {
  name: "未命名供应商",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-image-2.5-sunburst",
  timeout: 600,
  apiMode: "images" as const,
  codexCli: false,
  transparentBackgroundMethod: "api" as const,
};

/** 单行防御式归一：手改文件 / 旧数据缺字段都不能炸 */
function sanitizeRow(raw: unknown, index: number): ImageProfileRow | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" && r["id"] !== "" ? r["id"] : `profile-${index}`;
  const apiMode = r["apiMode"] === "responses" ? "responses" : "images";
  const reasoningEffort =
    r["reasoningEffort"] === "minimal" || r["reasoningEffort"] === "low" || r["reasoningEffort"] === "medium" || r["reasoningEffort"] === "high"
      ? r["reasoningEffort"]
      : undefined;
  const method = r["transparentBackgroundMethod"] === "local" ? "local" : "api";
  return {
    id,
    name: typeof r["name"] === "string" && r["name"] !== "" ? r["name"] : DEFAULTS.name,
    baseUrl: typeof r["baseUrl"] === "string" && r["baseUrl"] !== "" ? r["baseUrl"] : DEFAULTS.baseUrl,
    apiKey: typeof r["apiKey"] === "string" ? r["apiKey"] : "",
    model: typeof r["model"] === "string" && r["model"] !== "" ? r["model"] : DEFAULTS.model,
    ...(typeof r["imageGenerationModel"] === "string" && r["imageGenerationModel"] !== "" ? { imageGenerationModel: r["imageGenerationModel"] } : {}),
    timeout: typeof r["timeout"] === "number" && Number.isFinite(r["timeout"]) && r["timeout"] > 0 ? r["timeout"] : DEFAULTS.timeout,
    apiMode,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    codexCli: r["codexCli"] === true,
    ...(r["responseFormatB64Json"] === true ? { responseFormatB64Json: true } : {}),
    ...(r["streamImages"] === true ? { streamImages: true } : {}),
    ...(typeof r["streamPartialImages"] === "number" && Number.isFinite(r["streamPartialImages"]) ? { streamPartialImages: r["streamPartialImages"] } : {}),
    transparentBackgroundMethod: method,
  };
}

export class ImageProfileStore {
  private readonly file: string;

  constructor(homeDir: string) {
    this.file = path.join(homeDir, "image-profiles.json");
  }

  list(): ImageProfileRow[] {
    let raw: FileShape;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as FileShape;
    } catch {
      return []; // 不存在 / 坏 JSON：空清单（首启正常态）
    }
    if (!Array.isArray(raw.profiles)) return [];
    const rows: ImageProfileRow[] = [];
    for (let i = 0; i < raw.profiles.length; i += 1) {
      const row = sanitizeRow(raw.profiles[i], i);
      if (row !== null) rows.push(row);
    }
    return rows;
  }

  /** 脱敏清单（浏览器唯一可见形态） */
  listMasked(): MaskedImageProfile[] {
    return this.list().map(({ apiKey: _apiKey, ...rest }) => ({ ...rest, hasKey: _apiKey !== "" }));
  }

  get(id: string): ImageProfileRow | undefined {
    return this.list().find((p) => p.id === id);
  }

  /**
   * 写入/更新一行。apiKey 语义：undefined = 保留盘上旧值（编辑其他字段时密钥不该被清掉，
   * 浏览器根本拿不到旧密钥，回传的只能是「用户这次新输入的」或空）；"" = 显式清除。
   */
  put(input: Partial<ImageProfileRow> & { id: string }): MaskedImageProfile {
    if (input.id.trim() === "") throw Object.assign(new Error("profile id is required"), { code: "bad_params" });
    const rows = this.list();
    const prev = rows.find((p) => p.id === input.id);
    // apiKey undefined → 保留旧值（编辑其他字段不清密钥）；显式 "" → 清除。
    // 归一化在前：sanitizeRow 不认识 undefined 语义，先把 key 的意图折进输入。
    const keyInput = input.apiKey !== undefined ? input.apiKey : prev?.apiKey ?? "";
    const next: ImageProfileRow = sanitizeRow({ ...DEFAULTS, ...prev, ...input, apiKey: keyInput, id: input.id }, rows.length)!;
    const rest = rows.filter((p) => p.id !== next.id);
    this.write([...rest, next]);
    const { apiKey, ...masked } = next;
    return { ...masked, hasKey: apiKey !== "" };
  }

  delete(id: string): boolean {
    const rows = this.list();
    const next = rows.filter((p) => p.id !== id);
    if (next.length === rows.length) return false;
    this.write(next);
    return true;
  }

  private write(rows: readonly ImageProfileRow[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // tmp+rename 原子落盘（并发写不留下半截 JSON），与 token 落盘同款
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ profiles: rows }, null, 2), "utf8");
    try {
      renameSync(tmp, this.file);
    } catch {
      // Windows 上目标被占用（agent 正在读）的极窄窗口：重试一次再放弃
      try {
        renameSync(tmp, this.file);
      } catch {
        try {
          unlinkSync(tmp);
        } catch { /* noop */ }
        log.warn("image profiles write failed (rename)", { file: this.file });
      }
    }
  }

  exists(): boolean {
    return existsSync(this.file);
  }
}
