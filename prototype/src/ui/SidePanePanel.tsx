import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { History, PanelRightClose, X } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useSidePane, SIDE_PANE_MIN } from "../store/useSidePane.ts";
import { visibleTabsForUnit, type SidePaneTab } from "../core/sidePaneTabs.ts";
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
 * - **收起即归零**：用户收起 / 当前 bot 无 tab 时整列（含分隔条）不占空间；
 *   重开的入口是各业务入口的 openTab（openTab 永远展开面板）。
 * - tab 关闭语义见 core/sidePaneTabs.ts（关激活落右邻）。
 *
 * 后续扩展位（tab 类型 ≥ 2 时再做）：tab 拖拽排序、⌄ 总览搜索、最近关闭重开。
 */

/** 工作台 Group 的第三列。当前 bot 无可见 tab 时整个（含分隔条）不渲染。 */
export function SidePaneColumn(): ReactElement | null {
  const tabs = useSidePane((s) => s.tabs);
  const activeTabId = useSidePane((s) => s.activeTabId);
  const collapsed = useSidePane((s) => s.collapsed);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const mainView = useShell((s) => s.mainView);
  const visibleTabs = useMemo(() => visibleTabsForUnit(tabs, scopeUnitId), [tabs, scopeUnitId]);

  // 无 tab 才整列卸载（无保活内容可丢）；非 chat 视图只收起 —— Panel 保持挂载
  if (visibleTabs.length === 0) return null;
  const open = !collapsed && mainView === "chat";
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

  // 首帧挂载后显式应用 initialWidth 像素值，并仅在稳定后接收真实用户手势更新
  useEffect(() => {
    if (open && ref.current) {
      ref.current.resize(`${useSidePane.getState().paneWidth}px`);
    }
    const timer = setTimeout(() => {
      isMountedRef.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, [open]);

  // 折叠/展开走 panelRef，保证 Group 的子节点结构始终是 Panel / Separator
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (open) p.expand();
    else p.collapse();
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
      {/* tab 条：横向滚动；激活 tab 高亮，hover 出关闭 × */}
      <div role="tablist" aria-label="右侧面板标签页" className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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

      {/* 内容区：全量 tab 挂载（保活），仅「面板可见且激活」的那个显示 */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
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
        })}
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
