import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useMemoryPanel, injectedCount, type SkillEntry, type StewardSearchHit } from "../store/useMemoryPanel.ts";
import { useMemorySettings, WARN_RATIO } from "../store/useMemoryPrefs.ts";
import { cn } from "./cn.ts";

/**
 * 记忆三柱面板（docs/10 §五 WP-8）—— 对话区里 composer 上方的一个「记忆」区块，三行。
 *
 *   技能       常亮     已装载 N 个              展开看清单
 *   记忆       常亮     已注入 N 条 · 2,100/2,200 字符（百分比）   展开看**本轮注入了什么**
 *   会话搜索   默认灰   —                        点开 = 搜索框 + 结果列表
 *
 * 三条纪律在这个组件里都有对应的落点：
 * 1. **「本轮注入了什么」必须看得见**（§五 末段）—— 展开记忆行就是注入块原文 +
 *    每段来源的字符数 + 用户原话。记忆有没有起作用、什么时候串了项目，只靠它判断。
 * 2. **搜到 ≠ 注入**（§八 6）—— 检索结果只出现在这一屏，绝不写回任何 prompt。
 *    面板不碰注入路径，它只读。
 * 3. **每条搜索结果必带归属**（§4.6）—— 哪个 CLI · 哪个项目 · 什么时候 · 片段。
 *    `project === null`（mcode 会话没有 cwd）显示「未标注项目」，**不丢这条结果**。
 *
 * 降级：daemon 没起时三行各自显示「—」，头部给一句原因，界面不崩。
 */

type RowId = "skills" | "memory" | "search";

