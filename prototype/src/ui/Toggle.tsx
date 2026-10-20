import { cn } from "./cn.ts";

/**
 * 开关。独立于 SettingsPage 的中立模块：SettingsPage、AppearanceSettingsSection
 * （底栏锁定）与渠道账号区都从这里取，谁也不为「避免循环依赖」再抄一份形状
 * 相同的。disabled：扇出/拉起这类秒级 RPC 进行中锁开关，防并发写竞争。
 */
export function Toggle({
  on,
  onChange,
  disabled,
  ariaLabel,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  /** 无文字标签的纯开关位（如底栏锁定行）需要它补可访问名 */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-chip transition",
        on ? "bg-teal" : "bg-line",
        disabled ? "opacity-40" : undefined,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}
