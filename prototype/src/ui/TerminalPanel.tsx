import { useEffect, useRef, useState, useMemo } from "react";
import {
  SquareTerminal,
  Terminal,
  X,
  RotateCw,
  Trash2,
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
import { useAppearance } from "../store/useAppearance.ts";
import { dispatchTerminal } from "../adapters/daemon/client.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
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
  const { isMobile } = useIsMobile();

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  // 会话历史/终端抽屉已移除（见 useShell.ts 顶部注释）：非画布变体当前无人渲染，
  // 关闭动作只能由调用方显式传 onClose。
  const closeTerminal = onClose ?? (() => {});

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

  // 当前 bot 绑定的默认执行器（bindings.primary 优先；旧数据的裸 id 修复到注册表
  // 命名空间；绑定的执行器已不存在时回落全局默认）。没有 bot 绑定时跟随全局默认。
  const boundExecutor = useMemo(() => {
    const binding = unit?.bindings.find((b) => b.primary) ?? unit?.bindings[0];
    const rid = binding?.runtimeId;
    if (!rid) return activeRuntimeId;
    return (
      runtimes.find((r) => r.id === rid)?.id ??
      runtimes.find((r) => r.id === `daemon:${rid}`)?.id ??
      activeRuntimeId
    );
  }, [unit, runtimes, activeRuntimeId]);

  // 终端跟随 bot：切到某个 bot 时激活它的专属标签页（进程保持存活）；
  // 还没有就**经派发系统**为它开绑定执行器的 TUI（记入历史、免审批、带「派发」徽章
  // —— 用过的会话都有迹可循）。派发是异步的，用 pending 集合挡住重复触发；
  // 失败退回手动开（旧行为）。
  // ⚠ StrictMode 会把 effect 双调用 —— 全程用 getState() 读实时状态 + ref 防重，
  // 不幂等的写法会建出两个标签（实测）。
  // ⚠ 画布虽常驻挂载（hidden 裁剪），跟随逻辑只在**终端视图真正可见**时生效：
  //    开屏就给当前 bot 悄悄起一个用户没要的 TUI 是注意力扰乱（尤其人还在看
  //    历史会话列表时）；首次切到终端视图的那一刻才跟随。
  const conversationView = useShell((s) => s.conversationView);
  const lastFollowedUnitRef = useRef<string | null | undefined>(undefined);
  const pendingDispatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (isCanvas && conversationView !== "terminal") return;
    const uid = unit?.id ?? null;
    if (lastFollowedUnitRef.current === uid) return;
    lastFollowedUnitRef.current = uid;

    const st = useTerminalStore.getState();
    if (!uid || !unit) {
      // 等 F5 重挂先跑完：不等的话这个默认标签会先落地，重挂守卫 sees 非空直接放弃，
      // daemon 里活着的终端从此找不回来。reattachDone 在 daemon 不可用时也会置位。
      if (st.groups.length === 0 && st.reattachDone) st.createTab({ profileId: st.defaultProfileId });
      return;
    }
    const execName = runtimes.find((r) => r.id === boundExecutor)?.presentation.displayName ?? boundExecutor;
    // 优先匹配已有的 bot 专属终端（无感复用重挂存活终端，或同工作目录/执行器的存活会话）
    const own = st.instances.find(
      (i) => i.unitId === uid || (i.cwd && i.cwd === unit.rootPath && i.executorId === boundExecutor),
    );
    if (own) {
      if (!own.unitId) {
        own.unitId = uid;
        own.title = `${unit.name} · ${execName} (TUI)`;
      }
      const group = st.groups.find((g) => collectLeafIds(g.rootLayout).includes(own.id));
      if (group) st.setActiveGroup(group.id);
      st.setActiveInstance(own.id);
      return;
    }
    // 已派发过但标签还没落地（created 帧在途）——别再发一次
    if (pendingDispatchRef.current.has(uid)) return;
    // 侧栏历史行 / 历史弹窗刚派发过 TUI 恢复（resume 在途）：同理不再发全新的
    if ((st.pendingUnitDispatch[uid] ?? 0) > Date.now()) return;
    const bareId = boundExecutor.replace(/^daemon:/, "");
    if (isCanvas && bareId !== "") {
      pendingDispatchRef.current.add(uid);
      void dispatchTerminal({ unitId: unit.id, unitName: unit.name, rootPath: unit.rootPath, runtimeId: bareId })
        .catch((err: unknown) => {
          // daemon 不可达等：退回手动开，bot 切换不至于没有终端
          console.error("[TerminalPanel] 派发终端失败，退回手动:", err);
          useTerminalStore.getState().createTab({ profileId: "pwsh", cwd: unit.rootPath, executorId: boundExecutor, unitId: uid, title: `${unit.name} · ${execName} (TUI)` });
        })
        .finally(() => {
          // 停留几秒再清：created 帧认领有延迟，清早了会双发
          setTimeout(() => pendingDispatchRef.current.delete(uid), 3000);
        });
      return;
    }
    // 启动引导期先建的普适标签（bot 列表还没到）：唯一且无标记时换成 bot 专属标签。
    // 重挂标签不算数 —— 它背后是活进程，换标签不能顺手杀进程。
    const untagged = st.instances.filter((i) => !i.unitId && !i.reattached);
    const soleGroup = st.groups.length === 1 ? st.groups[0] : undefined;
    if (untagged.length === 1 && soleGroup) {
      st.closeTab(soleGroup.id);
    }
    st.createTab({
      profileId: "pwsh",
      cwd: unit.rootPath,
      executorId: boundExecutor,
      unitId: uid,
      title: `${unit.name} · ${execName} (TUI)`,
    });
    // 只在切换 bot（或首开）时走一次
  }, [unit?.id, unit, boundExecutor, isCanvas, runtimes, conversationView]);

  // 上面那个 effect 被 ref 挡住只跑一次；「无 bot 首启 + daemon 里也没活终端」时，
  // 默认标签要等 reattachDone 翻位后在这里补建，否则首屏永远没有终端。
  // 同样只在终端视图可见时补 —— 开屏不建空终端标签。
  const reattachDone = useTerminalStore((s) => s.reattachDone);
  useEffect(() => {
    if (!reattachDone || unit || (isCanvas && conversationView !== "terminal")) return;
    const st = useTerminalStore.getState();
    if (st.groups.length === 0) st.createTab({ profileId: st.defaultProfileId });
  }, [reattachDone, unit, isCanvas, conversationView]);

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

  // 选择 Agent 执行器 —— 全部走派发系统打开（记入历史、免审批、标签带「派发」徽章）；
  // 没选中 bot 时派发无处归属，退回手动开（旧行为）
  const handleLaunchExecutor = (execId: string, displayName: string) => {
    setMenuOpen(false);
    const bareId = execId.replace(/^daemon:/, "").replace(/:yolo$/, "");
    if (unit && bareId !== "") {
      void dispatchTerminal({ unitId: unit.id, unitName: unit.name, rootPath: unit.rootPath, runtimeId: bareId })
        .catch((err: unknown) => {
          console.error("[TerminalPanel] 派发终端失败，退回手动:", err);
          createTab({
            profileId: "pwsh",
            cwd: unit.rootPath,
            executorId: execId,
            unitId: unit.id,
            title: `${unit.name} · ${displayName} (TUI)`,
          });
        });
      return;
    }
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

  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col",
        isCanvas ? undefined : "bg-card",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* VS Code 同款终端多标签栏与自由分屏工具条 */}
      <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-line/40 bg-rail px-2 select-none">
        {/* 左侧：多终端 Tabs 标签页列表 */}
        <div
          className={cn(
            "flex h-full items-center gap-1 overflow-x-auto no-scrollbar py-1 scroll-smooth touch-pan-x",
            isMobile ? "flex-1 min-w-0 pr-1" : "max-w-[calc(100%-280px)]",
          )}
        >
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
                  "group relative flex h-7 items-center gap-1.5 rounded font-mono cursor-pointer transition select-none shrink-0",
                  isMobile
                    ? "px-2 text-[11px] max-w-[150px] min-w-[70px]"
                    : "px-2.5 text-caption max-w-[210px]",
                  isGroupActive
                    ? "bg-canvas text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-line-soft hover:text-ink",
                  isSplitGroup && "ring-1 ring-teal/30",
                )}
                title={tabTitle}
              >
                {isSplitGroup ? (
                  <Columns2 size={12} className="shrink-0 text-teal" />
                ) : (
                  <ShellOrAgentIcon icon={firstInst?.icon || "pwsh"} />
                )}

                <span className="truncate flex-1 min-w-0">{tabTitle}</span>

                {/* 派发徽章：autoterm_ 前缀 = 经派发系统（自动化/待办/手动派发），
                    会进该 bot 的历史；普通标签没有它 */}
                {firstInst?.id.startsWith("autoterm_") && (
                  <span
                    title="派发终端 —— 经过派发系统，会记入该 bot 的历史会话"
                    className="shrink-0 rounded bg-violet-500/15 px-1 py-0.2 text-[9px] font-semibold text-violet-400 font-sans"
                  >
                    派发
                  </span>
                )}

                {/* 分屏窗格数量小徽章 */}
                {isSplitGroup && (
                  <span className="shrink-0 rounded bg-teal/10 px-1 py-0.2 text-[9px] text-teal font-sans">
                    {leaves.length}P
                  </span>
                )}

                {/* 关闭单标签按钮（手机端常驻可见且易于点击，避免无 hover 导致无法关闭） */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(group.id);
                  }}
                  title="关闭标签页"
                  aria-label={`关闭标签页 ${tabTitle}`}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded text-ash transition",
                    "hover:bg-line-soft hover:text-rose-400 active:bg-rose-500/20 active:text-loss",
                    isMobile
                      ? "h-5 w-5 opacity-70 active:opacity-100 -mr-1"
                      : cn(
                          "ml-1 p-0.5",
                          isGroupActive
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover:opacity-80",
                        ),
                  )}
                >
                  <X size={isMobile ? 12 : 11} />
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

          {/* 移动端全屏半透明遮罩（点按背景关闭） */}
          {menuOpen && isMobile && (
            <div
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150"
              onClick={() => setMenuOpen(false)}
            />
          )}

          {/* 下拉弹出菜单（移动端支持平滑上下滑动、触控滚动及 UI 压缩） */}
          {menuOpen && (
            <div
              className={cn(
                "z-50 rounded-panel border border-line bg-card shadow-2xl backdrop-blur flex flex-col",
                isMobile
                  ? "fixed inset-x-3 top-12 max-h-[72dvh] p-2.5 animate-in fade-in zoom-in-95 duration-150"
                  : "absolute left-0 top-full mt-1.5 min-w-[260px] max-h-[480px] p-1.5",
              )}
            >
              {/* 移动端顶部标题栏与关闭叉号 */}
              {isMobile && (
                <div className="flex items-center justify-between pb-2 mb-1.5 border-b border-line/50 px-1 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Zap size={13} className="text-teal" />
                    <span className="text-body-sm font-semibold text-ink">选择派发执行器或终端</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    className="p-1 rounded text-ash hover:text-ink hover:bg-line-soft active:scale-90 transition"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {/* 滚动容器：添加 touch-pan-y 与 iOS 原生平滑滚动 */}
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y scrollbar-thin flex flex-col pr-0.5"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {/* 分组 1：Agent 执行器 —— 全部经派发系统打开 */}
                <div className="px-2 py-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase flex items-center gap-1 shrink-0">
                  <Zap size={11} />
                  <span>Agent CLI (TUI · 派发)</span>
                  <span className="ml-auto text-[9px] normal-case tracking-normal text-ash/50">
                    记入历史
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {executorOptions.map((r) => {
                    return (
                      <button
                        key={r.id}
                        onClick={() => handleLaunchExecutor(r.id, r.presentation.displayName)}
                        className={cn(
                          "flex w-full items-center rounded text-left text-ink hover:bg-teal-tint hover:text-teal active:bg-teal-tint transition",
                          isMobile
                            ? "gap-2 px-2 py-1.5 min-h-8.5"
                            : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                        )}
                      >
                        <ShellOrAgentIcon icon={r.id} />
                        <div className="flex flex-1 items-center justify-between min-w-0 gap-1.5">
                          <span className="text-caption font-mono font-medium truncate">
                            {r.presentation.displayName}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {activeRuntimeId === r.id && (
                              <span className="rounded bg-teal/15 px-1 py-0.2 text-[9px] font-sans font-medium text-teal">
                                当前
                              </span>
                            )}
                            <span className="rounded bg-line-soft px-1 py-0.2 text-[9px] font-sans text-ash">
                              TUI 派发
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="my-1.5 h-px bg-line/50 shrink-0" />

                {/* 分组 2：原生系统 Shell */}
                <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase shrink-0">
                  原生系统终端
                </div>
                <div className="flex flex-col gap-0.5">
                  {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
                    <button
                      key={profile.id}
                      onClick={() => handleCreateProfile(profile.id)}
                      className={cn(
                        "flex w-full items-center rounded text-left text-ink hover:bg-teal-tint hover:text-teal active:bg-teal-tint transition",
                        isMobile
                          ? "gap-2 px-2 py-1.5 min-h-8"
                          : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                      )}
                    >
                      <ShellOrAgentIcon icon={profile.icon} />
                      <span className="flex-1 text-caption font-mono truncate">{profile.name}</span>
                      {profile.id === defaultProfileId && (
                        <span className="text-[9px] text-teal/80 bg-teal/10 px-1 py-0.2 rounded font-sans shrink-0">
                          默认
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* 分组 3：自由分屏操作（仅在桌面端显示，手机屏幕过窄拆分分屏体验不佳） */}
                {!isMobile && (
                  <>
                    <div className="my-1.5 h-px bg-line/50 shrink-0" />
                    <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase shrink-0">
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
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：全局终端操作工具条 */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 桌面端才展示向右拆分、向下拆分与最大化，移动端直接隐藏节省横向空间 */}
          {!isMobile && (
            <>
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
            </>
          )}

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

          {/* 主画布模式下的视图切换按钮已随会话历史一并移除 */}

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
            终端需要一个工作目录才能启动。请在左侧侧边栏选择一个 bot 或项目。
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-body-sm text-ash">当前没有打开的终端实例。</p>
          <button
            onClick={handleNewDefault}
            className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-caption font-medium text-canvas hover:bg-teal-hover transition shadow"
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
