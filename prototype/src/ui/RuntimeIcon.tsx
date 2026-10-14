import type { RuntimeEntry } from "../core/registry.ts";
import { executorIconSrc } from "./executorIcon.ts";
import { cn } from "./cn.ts";

/**
 * 执行器品牌图标 —— 与设置页（ProviderInstancesPanel）同一规则：
 * 有官方 logo 用真图标，缺图回落 accent 底字母 glyph。
 * composer / rail / 模型行共用，保证与设置中看到的执行器形象一致。
 */
export function RuntimeIcon({
  runtime,
  size = 16,
  className,
}: {
  runtime: RuntimeEntry;
  size?: number;
  className?: string;
}) {
  const src = executorIconSrc(runtime.id);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className={cn("shrink-0 object-contain", className)}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded font-medium leading-none text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: runtime.presentation.accent,
        fontSize: Math.max(8, Math.round(size * 0.56)),
      }}
      aria-hidden
    >
      {runtime.presentation.glyph}
    </span>
  );
}
