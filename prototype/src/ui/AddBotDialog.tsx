import { useEffect, useMemo, useState } from "react";
import { FileText, Plus, Wand2, X } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 新建 bot 对话框 —— 高度自定义的创建流程，核心是 AGENTS.md：
 * 「这个 bot 被设计用来做什么」的岗位说明书（agents.md 开放标准的
 * markdown 约定：职责 / 环境提示 / 工作方式 / 交付与验收 等段落）。
 *
 * 布局：左侧表单（名称 / 一句话角色 / 工作目录 / 主执行器），
 * 右侧 AGENTS.md 编辑器。名称与角色在**用户未手动编辑**说明书前
 * 会自动同步进模板（touched 标记，一旦动过就不再覆盖）；工具条提供
 * agents.md 规范段落的插入按钮与一键重新生成。
 */

export interface AddBotDraft {
  readonly name: string;
  readonly role: string;
  readonly rootPath: string;
  readonly runtimeId: string;
  readonly agentsMd: string;
}

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

function agentsMdTemplate(name: string, role: string, rootPath: string): string {
  return `# ${name}\n\n> ${role || "（一句话说清这个 bot 被设计用来做什么）"}\n\n## 这个 bot 负责什么\n- 边界：\n- 产出物：\n\n## 工作目录\n- 根目录：\`${rootPath}\`\n- 动手前先读目录里已有的文件，长期记忆与产出都落在这里\n\n## 工作方式\n- 接到任务先列 3 步以内的计划，再执行\n- 不确定的地方先提问，不要猜\n\n## 交付与验收\n- 每次交付一个可检查的产物（文件 / 清单 / 报告）\n- 完成后汇报：做了什么、产出在哪、下一步建议\n`;
}

export function AddBotDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (draft: AddBotDraft) => void;
}) {
  const runtimes = useWorkbench((s) => s.runtimes);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [rootPath, setRootPath] = useState("C:/Users/chenziyu/project/Agent/bots/");
  const [agentsMd, setAgentsMd] = useState("");
  const [mdTouched, setMdTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeId, setRuntimeId] = useState<string>("zcode");

  // 名称 / 角色 → 模板自动同步，直到用户亲手编辑说明书
  useEffect(() => {
    if (!open || mdTouched) return;
    setAgentsMd(agentsMdTemplate(name, role, rootPath));
  }, [open, mdTouched, name, role, rootPath]);

  useEffect(() => {
    if (open) {
      setName("");
      setRole("");
      setRootPath("C:/Users/chenziyu/project/Agent/bots/");
      setAgentsMd("");
      setMdTouched(false);
      setError(null);
      setRuntimeId(useWorkbench.getState().activeRuntimeId);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const runtimeOptions = useMemo(
    () => runtimes.map((r) => ({ id: r.id, label: r.presentation.displayName, ok: r.state.status !== "not_installed" })),
    [runtimes],
  );  const create = () => {
    if (name.trim().length === 0) return setError("给 bot 起个名字");
    if (rootPath.trim().length === 0) return setError("工作目录不能为空");
    if (agentsMd.trim().length === 0) return setError("AGENTS.md 不能为空 —— 它就是这个 bot 的岗位说明书");
    onCreate({
      name: name.trim(),
      role: role.trim(),
      rootPath: rootPath.trim().replace(/\/+$/, ""),
      runtimeId,
      agentsMd: agentsMd,
    });
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
        aria-label="新建 bot"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[600px] max-h-[92vh] w-[880px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
      >
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <FileText size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">新建 bot</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        {/* 双栏：左表单 / 右 AGENTS.md */}
        <div className="flex min-h-0 flex-1">
          <div className="w-[320px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
            <Field label="名称" hint="名字决定头像的颜色与形状">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：竞品分析师"
                autoFocus
                className="w-full rounded-input bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal border border-transparent"
              />
            </Field>
            <Field label="一句话角色" hint="做什么，一句话讲清">
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="例如：每天跟踪竞品动态并产出对比简报"
                className="w-full rounded-input bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal border border-transparent"
              />
            </Field>
            <Field label="工作目录" hint="这个 bot 的根文件夹（AGENTS.md 与产出都放这里）">
              <input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                spellCheck={false}
                className="w-full rounded-input bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal border border-transparent"
              />
            </Field>
            <Field label="主执行器" hint="这条绑定是默认模型的 hint">
              <div className="flex flex-wrap gap-1">
                {runtimeOptions.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => !r.ok && undefined}
                    disabled={!r.ok}
                    title={r.ok ? r.label : "未安装，不可选"}
                    aria-pressed={runtimeId === r.id}
                    className={cn(
                      "rounded-btn border px-2 py-1 text-caption",
                      runtimeId === r.id
                        ? "border-teal-edge bg-teal-tint font-medium text-ink"
                        : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                      !r.ok && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </Field>
            <p className="text-caption leading-relaxed text-ash">
              AGENTS.md 是 agent 圈的开放约定：给 agent 看的 README。
              它就是这个 bot 的岗位说明书——被设计来做什么、怎么工作、怎么交付。
            </p>
          </div>

          <div className="flex min-w-0 flex-1 flex-col border-l border-line">
            <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
              <span className="flex items-center gap-1 text-caption text-ash">
                <FileText size={11} />
                AGENTS.md
              </span>
              <div className="ml-auto flex items-center gap-1">
                {SECTION_LIBRARY.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => insertSection(s.snippet(name || "这个 bot"))}
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
              className="min-h-0 flex-1 resize-none bg-canvas p-3 font-mono text-caption leading-relaxed text-ink outline-none"
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line px-4">
          {error ? <p className="text-caption text-loss">{error}</p> : <p className="text-caption text-ash">创建后可随时在编辑器里改 AGENTS.md</p>}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
              取消
            </button>
            <button
              onClick={create}
              className="flex items-center gap-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black"
            >
              <Plus size={11} />
              创建 bot
            </button>
          </div>
        </div>
      </div>
    </div>
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
