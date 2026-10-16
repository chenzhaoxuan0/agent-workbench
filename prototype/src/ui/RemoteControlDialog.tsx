import { useEffect, useState, useId } from "react";
import QRCode from "qrcode";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  HelpCircle,
  MessageCircle,
  QrCode,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Terminal,
  X,
} from "lucide-react";
import {
  fetchNetworkInterfaces,
  getChannelStatusRpc,
  type ChannelStatusResult,
  type NetworkInterfaceInfo,
} from "../adapters/daemon/client.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

export function RemoteControlDialog({ onClose }: { onClose: () => void }) {
  const dialogTitleId = useId();
  const [tab, setTab] = useState<"lan" | "im">("lan");
  const [interfaces, setInterfaces] = useState<readonly NetworkInterfaceInfo[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [channelStatus, setChannelStatus] = useState<ChannelStatusResult | null>(null);

  const activeUnit = useWorkbench(selectActiveUnit);
  const openUnitSettings = useShell((s) => s.openUnitSettings);

  // 1. 加载网卡与渠道状态
  const refreshData = async () => {
    setLoading(true);
    try {
      const [nets, chan] = await Promise.all([
        fetchNetworkInterfaces(),
        getChannelStatusRpc().catch(() => null),
      ]);
      setInterfaces(nets);
      if (chan) setChannelStatus(chan);

      // 默认选中推荐网卡（LAN 或 Tailscale，优先级最高排最前）
      const best = nets.find((n) => n.family === "IPv4" && n.type !== "loopback") || nets[0];
      if (best) setSelectedIp(best.address);
    } catch (err) {
      console.warn("[RemoteControlDialog] refresh failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshData();
  }, []);

  // 2. 构造移动端直连 URL 并生成二维码
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("agent-workbench:daemon-token") || ""
      : "";
  const port =
    typeof window !== "undefined" && window.location.port
      ? window.location.port
      : "3000";

  const mobileUrl = selectedIp
    ? `http://${selectedIp}:${port}${token ? `?token=${encodeURIComponent(token)}` : ""}`
    : "";

  useEffect(() => {
    if (!mobileUrl) return;
    QRCode.toDataURL(mobileUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: "#141517",
        light: "#ffffff",
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error("QR Code error:", err));
  }, [mobileUrl]);

  const handleCopy = () => {
    if (!mobileUrl) return;
    void navigator.clipboard.writeText(mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line/80 bg-canvas text-ink shadow-2xl">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between border-b border-line/60 bg-rail/60 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal/15 text-teal shadow-xs">
              <Smartphone size={20} />
            </div>
            <div>
              <h2 id={dialogTitleId} className="text-body font-semibold tracking-tight text-ink">
                移动端远控中心
              </h2>
              <p className="text-caption text-graphite">
                双轨聚合：局域网手机 Web 触控控制台 + 离场 IM 渠道实时互动
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭弹窗"
            className="rounded-btn p-1.5 text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {/* 选项卡切换 */}
        <div className="flex border-b border-line/60 bg-card/40 px-6">
          <button
            onClick={() => setTab("lan")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-body-sm font-medium transition",
              tab === "lan"
                ? "border-teal text-teal"
                : "border-transparent text-graphite hover:text-ink",
            )}
          >
            <QrCode size={16} />
            <span>近场扫码直连 (局域网 Web)</span>
          </button>
          <button
            onClick={() => setTab("im")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-body-sm font-medium transition",
              tab === "im"
                ? "border-teal text-teal"
                : "border-transparent text-graphite hover:text-ink",
            )}
          >
            <Radio size={16} />
            <span>离场 IM 渠道状态 (微信/飞书/TG/Discord)</span>
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === "lan" ? (
            <div className="space-y-6">
              {/* 网卡选择器 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="network-select" className="text-body-sm font-medium text-ink">
                    选择本机网络接口
                  </label>
                  <button
                    onClick={() => void refreshData()}
                    className="flex items-center gap-1 text-caption text-ash hover:text-teal"
                  >
                    <RefreshCw size={12} className={cn(loading && "animate-spin")} />
                    <span>刷新接口</span>
                  </button>
                </div>
                <select
                  id="network-select"
                  aria-label="选择本机网络接口"
                  value={selectedIp}
                  onChange={(e) => setSelectedIp(e.target.value)}
                  className="w-full rounded-lg border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none transition focus:border-teal"
                >
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                      {iface.address} ({iface.name} ·{" "}
                      {iface.type === "lan"
                        ? "局域网推荐"
                        : iface.type === "tailscale"
                          ? "Tailscale/VPN"
                          : iface.type === "loopback"
                            ? "本机回环"
                            : iface.type}
                      )
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-ash">
                  确保手机与电脑连入同一 Wi-Fi，或使用 Tailscale 跨网访问。
                </p>
              </div>

              {/* 二维码与链接展示 */}
              <div className="grid grid-cols-1 items-center gap-6 rounded-2xl border border-line/70 bg-rail/30 p-5 md:grid-cols-2">
                {/* 二维码 */}
                <div className="flex flex-col items-center justify-center gap-2">
                  <div className="relative flex aspect-square w-48 items-center justify-center overflow-hidden rounded-xl border border-line/80 bg-white p-3 shadow-md">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="手机扫码直连二维码"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-ash">
                        <RefreshCw size={24} className="animate-spin" />
                        <span className="text-caption">生成二维码中...</span>
                      </div>
                    )}
                  </div>
                  <span className="text-[12px] font-medium text-graphite">
                    手机相机或浏览器直接扫码
                  </span>
                </div>

                {/* 链接与一键复制 */}
                <div className="flex flex-col justify-center space-y-3">
                  <div>
                    <span className="block text-caption font-medium text-graphite">直连地址</span>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        readOnly
                        aria-label="直连地址"
                        value={mobileUrl}
                        className="w-full truncate rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-ink select-all focus:outline-none"
                      />
                      <button
                        onClick={handleCopy}
                        aria-label="复制直连地址"
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line/80 bg-line-soft px-3 py-2 text-caption font-medium text-ink transition hover:bg-teal hover:text-white"
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        <span>{copied ? "已复制" : "复制"}</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 rounded-xl bg-teal-tint/50 p-3 text-caption text-graphite border border-teal/20">
                    <div className="flex items-center gap-1.5 font-medium text-teal">
                      <ShieldCheck size={14} />
                      <span>无缝免输密钥配对</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      二维码中已内嵌临时配对令牌，手机扫码后自动静默鉴权并持久化存储，无需反复输入。
                    </p>
                  </div>
                </div>
              </div>

              {/* 移动端专属革新特性 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <Smartphone size={16} className="mt-0.5 shrink-0 text-teal" />
                  <div>
                    <h3 className="text-caption font-semibold text-ink">抗软键盘畸变</h3>
                    <p className="text-[11px] text-ash">
                      基于 100dvh 与弹性底抽屉，打字不遮挡消息流
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-teal" />
                  <div>
                    <h3 className="text-caption font-semibold text-ink">手势触控审批</h3>
                    <p className="text-[11px] text-ash">
                      工具调用拦截门底部卡片呈现，支持大触控按钮快捷决策
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <Terminal size={16} className="mt-0.5 shrink-0 text-teal" />
                  <div>
                    <h3 className="text-caption font-semibold text-ink">虚拟按键终端</h3>
                    <p className="text-[11px] text-ash">
                      辅助终端包含 Esc / Tab / Ctrl-C 等快捷按键行
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* IM 渠道状态选项卡 */
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-body-sm font-semibold text-ink">离场 IM 渠道守护状态</h3>
                  <p className="text-caption text-graphite">
                    即使离开电脑或不在局域网，四大 IM 机器人也可接收指令并实时推送审批按钮。
                  </p>
                </div>
                {activeUnit && (
                  <button
                    onClick={() => {
                      onClose();
                      openUnitSettings(activeUnit.id);
                    }}
                    className="flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-caption font-medium text-white shadow-xs transition hover:bg-teal-hover"
                  >
                    <span>配置渠道</span>
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {/* 微信 */}
                <ChannelCard
                  name="微信 (WeChat)"
                  desc="官方 iLink Bot 协议 · 微信扫码即连 · 极速安全免封号"
                  icon={MessageCircle}
                  status={channelStatus?.gateways["weixin"]}
                  interactive={true}
                />

                {/* 飞书 */}
                <ChannelCard
                  name="飞书 (Feishu)"
                  desc="官方 WebSocket 长连接 · 自动回复 · 表情状态透传"
                  icon={Send}
                  status={channelStatus?.gateways["feishu"]}
                  interactive={true}
                />

                {/* Telegram */}
                <ChannelCard
                  name="Telegram"
                  desc="长轮询 · 内联键盘按钮实时审批 · 指令直控"
                  icon={Globe}
                  status={channelStatus?.gateways["telegram"]}
                  interactive={true}
                />

                {/* Discord */}
                <ChannelCard
                  name="Discord"
                  desc="Gateway v10 · 组件交互按钮实时审批 · 频道/群聊响应"
                  icon={Radio}
                  status={channelStatus?.gateways["discord"]}
                  interactive={true}
                />
              </div>

              <div className="rounded-xl border border-line/60 bg-rail/40 p-4 text-caption leading-relaxed text-graphite">
                <div className="flex items-center gap-1.5 font-medium text-ink">
                  <HelpCircle size={14} className="text-teal" />
                  <span>首响仲裁与多端协同机制</span>
                </div>
                <p className="mt-1 text-[11px] text-ash">
                  当 Agent 遇到危险操作触发确认门时，局域网手机 Web、桌面端与所有已配置的 IM 渠道将同步收到审批请求。任何一端点击批准或拒绝后，系统立即实行首响仲裁，其余所有设备与 Bot 消息中的按钮将毫秒级自动置灰，绝无重复执行风险。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelCard({
  name,
  desc,
  icon: Icon,
  status,
  interactive,
}: {
  name: string;
  desc: string;
  icon: typeof MessageCircle;
  status?: { running: boolean; accounts: number; details?: Record<string, unknown> };
  interactive?: boolean;
}) {
  const isRunning = status?.running === true;
  const accountsCount = status?.accounts ?? 0;

  return (
    <div className="flex flex-col justify-between rounded-xl border border-line/70 bg-card p-4 transition hover:border-line-strong">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-line-soft text-teal">
              <Icon size={16} />
            </div>
            <h4 className="text-body-sm font-semibold text-ink">{name}</h4>
          </div>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
              isRunning
                ? "bg-gain-tint text-gain"
                : accountsCount > 0
                  ? "bg-amber-500/10 text-amber-600"
                  : "bg-line-soft text-ash",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isRunning ? "bg-gain animate-pulse" : accountsCount > 0 ? "bg-amber-500" : "bg-ash",
              )}
            />
            {isRunning ? "在线守护中" : accountsCount > 0 ? "已配置 (未连接)" : "未配置"}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-graphite">{desc}</p>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line/40 pt-2 text-[11px] text-ash">
        <span>配置账号数：{accountsCount}</span>
        {interactive && <span className="text-teal font-medium">支持按钮交互审批</span>}
      </div>
    </div>
  );
}
