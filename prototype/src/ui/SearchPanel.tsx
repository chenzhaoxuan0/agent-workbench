import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlarmClock,
  ChevronRight,
  FolderOpen,
  Search,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";
import { describeSchedule } from "../core/automation.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

type Scope = "all" | "sessions" | "automations" | "units" | "commands";

const SCOPES: readonly { id: Scope; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "sessions", label: "会话" },
  { id: "automations", label: "自动化" },
  { id: "units", label: "工作单元" },
  { id: "commands", label: "命令" },
];

interface Hit {
  readonly id: string;
  readonly kind: Scope;
  readonly title: string;
  readonly sub: string;
  readonly run: () => void;
}

/**
 * 统一搜索 —— 合并 ZCode 分散的几处 find：
 * TaskFindDialog（找任务）/ 会话内查找 / 文件查找 / 命令面板搜索 / 设置搜索。
 *
 * 保留 ZCode 的两个习惯：
 * - **按 scope 分组**，不是混成一条流；用户能预判结果来自哪
 * - **空结果要说明是"没匹配"还是"当前 scope 无内容"**
 */
export function SearchPanel() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const setMainView = useShell((s) => s.setMainView);

  const sessions = useWorkbench(useShallow((s) => s.sessions));
  const units = useWorkbench((s) => s.units);
  const automations = useWorkbench((s) => s.automations);
  const selectUnit = useWorkbench((s) => s.selectUnit);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 命令列表：setter 是稳定引用，用 getState 拿最新值
  const commands = useMemo(
    () => [
      {
        id: "new-task",
        label: "新建任务",
        group: "动作",
        run: () => {
          useShell.getState().setMainView("chat");
          useWorkbench.getState().setDraft("");
        },
      },
      { id: "open-automations", label: "打开自动化", group: "跳转", run: () => useShell.getState().setMainView("automations") },
      { id: "open-settings", label: "打开设置", group: "跳转", run: () => useShell.getState().openSettings("general") },
      { id: "open-runtimes", label: "打开执行器设置", group: "跳转", run: () => useShell.getState().openSettings("runtimes") },
      { id: "toggle-terminal", label: "切换终端面板", group: "动作", run: () => useShell.getState().toggleTerminal() },
      { id: "toggle-sidebar", label: "切换侧栏", group: "动作", run: () => useShell.getState().toggleSidebar() },
    ],
    [],
  );

  const hits = useMemo<readonly Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Hit[] = [];
    const match = (...parts: (string | undefined)[]) =>
      !needle || parts.some((p) => (p ?? "").toLowerCase().includes(needle));
    const inScope = (k: Scope) => scope === "all" || scope === k;

    if (inScope("sessions")) {
      for (const s of sessions) {
        if (!match(s.title, s.runtimeId)) continue;
        const u = units.find((x) => x.id === s.unitId);
        out.push({
          id: `s-${s.id}`,
          kind: "sessions",
          title: s.title,
          sub: `${u?.name ?? "—"} · ${s.runtimeId}`,
          run: () => {
            selectUnit(s.unitId);
            setMainView("chat");
          },
        });
      }
    }

    if (inScope("automations")) {
      for (const a of automations) {
        if (!match(a.name, a.description, a.runtimeId)) continue;
        const u = units.find((x) => x.id === a.unitId);
        out.push({
          id: `a-${a.id}`,
          kind: "automations",
          title: a.name,
          sub: `${describeSchedule(a)} · ${u?.name ?? "—"} · ${a.enabled ? "启用" : "暂停"}`,
          run: () => setMainView("automations"),
        });
      }
    }

    if (inScope("units")) {
      for (const u of units) {
        if (!match(u.name, u.rootPath, ...u.tags)) continue;
        out.push({
          id: `u-${u.id}`,
          kind: "units",
          title: u.name,
          sub: u.rootPath,
          run: () => {
            selectUnit(u.id);
            setMainView("chat");
          },
        });
      }
    }

    if (inScope("commands")) {
      for (const c of commands) {
        if (!match(c.label, c.group)) continue;
        out.push({ id: `c-${c.id}`, kind: "commands", title: c.label, sub: c.group, run: c.run });
      }
    }

    return out;
  }, [q, scope, sessions, automations, units, commands, selectUnit, setMainView]);

  useEffect(() => {
    setCursor(0);
  }, [q, scope]);

  const go = (h: Hit | undefined) => {
    if (!h) return;
    h.run();
    setMainView("chat");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[cursor]);
    } else if (e.key === "Escape") {
      setMainView("chat");
    }
  };

  const grouped = useMemo(() => {
    const m = new Map<Scope, Hit[]>();
    for (const h of hits) {
      const arr = m.get(h.kind) ?? [];
      arr.push(h);
      m.set(h.kind, arr);
    }
    return [...m.entries()];
  }, [hits]);

  const emptyBecauseScope =
    q.trim().length > 0 && hits.length === 0 && SCOPES.some((s) => s.id === scope);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pb-12 pt-10">
        <div className="rounded-card border border-line bg-card px-4 py-3 focus-within:border-teal focus-within:shadow-[0_0_0_3px_rgb(1_106_113/0.12)]">
          <div className="flex items-center gap-2.5">
            <Search size={15} className="shrink-0 text-ash" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="搜索会话、自动化、工作单元、命令…"
              aria-label="搜索"
              className="min-w-0 flex-1 bg-transparent text-body-lg text-ink outline-none placeholder:text-graphite"
            />
            <button
              onClick={() => setMainView("chat")}
              aria-label="关闭搜索"
              className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                aria-pressed={scope === s.id}
                className={cn(
                  "rounded-chip px-2.5 py-1 text-caption",
                  scope === s.id
                    ? "bg-teal font-medium text-canvas"
                    : "text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <p className="px-1 pb-2 pt-4 text-caption text-ash">
          {hits.length > 0
            ? `${hits.length} 条结果 · ↑↓ 选择 · Enter 打开 · Esc 返回`
            : "↑↓ 选择 · Enter 打开 · Esc 返回"}
        </p>

        {hits.length === 0 ? (
          <p className="rounded-card border border-line bg-card px-4 py-8 text-center text-body-sm text-graphite">
            {emptyBecauseScope
              ? `「${SCOPES.find((s) => s.id === scope)?.label}」下没有匹配「${q.trim()}」的内容`
              : q.trim()
                ? `没有匹配「${q.trim()}」的内容`
                : "输入关键词开始搜索"}
          </p>
        ) : (
          grouped.map(([kind, list]) => (
            <section key={kind} className="mb-3">
              <p className="px-1 pb-1.5 text-caption text-ash">
                {SCOPES.find((s) => s.id === kind)?.label} · {list.length}
              </p>
              {list.map((h) => {
                const idx = hits.indexOf(h);
                const active = idx === cursor;
                return (
                  <button
                    key={h.id}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => go(h)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-btn px-3 py-2 text-left",
                      active ? "bg-teal-tint" : "hover:bg-line-soft",
                    )}
                  >
                    <span className="shrink-0 text-ash">
                      {KIND_ICON[h.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-body-sm",
                          active ? "font-medium text-ink" : "text-graphite",
                        )}
                      >
                        {h.title}
                      </span>
                      <span className="block truncate font-mono text-caption text-ash">{h.sub}</span>
                    </span>
                    {active && <ChevronRight size={12} className="shrink-0 text-teal" />}
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const KIND_ICON: Record<Scope, React.ReactNode> = {
  all: <Search size={13} />,
  sessions: <SquarePen size={13} />,
  automations: <AlarmClock size={13} />,
  units: <FolderOpen size={13} />,
  commands: <Terminal size={13} />,
};
