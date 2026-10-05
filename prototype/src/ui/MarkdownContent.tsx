import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "./cn.ts";

/**
 * 极简、零依赖、高性能的 Markdown 渲染器。
 * 针对 Agent 对话场景专门优化：代码块（带复制按钮）、行内代码、粗体、列表、引用。
 */
export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className={cn("space-y-3 leading-relaxed text-ink text-body", className)}>
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return <CodeBlock key={i} lang={block.lang ?? ""} code={block.text} />;
        }
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          const sizeCls =
            block.level === 1
              ? "text-title font-medium mt-4 mb-2"
              : block.level === 2
                ? "text-body-lg font-medium mt-3 mb-1.5"
                : "text-body font-medium mt-2 mb-1";
          return (
            <Tag key={i} className={cn(sizeCls, "text-ink")}>
              {renderInline(block.text)}
            </Tag>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote
              key={i}
              className="border-l-2 border-line pl-3 my-2 text-graphite italic text-body-sm"
            >
              {renderInline(block.text)}
            </blockquote>
          );
        }
        if (block.type === "list" && block.items) {
          return (
            <ul key={i} className="my-2 space-y-1 pl-5 list-disc marker:text-ash">
              {block.items.map((item, idx) => (
                <li key={idx} className="text-body text-ink">
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // quiet fallback
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-input border border-line bg-card shadow-subtle">
      <div className="flex items-center justify-between border-b border-line/60 bg-rail px-3 py-1.5 text-caption font-mono text-ash">
        <span>{lang || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
          title="复制代码"
        >
          {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-caption font-mono leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface Block {
  type: "p" | "code" | "heading" | "quote" | "list";
  text: string;
  lang?: string;
  level?: number;
  items?: string[];
}

function parseMarkdownBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 代码块 ```lang
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      blocks.push({ type: "code", text: codeLines.join("\n"), lang });
      i++;
      continue;
    }

    // 标题 #, ##, ###
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!,
      });
      i++;
      continue;
    }

    // 引用 >
    if (line.startsWith("> ") || line === ">") {
      const quoteLines = [line.replace(/^>\s?/, "")];
      i++;
      while (i < lines.length && (lines[i]!.startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // 无序列表 - item / * item
    if (line.match(/^[\*\-]\s+(.*)$/)) {
      const items = [line.replace(/^[\*\-]\s+/, "")];
      i++;
      while (i < lines.length && lines[i]!.match(/^[\*\-]\s+(.*)$/)) {
        items.push(lines[i]!.replace(/^[\*\-]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", text: "", items });
      continue;
    }

    // 空行忽略
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 普通段落
    const pLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.trimStart().startsWith("```") &&
      !lines[i]!.match(/^(#{1,3})\s+/) &&
      !lines[i]!.startsWith("> ") &&
      !lines[i]!.match(/^[\*\-]\s+/)
    ) {
      pLines.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "p", text: pLines.join("\n") });
  }

  return blocks;
}

/** 渲染行内元素（粗体、行内代码、链接） */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // 行内代码 `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-line-soft px-1.5 py-0.5 font-mono text-[0.88em] text-ink"
        >
          {codeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 粗体 **bold**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink">
          {boldMatch[1]}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 普通字符直至下一个特殊标记
    const nextSpecial = remaining.search(/[`*]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial > 0) {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    } else {
      // 孤立符号
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    }
  }

  return parts;
}
