import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { cn } from "./cn.ts";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/**
 * 命令中心 —— 对应 ZCode 的 command-center / TaskFindDialog。
 *
 * ZCode 那边是可搜索的命令面板，这里先落「动作类」命令。
 * 任务查找（TaskFind）下一步接，现在先把 shell 级开关收进来。
 */
export function CommandCenter() {
  const open = useShell((s) => s.commandOpen);
  const setOpen = useShell((s) => s.setCommandOpen);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useCommands();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        (c.hint ?? "").toLowerCase().includes(needle) ||
        c.group.toLowerCase().includes(needle),
    );
  }, [commands, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      // 等一帧，确保 input 已挂载
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const groups = [...new Set(filtered.map((c) => c.group))];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-32"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={14} className="shrink-0 text-ash" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="搜索命令…"
            aria-label="搜索命令"
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-graphite"
          />
          <button
            onClick={() => setOpen(false)}
            aria-label="关闭"
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>

        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-body-sm text-ash">没有匹配的命令</p>
          )}

          {groups.map((g) => (
            <div key={g}>
              <p className="px-4 py-1.5 text-caption text-ash">{g}</p>
              {filtered
                .filter((c) => c.group === g)
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      c.run();
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-line-soft"
                  >
                    <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{c.label}</span>
                    {c.hint && (
                      <span className="shrink-0 font-mono text-caption text-ash">{c.hint}</span>
                    )}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function useCommands(): readonly Command[] {
  // 只订阅业务侧的必要字段；shell 走 getState()，避免无 selector 的全量订阅
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);

  return useMemo(() => {
    const wb = useWorkbench.getState();
    const shell = () => useShell.getState();
    const out: Command[] = [];

    out.push(
      {
        id: "view-employee",
        label: "切到员工视图",
        hint: "人 · 状态 · 日程",
        group: "视图",
        run: () => wb.setView("employee"),
      },
      {
        id: "view-project",
        label: "切到项目视图",
        hint: "看板 · diff · PR",
        group: "视图",
        run: () => wb.setView("project"),
      },
    );

    for (const u of units) {
      out.push({
        id: `unit-${u.id}`,
        label: `打开工作单元 · ${u.name}`,
        hint: u.rootPath,
        group: "工作单元",
        run: () => useWorkbench.getState().selectUnit(u.id),
      });
    }

    for (const r of runtimes) {
      const caps = Object.values(r.capabilities);
      out.push({
        id: `runtime-${r.id}`,
        label: `切换执行器 · ${r.presentation.displayName}`,
        hint: `${caps.filter(Boolean).length}/${caps.length} 能力`,
        group: "执行器",
        run: () => useWorkbench.getState().selectRuntime(r.id),
      });
    }

    out.push(
      {
        id: "toggle-sidebar",
        label: shell().sidebarCollapsed ? "展开侧栏" : "收起侧栏",
        group: "布局",
        run: () => shell().toggleSidebar(),
      },
      {
        id: "toggle-terminal",
        label: shell().terminalOpen ? "关闭终端" : "打开终端",
        hint: "⌘`",
        group: "布局",
        run: () => shell().toggleTerminal(),
      },
      {
        id: "toggle-sidepane",
        label: useSidePane.getState().open ? "收起右侧面板" : "展开右侧面板",
        group: "布局",
        run: () => useSidePane.getState().setOpen(!useSidePane.getState().open),
      },
      {
        id: "sidepane-overview",
        label: "面板总览与搜索",
        hint: "切换右侧标签",
        group: "布局",
        run: () => useSidePane.getState().setOpen(true),
      },
    );

    // 设置分区：按分组列出，对齐 ZCode 的设置导航
    for (const g of SETTINGS_GROUPS) {
      for (const s of SETTINGS_SECTIONS.filter((x) => x.groupId === g.id)) {
        out.push({
          id: `settings-${s.id}`,
          label: `设置 · ${s.title}`,
          hint: s.desc,
          group: "设置",
          run: () => useShell.getState().openSettings(s.id),
        });
      }
    }

    return out;
  }, [units, runtimes]);
}
