import type { ReactElement } from "react";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { UnitId } from "../core/units.ts";
import { UnitContextEditor } from "./UnitContextEditor.tsx";

/**
 * 右栏「Context」tab 的宿主（ADR 0014）——真正的矩阵与文件编辑在共享组件
 * UnitContextEditor（与设置页「上下文清单」分区、bot 设置对话框同一份实现，
 * 三个面永远长一样）。这里只负责 unit 解析与空态。
 */
export function ContextPane({ unitId }: { unitId: UnitId; shown?: boolean }): ReactElement | null {
  const unit = useWorkbench((s) => s.units.find((u) => String(u.id) === String(unitId)));
  if (unit === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-caption text-ash">
        这个 bot 已经不在了（目录或定义被移除）
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <UnitContextEditor unitId={String(unitId)} />
    </div>
  );
}
