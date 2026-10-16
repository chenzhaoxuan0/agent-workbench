import { useCallback, useEffect, useState } from "react";
import type { ComputerControlState } from "../core/control.ts";
import { getComputerControl, panicComputer, setComputerEnabled } from "../store/useControl.ts";
import { ActionLogCard, FanoutCard } from "./BrowserControlSection.tsx";
import { GroupCard, SettingsRow, Toggle } from "./SettingsPage.tsx";

/**
 * 电脑控制分区（docs/14 §3）—— 总闸、急停、租约状态与动作日志。
 *
 * 电脑控制能动真实桌面（真实键鼠），所以默认停用、总闸 + 急停是首期就有的红线
 * （Q7 决策）；高危动作的人工确认门是二期，UI 上如实说明。
 */
export function ComputerControlSection() {
  const [state, setState] = useState<ComputerControlState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 计数而非布尔：重叠操作时第一个 finally 不该提前解锁（评审收敛）
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;
  const [confirmPanic, setConfirmPanic] = useState(false);

  const refresh = useCallback(() => {
    getComputerControl()
      .then(setState)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = (label: string, fn: () => Promise<ComputerControlState>): void => {
    setBusyCount((c) => c + 1);
    setErr(null);
    fn()
      .then(setState)
      .catch((e) => setErr(`${label}失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusyCount((c) => Math.max(0, c - 1)));
  };

  const lease = state?.lease;
  const leaseText =
    lease?.holder != null
      ? `输入权：会话 ${lease.holder}（最近活动 ${Math.max(0, Math.round((Date.now() - (lease.lastActive ?? Date.now())) / 1000))}s 前，120s 空闲自动释放）`
      : "输入权：空闲";

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        电脑控制让执行器的模型直接操作真实桌面（截图、键鼠、窗口）。工具由 daemon
        统一提供（<span className="font-mono text-ink">workbench-computer</span>，HTTP 端点），所有执行器共享；
        因为能动真实键鼠，<span className="text-ink">默认停用</span>，且同一时刻只有一个会话持有输入权。
      </p>

      <GroupCard>
        <SettingsRow
          label="总闸（启用电脑控制）"
          description="开 = 各执行器获得 computer_* 工具（12 家写原生配置；dsh 随会话动态注入）；关 = 一切工具调用被拒绝。启用同时会预载桌面运行时（nut.js），依赖问题在开闸这一刻暴露。"
          control={<Toggle on={state?.config.enabled === true} disabled={busy} onChange={(v) => run("总闸切换", () => setComputerEnabled(v))} />}
        />
        <SettingsRow
          label="急停（Kill Switch）"
          description="立即关总闸 + 释放输入权。执行器侧的等价出口是 computer_stop 工具。"
          control={
            confirmPanic ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setConfirmPanic(false);
                    run("急停", panicComputer);
                  }}
                  className="rounded-btn bg-loss px-3 py-1.5 text-body-sm text-white"
                >
                  确认急停
                </button>
                <button
                  onClick={() => setConfirmPanic(false)}
                  className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmPanic(true)}
                disabled={busy || state?.config.enabled !== true}
                className="rounded-btn border border-loss px-3 py-1.5 text-body-sm text-loss hover:bg-loss/10 disabled:opacity-40"
              >
                急停
              </button>
            )
          }
        />
        <SettingsRow
          label="输入租约"
          description={leaseText}
          control={
            <span className="text-caption text-ash">
              {lease?.holder != null ? "占用中" : "空闲"}
            </span>
          }
        />
        {state?.runtimeError != null && (
          <SettingsRow
            label="桌面运行时"
            description={`nut.js 加载失败：${state.runtimeError}。工具面会持续报 runtime unavailable，修好依赖后在设置里重新启用即可（无需重启 daemon）。`}
            control={<span className="text-caption text-loss">异常</span>}
          />
        )}
      </GroupCard>

      <FanoutCard state={state} />
      <ActionLogCard actions={state?.actions ?? []} />

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}
    </div>
  );
}
