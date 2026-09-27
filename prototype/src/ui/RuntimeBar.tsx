import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 执行器切换条 —— 整个产品最关键的一根杠。
 *
 * 设计说明（对齐 DESIGN.md）：
 * - 六家工具平级：一个徽标 + 名称 + 能力计数 + 状态点，没有主次
 * - 品牌色只出现在那个 20px 徽标上——它是**身份数据**（相当于头像），
 *   不是 UI 装饰。界面其余部分严格守住「单色 + 唯一青色」。
 * - 激活态用青色浅填充 + 青色边框（teal-tint / teal-edge），
 *   而非实心青底——六个实心青块会互相打架且噪音过大
 */
export function RuntimeBar() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const select = useWorkbench((s) => s.selectRuntime);

  if (runtimes.length === 0) {
    return <div className="h-[60px] shrink-0 border-b border-line bg-rail" />;
  }

  return (
    <div className="flex h-[60px] shrink-0 items-center gap-4 border-b border-line bg-rail px-6">
      <span className="shrink-0 text-body-sm text-graphite">执行器</span>

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2">
        {runtimes.map((r) => {
          const active = r.id === activeId;
          const notInstalled = r.state.status === "not_installed";
          const caps = Object.values(r.capabilities);
          const capCount = caps.filter(Boolean).length;
          const capTotal = caps.length;

          return (
            <button
              key={r.id}
              onClick={() => select(r.id)}
              title={`${r.presentation.displayName} · ${r.presentation.vendor}\n${r.presentation.tagline}\n能力 ${capCount}/${capTotal} · 传输 ${r.transportKind}`}
              aria-pressed={active}
              className={cn(
                "group flex shrink-0 items-center gap-2.5 rounded-input border px-3 py-1.5",
                active
                  ? "border-teal bg-teal-tint"
                  : "border-line bg-card hover:border-ash",
                notInstalled && "opacity-55 hover:opacity-80",
              )}
            >
              {/* 品牌色仅限此处：20px 身份徽标 */}
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn text-caption font-medium text-white"
                style={{ background: r.presentation.accent }}
                aria-hidden
              >
                {r.presentation.glyph}
              </span>

              <span className="flex flex-col items-start leading-tight">
                <span
                  className={cn(
                    "text-body-sm",
                    active ? "font-medium text-ink" : "text-graphite group-hover:text-ink",
                  )}
                >
                  {r.presentation.displayName}
                </span>
                <span className="tnum text-caption text-ash">
                  {capCount}/{capTotal} 能力
                </span>
              </span>

              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  r.state.status === "ready" && "bg-gain",
                  r.state.status === "starting" && "animate-pulse bg-teal",
                  r.state.status === "not_installed" && "bg-ash",
                  r.state.status === "error" && "bg-loss",
                  r.state.status === "stopped" && "bg-ash",
                )}
                aria-hidden
              />
            </button>
          );
        })}
      </div>

      <span className="shrink-0 text-caption text-ash">共 {runtimes.length} 家 · 平级可换</span>
    </div>
  );
}
