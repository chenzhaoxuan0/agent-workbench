/**
 * 导入已有文件夹（docs/09 §七）——bot 区从「创建器」升级为「manager」的那一步。
 *
 * ## 概念
 *
 * **导入 = 注册，不是移动。** 这是「文件即数据库」的自然延伸：
 *
 *   新建 = 建文件夹 + 写 AGENTS.md + 注册；**导入 = 只注册。**
 *
 * 文件夹留在原地，git 历史不动，工作台只是把它登记进管理面。导入完成后 daemon
 * 立刻拿到完整定义，IM / webhook / cron 全部即时激活。
 *
 * ## 三分支
 *
 * 走哪一支由 `bot.inspect` 的探测结果决定（§七.3）：
 *
 *   重新连接  已有 bot.json → 展示既有定义，零写入
 *   认领      有 AGENTS.md、无 bot.json → 主路径，预填后落盘
 *   脚手架    两者皆无 → 问用户要不要补模板，**不替老文件夹做决定**
 *
 * ## 安全
 *
 * bot.json 里会有渠道密钥，而老文件夹大概率是 git 仓库。一 push 就泄漏。
 * 所以 git + 密钥这一项在落盘前是硬提示，不是设置里的一条说明（§七.5）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FolderOpen,
  Loader2,
  ShieldAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useWorkbench, selectVisibleModels } from "../store/useWorkbench.ts";
import {
  asModelId,
  asRuntimeId,
  asUnitId,
  type WorkUnit,
} from "../core/units.ts";
import {
  ensureBotGitignore,
  inspectBotFolder,
  type BotInspectReport,
} from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/** 探测结果决定走哪一支 */
type Branch = "reconnect" | "claim" | "scaffold" | "blocked";

function branchOf(r: BotInspectReport | null): Branch {
  if (r === null) return "blocked";
  if (!r.exists) return "blocked";
  if (r.conflicts.alreadyRegistered !== null) return "blocked";
  if (r.hasBotJson) return "reconnect";
  if (r.hasAgentsMd) return "claim";
  return "scaffold";
}

const BRANCH_META: Record<Branch, { title: string; sub: string }> = {
  reconnect: { title: "重新连接", sub: "这个文件夹已经是一个 bot 了，直接接回来" },
  claim: { title: "认领", sub: "文件夹留在原地不动，只把它登记进管理面" },
  scaffold: { title: "脚手架", sub: "这个文件夹里既没有 AGENTS.md 也没有 bot.json" },
  blocked: { title: "无法导入", sub: "" },
};

export interface ImportBotResult {
  unit: WorkUnit;
  /** reconnect 分支不写盘，只并入前端 state */
  noWrite: boolean;
}

