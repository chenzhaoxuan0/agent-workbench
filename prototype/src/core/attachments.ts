/**
 * 附件模型与格式工具 —— 对齐 ZCode 附件系统规范 (chatAttachments.ts / chatAttachmentMetadata.ts)。
 *
 * core/ 是零依赖契约层（backend 经 events.ts 传递检查本文件），DOM 运行时
 * （File / FileReader / objectURL）放在 ui/attachmentFile.ts，别在这里加。
 *
 * 支持格式：
 * - 图片：png, jpg, jpeg, gif, webp, svg, bmp, ico (最大 20MB)
 * - 源码与文本：ts, tsx, js, jsx, py, rs, go, java, c, cpp, h, cs, html, css, sql, sh, yaml, yml, toml, json, xml, md, txt, log, diff, patch 等
 * - 常见文档：pdf, csv
 */

export const MAX_ATTACHMENTS = 8;
export const INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export type AttachmentCategory = "image" | "code" | "document" | "other";

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  category: AttachmentCategory;
  url?: string; // 浏览器本地预览 URL (URL.createObjectURL)
  localPath?: string; // 桌面端原生路径 (如果有)
  textContent?: string; // 纯文本/代码类附件文本内容
  base64?: string; // 图片或文件的 base64 编码
}

const TEXT_LIKE_REGEX =
  /^(cjs|conf|cpp|cs|css|csv|diff|env|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|patch|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;

const CODE_EXT_REGEX =
  /^(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|cs|html|css|sql|sh|bash|json|yaml|yml|toml|xml)$/i;

export function isTextLikeExtension(ext: string): boolean {
  return TEXT_LIKE_REGEX.test(ext);
}

export function inferAttachmentMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "txt":
    case "log":
      return "text/plain";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "pdf":
      return "application/pdf";
    default:
      if (isTextLikeExtension(ext)) return "text/plain";
      return "application/octet-stream";
  }
}

export function categorizeAttachment(filename: string, mimeType: string): AttachmentCategory {
  if (mimeType.startsWith("image/")) return "image";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_EXT_REGEX.test(ext)) return "code";
  if (mimeType.startsWith("text/") || ext === "pdf" || ext === "md" || ext === "txt" || ext === "csv") {
    return "document";
  }
  return "other";
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
  const kib = Math.ceil(bytes / 1024);
  return `${kib} KB`;
}
