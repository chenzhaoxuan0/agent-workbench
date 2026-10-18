import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { History, LayoutGrid, PanelRightClose, X } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useSidePane, SIDE_PANE_MIN } from "../store/useSidePane.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { sidePaneOccupies, visibleTabsForUnit, type SidePaneTab } from "../core/sidePaneTabs.ts";
import { HistoryPane } from "./HistoryPane.tsx";
import { cn } from "./cn.ts";

/**
 * 右侧标签页面板 —— 工作台第三列（对齐 ZCode 的 AnimatedSidePanePanel，按本产品体量裁剪）。
 *
 * 关键行为（都不是样式问题）：
 * - **bot 作用域**：tab 条只画当前 bot 的 tab，但内容区挂载**全量** tab ——
 *   切 bot 隐藏不销毁，A 的展开态/滚动位置在切回时原样恢复（保活）。
 * - **只在 chat 主视图展开**（ZCode：workspaceMainView === "chat" && isSidePaneOpen）：
 *   自动化/出图/待办/源代码管理是全局页，不属于任何 bot，旁边挂当前 bot 的
 *   历史面板是错位的。切走时面板**收起但保持挂载** —— 保活不因换视图丢失；
 *   openTab 会顺带切回 chat（见 useSidePane.openTab）。
 * - **展开即有内容**：无可见 tab 时面板显示**功能主页**（SidePaneHome）—— 直接在
 *   面板里点选要开的功能，而不是空壳或整列消失；用户收起才归零（含分隔条不占空间）。
 *   重开入口有二 —— 工作区头部最右的开合钮（useSidePane.toggleFromHeader，ZCode
 *   头部状态感知开关同款）与各业务入口的 openTab（永远展开面板）。
 * - **窗口宽度插块**（Electron）：面板占位 = 整窗加宽面板那块宽度，让位 = 减回 ——
 *   对话列宽度恒定，「右侧插进来/拿走一块窗口」而非对话区被压窄（见 SidePaneColumn）。
 * - tab 关闭语义见 core/sidePaneTabs.ts（关激活落右邻）。
 *
 * 后续扩展位（tab 类型 ≥ 2 时再做）：tab 拖拽排序、⌄ 总览搜索、最近关闭重开。
 */

/** 工作台 Group 的第三列。收起/切主视图只折叠不卸载（保活），无 tab 可保才卸载。 */
export function SidePaneColumn(): ReactElement | null {
  const tabs = useSidePane((s) => s.tabs);
  const activeTabId = useSidePane((s) => s.activeTabId);
  const collapsed = useSidePane((s) => s.collapsed);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const mainView = useShell((s) => s.mainView);
  const paneWidth = useSidePane((s) => s.paneWidth);
  const visibleTabs = useMemo(() => visibleTabsForUnit(tabs, scopeUnitId), [tabs, scopeUnitId]);

  // 面板真实占位（口径见 core/sidePaneTabs.sidePaneOccupies —— 列卸载/切主视图都算让位；
  // 无可见 tab 时也占位，显示功能主页）
  const open = sidePaneOccupies(scopeUnitId, collapsed, mainView === "chat");

  // 窗口宽度插块（Electron）：窗口宽度始终跟随「面板占位宽度」—— 展开/收起翻转
  // 与拖宽/拖窄都走同一账本（appliedRef 记当前已插进去的宽度），对话列宽度在两侧
  // 都不动，视觉上是「右侧插进来/拿走/变宽一块窗口」而非对话区被压窄。
  // 屏幕边截断时主进程返回实际生效宽度，缺口从账面扣除 —— 下次开合从真实基数
  // 出发，不留净漂移。纯浏览器访问没有窗口控制面，静默降级为现状（对话列让宽）。
  const appliedRef = useRef(0);
  useEffect(() => {
    const api = (
      window as Window & {
        electronAPI?: { adjustWindowWidth?: (delta: number) => Promise<number> };
      }
    ).electronAPI;
    if (api?.adjustWindowWidth === undefined) return;
    const target = open ? paneWidth : 0;
    const delta = target - appliedRef.current;
    // 死区：±1px 的拖动抖动/取整差不惊动窗口（账本按累计差额记账，跳过不破坏口径）
    if (Math.abs(delta) < 2) return;
    appliedRef.current = target;
    void api
      .adjustWindowWidth(delta)
      .then((real) => {
        appliedRef.current -= delta - real;
      })
      .catch(() => {
        appliedRef.current -= delta; // 失败当作没插进去，下个回合从原基数重算
      });
  }, [open, paneWidth]);

  // 卸载判据只有「无 tab 可保活」：收起/切主视图时保持挂载、面板 collapse 到 0 ——
  // 全量 tab（含其他 bot 的）的展开态/滚动位置在重开时原样恢复。
  if (tabs.length === 0 && !open) return null;
  return (
    <>
      {/* 收起时不保留分隔条（ZCode：收起即归零，不为隐藏面板留空隙） */}
      {open ? <SidePaneResizeHandle /> : null}
      <SidePanePanelSlot open={open} visibleTabs={visibleTabs} activeTabId={activeTabId} />
    </>
  );
}