export function ImportBotDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (r: ImportBotResult) => void;
}) {
  const runtimes = useWorkbench((s) => s.runtimes);
  const addUnit = useWorkbench((s) => s.addUnit);

  const [pathInput, setPathInput] = useState("");
  const [report, setReport] = useState<BotInspectReport | null>(null);
  const [existing, setExisting] = useState<WorkUnit | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 认领/脚手架分支的表单
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [modelHint, setModelHint] = useState<string | null>(null);
  const [scaffoldWriteMd, setScaffoldWriteMd] = useState(true);
  const [gitignoreFixed, setGitignoreFixed] = useState(false);

  const modelSpecs = useWorkbench(selectVisibleModels(runtimeId));
  const branch = branchOf(report);

  useEffect(() => {
    if (!open) return;
    setPathInput("");
    setReport(null);
    setExisting(null);
    setProbing(false);
    setBusy(false);
    setError(null);
    setName("");
    setRole("");
    setModelHint(null);
    setScaffoldWriteMd(true);
    setGitignoreFixed(false);
    setRuntimeId(useWorkbench.getState().runtimes.length > 0 ? useWorkbench.getState().activeRuntimeId : "");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const probe = useCallback(async () => {
    const target = pathInput.trim();
    if (target === "") return setError("填一个文件夹路径");
    setProbing(true);
    setError(null);
    try {
      const { report: r, existing: ex } = await inspectBotFolder(target);
      setReport(r);
      setExisting(ex);
      setGitignoreFixed(false);
      // 预填：AGENTS.md 派生 > 既有定义 > 文件夹名（bot.json > AGENTS.md > 文件夹名，§七.2）
      if (r.hasBotJson && ex !== null) {
        setName(ex.name);
        setRole(ex.identity?.role ?? "");
      } else {
        setName(r.derived?.name || folderNameOf(r.rootPath));
        setRole(r.derived?.role ?? "");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setProbing(false);
    }
  }, [pathInput]);

  const fixGitignore = async (): Promise<void> => {
    if (report === null) return;
    try {
      const { changed } = await ensureBotGitignore(report.rootPath);
      setGitignoreFixed(true);
      // 重探一次，让安全结论跟着 .gitignore 一起更新
      const { report: r, existing: ex } = await inspectBotFolder(report.rootPath);
      setReport(r);
      setExisting(ex);
      if (!changed) setError("`.agent-workbench/` 已经在 .gitignore 里了");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (): Promise<void> => {
    if (report === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (branch === "reconnect" && existing !== null) {
        // 零写入：文件夹原地不动，只并进管理面
        onImported({ unit: existing, noWrite: true });
        onClose();
        return;
      }
      if (report.conflicts.alreadyRegistered !== null) {
        setError(`这个目录已经被「${report.conflicts.alreadyRegistered.name}」占用了`);
        return;
      }
      const unit: WorkUnit = {
        id: asUnitId(report.suggestedId === "" ? `bot-${Date.now().toString(36)}` : report.suggestedId),
        rootPath: report.rootPath,
        name: name.trim() === "" ? folderNameOf(report.rootPath) : name.trim(),
        kind: "bot",
        identity: {
          role: role.trim(),
          persona: undefined,
          sourcePath: "AGENTS.md",
          loadedAt: Date.now(),
        },
        bindings: runtimeId
          ? [
              {
                runtimeId: asRuntimeId(runtimeId),
                modelHint: modelHint ? asModelId(modelHint) : undefined,
                primary: true,
              },
            ]
          : [],
        assets: {
          agentFiles: [
            ...(report.assets.skillFiles.length > 0 ? [report.assets.skillFiles[0]!] : []),
            ...(report.assets.memoryFile === null ? [] : [report.assets.memoryFile]),
            ...report.assets.extraAgentFiles,
          ],
          skillDirs: [...report.assets.skillDirs],
        },
        // 脚手架分支且用户勾了「补模板」时才让 daemon 落一份 AGENTS.md
        agentsMd: branch === "scaffold" ? (scaffoldWriteMd ? "# 未命名\n\n（还没写岗位说明书）\n" : undefined) : undefined,
        memory: { semantic: true, episodic: true, procedural: true },
        tags: ["导入"],
        lastActiveAt: Date.now(),
      };
      await addUnit(unit);
      onImported({ unit, noWrite: false });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const meta = BRANCH_META[branch];
  const blockedReason = useMemo(() => {
    if (report === null) return null;
    if (!report.exists) return "目录不存在";
    if (report.conflicts.alreadyRegistered !== null)
      return `这个目录已经是「${report.conflicts.alreadyRegistered.name}」的工作目录了`;
    return null;
  }, [report]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="添加已有文件夹"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
      >
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          {report !== null && (
            <button
              onClick={() => setReport(null)}
              aria-label="返回"
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <FolderOpen size={13} className="text-ash" />
          <h2 className="text-body font-medium text-ink">添加已有文件夹</h2>
          <button onClick={onClose} aria-label="关闭" className="ml-auto rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* ---- 步骤一：填路径 ---- */}
          {report === null ? (
            <div className="space-y-3">
              <p className="text-body-sm text-graphite">
                导入是**注册**，不是搬家。文件夹留在原地、git 历史不动，工作台只是把它登记进管理面。
              </p>
              <label className="block space-y-1">
                <span className="block text-caption font-medium text-graphite">文件夹路径</span>
                <input
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void probe()}
                  placeholder="D:/work/old-repo"
                  spellCheck={false}
                  aria-label="文件夹路径"
                  className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                />
                <span className="block text-caption text-ash">Electron 阶段这里会换成原生目录选择器</span>
              </label>
              {error !== null && <p className="text-caption text-loss">{error}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {/* 分支头 */}
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded-btn px-1.5 py-0.5 text-caption",
                    branch === "blocked" ? "bg-loss/10 text-loss" : "bg-teal-tint text-teal",
                  )}
                >
                  {meta.title}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-mono text-caption text-graphite" title={report.rootPath}>
                    {report.rootPath}
                  </p>
                  {meta.sub !== "" && <p className="text-caption text-ash">{meta.sub}</p>}
                </div>
              </div>

              {/* 阻断 */}
              {branch === "blocked" && (
                <Notice tone="loss" icon={X}>
                  {blockedReason ?? "这个目录不能导入"}
                </Notice>
              )}

              {/* 安全：git + 密钥 */}
              {report.security.applicable && !report.security.safe && !gitignoreFixed && (
                <Notice tone="loss" icon={ShieldAlert}>
                  <p>{report.security.message}</p>
                  <button
                    onClick={() => void fixGitignore()}
                    className="mt-1.5 flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-ink hover:bg-line-soft"
                  >
                    <ShieldAlert size={10} />
                    把 `.agent-workbench/` 加进 .gitignore
                  </button>
                </Notice>
              )}
              {report.security.applicable && (report.security.safe || gitignoreFixed) && (
                <Notice tone="ok" icon={Check}>
                  {gitignoreFixed ? "`.agent-workbench/` 已加入 .gitignore，密钥不会被提交" : report.security.message}
                </Notice>
              )}

              {/* 扫描根副作用 */}
              {report.scanRootEffect.warning !== null && (
                <Notice tone="warn" icon={AlertTriangle}>
                  {report.scanRootEffect.warning}
                </Notice>
              )}

              {/* 嵌套 */}
              {report.conflicts.nestedInside !== null && (
                <Notice tone="warn" icon={AlertTriangle}>
                  这个文件夹在另一个 bot「{report.conflicts.nestedInside.unitId}」的工作目录内部。两个都会注册，但
                  扫描时容易混淆。
                </Notice>
              )}

              {/* 重新连接：展示既有定义，零写入 */}
              {branch === "reconnect" && existing !== null && (
                <div className="rounded-card border border-line bg-rail/40 p-3">
                  <p className="text-caption font-medium text-ink">{existing.name}</p>
                  <p className="mt-0.5 text-caption text-ash">
                    {existing.identity?.role || "（没有角色描述）"} ·{" "}
                    {existing.bindings.find((b) => b.primary)?.runtimeId ?? "无执行器"}
                  </p>
                  <p className="mt-2 text-caption text-ash">
                    这次不写任何东西，只是把它接回管理面。适合换浏览器、换机器后重新纳管。
                  </p>
                </div>
              )}

              {/* 认领 / 脚手架：表单 */}
              {(branch === "claim" || branch === "scaffold") && (
                <div className="space-y-3">
                  {branch === "scaffold" && (
                    <label className="flex items-start gap-2 rounded-card border border-line p-2.5">
                      <input
                        type="checkbox"
                        checked={scaffoldWriteMd}
                        onChange={(e) => setScaffoldWriteMd(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span className="text-caption text-graphite">
                        按模板补一份 AGENTS.md 再注册
                        <span className="mt-0.5 block text-ash">
                          不勾也可以注册，只是这个 bot 暂时没有岗位说明书。
                        </span>
                      </span>
                    </label>
                  )}

                  <Field label="名称" hint={report.derived === null ? "文件夹里没有 AGENTS.md，名称取自文件夹名" : "从 AGENTS.md 的标题派生"}>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      aria-label="名称"
                      className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-caption text-ink outline-none focus:border-teal"
                    />
                  </Field>

                  <Field label="一句话角色" hint="从 AGENTS.md 的引言派生，可以改">
                    <input
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      aria-label="一句话角色"
                      className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-caption text-ink outline-none focus:border-teal"
                    />
                  </Field>

                  <Field label="主执行器" hint="导入后可以随时改">
                    <select
                      value={runtimeId}
                      onChange={(e) => {
                        setRuntimeId(e.target.value);
                        setModelHint(null);
                      }}
                      aria-label="主执行器"
                      className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-caption text-ink outline-none focus:border-teal"
                    >
                      <option value="">不指定</option>
                      {runtimes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.presentation?.displayName ?? r.id}
                        </option>
                      ))}
                    </select>
                  </Field>

                  {runtimeId !== "" && modelSpecs.length > 0 && (
                    <Field label="默认模型" hint="不选就用执行器默认">
                      <select
                        value={modelHint ?? ""}
                        onChange={(e) => setModelHint(e.target.value === "" ? null : e.target.value)}
                        aria-label="默认模型"
                        className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-caption text-ink outline-none focus:border-teal"
                      >
                        <option value="">自动</option>
                        {modelSpecs.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}

                  <AssetList report={report} />
                </div>
              )}

              {error !== null && <p className="text-caption text-loss">{error}</p>}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-line px-4 py-2">
          {report === null ? (
            <>
              <p className="text-caption text-ash">探测是只读的，一个字节都不会写</p>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose} className="rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
                  取消
                </button>
                <button
                  onClick={() => void probe()}
                  disabled={probing}
                  className="flex items-center gap-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black disabled:opacity-50"
                >
                  {probing ? <Loader2 size={11} className="animate-spin" /> : <FolderOpen size={11} />}
                  {probing ? "探测中…" : "探测"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-caption text-ash">
                {branch === "reconnect" ? "零写入，只是接回管理面" : "导入只写 .agent-workbench/，不动你的既有文件"}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose} className="rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
                  取消
                </button>
                <button
                  onClick={() => void submit()}
                  disabled={busy || branch === "blocked" || (report.security.applicable && !report.security.safe && !gitignoreFixed)}
                  title={
                    report.security.applicable && !report.security.safe && !gitignoreFixed
                      ? "先把 .agent-workbench/ 加进 .gitignore"
                      : undefined
                  }
                  className="flex items-center gap-1 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:bg-black disabled:opacity-50"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  {busy ? "注册中…" : branch === "reconnect" ? "接回管理面" : "认领这个文件夹"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 让人看见「导入后会继承什么」——docs/09 §七.2 资产盘点 */
function AssetList({ report }: { report: BotInspectReport }) {
  const items: string[] = [];
  if (report.assets.memoryFile !== null) items.push(report.assets.memoryFile);
  if (report.assets.hasSoul) items.push("人设文件（SOUL/PERSONA）");
  if (report.assets.skillFiles.length > 0) items.push(`${report.assets.skillFiles.join("、")}`);
  if (report.assets.skillDirs.length > 0) items.push(`技能目录：${report.assets.skillDirs.join("、")}`);
  if (report.assets.hasAutomations) items.push("已有自动化");
  if (report.assets.extraAgentFiles.length > 0) items.push(report.assets.extraAgentFiles.join("、"));
  if (items.length === 0) return null;
  return (
    <div className="rounded-card border border-line bg-rail/40 p-2.5">
      <p className="text-caption text-ash">这个文件夹里已有的、会被继承的东西</p>
      <p className="mt-1 font-mono text-[11px] leading-relaxed text-graphite">{items.join(" · ")}</p>
    </div>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "loss" | "warn" | "ok";
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-card border p-2.5",
        tone === "loss" && "border-loss/30 bg-loss/5",
        tone === "warn" && "border-line bg-rail/60",
        tone === "ok" && "border-teal-edge bg-teal-tint/40",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", tone === "loss" ? "text-loss" : tone === "ok" ? "text-teal" : "text-graphite")}>
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1 text-caption text-graphite">{children}</div>
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

function folderNameOf(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "未命名";
}
