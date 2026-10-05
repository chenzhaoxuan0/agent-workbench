import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Wand2,
  X,
  Radio,
  type LucideIcon,
} from "lucide-react";
import { useWorkbench, selectVisibleModels, BOT_CONFLICT, type BotWriteGuards } from "../store/useWorkbench.ts";
import type { WorkUnit, BotChannel } from "../core/units.ts";
import { openFolder } from "../adapters/daemon/client.ts";
import { ChannelSection } from "./ChannelSection.tsx";
import { cn } from "./cn.ts";

/**
 * 新建 bot 对话框 —— 高度自定义的创建流程。
 *
 * 可定制面对齐 waku-agent 的四个正交旋钮（SOUL.md 人设 / 记忆三柱 /
 * 模型 / 技能），映射到本项目的数据模型：
 *
 * - **身份**：名称（决定头像色形）/ 一句话角色 / 工作目录 / 主执行器 + 默认模型
 * - **系统提示词**：persona 人设与语气（对应 waku 的 SOUL.md——运行时
 *   拼进 system prompt 的部分，与 AGENTS.md 岗位说明书刻意分开：
 *   「agent 的人设在 SOUL，规矩在 AGENTS.md」是 waku 的教学要点）
 * - **记忆接入**（可选开关）：语义事实 / 情节记忆 / 程序性技能
 *   （waku 的 semantic / episodic / procedural 三柱；真运行时据此接后端）
 * - **AGENTS.md**：岗位说明书本体（agents.md 开放约定的 markdown 段落）
 */

export interface BotMemoryPolicy {
  readonly semantic: boolean;
  readonly episodic: boolean;
  readonly procedural: boolean;
}

export interface AddBotDraft {
  readonly name: string;
  readonly role: string;
  readonly rootPath: string;
  readonly runtimeId: string;
  readonly modelHint: string | null;
  readonly persona: string;
  readonly memory: BotMemoryPolicy;
  readonly agentsMd: string;
  readonly channels: readonly BotChannel[];
}

type Section = "identity" | "persona" | "memory" | "agentsmd" | "channels";

const SECTIONS: readonly { id: Section; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "identity", label: "身份", icon: FileText, hint: "名称、角色、目录、执行器" },
  { id: "persona", label: "系统提示词", icon: Wand2, hint: "人设与语气（SOUL）" },
  { id: "memory", label: "记忆", icon: Brain, hint: "接入哪几类记忆" },
  { id: "agentsmd", label: "AGENTS.md", icon: FileText, hint: "岗位说明书本体" },
  { id: "channels", label: "渠道", icon: Radio, hint: "把 bot 接到 IM / webhook" },
];

const SECTION_LIBRARY: readonly { label: string; snippet: (name: string) => string }[] = [
  {
    label: "项目概览",
    snippet: (n) => `## 项目概览\n- ${n} 服务于：\n- 关键依赖与数据来源：\n`,
  },
  {
    label: "环境提示",
    snippet: () => `## 环境提示\n- 首选命令与参数：\n- 需要规避的操作：\n`,
  },
  {
    label: "代码风格",
    snippet: () => `## 代码风格\n- 语言与框架偏好：\n- 命名与注释约定：\n`,
  },
  {
    label: "测试说明",
    snippet: () => `## 测试说明\n- 交付前必须通过的检查：\n- 回归验证方式：\n`,
  },
  {
    label: "交付说明",
    snippet: () => `## 交付说明\n- 产物位置与命名：\n- 汇报格式：做了什么 / 产出在哪 / 下一步\n`,
  },
];

const PERSONA_TEMPLATE = (name: string, role: string) =>
  `你是「${name}」——${role || "一个领域专属助手"}。\n\n语气与风格：\n- 简洁、务实、不堆砌客套\n- 结论先行，细节按需展开\n\n原则：\n- 不确定先问，不要猜\n- 交付前自检一遍\n`;

