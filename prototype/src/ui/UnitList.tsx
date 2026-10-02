import { Bot, FolderGit2 } from "lucide-react";
import { useWorkbench, type ViewMode } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 左栅 —— 工作单元导航。
 *
 * 对齐 DESIGN.md 的 Sidebar 规范：
 * - 顶部品牌锚点（Sidebar Brand Mark）
 * - 视图切换用胶囊 chip，激活态填 Deep Teal + 白字
 * - 单元列表用导航项形态，激活态青色浅填充 + 12px 圆角
 */
export function UnitList() {
  const units = useWorkbench((s) => s.units);
  const view = useWorkbench((s) => s.view);
  const activeId = useWorkbench((s) => s.activeUnitId);
  const setView = useWorkbench((s) => s.setView);
  const selectUnit = useWorkbench((s) => s.selectUnit);

  const visible = units.filter((u) => u.kind === view);

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-rail">
      {/* 品牌锚点 */}
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-line px-6">
        <span className="flex h-5 w-5 items-center justify-center rounded-btn bg-ink text-caption font-medium text-canvas">
          A
        </span>
        <span className="text-body font-medium text-ink">Agent Workbench</span>
      </div>

      {/* 身份切换：胶囊 */}
      <div className="flex gap-2 px-4 py-4">
        {VIEWS.map((v) => {
          const active = v.id === view;
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-pressed={active}
              className={cn(
                "flex items-center gap-1.5 rounded-chip px-3 py-2 text-body-sm",
                active
                  ? "bg-teal font-medium text-white"
                  : "text-graphite hover:bg-surface-hover hover:text-ink",
              )}
            >
              <Icon size={12} />
              {v.label}
            </button>
          );
        })}
      </div>

      {/* 区块标签 */}
      <p className="px-6 pb-2 text-body-sm text-ash">工作单元</p>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {visible.length === 0 && (
          <p className="px-2 py-8 text-center text-body-sm text-ash">该身份下暂无工作单元</p>
        )}

        {visible.map((u) => {
          const active = u.id === activeId;
          return (
            <button
              key={u.id}
              onClick={() => selectUnit(u.id)}
              aria-current={active}
              className={cn(
                "mb-1 flex w-full flex-col gap-1.5 rounded-input px-3 py-3 text-left",
                active ? "bg-teal-tint" : "hover:bg-surface-hover",
              )}
            >
              <div className="flex items-center gap-2">
                {u.identity?.avatar ? (
                  <span className="shrink-0 text-body-lg" aria-hidden>
                    {u.identity.avatar}
                  </span>
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn bg-line-soft text-caption font-medium text-graphite">
                    {u.name.slice(0, 1)}
                  </span>
                )}
                <span className="truncate text-body-sm font-medium text-ink">{u.name}</span>
              </div>

              {u.identity && (
                <p className="truncate pl-7 text-caption text-graphite">{u.identity.role}</p>
              )}

              <div className="flex flex-wrap items-center gap-1.5 pl-7">
                {u.schedule && (
                  <span
                    className={cn(
                      "rounded-chip px-2 py-0.5 text-caption",
                      u.schedule.enabled ? "bg-teal-tint text-teal" : "bg-line-soft text-graphite",
                    )}
                  >
                    {u.schedule.enabled ? "● " : "○ "}
                    {u.schedule.description}
                  </span>
                )}
                {u.tags.map((t) => (
                  <span key={t} className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-graphite">
                    {t}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

const VIEWS: readonly { id: ViewMode; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "bot", icon: Bot },
  { id: "project", label: "项目", icon: FolderGit2 },
];