function SidePaneResizeHandle(): ReactElement {
  return (
    <Separator
      className="group relative w-px bg-line cursor-col-resize transition-colors data-[separator=active]:bg-teal hover:bg-teal/50"
      style={{ cursor: "col-resize" }}
    >
      {/* 16px 宽的命中区域，带明确的 col-resize 光标与 hover/active 激活高亮条 */}
      <span
        className="absolute inset-y-0 -left-2 -right-2 z-20 cursor-col-resize transition-colors group-hover:bg-teal/20 group-data-[separator=active]:bg-teal/30"
        aria-hidden
      />
    </Separator>
  );
}

function SidePanePanelSlot({
  open,
  visibleTabs,
  activeTabId,
}: {
  open: boolean;
  visibleTabs: readonly SidePaneTab[];
  activeTabId: string;
}): ReactElement {
  const setPaneWidth = useSidePane((s) => s.setPaneWidth);
  // ⚠ initialWidth 只在挂载时读取一次持久化宽度作为 defaultSize。
  const [initialWidth] = useState(() => useSidePane.getState().paneWidth);
  const ref = useRef<PanelImperativeHandle>(null);
  const isMountedRef = useRef(false);

  // 挂载稳定后才接收真实用户手势的宽度更新（挡掉程序性 resize 的回写）
  useEffect(() => {
    const timer = setTimeout(() => {
      isMountedRef.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // 折叠/展开 + 展开时的持久化宽度应用。**刚挂载的条件节点当帧不能直接调
  // imperative API**：react-resizable-panels 的 Group 还没把这个新 Panel 登记
  // 进布局，立即 resize/expand 会抛 "Layout not found"（侧栏不炸是因为它跟
  // Group 同帧挂载、带初始布局；本列是点开才挂载）—— 推迟一帧再调。
  // 收起方向同步调（面板此前必然展开挂载过，布局已登记）。
  useEffect(() => {
    if (!open) {
      ref.current?.collapse();
      return;
    }
    const id = requestAnimationFrame(() => {
      const p = ref.current;
      if (!p) return;
      p.expand();
      p.resize(`${useSidePane.getState().paneWidth}px`);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <Panel
      panelRef={ref}
      defaultSize={`${initialWidth}px`}
      minSize={`${SIDE_PANE_MIN}px`}
      maxSize="50%"
      collapsedSize="0px"
      collapsible
      onResize={(size) => {
        // 仅在真实交互/挂载就绪后，且未折叠时才持久化宽度（折叠过程的 0 不写回）
        if (isMountedRef.current && open) {
          setPaneWidth(size.inPixels);
        }
      }}
      className="min-w-0 overflow-hidden"
    >
      <SidePanePanelBody open={open} visibleTabs={visibleTabs} activeTabId={activeTabId} />
    </Panel>
  );
}

function SidePanePanelBody({
  open,
  visibleTabs,
  activeTabId,
}: {
  /** 面板当前实际可见（未收起且在 chat 主视图）—— 内容保活协议的开关 */
  open: boolean;
  visibleTabs: readonly SidePaneTab[];
  activeTabId: string;
}): ReactElement {
  // 全量 tabs：内容区跨 bot / 跨主视图保活，隐藏的不卸载
  const tabs = useSidePane((s) => s.tabs);
  const activateTab = useSidePane((s) => s.activateTab);
  const closeTab = useSidePane((s) => s.closeTab);
  const toggleCollapsed = useSidePane((s) => s.toggleCollapsed);
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId) ? activeTabId : "";

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-card">
      {/* tab 条：横向滚动；激活 tab 高亮，hover 出关闭 ×。无可见 tab 时标「功能」，
          此时内容区就是功能主页 */}
      <div role="tablist" aria-label="右侧面板标签页" className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visibleTabs.length === 0 && (
            <span className="flex h-7 shrink-0 select-none items-center gap-1.5 rounded-btn border border-teal/40 bg-teal-tint/60 px-2 text-caption text-ink">
              <LayoutGrid size={11} className="shrink-0 text-teal" />
              功能
            </span>
          )}
          {visibleTabs.map((tab) => {
            const active = tab.id === visibleActiveTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => activateTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") activateTab(tab.id);
                }}
                className={cn(
                  "group flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-btn border px-2 text-caption transition",
                  active
                    ? "border-teal/40 bg-teal-tint/60 text-ink"
                    : "border-transparent text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {tab.type === "history" && (
                  <History size={11} className={active ? "shrink-0 text-teal" : "shrink-0 text-ash"} />
                )}
                <span className="max-w-44 truncate">{sidePaneTabTitle(tab)}</span>
                {/* 行根承担 tab 切换，关闭用 span 实现（button 套 button 非法） */}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${sidePaneTabTitle(tab)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }
                  }}
                  className="rounded p-0.5 text-ash opacity-0 transition hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X size={11} />
                </span>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="收起右侧面板"
          title="收起右侧面板（从历史等入口可重新打开）"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      {/* 内容区：全量 tab 挂载（保活），仅「面板可见且激活」的那个显示；
          无可见 tab（或聚焦缺失）时落功能主页 —— 面板展开永远有东西可点 */}
      <div className="relative min-h-0 flex-1">
        {visibleActiveTabId === "" ? (
          <SidePaneHome />
        ) : (
          tabs.map((tab) => {
            const shown = open && tab.id === visibleActiveTabId;
            return (
              <div
                key={tab.id}
                aria-hidden={!shown}
                className={cn("absolute inset-0 min-h-0", shown ? "block" : "hidden")}
              >
                <SidePaneTabContent tab={tab} shown={shown} closeTab={closeTab} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * 单个 tab 的内容宿主。memo 挡住两类无关重渲染：
 * 别的 bot 开/关 tab（tabs 数组变了但这个 tab 对象没动）、面板收起时的
 * open 翻转（shown 不变时 HistoryPane 的整棵列表树不重算）。
 * isActive 翻转（切 tab）本身仍会重渲染 —— 那是保活协议的必要代价。
 */
const SidePaneTabContent = memo(function SidePaneTabContent({
  tab,
  shown,
  closeTab,
}: {
  tab: SidePaneTab;
  shown: boolean;
  closeTab: (tabId: string) => void;
}) {
  // 稳定引用：否则 memo 挡不住 —— 每次父渲染生成的新箭头函数都会击穿比较
  const onFinished = useCallback(() => closeTab(tab.id), [closeTab, tab.id]);
  if (tab.type !== "history") return null;
  return (
    <HistoryPane
      unitId={String(tab.ownerUnitId)}
      unitName={tab.unitName}
      focusKey={tab.focusKey}
      isActive={shown}
      onFinished={onFinished}
    />
  );
});

function sidePaneTabTitle(tab: SidePaneTab): string {
  return tab.type === "history" ? `${tab.unitName} · 历史` : tab.id;
}

/* ------------------------------------------------------------- 功能主页 */

/**
 * 面板功能主页 —— 展开时若无可见 tab（或聚焦缺失），面板直接列出当前可点的功能
 * 入口，点选后才把对应内容以 tab 形式打开。右侧栏现有功能就一类：各单元的历史
 * 会话（自动化任务、待办、心跳与手动会话的时间轴）；后续新功能（移动端远控等）
 * 以标签页形式入驻时，这里就是它们的统一入口页。
 */
function SidePaneHome(): ReactElement {
  const units = useWorkbench((s) => s.units);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const current = units.find((u) => String(u.id) === String(scopeUnitId));
  const others = units.filter((u) => String(u.id) !== String(scopeUnitId));

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <p className="text-body-sm font-medium text-ink">面板功能</p>
      <p className="mt-0.5 text-[10px] text-ash">点选要打开的功能，它将以标签页入驻本面板</p>

      {current !== undefined && (
        <button
          type="button"
          onClick={() =>
            useSidePane.getState().openTab({ unitId: current.id, unitName: current.name })
          }
          className="mt-3 flex w-full cursor-pointer items-start gap-2.5 rounded-card border border-line bg-canvas p-3 text-left transition hover:border-teal-edge hover:bg-teal-tint/40"
        >
          <History size={16} className="mt-0.5 shrink-0 text-teal" />
          <span className="min-w-0">
            <span className="block text-body-sm font-medium text-ink">历史会话</span>
            <span className="mt-0.5 block text-caption text-graphite">
              {current.name} 的自动化任务、待办、心跳与手动会话时间轴
            </span>
          </span>
        </button>
      )}

      {others.length > 0 && (
        <>
          <p className="mt-4 text-[10px] font-medium tracking-wide text-ash">其他单元 · 历史</p>
          <div className="mt-1.5 space-y-1">
            {others.map((u) => (
              <button
                key={String(u.id)}
                type="button"
                onClick={() => {
                  // 开别人的历史要顺带切 bot：tab 按 owner 过滤可见，不切就「点了没反应」
                  useWorkbench.getState().selectUnit(u.id);
                  useSidePane.getState().openTab({ unitId: u.id, unitName: u.name });
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-btn px-2 py-1.5 text-left text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
              >
                <History size={12} className="shrink-0 text-ash" />
                <span className="min-w-0 truncate">{u.name} 的历史</span>
              </button>
            ))}
          </div>
        </>
      )}

      {units.length === 0 && (
        <p className="mt-3 text-caption text-ash">还没有单元 —— 左侧栏添加单元后面板功能会在这里列出。</p>
      )}

      <p className="mt-4 border-t border-line-soft pt-2 text-[10px] leading-relaxed text-ash">
        更多功能将陆续以标签页形式入驻本面板。
      </p>
    </div>
  );
}