function agentsMdTemplate(name: string, role: string, rootPath: string): string {
  return `# ${name}\n\n> ${role || "（一句话说清这个 bot 被设计用来做什么）"}\n\n## 这个 bot 负责什么\n- 边界：\n- 产出物：\n\n## 工作目录\n- 根目录：\`${rootPath}\`\n- 动手前先读目录里已有的文件，长期记忆与产出都落在这里\n\n## 工作方式\n- 接到任务先列 3 步以内的计划，再执行\n- 不确定的地方先提问，不要猜\n\n## 交付与验收\n- 每次交付一个可检查的产物（文件 / 清单 / 报告）\n- 完成后汇报：做了什么、产出在哪、下一步建议\n`;
}

export function AddBotDialog({
  open,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /**
   * 编辑模式：传入已有单元即预填、按「保存」提交；null / undefined 是新建。
   * 和新建共用一份表单状态 —— 两套表单迟早会长歪。
   */
  initial?: WorkUnit | null;
  onClose: () => void;
  /**
   * 提交。返回的 Promise 若以 code="conflict" 拒绝，表示「盘上已被改过，未写入」——
   * 对话据展示覆盖 / 重新加载 / 取消三选一。`opts.overwrite` 让调用方跳过乐观锁。
   */
  onSubmit: (draft: AddBotDraft, opts?: { overwrite?: boolean }) => void | Promise<void>;
}) {
  const runtimes = useWorkbench((s) => s.runtimes);
  const [section, setSection] = useState<Section>("identity");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [rootPath, setRootPath] = useState("C:/Users/chenziyu/project/Agent/bots/");
  const [agentsMd, setAgentsMd] = useState("");
  const [mdTouched, setMdTouched] = useState(false);
  const [persona, setPersona] = useState("");
  const [personaTouched, setPersonaTouched] = useState(false);
  const [memory, setMemory] = useState<BotMemoryPolicy>({ semantic: true, episodic: true, procedural: true });
  const [error, setError] = useState<string | null>(null);
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [modelHint, setModelHint] = useState<string | null>(null);
  /** 打开这一刻盘上的真值，保存时当乐观锁基线传回 daemon */
  const [baseGuards, setBaseGuards] = useState<BotWriteGuards>({});
  /** 盘上已被改过、未写入。等用户选：覆盖 / 重新加载 / 取消 */
  const [conflict, setConflict] = useState<{ reason: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [diskNote, setDiskNote] = useState<string | null>(null);
  /** AGENTS.md 落盘位置（编辑模式才有）。显示它，用户才知道去 VS Code 改哪个文件。 */
  const [agentsMdMeta, setAgentsMdMeta] = useState<WorkUnit["agentsMdMeta"]>(undefined);
  /** 渠道配置。空 = 纯工作台内 bot。改了跟着保存一起写穿 bot.json。 */
  const [channels, setChannels] = useState<readonly BotChannel[]>(initial?.channels ?? []);
  const [folderOpened, setFolderOpened] = useState(false);

  const isEdit = Boolean(initial);

  // selectVisibleModels 引用稳定（visibleModelsFor 按 runtimeId 分槽缓存），
  // 不能在此处 .map() 出新对象——那会回到 getSnapshot 无限循环的老坑
  const runtimeModelSpecs = useWorkbench(selectVisibleModels(runtimeId));

  /** 用一个单元定义填满整张表单（预填与「重新加载」共用，免得两处走偏） */
  const fillFrom = (b: WorkUnit) => {
    const binding = b.bindings.find((x) => x.primary) ?? b.bindings[0];
    setName(b.name);
    setRole(b.identity?.role ?? "");
    setRootPath(b.rootPath);
    setAgentsMd(b.agentsMd ?? "");
    setMdTouched(true);
    setPersona(b.identity?.persona ?? "");
    setPersonaTouched(true);
    setMemory(b.memory ?? { semantic: true, episodic: true, procedural: true });
    setRuntimeId(binding?.runtimeId ?? "");
    setModelHint(binding?.modelHint ?? null);
    setChannels(b.channels ?? []);
    setAgentsMdMeta(b.agentsMdMeta);
    setBaseGuards({
      ifRevision: b.revision,
      ifAgentsMdHash: b.agentsMdMeta?.hash ?? "",
    });
  };

  // 打开时重置 / 预填。编辑模式**不**把 mdTouched / personaTouched 置回 false：
  // 那两个 flag 的含义是「用户没亲手改过，可以跟着名称自动重生成」。
  // 编辑一个已经写好 AGENTS.md 的 bot 时，名字一改就把岗位说明书冲掉是不可接受的。
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflict(null);
    setDiskNote(null);
    setSection("identity");
    if (initial) {
      fillFrom(initial);
    } else {
      setName("");
      setRole("");
      setRootPath("C:/Users/chenziyu/project/Agent/bots/");
      setAgentsMd("");
      setMdTouched(false);
      setPersona("");
      setPersonaTouched(false);
      setMemory({ semantic: true, episodic: true, procedural: true });
      // activeRuntimeId 在没有 daemon 时是个残留的默认字符串（如 "zcode"），
      // 直接用它会让「默认模型」列出某个并不存在的执行器的模型，
      // 提交时还会写出一条指向幽灵执行器的绑定。没有可用执行器就置空。
      setRuntimeId(
        useWorkbench.getState().runtimes.length > 0 ? useWorkbench.getState().activeRuntimeId : "",
      );
      setModelHint(null);
      setChannels([]);
      setAgentsMdMeta(undefined);
      setBaseGuards({});
    }
  }, [open, initial]);

  // 名称 / 角色 → 模板自动同步，直到用户亲手编辑（AGENTS.md 与 persona 各自独立）。
  //
  // ⚠ 必须显式排除编辑模式。两个 effect 在**同一次 commit** 里跑：prefill 先
  // setAgentsMd(真实内容) + setMdTouched(true)，但本 effect 读到的是本次渲染
  // 闭包里的旧值（mdTouched 还是 false、name 还是 ""），于是 setAgentsMd(空模板)
  // 把 prefill 覆盖掉；下一轮 mdTouched 已是 true，本 effect 直接 return ——
  // 岗位说明书被冲成空模板，而且用户点「保存」会把这个空模板写回 bot.json。
  // 新建模式侥幸没事（初值本就是空模板），但同一个竞态，不该靠运气。
  useEffect(() => {
    if (!open || isEdit || mdTouched) return;
    setAgentsMd(agentsMdTemplate(name, role, rootPath));
  }, [open, isEdit, mdTouched, name, role, rootPath]);

  useEffect(() => {
    if (!open || isEdit || personaTouched) return;
    setPersona(PERSONA_TEMPLATE(name, role));
  }, [open, isEdit, personaTouched, name, role]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const draft = (): AddBotDraft => ({
    name: name.trim(),
    role: role.trim(),
    rootPath: rootPath.trim().replace(/\/+$/, ""),
    runtimeId,
    modelHint,
    persona: persona.trim(),
    memory,
    agentsMd,
    channels,
  });

  const submit = async (overwrite = false) => {
    if (saving) return;
    if (name.trim().length === 0) return setError("给 bot 起个名字");
    if (rootPath.trim().length === 0) return setError("工作目录不能为空");
    if (agentsMd.trim().length === 0) return setError("AGENTS.md 不能为空 —— 它就是这个 bot 的岗位说明书");
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draft(), overwrite ? { overwrite: true } : undefined);
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === BOT_CONFLICT) {
        // 盘上已被改过，daemon 没写。这里**不做任何重试**——让用户决定谁赢。
        const reason = String((err as { data?: { reason?: unknown } }).data?.reason ?? "");
        setConflict({ reason });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  /** 重拉盘上定义（用户在 VS Code 改完 AGENTS.md 后的那一下）。daemon 无缓存，每次重扫盘。 */
  const reloadFromDisk = async () => {
    if (initial === undefined || initial === null) return;
    try {
      const fresh = await useWorkbench.getState().reloadUnit(initial.id);
      if (fresh === null) {
        setDiskNote("盘上找不到这个 bot 的定义了（bot.json 可能被删了）");
        return;
      }
      fillFrom(fresh);
      setConflict(null);
      setError(null);
      setDiskNote(null);
    } catch (err: unknown) {
      setDiskNote(`重新加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!open) return null;

  const insertSection = (snippet: string) => {
    setMdTouched(true);
    setAgentsMd((md) => `${md.trimEnd()}\n\n${snippet}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "bot 设置" : "新建 bot"}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[620px] max-h-[92vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
      >
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <FileText size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">{isEdit ? "bot 设置" : "新建 bot"}</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 分区导航 */}
          <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-rail p-2">
            {SECTIONS.map(({ id, label, icon: Icon, hint }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                aria-current={section === id}
                className={cn(
                  "flex items-start gap-2 rounded-btn px-2 py-2 text-left",
                  section === id ? "bg-teal-tint" : "hover:bg-line-soft",
                )}
              >
                <Icon size={13} className={cn("mt-0.5 shrink-0", section === id ? "text-teal" : "text-ash")} />
                <span className="min-w-0">
                  <span className={cn("block truncate text-body-sm", section === id ? "font-medium text-ink" : "text-graphite")}>
                    {label}
                  </span>
                  <span className="block truncate text-caption text-ash">{hint}</span>
                </span>
              </button>
            ))}
          </nav>

          {/* 内容区 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {section === "identity" && (
              <div className="space-y-4">
                <Field label="名称" hint="名字决定头像的颜色与形状">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：竞品分析师"
                    className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
                <Field label="一句话角色" hint="做什么，一句话讲清">
                  <input
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="例如：每天跟踪竞品动态并产出对比简报"
                    className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
                <Field label="工作目录" hint="这个 bot 的根文件夹（AGENTS.md 与产出都放这里）">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={rootPath}
                      onChange={(e) => setRootPath(e.target.value)}
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        if (!rootPath.trim()) return;
                        try {
                          await openFolder({ path: rootPath.trim() });
                          setFolderOpened(true);
                          setTimeout(() => setFolderOpened(false), 2000);
                        } catch (err) {
                          console.error("[AddBotDialog] 打开文件夹失败:", err);
                        }
                      }}
                      disabled={!rootPath.trim()}
                      title="在文件资源管理器中打开"
                      className="flex shrink-0 items-center gap-1 rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink active:scale-95 transition disabled:opacity-40"
                    >
                      {folderOpened ? <Check size={12} className="text-gain" /> : <FolderOpen size={12} />}
                      <span>{folderOpened ? "已打开" : "打开"}</span>
                    </button>
                  </div>
                </Field>
                <Field label="默认执行器 (CLI)" hint="这个 bot 主要由哪家 CLI 执行">
                  {runtimes.length === 0 ? (
                    <div className="rounded-input bg-rail px-3 py-2.5">
                      <p className="text-body-sm text-graphite">暂无可用执行器</p>
                      <p className="mt-1 text-caption leading-relaxed text-ash">
                        本地 daemon 没有连上，所以执行器清单是空的。
                      </p>
                    </div>
                  ) : (
                    <select
                      value={runtimeId}
                      onChange={(e) => {
                        setRuntimeId(e.target.value);
                        setModelHint(null);
                      }}
                      className="w-full rounded-input border border-line bg-canvas px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
                    >
                      <option value="">未指定（由会话按需选择）</option>
                      {runtimes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.presentation.displayName} {r.testOnly ? "· 测试夹具" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="默认模型（可选）" hint="不指定则跟随该执行器的默认模型">
                  {runtimeId === "" ? (
                    <p className="text-caption text-ash">先选一个主执行器，这里才会列出它支持的模型清单。</p>
                  ) : (
                    <select
                      value={modelHint ?? ""}
                      onChange={(e) => setModelHint(e.target.value === "" ? null : e.target.value)}
                      className="w-full rounded-input border border-line bg-canvas px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
                    >
                      <option value="">自动（跟随执行器原生默认）</option>
                      {runtimeModelSpecs.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
            )}

            {section === "persona" && (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <Field
                  label="系统提示词 · 人设与语气"
                  hint="对应 waku 的 SOUL.md：运行时拼进 system prompt 的「你是谁、什么语气、什么原则」。与 AGENTS.md（岗位说明书）分开维护。"
                >
                  <span />
                </Field>
                <textarea
                  value={persona}
                  onChange={(e) => {
                    setPersonaTouched(true);
                    setPersona(e.target.value);
                  }}
                  spellCheck={false}
                  aria-label="系统提示词"
                  placeholder="留空则使用默认语气：简洁、务实、结论先行。"
                  className="min-h-0 flex-1 resize-none rounded-card border border-line bg-canvas p-3 font-mono text-caption leading-relaxed text-ink outline-none placeholder:text-ash focus:border-teal"
                />
                {!personaTouched && (
                  <button
                    onClick={() => {
                      setPersonaTouched(true);
                      setPersona(PERSONA_TEMPLATE(name, role));
                    }}
                    className="flex w-fit items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    <Wand2 size={10} />
                    按名称与角色生成人设
                  </button>
                )}
              </div>
            )}

            {section === "memory" && (
              <div className="space-y-2">
                <p className="text-caption leading-relaxed text-ash">
                  对齐 waku 的记忆三柱：选择这个 bot 接入哪几类记忆。
                  真实运行时据此接入对应后端；原型期仅作为声明保存。
                </p>
                <MemoryToggle
                  label="语义记忆 · 事实"
                  desc="关于人、项目、偏好的持久事实（“甲方喜欢简报不用长文”）"
                  checked={memory.semantic}
                  onChange={(v) => setMemory((m) => ({ ...m, semantic: v }))}
                />
                <MemoryToggle
                  label="情节记忆 · 事件"
                  desc="带日期的“发生过什么”（对话蒸馏出的一句话摘要）"
                  checked={memory.episodic}
                  onChange={(v) => setMemory((m) => ({ ...m, episodic: v }))}
                />
                <MemoryToggle
                  label="程序性记忆 · 技能"
                  desc="怎么做事的流程（SKILL.md，命中关键词时注入）"
                  checked={memory.procedural}
                  onChange={(v) => setMemory((m) => ({ ...m, procedural: v }))}
                />
              </div>
            )}

            {section === "agentsmd" && (
              <div className="flex h-full min-h-0 flex-col gap-2">
                {/* 落盘位置 + 重新加载：这是"文件夹即 bot"能不能被用户看见的关键一行。
                    不显示路径，用户就不知道该去 VS Code 改哪个文件。 */}
                <div className="flex shrink-0 items-center gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-caption text-ash">
                    <FileText size={11} className="shrink-0" />
                    <span className="shrink-0">AGENTS.md · 岗位说明书</span>
                    {isEdit && agentsMdMeta && (
                      <span
                        className="truncate font-mono text-[10px] text-ash/80"
                        title={`编辑这个文件 → 点右侧「重新加载」→ 内容同步进来\n${agentsMdMeta.path}`}
                      >
                        · {agentsMdMeta.path}
                      </span>
                    )}
                    {isEdit && !agentsMdMeta && (
                      <span className="text-[10px] text-loss">· 文件不存在，保存时会创建</span>
                    )}
                  </span>
                  {isEdit && (
                    <button
                      onClick={() => void reloadFromDisk()}
                      title="丢弃当前编辑内容，从磁盘重新读取"
                      className="ml-auto flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                    >
                      <RefreshCw size={10} />
                      重新加载
                    </button>
                  )}
                  <div className={cn("flex items-center gap-1", !isEdit && "ml-auto")}>
                    {SECTION_LIBRARY.map((s) => (
                      <button
                        key={s.label}
                        onClick={() => {
                          setMdTouched(true);
                          setAgentsMd((md) => `${md.trimEnd()}\n\n${s.snippet(name || "这个 bot")}`);
                        }}
                        title={`插入「${s.label}」段落`}
                        className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink"
                      >
                        <Plus size={9} />
                        {s.label}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setMdTouched(false);
                        setAgentsMd(agentsMdTemplate(name, role, rootPath));
                      }}
                      title="按名称与角色重新生成模板"
                      className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink"
                    >
                      <Wand2 size={9} />
                      重新生成
                    </button>
                  </div>
                </div>
                <textarea
                  value={agentsMd}
                  onChange={(e) => {
                    setMdTouched(true);
                    setAgentsMd(e.target.value);
                  }}
                  spellCheck={false}
                  aria-label="AGENTS.md 内容"
                  className="min-h-0 flex-1 resize-none rounded-card border border-line bg-canvas p-3 font-mono text-caption leading-relaxed text-ink outline-none focus:border-teal"
                />
              </div>
            )}

            {section === "channels" && (
              <ChannelSection
                botId={initial?.id ?? ""}
                channels={channels}
                onChange={setChannels}
                disabled={!isEdit}
              />
            )}
          </div>
        </div>

        {/* 底部 */}
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-line px-4 py-2">
          {conflict !== null ? (
            <>
              {/* 冲突态整条换掉提示语：此刻最重要的信息是"你没写进去"，不是"保存" */}
              <p className="min-w-0 flex-1 text-caption text-loss">
                磁盘上的 {conflict.reason === "agents_md" ? "AGENTS.md" : "bot.json"} 在你编辑期间被改过
                （多半是在 VS Code 里直接编辑了）。<span className="font-medium">这次没有写入。</span>
              </p>              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => void reloadFromDisk()}
                  className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-line-soft"
                >
                  重新加载
                </button>
                <button
                  onClick={() => void submit(true)}
                  className="rounded-btn px-3 py-1.5 text-body-sm text-loss hover:bg-loss/10"
                  title="用这里的版本覆盖磁盘上的改动"
                >
                  仍然覆盖
                </button>
                <button
                  onClick={() => setConflict(null)}
                  className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black"
                >
                  取消
                </button>
              </div>
            </>
          ) : (
            <>
              {error ? (
                <p className="text-caption text-loss">{error}</p>
              ) : diskNote !== null ? (
                <p className="text-caption text-loss">{diskNote}</p>
              ) : runtimes.length === 0 ? (
                <p className="text-caption text-ash">
                  未连接 daemon，这个 bot 会先以「无执行器」保存 —— 之后可在设置里补
                </p>
              ) : (
                <p className="text-caption text-ash">
                  {isEdit
                    ? "保存写穿到 bot.json 与工作目录下的 AGENTS.md"
                    : "创建后可随时在编辑器里改 AGENTS.md 与人设"}
                </p>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose} className="rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
                  取消
                </button>
                <button
                  onClick={() => void submit(false)}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black disabled:opacity-50"
                >
                  {isEdit ? <Check size={11} /> : <Plus size={11} />}
                  {saving ? "写入中…" : isEdit ? "保存" : "创建 bot"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryToggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={cn(
        "flex w-full items-center gap-3 rounded-card border px-3 py-2.5 text-left",
        checked ? "border-teal-edge bg-teal-tint/60" : "border-line hover:bg-line-soft",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body-sm font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-caption leading-relaxed text-ash">{desc}</span>
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-teal" : "bg-line",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left]",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-caption font-medium text-graphite">{label}</span>
      {children}
      {hint && <span className="block text-caption text-ash">{hint}</span>}
    </label>
  );
}
