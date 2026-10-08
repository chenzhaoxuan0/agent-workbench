import { useEffect, useRef, useState } from "react";
import {
  SquareTerminal,
  Terminal,
  X,
  RotateCw,
  Trash2,
  FolderOpen,
  MessageSquare,
  Sparkles,
  Zap,
  Plus,
  ChevronDown,
  Columns2,
  Check,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import {
  useTerminalStore,
  SUPPORTED_TERMINAL_PROFILES,
  type TerminalProfile,
} from "../store/useTerminalStore.ts";
import {
  TerminalInstanceView,
  type TerminalInstanceHandle,
} from "./TerminalInstanceView.tsx";
import { openFolder } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/**
 * 终端类型图标与颜色辅助组件（对齐 VS Code 终端 Profile 风格）
 */
function ShellIcon({
  icon,
  className,
}: {
  icon: TerminalProfile["icon"];
  className?: string;
}) {
  switch (icon) {
    case "pwsh":
      return <Terminal className={cn("text-teal", className)} size={13} />;
    case "powershell":
      return <SquareTerminal className={cn("text-sky-400", className)} size={13} />;
    case "cmd":
      return <Terminal className={cn("text-zinc-400", className)} size={13} />;
    case "wsl":
      return <Terminal className={cn("text-amber-400", className)} size={13} />;
    case "bash":
      return <Terminal className={cn("text-emerald-400", className)} size={13} />;
    default:
      return <Terminal className={cn("text-ash", className)} size={13} />;
  }
}

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
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId));
  const toggleTerminal = useShell((s) => s.toggleTerminal);
  const setConversationView = useShell((s) => s.setConversationView);

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  const closeTerminal =
    onClose ?? (isPage || isCanvas ? () => setConversationView("chat") : toggleTerminal);

  // 多终端实例状态
  const {
    instances,
    activeInstanceId,
    splitInstanceId,
    defaultProfileId,
    createInstance,
    closeInstance,
    setActiveInstance,
    splitWithNew,
    setSplitInstance,
  } = useTerminalStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const instanceRefs = useRef<Map<string, TerminalInstanceHandle>>(new Map());

  // 初始化：若无终端实例，则自动新建一个默认终端
  useEffect(() => {
    if (instances.length === 0) {
      if (isCanvas && activeRuntimeId) {
        // 在画布模式下，默认在 PowerShell 7 中拉起当前 Agent CLI
        createInstance({
          profileId: "pwsh",
          cwd: unit?.rootPath,
          executorId: activeRuntimeId,
          title: `${runtime?.presentation.displayName ?? activeRuntimeId} (pwsh)`,
        });
      } else {
        createInstance({
          profileId: defaultProfileId,
          cwd: unit?.rootPath,
        });
      }
    }
  }, [instances.length, isCanvas, activeRuntimeId, unit?.rootPath, defaultProfileId, createInstance, runtime]);

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

  // 清屏：针对活跃终端调用 clear()
  const handleClear = () => {
    if (activeInstanceId) {
      instanceRefs.current.get(activeInstanceId)?.clear();
    }
  };

  // 重启：针对活跃终端调用 restart()
  const handleRestart = () => {
    if (activeInstanceId) {
      instanceRefs.current.get(activeInstanceId)?.restart();
    }
  };

  // 新建默认终端
  const handleNewDefault = () => {
    createInstance({
      profileId: defaultProfileId,
      cwd: unit?.rootPath,
    });
  };

  // 选择 Profile 新建终端
  const handleCreateProfile = (profileId: string) => {
    setMenuOpen(false);
    createInstance({
      profileId,
      cwd: unit?.rootPath,
    });
  };

  // 拆分终端
  const handleToggleSplit = () => {
    if (splitInstanceId !== null) {
      setSplitInstance(null);
    } else {
      splitWithNew();
    }
  };

  const activeInstance = instances.find((i) => i.id === activeInstanceId);
  const splitInstance = instances.find((i) => i.id === splitInstanceId);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col bg-[#0f1115]",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* VS Code 同款终端 Tab 标签栏与操作工具条 */}
      <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-line/40 bg-[#14171f] px-2">
        {/* 左侧：多终端 Tabs 列表 */}
        <div className="flex h-full max-w-[calc(100%-250px)] items-center gap-1 overflow-x-auto no-scrollbar py-1">
          {instances.map((inst) => {
            const isActive = inst.id === activeInstanceId;
            const isSplit = inst.id === splitInstanceId;
            return (
              <div
                key={inst.id}
                onClick={() => setActiveInstance(inst.id)}
                className={cn(
                  "group relative flex h-7 items-center gap-1.5 rounded px-2.5 text-caption font-mono cursor-pointer transition select-none max-w-[200px]",
                  isActive
                    ? "bg-[#0f1115] text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-[#1b1f2b] hover:text-ink",
                  isSplit && "ring-1 ring-teal/40",
                )}
                title={`${inst.title} (${inst.shell})`}
              >
                <ShellIcon icon={inst.icon} />
                <span className="truncate">{inst.title}</span>

                {/* 拆分标记 */}
                {isSplit && (
                  <span className="rounded bg-teal/10 px-1 py-0.2 text-[9px] text-teal font-sans">
                    分屏
                  </span>
                )}

                {/* 关闭单标签按钮 */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeInstance(inst.id);
                  }}
                  title="关闭终端"
                  className={cn(
                    "ml-1 rounded p-0.5 text-ash hover:bg-line-soft hover:text-rose-400 transition",
                    isActive ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover:opacity-80",
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        {/* 新建终端按钮与下拉菜单（独立在外，不受 overflow 裁剪限制） */}
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
              title="选择终端 Shell (PowerShell 7, WSL, CMD, Bash...)"
              className="flex items-center px-1 py-1 text-ash/80 hover:text-ink border-l border-line/30 transition"
            >
              <ChevronDown size={11} />
            </button>
          </div>

          {/* 下拉弹出菜单 */}
          {menuOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-50 min-w-[220px] rounded-panel border border-line bg-[#161a23] p-1.5 shadow-2xl backdrop-blur">
              <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase">
                新建系统终端
              </div>
              {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => handleCreateProfile(profile.id)}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
                >
                  <ShellIcon icon={profile.icon} />
                  <span className="flex-1 text-caption font-mono">{profile.name}</span>
                  {profile.id === defaultProfileId && (
                    <span className="text-[10px] text-teal/70 font-sans">默认</span>
                  )}
                </button>
              ))}

              <div className="my-1.5 h-px bg-line/50" />

              <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase">
                分屏操作
              </div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  splitWithNew();
                }}
                className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
              >
                <Columns2 size={13} className="text-teal" />
                <span className="text-caption font-mono">向右拆分终端 (Split)</span>
              </button>
            </div>
          )}
        </div>

        {/* 右侧：全局终端操作工具条 */}
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {/* 拆分终端按钮 */}
          <button
            type="button"
            onClick={handleToggleSplit}
            title={splitInstanceId ? "取消分屏" : "向右拆分终端 (Split Terminal)"}
            className={cn(
              "flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption transition",
              splitInstanceId
                ? "bg-teal-tint text-teal"
                : "text-ash hover:bg-line-soft hover:text-ink",
            )}
          >
            <Columns2 size={12} />
            <span className="hidden xl:inline">{splitInstanceId ? "合并分屏" : "拆分"}</span>
          </button>

          {/* 清屏 */}
          <button
            type="button"
            onClick={handleClear}
            title="清空终端屏幕 (Ctrl+L)"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Trash2 size={12} />
            <span className="hidden sm:inline">清屏</span>
          </button>

          {/* 重启当前终端会话 */}
          <button
            type="button"
            onClick={handleRestart}
            title="重启当前终端进程"
            className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-teal-tint hover:text-teal transition"
          >
            <RotateCw size={12} />
            <span className="hidden sm:inline">重启</span>
          </button>

          {/* 在系统文件资源管理器中打开工作目录 */}
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

      {/* 终端内容区：支持单窗格与分屏双窗格 */}
      {unit === undefined ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <p className="text-body-sm text-ash">
            终端需要一个工作目录才能启动。请在左侧侧边栏选择一个 Bot 或工作空间。
          </p>
        </div>
      ) : instances.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-body-sm text-ash">当前没有打开的终端实例。</p>
          <button
            onClick={handleNewDefault}
            className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-caption font-medium text-[#0f1115] hover:bg-teal-hover transition shadow"
          >
            <Plus size={13} />
            <span>新建 PowerShell 7 终端</span>
          </button>
        </div>
      ) : splitInstance ? (
        /* 分屏双窗格布局 */
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          {/* 左侧主窗格 */}
          <div className="relative min-w-0 flex-1 h-full overflow-hidden">
            {instances
              .filter((inst) => inst.id !== splitInstance.id)
              .map((inst) => (
                <TerminalInstanceView
                  key={inst.id}
                  ref={(r) => {
                    if (r) instanceRefs.current.set(inst.id, r);
                    else instanceRefs.current.delete(inst.id);
                  }}
                  terminalId={inst.id}
                  shell={inst.shell}
                  cwd={inst.cwd || unit.rootPath}
                  executorId={inst.executorId}
                  isActive={inst.id === activeInstanceId}
                />
              ))}
          </div>

          {/* 分屏垂直分割线 */}
          <div className="w-[1px] bg-line/60 hover:bg-teal/50 transition cursor-col-resize shrink-0" />

          {/* 右侧拆分窗格 */}
          <div className="relative min-w-0 flex-1 h-full overflow-hidden flex flex-col">
            <div className="flex h-6 shrink-0 items-center justify-between border-b border-line/30 bg-[#161a23] px-2 text-[11px] font-mono text-ash">
              <div className="flex items-center gap-1.5">
                <ShellIcon icon={splitInstance.icon} />
                <span>{splitInstance.title}</span>
              </div>
              <button
                type="button"
                onClick={() => setSplitInstance(null)}
                title="关闭拆分窗格"
                className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
              >
                <X size={11} />
              </button>
            </div>
            <div className="min-h-0 flex-1 relative overflow-hidden">
              <TerminalInstanceView
                key={splitInstance.id}
                ref={(r) => {
                  if (r) instanceRefs.current.set(splitInstance.id, r);
                  else instanceRefs.current.delete(splitInstance.id);
                }}
                terminalId={splitInstance.id}
                shell={splitInstance.shell}
                cwd={splitInstance.cwd || unit.rootPath}
                executorId={splitInstance.executorId}
                isActive={true}
              />
            </div>
          </div>
        </div>
      ) : (
        /* 单窗格布局：所有常驻实例渲染在同一容器内，隐藏实例设置 display: none，绝不杀掉后台 PTY */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          {instances.map((inst) => (
            <TerminalInstanceView
              key={inst.id}
              ref={(r) => {
                if (r) instanceRefs.current.set(inst.id, r);
                else instanceRefs.current.delete(inst.id);
              }}
              terminalId={inst.id}
              shell={inst.shell}
              cwd={inst.cwd || unit.rootPath}
              executorId={inst.executorId}
              isActive={inst.id === activeInstanceId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
