/**
 * `[bot|项目]` 迷你分段 —— 双视图过滤器（docs/04「收在分区行」；ADR 0011）。
 * 侧栏分区行与单元切换器弹层共用。视觉语言与 WorkspaceHeader 的「对话|终端」
 * 切换同构：浅底胶囊容器 + 激活片上浮，小而克制。
 */

import { Bot, FolderGit2 } from "lucide-react";
import type { ViewMode } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

export const UNIT_VIEWS: readonly { id: ViewMode; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "bot", icon: Bot },
  { id: "project", label: "项目", icon: FolderGit2 },
];

export function UnitViewSegment({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div
      role="group"
      aria-label="单元视图"
      data-no-drag
      className="flex shrink-0 items-center rounded-btn border border-line/40 bg-line-soft/80 p-0.5"
    >
      {UNIT_VIEWS.map((v) => {
        const active = value === v.id;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onChange(v.id)}
            aria-pressed={active}
            title={v.id === "bot" ? "bot 视图（默认）：数字 bot 与常驻服务" : "项目视图：手动标注为项目的单元"}
            className={cn(
              "flex h-4 items-center rounded-btn px-1.5 text-caption font-medium leading-none transition",
              active ? "border border-teal/25 bg-card text-teal shadow-xs" : "text-graphite hover:text-ink",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
