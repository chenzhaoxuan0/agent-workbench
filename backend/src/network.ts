/**
 * 本机网卡探测与拓扑识别 —— 为移动端远控配对码（Pairing QR）提供智能网络地址推荐。
 */

import os from "node:os";

export interface NetworkInterfaceInfo {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly family: "IPv4";
  readonly type: "lan" | "tailscale" | "loopback" | "virtual" | "other";
  readonly label: string;
  readonly isRecommended: boolean;
}

/** 识别网卡类别并给出用户友好标签 */
function classifyInterface(name: string, ip: string, internal: boolean): { type: NetworkInterfaceInfo["type"]; label: string } {
  if (internal || ip.startsWith("127.")) {
    return { type: "loopback", label: "本机回环 (127.0.0.1)" };
  }

  const lowerName = name.toLowerCase();

  // Tailscale 判定：网卡名含 tailscale，或者属于 CGNAT 100.64.0.0/10 地址段
  const parts = ip.split(".").map(Number);
  const p0 = parts[0] ?? 0;
  const p1 = parts[1] ?? 0;
  const isCgnat = p0 === 100 && p1 >= 64 && p1 <= 127;
  if (lowerName.includes("tailscale") || isCgnat) {
    return { type: "tailscale", label: `Tailscale 虚拟专网 (${name})` };
  }

  // 虚拟网卡 (WSL, Hyper-V, Docker, VMware)
  if (
    lowerName.includes("vethernet") ||
    lowerName.includes("docker") ||
    lowerName.includes("wsl") ||
    lowerName.includes("vmware") ||
    lowerName.includes("virtual") ||
    lowerName.includes("vbox")
  ) {
    return { type: "virtual", label: `虚拟网卡 (${name})` };
  }

  // Wi-Fi 无线网卡
  if (lowerName.includes("wi-fi") || lowerName.includes("wlan") || lowerName.includes("wireless")) {
    return { type: "lan", label: `无线局域网 Wi-Fi (${name})` };
  }

  // 以太网有线网卡
  if (lowerName.includes("ethernet") || lowerName.includes("以太网") || lowerName.startsWith("eth") || lowerName.startsWith("en")) {
    return { type: "lan", label: `有线局域网 (${name})` };
  }

  // 私有局域网 IP 段判定
  const isPrivateLan =
    (p0 === 192 && p1 === 168) ||
    p0 === 10 ||
    (p0 === 172 && p1 >= 16 && p1 <= 31);

  if (isPrivateLan) {
    return { type: "lan", label: `局域网连接 (${name})` };
  }

  return { type: "other", label: `${name} (${ip})` };
}

/**
 * 列出本机所有可用的 IPv4 地址，按移动端可用性优先级排序：
 * 1. 物理 Wi-Fi / 有线局域网 (lan)
 * 2. Tailscale 虚拟专网 (tailscale)
 * 3. 其他非虚拟非回环
 * 4. 虚拟网卡 (virtual)
 * 5. 回环 (loopback)
 */
export function getNetworkInterfaces(): NetworkInterfaceInfo[] {
  const nets = os.networkInterfaces();
  const list: NetworkInterfaceInfo[] = [];

  for (const [name, netList] of Object.entries(nets)) {
    if (!netList) continue;
    for (const net of netList) {
      if (net.family !== "IPv4") continue;
      const { type, label } = classifyInterface(name, net.address, net.internal);
      list.push({
        id: `${name}:${net.address}`,
        name,
        address: net.address,
        family: "IPv4",
        type,
        label,
        isRecommended: false,
      });
    }
  }

  const priorityMap: Record<NetworkInterfaceInfo["type"], number> = {
    lan: 1,
    tailscale: 2,
    other: 3,
    virtual: 4,
    loopback: 5,
  };

  list.sort((a, b) => {
    const diff = priorityMap[a.type] - priorityMap[b.type];
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });

  // 标出首选推荐网卡
  if (list.length > 0) {
    const firstNonLoop = list.find((item) => item.type === "lan") ?? list.find((item) => item.type === "tailscale") ?? list[0];
    if (firstNonLoop) {
      const recIndex = list.indexOf(firstNonLoop);
      const item = list[recIndex];
      if (recIndex >= 0 && item) {
        list[recIndex] = {
          id: item.id,
          name: item.name,
          address: item.address,
          family: item.family,
          type: item.type,
          label: item.label,
          isRecommended: true,
        };
      }
    }
  }

  return list;
}
