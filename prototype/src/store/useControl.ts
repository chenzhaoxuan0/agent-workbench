/**
 * 浏览器 / 电脑控制的数据层（docs/14）—— 两个设置分区的唯一 RPC 封装处。
 *
 * 沿用 useMemoryPanel 的口径：DaemonClient 单例 + rpc<T>(method, params)，
 * 本文件不往 client.ts 加新函数。UI 侧全部本地 state（无 zustand）：
 * 这两个分区的数据只在打开时拉取 + 5s 轮询（动作日志是尾读），不值得进全局 store。
 */
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type {
  BrowserChannel,
  BrowserControlMode,
  BrowserControlState,
  ComputerControlState,
} from "../core/control.ts";

function rpc<T>(method: string, params: unknown = null, timeoutMs = 60_000): Promise<T> {
  return DaemonClient.get(defaultDaemonEndpoint()).rpc<T>(method, params, timeoutMs);
}

/* ------------------ 浏览器控制 ------------------ */

export function getBrowserControl(): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.get");
}

export function setBrowserEnabled(enabled: boolean): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.setEnabled", { enabled });
}

export function setBrowserMode(mode: BrowserControlMode): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.setMode", { mode });
}

export function setBrowserChannel(browser: BrowserChannel): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.setBrowser", { browser });
}

export function startSharedChrome(): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.sharedChrome.start");
}

export function stopSharedChrome(): Promise<BrowserControlState> {
  return rpc<BrowserControlState>("browserControl.sharedChrome.stop");
}

/* ------------------ 电脑控制 ------------------ */

export function getComputerControl(): Promise<ComputerControlState> {
  return rpc<ComputerControlState>("computerControl.get");
}

export function setComputerEnabled(enabled: boolean): Promise<ComputerControlState> {
  return rpc<ComputerControlState>("computerControl.setEnabled", { enabled });
}

export function panicComputer(): Promise<ComputerControlState> {
  return rpc<ComputerControlState>("computerControl.panic");
}

/** 动作行的时间戳显示（本地时分秒；跨天不管——这是日志尾巴不是档案） */
export function controlTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
