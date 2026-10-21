import { cn } from "./cn.ts";

/**
 * 档位滑动条 —— codex 思考强度滑动条的同款观感：
 * 胶囊轨道（已选部分 accent 填充）+ 每档一枚轨道圆点 + 白色圆钮，吸附到档。
 *
 * 本体是原生 `<input type="range">`（min=0 / max=n-1 / step=1）：拖动、点轨道、
 * 触屏、方向键、读屏标签全部免费 —— 自绘 pointer 事件在手机端（iOS Safari 的
 * touch 语义）和键盘可达性上都要重造一遍轮子，不值。滑块皮肤在 styles.css 的
 * `.aw-range`；已填充比例由组件内联 linear-gradient 刷在轨道上（亮暗主题都取
 * 主题令牌，自动跟随）；档位圆点是轨道后面一层 pointer-events-none 的小点。
 *
 * 圆点与滑块的对齐：圆钮有宽度（THUMB = 22px），它的行程是
 * [THUMB/2, 100% − THUMB/2] 而不是 [0, 100%] —— 圆点按同一条行程定位
 * （wrapper 与圆点层各内缩 THUMB/2，圆点在收缩后的坐标系里按比例放）。
 */
const THUMB = 22;

export function StopSlider({
  stops,
  valueIndex,
  onChange,
  ariaLabel,
  className,
  muted = false,
}: {
  /** 档位列表（≥2 档才有意义；调用方保证） */
  readonly stops: readonly { readonly id: string; readonly label: string }[];
  /** 当前档下标（0 起） */
  readonly valueIndex: number;
  readonly onChange: (index: number) => void;
  readonly ariaLabel: string;
  readonly className?: string;
  /**
   * 未激活态（用户还在「默认」档，没有选过任何真实档位）：轨道不出填充、
   * 圆钮半透明停在起点 —— 明确表达「这条滑动条现在没在管事」；一拖动/点击
   * 立即选中对应档位。缺了这层区分，静止的轨道会被读成「选了第一档」。
   */
  readonly muted?: boolean;
}) {
  const max = Math.max(0, stops.length - 1);
  const idx = muted ? 0 : Math.min(Math.max(0, valueIndex), max);
  const pct = muted || max === 0 ? 0 : (idx / max) * 100;
  return (
    <div className={cn("relative flex h-6 items-center px-[11px]", className)}>
      {/* 档位圆点：pointer-events-none，点击/拖动由下面的 range 全权处理 */}
      <div className="pointer-events-none absolute inset-y-0 left-[11px] right-[11px]" aria-hidden>
        {stops.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              "absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
              muted ? "bg-ink/15" : "bg-ink/25",
            )}
            style={{ left: `${max === 0 ? 0 : (i / max) * 100}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={idx}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={ariaLabel}
        aria-valuetext={muted ? undefined : stops[idx]?.label}
        className={cn("aw-range w-full", muted && "aw-range-muted")}
        style={{
          background: `linear-gradient(to right, var(--color-teal) 0%, var(--color-teal) ${pct}%, var(--color-line-soft) ${pct}%, var(--color-line-soft) 100%)`,
        }}
      />
    </div>
  );
}
