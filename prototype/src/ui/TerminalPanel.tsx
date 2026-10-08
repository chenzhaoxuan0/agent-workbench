import { useEffect, useRef, useState, useMemo } from "react";
import {
  SquareTerminal,
  Terminal,
  X,
  RotateCw,
  Trash2,
  FolderOpen,
  MessageSquare,
  Zap,
  Plus,
  ChevronDown,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import {
  useTerminalStore,
  SUPPORTED_TERMINAL_PROFILES,
  collectLeafIds,
} from "../store/useTerminalStore.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { TerminalSplitTree } from "./TerminalSplitTree.tsx";
import { TerminalPaneSlot, ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { openFolder } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

export function TerminalPanel({
  variant = "dock",
  onClose,
  label,
}: {
  variant?: "dock" | "page" | "canvas";
  onClose?: () => void;
  label?: string;
} = {}) {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const runtimes = useWorkbench((s) => s.runtimes);
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const setConversationView = useShell((s) => s.setConversationView);

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  const closeTerminal =
    onClose ?? (isPage || isCanvas ? () => setConversationView("chat") : toggleTerminal);

  // 多终端自由分屏树与标签组状态
  const {
    instances,
    groups,
    activeGroupId,
    activeInstanceId,
    maximizedInstanceId,
    defaultProfileId,
    createTab,
    splitPane,
    closeTab,
    setActiveGroup,
    setActiveInstance,
    toggleMaximize,
  } = useTerminalStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 初始化：若无标签组，则自动新建一个默认终端
  useEffect(() => {
    if (groups.length === 0) {
      if (isCanvas && activeRuntimeId) {
        // 画布模式默认在 PowerShell 7 中交互启动当前选中的 Agent CLI
        createTab({
          profileId: "pwsh",
          cwd: unit?.rootPath,
          executorId: activeRuntimeId,
          title: `${runtime?.presentation.displayName ?? activeRuntimeId} (TUI)`,
        });
      } else {
        createTab({
          profileId: defaultProfileId,
          cwd: unit?.rootPath,
        });
      }
    }
  }, [groups.length, isCanvas, activeRuntimeId, unit?.rootPath, defaultProfileId, createTab, runtime]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // 清屏当前活跃窗格
  const handleClear = () => {
    if (activeInstanceId) {
      terminalSessionRegistry.get(activeInstanceId)?.clear();
    }
  };

  // 重启当前活跃窗格
  const handleRestart = () => {
    if (activeInstanceId) {
      void terminalSessionRegistry.get(activeInstanceId)?.restart();
    }
  };

  // 新建默认终端标签页
  const handleNewDefault = () => {
    createTab({
      profileId: defaultProfileId,
      cwd: unit?.rootPath,
    });
  };

  // 选择 Profile 新建系统终端
  const handleCreateProfile = (profileId: string) => {
    setMenuOpen(false);
    createTab({
      profileId,
      cwd: unit?.rootPath,
    });
  };

  // 选择 Agent 执行器在 pwsh 中交互启动其 TUI
  const handleLaunchExecutor = (execId: string, displayName: string) => {
    setMenuOpen(false);
    createTab({
      profileId: "pwsh",
      cwd: unit?.rootPath,
      executorId: execId,
      title: `${displayName} (TUI)`,
    });
  };

  // 获取可用的 Agent 执行器列表
  const executorOptions = useMemo(() => {
    return runtimes.filter((r) => !r.testOnly);
  }, [runtimes]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0];
  const activeLeaves = useMemo(() => {
    return activeGroup ? collectLeafIds(activeGroup.rootLayout) : [];
  }, [activeGroup]);

  const maximizedInst = useMemo(() => {
    return instances.find((i) => i.id === maximizedInstanceId);
  }, [instances, maximizedInstanceId]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col bg-[#000000]",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* VS Code 同款终端多标签栏与自由分屏工具条 */}
      <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-line/40 bg-[#121212] px-2 select-none">
        {/* 左侧：多终端 Tabs 标签页列表 */}
        <div className="flex h-full max-w-[calc(100%-280px)] items-center gap-1 overflow-x-auto no-scrollbar py-1">
          {groups.map((group) => {
            const isGroupActive = group.id === activeGroupId;
            const leaves = collectLeafIds(group.rootLayout);
            const firstInst = instances.find((i) => i.id === leaves[0]);
            const isSplitGroup = leaves.length > 1;

            const tabTitle =
              group.title ||
              (isSplitGroup
                ? `分屏 (${leaves.length} 窗格)`
                : firstInst?.title || "终端");

            return (
              <div
                key={group.id}
                onClick={() => setActiveGroup(group.id)}
                className={cn(
                  "group relative flex h-7 items-center gap-1.5 rounded px-2.5 text-caption font-mono cursor-pointer transition select-none max-w-[210px]",
                  isGroupActive
                    ? "bg-[#000000] text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-[#181817] hover:text-ink",
                  isSplitGroup && "ring-1 ring-teal/30",
                )}
                title={tabTitle}
              >
                {isSplitGroup ? (
                  <Columns2 size={12} className="text-teal" />
                ) : (
                  <ShellOrAgentIcon icon={firstInst?.icon || "pwsh"} />
                )}

                <span className="truncate">{tabTitle}</span>

                {/* 分屏窗格数量小徽章 */}
                {isSplitGroup && (
                  <span className="rounded bg-teal/10 px-1 py-0.2 text-[9px] text-teal font-sans">
                    {leaves.length}P
                  </span>
                )}

                {/* 关闭单标签按钮 */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(group.id);
                  }}
                  title="关闭标签页"
                  className={cn(
                    "ml-1 rounded p-0.5 text-ash hover:bg-line-soft hover:text-rose-400 transition",
                    isGroupActive
                      ? "opacity-80 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-80",
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        {/* 新建终端按钮与下拉菜单（包含交互式 Agent TUI、系统终端、分屏操作） */}
        <div className="relative flex items-center ml-1.5 shrink-0" ref={menuRef}>
          <div className="flex items-center rounded-btn bg-line-soft/40 hover:bg-line-soft text-ash hover:text-ink transition">
            <button
              type="button"
              onClick={handleNewDefault}
              title="新建终端 (PowerShell 7)"
              className="flex items-center p-1 hover:text-teal transition"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              title="选择 Agent 执行器或系统 Shell (ZCode, Claude, Codex, WSL, CMD...)"
              className="flex items-center px-1 py-1 text-ash/80 hover:text-ink border-l border-line/30 transition"
            >
              <ChevronDown size={11} />
            </button>
          </div>

          {/* 下拉弹出菜单 */}
          {menuOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-50 min-w-[250px] rounded-panel border border-line bg-[#181817] p-1.5 shadow-2xl backdrop-blur">
              {/* 分组 1：Agent 交互式执行器（在 PowerShell 7 中运行其真 TUI） */}
              <div className="px-2 py-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase flex items-center gap-1">
                <Zap size={11} />
                <span>交互式 Agent CLI (TUI)</span>
              </div>
              {executorOptions.map((r) => (
                <button
                  key={r.id}
                  onClick={() => handleLaunchExecutor(r.id, r.presentation.displayName)}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
                >
                  <ShellOrAgentIcon icon={r.id} />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-caption font-mono font-medium truncate">
                      {r.presentation.displayName}
                    </span>
                    <span className="text-[10px] text-ash/60 font-sans truncate">
                      PowerShell 7 · 交互式 TUI
                    </span>
                  </div>
                  {activeRuntimeId === r.id && (
                    <span className="text-[10px] text-teal/70 font-sans">当前</span>
                  )}
                </button>
              ))}

              <div className="my-1.5 h-px bg-line/50" />

              {/* 分组 2：原生系统 Shell */}
              <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase">
                原生系统终端
              </div>
              {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => handleCreateProfile(profile.id)}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
                >
                  <ShellOrAgentIcon icon={profile.icon} />
                  <span className="flex-1 text-caption font-mono">{profile.name}</span>
                  {profile.id === defaultProfileId && (
                    <span className="text-[10px] text-teal/70 font-sans">默认</span>
                  )}
                </button>
              ))}

              <div className="my-1.5 h-px bg-line/50" />

              {/* 分组 3：自由分屏操作 */}
              <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase">
                自由分屏操作
              </div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  splitPane({ direction: "horizontal" });
                }}
                className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
              >
                <Columns2 size={13} className="text-teal" />
                <span className="text-caption font-mono">向右拆分当前窗格 (Split Right)</span>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  splitPane({ direction: "vertical" });
                }}
                className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
              >
                <Rows2 size={13} className="text-teal" />
                <span className="text-caption font-mono">向下拆分当前窗格 (Split Down)</span>
              </button>
            </div>
          )}
        </div>

        {/* 右侧：全局终端操作工具条 */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 向右拆分 */}
          <button
            type="button"
            onClick={() => splitPane({ direction: "horizontal" })}
            title="向右拆分当前窗格 (Split Right)"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Columns2 size={12} />
            <span className="hidden xl:inline">向右拆分</span>
          </button>

          {/* 向下拆分 */}
          <button
            type="button"
            onClick={() => splitPane({ direction: "vertical" })}
            title="向下拆分当前窗格 (Split Down)"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Rows2 size={12} />
            <span className="hidden xl:inline">向下拆分</span>
          </button>

          {/* 最大化 / 还原 */}
          <button
            type="button"
            onClick={() => toggleMaximize()}
            title={maximizedInstanceId ? "还原分屏窗格" : "最大化当前聚焦窗格"}
            className={cn(
              "flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption transition",
              maximizedInstanceId
                ? "bg-teal-tint text-teal"
                : "text-ash hover:bg-line-soft hover:text-ink",
            )}
          >
            {maximizedInstanceId ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            <span className="hidden sm:inline">
              {maximizedInstanceId ? "还原" : "最大化"}
            </span>
          </button>

          {/* 清屏 */}
          <button
            type="button"
            onClick={handleClear}
            title="清空当前窗格屏幕 (Ctrl+L 重绘)"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Trash2 size={12} />
            <span className="hidden sm:inline">清屏</span>
          </button>

          {/* 重启当前终端进程 */}
          <button
            type="button"
            onClick={handleRestart}
            title="重启当前终端进程"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-teal-tint hover:text-teal transition"
          >
            <RotateCw size={12} />
            <span className="hidden sm:inline">重启</span>
          </button>

          {/* 打开工作空间目录 */}
          {unit && (
            <button
              type="button"
              onClick={() => void openFolder({ path: unit.rootPath }).catch(() => {})}
              title="在系统资源管理器中打开当前工作空间"
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <FolderOpen size={12} />
            </button>
          )}

          {/* 主画布模式下提供切换至会话历史按钮 */}
          {isCanvas && (
            <button
              type="button"
              onClick={() => setConversationView("chat")}
              title="切换至会话与历史列表视图"
              className="flex items-center gap-1 rounded-btn bg-line-soft/60 px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
            >
              <MessageSquare size={12} />
              <span className="hidden sm:inline">会话历史</span>
            </button>
          )}

          {/* 关闭终端（非画布态） */}
          {!isCanvas && (
            <button
              type="button"
              onClick={closeTerminal}
              aria-label={isPage ? "关闭终端窗格" : "关闭终端"}
              title={isPage ? undefined : "关闭终端"}
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 终端内容区：完全无限制的自由递归分屏树 */}
      {unit === undefined ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <p className="text-body-sm text-ash">
            终端需要一个工作目录才能启动。请在左侧侧边栏选择一个 Bot 或工作空间。
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-body-sm text-ash">当前没有打开的终端实例。</p>
          <button
            onClick={handleNewDefault}
            className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-caption font-medium text-[#000000] hover:bg-teal-hover transition shadow"
          >
            <Plus size={13} />
            <span>新建 PowerShell 7 终端</span>
          </button>
        </div>
      ) : maximizedInst ? (
        /* 当前窗格最大化展示 */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          <TerminalPaneSlot
            key={maximizedInst.id}
            inst={maximizedInst}
            totalPanesInGroup={1}
          />
        </div>
      ) : activeGroup ? (
        /* 自由递归分屏树展示 */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          <TerminalSplitTree
            key={activeGroup.id}
            node={activeGroup.rootLayout}
            totalPanesInGroup={activeLeaves.length}
          />
        </div>
      ) : null}
    </div>
  );
}
