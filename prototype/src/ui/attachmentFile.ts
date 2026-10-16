/**
 * 附件的 DOM 读取侧 —— File → ChatAttachment。
 *
 * 从 core/attachments.ts 拆出来：core 是 backend 也要类型检查的契约层
 * （lib 无 DOM），FileReader / objectURL 这类浏览器运行时只能待在 ui/。
 */

import {
  categorizeAttachment,
  inferAttachmentMimeType,
  type ChatAttachment,
} from "../core/attachments.ts";

export async function createAttachmentFromFile(file: File): Promise<ChatAttachment> {
  const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mimeType = file.type || inferAttachmentMimeType(file.name);
  const category = categorizeAttachment(file.name, mimeType);

  let url: string | undefined;
  let textContent: string | undefined;
  let base64: string | undefined;

  // 1. 如果是图片，创建 objectUrl 供缩略图与大图预览
  if (category === "image") {
    try {
      url = URL.createObjectURL(file);
      // 转 base64 备用
      base64 = await readFileAsBase64(file);
    } catch {
      // 容错降级
    }
  } else if (category === "code" || category === "document") {
    // 2. 如果是文本/代码文件（且小于 2MB），尝试直接读纯文本
    if (file.size <= 2 * 1024 * 1024 && !mimeType.includes("pdf")) {
      try {
        textContent = await file.text();
      } catch {
        // 二进制或读取失败
      }
    }
  }

  // 读取桌面端 Electron 挂在 File 上的 path 属性 (若有)
  const localPath = (file as unknown as { path?: string }).path || undefined;

  return {
    id,
    name: file.name,
    size: file.size,
    mimeType,
    category,
    url,
    localPath,
    textContent,
    base64,
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const marker = reader.result.indexOf(",");
        resolve(marker !== -1 ? reader.result.slice(marker + 1) : reader.result);
      } else {
        reject(new Error("读取 Base64 失败"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
