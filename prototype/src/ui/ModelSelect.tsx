/**
 * 模型下拉框 —— 四个入口共用的**唯一**实现。
 *
 * ## 为什么必须是共用组件，而不是「四处各写一遍差不多」
 *
 * 「隐藏失效模型」是一条**规则**，不是一个样式。这条规则一旦漏掉一处，后果
 * 不是难看，而是静默出错：用户在定时任务里配了一个已经下线的模型，界面上
 * 看不出来，到点照样跑，失败得等跑完才知道。所以四个下拉框必须共用一份判定，
 * 而不是复制四份看起来差不多的代码。
 *
 * ## 行为契约
 *
 * - 可选项一律来自 `visibleModelsFor`（已含用户偏好排序与自定义模型）；
 * - 当前选中的模型若**已不在可选清单里**（模型下线 / 换了订阅），**不静默换掉**：
 *   补一条「X（不可用）」选项让它仍然显示，并在下方说明白。模型下线不是用户的
 *   错，不该在他不知情时把他正在用的东西换掉 —— 以前正是在这里悄悄换成列表第一个的。
 * - 保存**不硬拦**（模型临时不可用不该让人连任务都存不了），但界面必须给提示。
 */

import { asModelId } from "../core/models.ts";
import { isModelAvailable, modelSpecFor, useWorkbench, visibleModelsFor } from "../store/useWorkbench.ts";

export interface ModelSelectProps {
  /** 命名空间后的运行时 id（`daemon:<id>` 形式） */
  readonly runtimeId: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly className?: string;
  readonly ariaLabel?: string;
  /** 禁用整个下拉（执行器未选 / 正在保存等）。默认不禁用。 */
  readonly disabled?: boolean;
  /** 首个空选项的文案。默认「跟随默认」 */
  readonly placeholder?: string;
}

export function ModelSelect({
  runtimeId,
  value,
  onChange,
  className,
  ariaLabel,
  disabled,
  placeholder = "跟随默认",
}: ModelSelectProps) {
  const models = useWorkbench((s) => visibleModelsFor(s, runtimeId));
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === runtimeId));

  // 判定走 isModelAvailable 而不是在这里自己 some 一遍：发送路径（store.send）
  // 与顶栏（RuntimePicker）判的是同一件事，三处必须一致，否则会出现
  // 「顶栏说这个模型不可用、下拉框却还当它正常」或反过来的分裂。
  // 空值 = 跟随执行器默认，永远算可用（默认模型必然在清单里）。
  // 订阅式读法（不用 getState()）：模型清单变了，这个标记必须跟着变。
  const unavailable = useWorkbench((s) => value !== "" && !isModelAvailable(s, runtimeId, value));
  // 失效模型的名字只能从退役留档里取：动态发现的新模型不在本地目录里，
  // 只查目录会拿到 undefined，界面上就只剩一串空气。
  const label = unavailable ? (modelSpecFor(runtime, asModelId(value))?.displayName ?? value) : "";

  return (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <option value="">{placeholder}</option>
        {unavailable && (
          <option value={value}>{label}（不可用）</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
      </select>
      {unavailable && (
        <p className="mt-1 text-caption text-amber-600">
          {label} 已不在 {runtime?.presentation.displayName ?? "该执行器"} 的可选清单里（多半是模型下线了）。保存不会拦你，但用它跑任务大概率失败 —— 建议换一个。
        </p>
      )}
    </>
  );
}
