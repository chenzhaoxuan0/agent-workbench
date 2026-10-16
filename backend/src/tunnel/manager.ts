/**
 * 远程公网穿透管理器（Tunnel Manager）。
 *
 * 支持双模公网直连：
 * 1. Cloudflare Quick Tunnel（基于 cloudflared 零配置即开即用，生成 trycloudflare.com 临时域名）
 * 2. 自定义公网地址（Frp / Ngrok / 自建反代域名配置持久化）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";

export type TunnelStatus = "stopped" | "starting" | "running" | "error";
export type TunnelProvider = "cloudflared" | "custom";

export interface TunnelState {
  readonly status: TunnelStatus;
  readonly provider: TunnelProvider;
  readonly url: string | null;
  readonly error: string | null;
  readonly cloudflaredAvailable: boolean;
  readonly customUrl: string | null;
}

export class TunnelManager {
  private status: TunnelStatus = "stopped";
  private provider: TunnelProvider = "cloudflared";
  private activeUrl: string | null = null;
  private errorMessage: string | null = null;
  private customUrl: string | null = null;
  private proc: ChildProcess | null = null;
  private readonly configPath: string;

  constructor(
    private readonly homeDir: string,
    private readonly localPort: number,
  ) {
    this.configPath = path.join(homeDir, "tunnel.json");
    void this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(data) as { customUrl?: string; provider?: TunnelProvider };
      if (typeof parsed.customUrl === "string") this.customUrl = parsed.customUrl;
      if (parsed.provider) this.provider = parsed.provider;
    } catch {
      // 首次加载忽略
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await fs.mkdir(this.homeDir, { recursive: true });
      await fs.writeFile(
        this.configPath,
        JSON.stringify({ customUrl: this.customUrl, provider: this.provider }, null, 2),
        "utf8",
      );
    } catch (err) {
      log.warn("failed to save tunnel config", { error: String(err) });
    }
  }

  /** 探测系统是否存在 cloudflared 可执行文件 */
  async isCloudflaredAvailable(): Promise<{ available: boolean; binPath?: string }> {
    // 1. 检查 PATH
    const probeCmd = process.platform === "win32" ? "where.exe" : "which";
    const fromPath = await new Promise<string | null>((resolve) => {
      try {
        const cp = spawn(probeCmd, ["cloudflared"], { windowsHide: true });
        let out = "";
        cp.stdout.on("data", (d: Buffer) => (out += d.toString()));
        cp.on("close", (code) => {
          if (code === 0 && out.trim()) {
            const firstLine = out.trim().split(/\r?\n/)[0];
            resolve(firstLine ?? null);
          } else {
            resolve(null);
          }
        });
        cp.on("error", () => resolve(null));
      } catch {
        resolve(null);
      }
    });

    if (fromPath) return { available: true, binPath: fromPath };

    // 2. 检查本地 ~/.agent-workbench/bin/
    const localBin = path.join(
      this.homeDir,
      "bin",
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    try {
      await fs.access(localBin);
      return { available: true, binPath: localBin };
    } catch {
      return { available: false };
    }
  }

  async getState(): Promise<TunnelState> {
    const { available } = await this.isCloudflaredAvailable();
    return {
      status: this.status,
      provider: this.provider,
      url: this.activeUrl,
      error: this.errorMessage,
      cloudflaredAvailable: available,
      customUrl: this.customUrl,
    };
  }

  async start(options?: { provider?: TunnelProvider; customUrl?: string }): Promise<TunnelState> {
    const targetProvider = options?.provider ?? this.provider;
    this.provider = targetProvider;

    if (options?.customUrl !== undefined) {
      this.customUrl = options.customUrl.trim() || null;
      await this.saveConfig();
    }

    if (targetProvider === "custom") {
      if (!this.customUrl) {
        this.status = "error";
        this.errorMessage = "请先提供有效的自定义公网域名或 Frp 地址";
        return this.getState();
      }
      this.status = "running";
      this.activeUrl = this.customUrl;
      this.errorMessage = null;
      log.info("custom tunnel active", { url: this.activeUrl });
      return this.getState();
    }

    // Cloudflare Quick Tunnel 启动
    const { available, binPath } = await this.isCloudflaredAvailable();
    if (!available || !binPath) {
      this.status = "error";
      this.errorMessage =
        "未在系统中检测到 cloudflared。可通过 winget install Cloudflare.cloudflared 安装，或直接使用自定义穿透地址。";
      return this.getState();
    }

    // 若已有在跑的子进程则先关闭
    this.stop();

    this.status = "starting";
    this.errorMessage = null;
    this.activeUrl = null;

    try {
      const localTarget = `http://127.0.0.1:${this.localPort}`;
      const cp = spawn(
        binPath,
        ["tunnel", "--url", localTarget, "--no-autoupdate"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      this.proc = cp;

      const timer = setTimeout(() => {
        if (this.status === "starting") {
          this.status = "error";
          this.errorMessage = "Cloudflare Tunnel 启动超时（15 秒内未获取到公网地址）";
          this.stop();
        }
      }, 15_000);

      const onOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        // 匹配 Cloudflare 自动分配的 trycloudflare.com 临时公网地址
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
        if (match && match[0]) {
          clearTimeout(timer);
          this.activeUrl = match[0];
          this.status = "running";
          this.errorMessage = null;
          log.info("cloudflare quick tunnel ready", { url: this.activeUrl });
        }
      };

      cp.stdout?.on("data", onOutput);
      cp.stderr?.on("data", onOutput);

      cp.on("close", (code) => {
        clearTimeout(timer);
        if (this.status === "running" || this.status === "starting") {
          this.status = code === 0 ? "stopped" : "error";
          if (code !== 0 && !this.errorMessage) {
            this.errorMessage = `cloudflared 进程异常退出 (code: ${code})`;
          }
        }
        this.proc = null;
      });

      cp.on("error", (err) => {
        clearTimeout(timer);
        this.status = "error";
        this.errorMessage = `启动 cloudflared 失败: ${err.message}`;
        this.proc = null;
      });
    } catch (err: unknown) {
      this.status = "error";
      this.errorMessage = `启动出错: ${err instanceof Error ? err.message : String(err)}`;
    }

    return this.getState();
  }

  stop(): TunnelState {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
    this.status = "stopped";
    this.activeUrl = null;
    this.errorMessage = null;
    log.info("tunnel stopped");
    return {
      status: this.status,
      provider: this.provider,
      url: null,
      error: null,
      cloudflaredAvailable: false,
      customUrl: this.customUrl,
    };
  }
}