export function MemoryPanel() {
  const sessionId = useWorkbench((s) => s.activeSessionId);
  const unit = useWorkbench(selectActiveUnit);
  const rootPath = unit?.rootPath ?? null;

  const loading = useMemoryPanel((s) => s.loading);
  const error = useMemoryPanel((s) => s.error);
  const memory = useMemoryPanel((s) => s.memory);
  const dispatches = useMemoryPanel((s) => s.dispatches);
  const skills = useMemoryPanel((s) => s.skills);
  const load = useMemoryPanel((s) => s.load);
  const sessionSearchOn = useMemoryPanel((s) => s.sessionSearchOn);
  const setSessionSearchOn = useMemoryPanel((s) => s.setSessionSearchOn);

  const [open, setOpen] = useState<RowId | null>(null);

  useEffect(() => {
    void load({ sessionId, rootPath });
  }, [load, sessionId, rootPath]);

  // 切会话 / 换 bot 就撤掉上一轮的检索结果：陈旧的命中比没有更容易误导
  useEffect(() => {
    useMemoryPanel.getState().clearSearch();
  }, [sessionId, rootPath]);

  const toggle = (id: RowId): void => setOpen((cur) => (cur === id ? null : id));

  // 「已注入 N 条」= 分发日志里注入来源的条目数；分母取后端的 limit（前端那个数
  // 只是提醒阈值，见 useMemoryPrefs 的说明）
  const injected = injectedCount(dispatches);
  const used = memory?.chars ?? null;
  const limit = memory?.limit ?? null;
  const ratio = used !== null && limit !== null && limit > 0 ? used / limit : null;
  const warnRatio = useMemorySettings((s) => s.prefs.memoryCharLimit);

  const memoryValue =
    used === null || limit === null
      ? "—"
      : `已注入 ${injected} 条 · ${used.toLocaleString("zh-CN")}/${limit.toLocaleString("zh-CN")} 字符${ratio === null ? "" : `（${Math.round(ratio * 100)}%）`}`;

  return (
    <div className="shrink-0 border-t border-line bg-rail">
      <div className="mx-auto max-w-[900px] px-8 py-2">
        <div className="flex items-center gap-2 pb-1.5">
          <span className="text-caption font-medium text-graphite">记忆</span>
          {error !== null && <span className="truncate text-caption text-ash">未连接 · {error}</span>}
          {error === null && loading && <span className="text-caption text-ash">读取中…</span>}
        </div>

        <ul className="divide-y divide-line-soft rounded-input border border-line bg-canvas">
          {/* 技能 —— procedural 柱：<rootPath>/skills/，不检索直接进 prompt */}
          <li>
            <RowButton
              open={open === "skills"}
              onClick={() => toggle("skills")}
              label="技能"
              dot
              value={error !== null && skills.length === 0 ? "—" : `已装载 ${skills.length} 个`}
            />
            {open === "skills" && (
              <div className="border-t border-line-soft px-3 py-2">
                {skills.length === 0 ? (
                  <p className="text-caption text-ash">
                    没有识别到技能资产。daemon 认的是根级 SKILL.md 与 skills / .claude/skills 这几个目录。
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {skills.map((s) => (
                      <SkillLine key={`${s.kind}:${s.name}`} skill={s} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>

          {/* 记忆 —— semantic 柱：MEMORY.md，2200 字符封顶，恒注入 */}
          <li>
            <RowButton
              open={open === "memory"}
              onClick={() => toggle("memory")}
              label="记忆"
              dot
              value={memoryValue}
            />
            {open === "memory" && (
              <div className="border-t border-line-soft px-3 py-2">
                {ratio !== null && ratio >= WARN_RATIO && (
                  <p className="pb-1.5 text-caption text-graphite">
                    用量已过 {Math.round(WARN_RATIO * 100)}%：下次写入前先整合相近条目（提醒阈值 {warnRatio.toLocaleString("zh-CN")} 字符）。
                  </p>
                )}
                {dispatches.length === 0 ? (
                  <p className="text-caption text-ash">
                    本会话没有注入记录。注入只在会话开始那一次发生（冻结快照，续聊不重复注入）；
                    项目没有记忆、或 MEMORY.md 还只有模板占位时也不注入。
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {dispatches.map((d) => (
                      <li key={d.id} className="border-t border-line-soft pt-2 first:border-t-0 first:pt-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-caption text-ash">
                          <span className="tnum">{fmtTime(d.createdAt)}</span>
                          <span>· {d.runtimeId}</span>
                          <span className="tnum">· 注入 {d.injectedChars.toLocaleString("zh-CN")} 字符</span>
                        </div>
                        {d.parts.length > 0 && (
                          <ul className="mt-1 flex flex-wrap gap-1">
                            {d.parts.map((p, i) => (
                              <li
                                key={`${d.id}:${i}`}
                                title={p.sourcePath}
                                className="rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite"
                              >
                                {p.scope} <span className="tnum text-ash">{p.chars}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-btn bg-rail p-2 font-mono text-caption leading-relaxed text-graphite">
                          {d.injectedBlock.trim() === "" ? "（本轮没有注入内容）" : d.injectedBlock}
                        </pre>
                        <p className="mt-1.5 text-caption text-ash">
                          <span className="text-graphite">用户原话</span>：{d.userText.trim() === "" ? "（空）" : d.userText}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>

          {/* 会话搜索 —— episodic 柱：CLI 原生会话文件，默认关 */}
          <li>
            <RowButton
              open={open === "search"}
              onClick={() => {
                // 关着时点这一行 = 把它打开（规格：点开 = 搜索框 + 结果列表）
                if (!sessionSearchOn) setSessionSearchOn(true);
                toggle("search");
              }}
              label="会话搜索"
              dot={sessionSearchOn}
              value={sessionSearchOn ? "已开启" : "默认关"}
            />
            {open === "search" && (
              <SearchArea botId={unit?.id ?? null} on={sessionSearchOn} setOn={setSessionSearchOn} />
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 行 */

function RowButton({
  open,
  onClick,
  label,
  value,
  dot,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
  value: string;
  dot: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover"
    >
      <ChevronRight size={11} className={cn("shrink-0 text-ash transition", open && "rotate-90")} />
      {/* 常亮 / 默认灰：灰点就是「这根柱子现在是关的」，一眼可辨 */}
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot ? "bg-teal" : "bg-line")} />
      <span className="w-16 shrink-0 text-caption text-graphite">{label}</span>
      <span className="tnum min-w-0 flex-1 truncate text-caption text-ink">{value}</span>
    </button>
  );
}

function SkillLine({ skill }: { skill: SkillEntry }) {
  return (
    <li className="flex items-center gap-1.5 text-caption">
      <span className="truncate text-ink">{skill.name}</span>
      <span className="shrink-0 text-ash">{skill.kind === "dir" ? "目录" : "文件"}</span>
    </li>
  );
}

/* ------------------------------------------------------------- 检索 */

function SearchArea({ botId, on, setOn }: { botId: string | null; on: boolean; setOn: (v: boolean) => void }) {
  const query = useMemoryPanel((s) => s.query);
  const setQuery = useMemoryPanel((s) => s.setQuery);
  const searching = useMemoryPanel((s) => s.searching);
  const searchError = useMemoryPanel((s) => s.searchError);
  const result = useMemoryPanel((s) => s.result);
  const runSearch = useMemoryPanel((s) => s.runSearch);

  if (!on) {
    return (
      <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
        <p className="text-caption text-ash">关着。开启后每次检索都要你亲手点，且结果只出现在这一屏。</p>
        <button onClick={() => setOn(true)} className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-surface-hover hover:text-ink">
          开启
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-line-soft px-3 py-2">
      <div className="flex items-center gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && botId !== null) void runSearch({ botId, query });
          }}
          placeholder="搜你自己以前说过的话（支持 2 字中文）"
          aria-label="会话搜索"
          className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
        />
        <button
          onClick={() => {
            if (botId !== null) void runSearch({ botId, query });
          }}
          disabled={searching || botId === null || query.trim() === ""}
          className="shrink-0 rounded-btn bg-ink px-2.5 py-1.5 text-caption text-canvas disabled:opacity-40"
        >
          {searching ? "扫描中…" : "搜索"}
        </button>
        <button
          onClick={() => setOn(false)}
          className="shrink-0 rounded-btn border border-line px-2 py-1.5 text-caption text-graphite hover:bg-surface-hover hover:text-ink"
        >
          关
        </button>
      </div>

      {botId === null && <p className="pt-1.5 text-caption text-ash">先选一个 bot —— 检索要带着它的身份去问，权限钉在 bot 上。</p>}

      {searchError !== null && (
        <p className="pt-1.5 text-caption leading-relaxed text-loss">
          {searchError}
          {searchError.includes("跨项目检索") && "（在「设置 › 记忆 › 跨项目检索」里给这个 bot 打开，或改问管家 bot）"}
        </p>
      )}

      {result !== null && (
        <>
          <p className="pt-1.5 text-caption text-ash">
            命中 {result.hits.length} 条 · 扫了 {result.scannedBlocks.toLocaleString("zh-CN")} 块 ·{" "}
            <span className="tnum">{result.elapsedMs}</span> ms
            {result.scoped && " · 范围已按路径收窄"}
            {Object.entries(result.byCli).map(([cli, n]) => ` · ${cli} ${n}`)}
          </p>
          {result.hits.length === 0 ? (
            <p className="pt-1.5 text-caption text-ash">没有命中。关键词检索的天花板就在这儿：同义词（工作台 / agent-workbench）匹配不到。</p>
          ) : (
            <ul className="mt-1 divide-y divide-line-soft">
              {result.hits.map((h, i) => (
                <HitLine key={`${h.srcPath}:${h.lineNo}:${i}`} hit={h} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function HitLine({ hit }: { hit: StewardSearchHit }) {
  return (
    <li className="py-2">
      {/* 归属四件套：哪个 CLI · 哪个项目 · 什么时候 · 哪一行 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">{hit.cli}</span>
        <span
          title={hit.project ?? "源会话里没有 cwd，反解不出来"}
          className={cn("rounded-chip bg-line-soft px-1.5 py-0.5 text-caption", hit.project === null ? "text-ash" : "text-graphite")}
        >
          {hit.project === null ? "未标注项目" : baseName(hit.project)}
        </span>
        <span className="tnum text-caption text-ash">{fmtTime(hit.at)}</span>
        <span className="tnum text-caption text-ash">第 {hit.lineNo} 行</span>
        <button
          onClick={() => openInEditor(hit.srcPath, hit.lineNo)}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-btn border border-line px-1.5 py-0.5 text-caption text-graphite hover:bg-surface-hover hover:text-ink"
        >
          在原文件打开
          <ExternalLink size={9} />
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-caption leading-relaxed text-ink">{hit.text}</p>
      {hit.context.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-caption text-ash">前后文</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded-btn bg-rail p-2 font-mono text-caption leading-relaxed text-graphite">
            {hit.context.join("\n")}
          </pre>
        </details>
      )}
      {/* 深链要编辑器接，没接住时这条路径就是唯一的退路，所以一直摆着 */}
      <p className="mt-1 truncate font-mono text-caption text-ash">{hit.srcPath}</p>
    </li>
  );
}

/* ------------------------------------------------------------- 小工具 */

function fmtTime(v: string | number): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== "");
  return parts[parts.length - 1] ?? p;
}

/** 深链到编辑器：vscode://file/<绝对路径>:<行号>（斜杠化，Windows 盘符保留） */
function editorUri(srcPath: string, lineNo: number): string {
  return encodeURI(`vscode://file/${srcPath.replace(/\\/g, "/")}:${lineNo}`);
}

function openInEditor(srcPath: string, lineNo: number): void {
  try {
    window.open(editorUri(srcPath, lineNo), "_blank", "noopener");
  } catch {
    /* 浏览器拦了外部协议 —— 上面那行原路径可复制，交给用户自己开 */
  }
}
