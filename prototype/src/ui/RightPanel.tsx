import { Check, FileText, GitPullRequest, Image as ImageIcon, Package, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, selectActiveRuntime, selectActiveUnit, selectUnitDeliverables } from "../store/useWorkbench.ts";
import type { RuntimeCapabilities } from "../core/adapter.ts";
import type { Deliverable } from "../core/units.ts";
import { cn } from "./cn.ts";

const CAP_LABELS: readonly (readonly [keyof RuntimeCapabilities, string])[] = [
  ["resumeSession", "恢复会话"],
  ["fileDiff", "结构化 diff"],
  ["terminal", "内建终端"],
  ["permissions", "权限审批"],
  ["subagents", "子代理"],
  ["worktrees", "worktree"],
  ["sandbox", "沙箱"],
  ["mcp", "MCP"],
  ["usage", "用量计量"],
  ["multimodal", "多模态"],
];

/**
 * 右栅 —— 身份详情 + 能力矩阵 + 产出归档。
 *
 * 能力矩阵是这块 UI 最该被反复推敲的部分：它逼你面对
 * 「某个工具不支持这个能力时，界面怎么退化」这个真实成本。
 */
export function RightPanel({ onClose }: { onClose: () => void }) {
  const unit = useWorkbench(selectActiveUnit);
  const runtime = useWorkbench(selectActiveRuntime);
  // selectUnitDeliverables 每次返回新数组，必须用 useShallow 做浅比较，否则无限重渲染
  const deliverables = useWorkbench(useShallow(selectUnitDeliverables));

  if (!unit) return null;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-rail">
      <div className="flex h-[60px] shrink-0 items-center justify-between border-b border-line px-6">
        <span className="text-body-sm text-graphite">详情</span>
        <button
          onClick={onClose}
          aria-label="关闭详情面板"
          className="rounded-btn p-1 text-graphite hover:bg-line-soft hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 身份 */}
        <Section title="身份">
          <p className="text-body font-medium text-ink">
            {unit.identity?.avatar} {unit.name}
          </p>
          {unit.identity && <p className="mt-1 text-body-sm text-graphite">{unit.identity.role}</p>}
          <p className="mt-2 truncate font-mono text-caption text-ash" title={unit.rootPath}>
            {unit.rootPath}
          </p>
          <p className="mt-2 text-caption text-ash">
            来源 <span className="font-mono text-graphite">{unit.identity?.sourcePath ?? "—"}</span> · 零迁移
          </p>
        </Section>

        {/* 执行器能力 */}
        {runtime && (
          <Section title="当前执行器能力">
            <div className="mb-3 flex items-center gap-2.5">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-caption font-medium text-white"
                style={{ background: runtime.presentation.accent }}
                aria-hidden
              >
                {runtime.presentation.glyph}
              </span>
              <div className="min-w-0">
                <p className="truncate text-body-sm font-medium text-ink">
                  {runtime.presentation.displayName}
                </p>
                <p className="truncate text-caption text-ash">{runtime.presentation.tagline}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1">
              {CAP_LABELS.map(([key, label]) => {
                const on = runtime.capabilities[key];
                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-body-sm",
                      on ? "text-ink" : "text-ash",
                    )}
                    title={on ? "支持" : "不支持"}
                  >
                    {on ? (
                      <Check size={12} className="shrink-0 text-teal" />
                    ) : (
                      <X size={12} className="shrink-0" />
                    )}
                    <span className={cn("truncate", !on && "line-through")}>{label}</span>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 font-mono text-caption text-ash">
              transport: {runtime.transportKind} · {runtime.state.status}
            </p>
          </Section>
        )}

        {/* 产出归档 */}
        <Section title={`产出归档 · ${deliverables.length}`}>
          {deliverables.length === 0 && <p className="text-body-sm text-ash">暂无产出</p>}
          {deliverables.map((d) => (
            <DeliverableRow key={d.id} d={d} />
          ))}
        </Section>
      </div>
    </aside>
  );
}

/** 区块标签：Graphite 12px，无底色无边框，只提供排版节奏 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-5 last:border-b-0">
      <p className="mb-3 text-body-sm text-ash">{title}</p>
      {children}
    </section>
  );
}

const KIND_ICON = {
  file: FileText,
  diff: GitPullRequest,
  pr: GitPullRequest,
  report: FileText,
  image: ImageIcon,
} as const;

function DeliverableRow({ d }: { d: Deliverable }) {
  const Icon = KIND_ICON[d.kind] ?? Package;
  return (
    <div className="-mx-2 flex items-start gap-2 rounded-btn px-2 py-2 hover:bg-line-soft">
      <Icon size={12} className="mt-0.5 shrink-0 text-ash" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-sm text-ink">{d.title}</p>
        {d.path && <p className="truncate font-mono text-caption text-ash">{d.path}</p>}
      </div>
      <span className="tnum shrink-0 text-caption text-ash">
        {new Date(d.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
      </span>
    </div>
  );
}
