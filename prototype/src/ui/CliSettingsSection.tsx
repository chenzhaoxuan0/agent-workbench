/**
 * 设置页「命令行 (aw)」分区（2026-10-23）—— ai-native 操作面给人的入口。
 *
 * docs/21 的立场：GUI 能做的每件事都有 CLI 等价物，但这个事实此前只活在
 * docs/21 §6 的表里，界面上无一处可发现。本分区把「装在哪、怎么连、常用命令、
 * GUI×CLI 对照」摆到设置页，30 秒内让人知道 aw 的存在与用法。
 * 对照表是 docs/21 §6 的活投影——改那边记得同步这里（两处都是手工表）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

/** GUI 操作 × aw 命令对照（docs/21 §6 的精简投影） */
const QUICK_MAP: readonly { gui: string; cli: string; note?: string }[] = [
  { gui: "发起/续聊会话（带附件）", cli: `aw session chat --bot <id> --text "…" --attach p1,p2` },
  { gui: "会话列表 / 消息 / 取消", cli: "aw session list / messages / cancel" },
  { gui: "事件流跟随", cli: "aw events --session <sid> --follow" },
  { gui: "bot 增删改查", cli: "aw bot list / put / inspect / ask" },
  { gui: "待办（GTD）", cli: "aw backlog list / add / done" },
  { gui: "git 状态 / 提交", cli: "aw git status / commit --root <路径>" },
  { gui: "记忆检索 / MEMORY.md 读写", cli: "aw call memory.search --params '{…}'" },
  { gui: "通知事实源", cli: "aw call notifications.list --json" },
  { gui: "出图", cli: "aw call image.generate --params '{…}'" },
  { gui: "健康自检", cli: "aw doctor" },
  { gui: "全部 160+ 方法自描述", cli: "aw methods [--domain git]" },
];

function Code({ children }: { children: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(children).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="点击复制"
      className="group flex w-full items-center gap-2 text-left"
    >
      <code className="min-w-0 flex-1 truncate rounded-btn border border-line-soft bg-rail px-2 py-1.5 font-mono text-[11px] text-ink transition group-hover:border-teal/40">
        {children}
      </code>
      <span className={cn("shrink-0 text-[10px] transition", copied ? "text-teal" : "text-ash/0 group-hover:text-ash")}>
        {copied ? "已复制" : "复制"}
      </span>
    </button>
  );
}

export function CliSettingsSection(): ReactElement {
  const [endpoint, setEndpoint] = useState<string>("http://127.0.0.1:5281");
  useEffect(() => {
    setEndpoint(defaultDaemonEndpoint());
  }, []);

  return (
    <div className="space-y-4">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        工作台有一个零依赖的命令行客户端 <span className="font-mono text-ink">aw</span>（node≥22，
        独立包 <span className="font-mono">cli/</span>）：GUI 能做的每件事都有命令行等价物——
        让 agent 指挥工作台、写脚本批量操作、或在无 GUI 的服务器上驾驶它。每个 bot 工作区里
        也播种了同名技能（<span className="font-mono">.agents/skills/agent-workbench/</span>），
        bot 里的 agent 天然知道怎么用。
      </p>

      {/* 安装与连接 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line-soft px-4 pb-2 pt-3">
          <p className="text-body-sm font-medium text-ink">安装与连接</p>
        </div>
        <div className="space-y-2.5 px-4 py-3">
          <div>
            <p className="mb-1 text-caption text-ash">装到 PATH（仓库内链接，免发布）</p>
            <Code>pnpm -C cli link --global</Code>
          </div>
          <div>
            <p className="mb-1 text-caption text-ash">验证连通（daemon 正在跑时）</p>
            <Code>aw doctor</Code>
          </div>
          <p className="text-caption leading-relaxed text-ash">
            daemon 端点 <span className="font-mono text-graphite">{endpoint}</span>，
            凭证在 <span className="font-mono text-graphite">~/.agent-workbench/token</span>（aw 自动读取）；
            <span className="font-mono text-graphite">AGENT_WORKBENCH_URL / AGENT_WORKBENCH_TOKEN</span> 可覆盖。
            退出码：0 成功 / 2 用法错 / 3 RPC 错 / 4 传输错（daemon 不在或 401）。
          </p>
        </div>
      </div>

      {/* 常用命令 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line-soft px-4 pb-2 pt-3">
          <p className="text-body-sm font-medium text-ink">GUI 操作 × aw 命令对照</p>
          <p className="mt-0.5 text-caption text-ash">任何操作先查 <span className="font-mono">aw methods</span>——它永远比文档新（全表见 docs/21 §6）</p>
        </div>
        <ul className="divide-y divide-line-soft">
          {QUICK_MAP.map((r) => (
            <li key={r.cli} className="flex flex-col gap-1 px-4 py-2.5">
              <span className="text-caption text-graphite">{r.gui}</span>
              <Code>{r.cli}</Code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
