import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Cpu, SlidersHorizontal, Shield } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { getMode } from "../core/permission.ts";
import { selectActivePair, useWorkbench } from "../store/useWorkbench.ts";
import { EMPTY_LOOP, LoopParamsPanel, summaryOfLoop } from "./LoopParamsPicker.tsx";
import { PermissionModePanel } from "./PermissionModePicker.tsx";
import { RuntimePanel } from "./RuntimePicker.tsx";
import { cn } from "./cn.ts";

/**
 * 运行配置菜单 —— composer 右侧那颗 ⋯ 的全部内容。
 *
 * ## 为什么要它
 *
 * 渐进披露的一条。原来「默认询问 / loop 参数 / 执行器」三个触发器常驻在
 * 输入框右缘，可它们是**低频**的：权限模式一个任务内不变、执行器和模型
 * 绝大多数会话不换、loop 参数只在调推理力度时才动。常驻三个带文字的按钮，
 * 是用版面换了几次点击。
 *
 * 收进一颗 ⋯ 之后：
 * - 触发器平时**只有一个图标**，不占文字宽度；
 * - 点开是三行手风琴，**每行折叠时照样显示当前值**——
 *   信息没丢，只是不用一直盯着看；
 * - 选中即生效，面板留在原地可以继续调下一项。
 *
 * ## 危险档必须仍然可见
 *
 * 「完全放行」（bypass）一旦点下去，后面所有授权框都不再出现。原来的设计
 * 让它在整个会话里持续保持警示色，收进浮层后**不能丢这个信号**：
 * 触发器在 bypass 档染成警示色，是整条 composer 上唯一一处不隐藏的风险提示。
 *
 * ## 复用而非重写
 *
 * 三段内容分别复用 `PermissionModePanel` / `LoopParamsPanel` / `RuntimePanel`
 * ——它们和 composer 里原来的独立下拉共用同一份渲染与状态逻辑，
 * 这里只换了宿主，不做第二套实现。
 */

type Section = "perm" | "loop" | "runtime";

export function RunConfigMenu() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Section | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const mode = useWorkbench((s) => s.permissionMode);
  const loop = useWorkbench((s) => s.loopParams[s.activeRuntimeId] ?? EMPTY_LOOP);
  // selectActivePair 每次返回新对象 —— 必须 useShallow（见 useWorkbench.ts 的警告注释）
  const { runtime, model } = useWorkbench(useShallow(selectActivePair));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const def = getMode(mode);
  // bypass 档持续染警示色 —— 见文件头「危险档必须仍然可见」
  const danger = def.danger;
  // loop 参数被显式改过（非默认）时点一颗小圆点，避免"设过了但忘了"的情况
  const loopDirty = loop.reasoningLevel !== undefined;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="运行配置"
        title={
          danger
            ? `运行配置 · 当前 ${def.label}（授权框已全部关闭）`
            : `运行配置 · 权限 ${def.label} · ${summaryOfLoop(loop)}`
        }
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-btn",
          open
            ? "bg-line-soft text-ink"
            : danger
              ? "text-loss hover:bg-loss/5"
              : "text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <SlidersHorizontal size={15} className="shrink-0" />
        {loopDirty && !danger && (
          <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-teal" aria-hidden />
        )}
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="运行配置"
            className="absolute bottom-full right-0 z-40 mb-2 w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-card border border-line bg-canvas shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
          >
            <Section
              icon={<Shield size={13} className={cn("shrink-0", danger ? "text-loss" : "text-graphite")} />}
              label="权限模式"
              value={def.label}
              danger={danger}
              open={expanded === "perm"}
              onToggle={() => setExpanded((x) => (x === "perm" ? null : "perm"))}
            >
              <PermissionModePanel />
            </Section>

            <Section
              icon={<SlidersHorizontal size={13} className="shrink-0 text-graphite" />}
              label="agent loop"
              value={summaryOfLoop(loop)}
              dirty={loopDirty}
              open={expanded === "loop"}
              onToggle={() => setExpanded((x) => (x === "loop" ? null : "loop"))}
            >
              <LoopParamsPanel />
            </Section>

            <Section
              icon={<Cpu size={13} className="shrink-0 text-graphite" />}
              label="执行器与模型"
              value={
                runtime
                  ? `${runtime.presentation.displayName} · ${model?.displayName ?? "未选模型"}`
                  : "未连接执行器"
              }
              open={expanded === "runtime"}
              onToggle={() => setExpanded((x) => (x === "runtime" ? null : "runtime"))}
              bare
            >
              <RuntimePanel />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 手风琴段 —— 折叠行固定三段：图标 / 标题 / **当前值**。
 *
 * 「当前值折叠时也显示」是这个面板的核心：收起的是版面，不是信息。
 * 打开一次就能扫完三行现状，不用逐个点进去确认。
 */
function Section({
  icon,
  label,
  value,
  open,
  onToggle,
  danger,
  dirty,
  bare,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  /** 危险档：标题与值都染警示色 */
  danger?: boolean;
  /** 非默认：标题右侧点一颗小圆点 */
  dirty?: boolean;
  /** 面板自带边框（RuntimePanel），段内不再包一层圆角边框 */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-line-soft"
      >
        {icon}
        <span className="shrink-0 text-body-sm text-graphite">{label}</span>
        {dirty && <span className="h-1 w-1 shrink-0 rounded-full bg-teal" aria-hidden />}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right text-body-sm",
            danger ? "font-medium text-loss" : open ? "text-ink" : "text-ash",
          )}
        >
          {value}
        </span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-ash transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div className={cn("px-2 pb-2", !bare && "px-1")}>
          {bare ? (
            children
          ) : (
            <div className="rounded-input border border-line bg-canvas p-1">{children}</div>
          )}
        </div>
      )}
    </div>
  );
}
