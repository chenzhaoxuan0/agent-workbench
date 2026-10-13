import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  Bot,
  FolderGit2,
  History,
  Layers,
  Rocket,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, useShell } from "../store/useShell.ts";
import { fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { formatRelative } from "../core/automation.ts";
import { asUnitId } from "../core/units.ts";
import { cn } from "./cn.ts";

/**
 * 命令中心 —— 对齐 ZCode 的 CommandCenterDialog。
 *
 * ZCode 没有「搜索主视图」：侧栏的搜索按钮和 Cmd/Ctrl+K 打开的都是这个
 * 顶部居中浮层，内含作用域页签（全部/命令/会话/文件）+ 分组结果 + 键盘导航。
 * 本项目的搜索域没有文件索引，用 工作单元 / 自动化 补位，结构同构：
 *
 *   头部（圆角输入框）
 *   作用域页签行
 *   分组结果列表（↑↓ 移动 · Enter 打开 · Esc 关闭）
 */

type Scope = "all" | "commands" | "units" | "automations" | "sessions";

const SCOPES: readonly { id: Scope; label: string; icon: typeof Rocket }[] = [
  { id: "all", label: "全部", icon: Layers },
  { id: "commands", label: "命令", icon: Rocket },
  { id: "units", label: "Agent", icon: Bot },
  { id: "automations", label: "自动化", icon: AlarmClock },
  { id: "sessions", label: "会话", icon: History },
];

interface Item {
  readonly id: string;
  readonly scope: Exclude<Scope, "all">;
  readonly group: string;
  readonly icon: typeof Rocket;
  readonly label: string;
  readonly hint?: string;
  readonly meta?: string;
  readonly run: () => void;
}

export function CommandCenter() {
  const open = useShell((s) => s.commandOpen);
  const setOpen = useShell((s) => s.setCommandOpen);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useCommands();
  const units = useWorkbench((s) => s.units);
  const automations = useWorkbench((s) => s.automations);
  const hideFailedInDialog = useHistoryPrefs((s) => s.prefs.hideFailedInDialog);
  const [historyEntries, setHistoryEntries] = useState<readonly UnitHistoryEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchUnitHistory(undefined, 200)
      .then((res) => {
        if (alive) setHistoryEntries(res);
      })
      .catch((err: unknown) => {
        console.warn("[CommandCenter] fetchUnitHistory failed:", err);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 搜索域数据（命令 / 工作单元 / 自动化 / 跨 Bot 历史会话）
  const items = useMemo<readonly Item[]>(() => {
    const out: Item[] = commands.map((c) => ({
      id: c.id,
      scope: "commands",
      group: c.group,
      icon: c.icon ?? Rocket,
      label: c.label,
      hint: c.hint,
      run: c.run,
    }));

    for (const u of units) {
      out.push({
        id: `unit-${u.id}`,
        scope: "units",
        group: "Agent 智能体",
        icon: Bot,
        label: u.name,
        hint: u.identity?.role ? `${u.identity.role} · ${u.rootPath}` : u.rootPath,
        run: () => useWorkbench.getState().selectUnit(u.id),
      });
    }
    for (const a of automations) {
      out.push({
        id: `automation-${a.id}`,
        scope: "automations",
        group: "自动化",
        icon: AlarmClock,
        label: a.name,
        hint: a.description,
        run: () => useShell.getState().setMainView("automations"),
      });
    }
    for (const h of historyEntries) {
      if (hideFailedInDialog && h.status === "failed") continue;
      const uName = h.unitName || units.find((u) => u.id === h.unitId)?.name || "Agent";
      const uId = h.unitId || "";
      const statusLabel =
        h.status === "done"
          ? "完成"
          : h.status === "failed"
            ? "失败"
            : h.status === "running"
              ? "运行中"
              : h.status;
      out.push({
        id: `history-${h.key}`,
        scope: "sessions",
        group: "历史会话",
        icon: History,
        label: h.title,
        hint: `${uName} · ${h.runtimeId} · ${statusLabel} · ${formatRelative(h.startedAt)}`,
        meta: h.launchMode === "terminal" ? "TUI" : "后台",
        run: () => {
          if (uId) {
            useWorkbench.getState().selectUnit(asUnitId(uId));
            useShell.getState().openHistoryModal({
              unitId: uId,
              unitName: uName,
              focusKey: h.key,
            });
          }
        },
      });
    }
    return out;
  }, [commands, units, automations, historyEntries, hideFailedInDialog]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (text: string) => text.toLowerCase().includes(needle);
    return items.filter(
      (it) =>
        (scope === "all" || it.scope === scope) &&
        (needle === "" || hit(it.label) || hit(it.hint ?? "") || hit(it.group)),
    );
  }, [items, q, scope]);

  useEffect(() => {
    if (open) {
      setQ("");
      setScope("all");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [q, scope]);

  // 保持游标可见
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, filtered.length]);

  if (!open) return null;

  const move = (delta: number) => setCursor((c) => Math.max(0, Math.min(filtered.length - 1, c + delta)));
  const runItem = (it: Item | undefined) => {
    if (!it) return;
    it.run();
    setOpen(false);
  };

  const groups = [...new Set(filtered.map((it) => it.group))];
  let rowIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-xs pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="搜索"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            runItem(filtered[cursor]);
          }
        }}
        className="w-[640px] max-w-[92vw] overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        {/* 头部：ZCode 的圆角输入框 */}
        <div className="border-b border-line px-2 pb-2 pt-2">
          <div className="flex h-8 items-center gap-2 rounded-chip border border-line bg-rail px-3">
            <Search size={14} className="shrink-0 text-ash" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索命令、会话、工作单元、自动化…"
              aria-label="搜索"
              className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-graphite"
            />
            <button
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="shrink-0 rounded-btn p-0.5 text-ash hover:bg-line-soft hover:text-ink"
            >
              <X size={12} />
            </button>
          </div>

          {/* 作用域页签（ZCode 的 CommandCenterScopeButton） */}
          <div className="mt-1.5 flex gap-1">
            {SCOPES.map(({ id, label, icon: Icon }) => {
              const active = scope === id;
              return (
                <button
                  key={id}
                  onClick={() => setScope(id)}
                  aria-pressed={active}
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-chip border px-2 text-caption",
                    active
                      ? "border-teal-edge bg-teal-tint font-medium text-ink"
                      : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  <Icon size={12} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 分组结果列表 */}
        <div ref={listRef} className="max-h-[380px] overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-body-sm text-ash">没有匹配的结果</p>
          )}

          {groups.map((g) => (
            <div key={g}>
              <p className="px-4 pb-1 pt-1.5 text-caption text-ash">{g}</p>
              {filtered
                .filter((it) => it.group === g)
                .map((it) => {
                  rowIndex += 1;
                  const i = rowIndex;
                  const selected = i === cursor;
                  const Icon = it.icon;
                  return (
                    <button
                      key={it.id}
                      role="option"
                      aria-selected={selected}
                      onClick={() => runItem(it)}
                      onMouseEnter={() => setCursor(i)}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-4 py-2 text-left",
                        selected ? "bg-teal-tint" : "hover:bg-line-soft",
                      )}
                    >
                      <Icon size={12} className="shrink-0 text-graphite" />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-body-sm", selected ? "text-ink" : "text-ink")}>
                          {it.label}
                        </span>
                        {it.hint && (
                          <span className="block truncate text-caption text-ash">{it.hint}</span>
                        )}
                      </span>
                      {it.meta && <span className="tnum shrink-0 text-caption text-ash">{it.meta}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line-soft px-4 py-1.5 text-caption text-ash">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">{filtered.length} 条结果</span>
        </div>
      </div>
    </div>
  );
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: typeof Rocket;
  run: () => void;
}

function useCommands(): readonly Command[] {
  // 只订阅业务侧的必要字段；shell 走 getState()，避免无 selector 的全量订阅
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);

  return useMemo(() => {
    const shell = () => useShell.getState();
    const out: Command[] = [];

    out.push(
      {
        id: "view-chat",
        label: "切到主对话",
        hint: "Personal Agent 对话流",
        group: "视图",
        run: () => shell().setMainView("chat"),
      },
      {
        id: "view-image",
        label: "切到出图工作台",
        hint: "AI 图像生成与实验",
        group: "视图",
        run: () => shell().setMainView("image"),
      },
      {
        id: "open-automations",
        label: "打开自动化",
        hint: "定时任务与后台流",
        group: "视图",
        run: () => shell().setMainView("automations"),
      },
    );

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
        hint: "⌘B",
        group: "布局",
        run: () => shell().toggleSidebar(),
      },
      {
        id: "new-agent",
        label: "新建 Agent",
        hint: "从 AGENTS.md 岗位说明书开始",
        group: "Agent",
        run: () => shell().openAddBot(),
      },
      {
        id: "import-agent",
        label: "认领已有目录为 Agent",
        hint: "本地文件夹挂载，侦测 AGENTS.md",
        group: "Agent",
        run: () => shell().openImportBot(),
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
          icon: Settings2,
          run: () => useShell.getState().openSettings(s.id),
        });
      }
    }

    return out;
  }, [units, runtimes]);
}
