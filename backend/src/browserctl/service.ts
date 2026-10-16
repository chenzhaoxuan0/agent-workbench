/**
 * 浏览器控制服务（docs/14 §2）—— playwright-mcp 的扇出编排与共享 Chrome 生命周期。
 *
 * 工作台不内置浏览器：条目是官方 `npx @playwright/mcp@latest`，模式只有两种——
 * - 隔离（默认）：每执行器独立持久 profile（显式 --user-data-dir，绕开官方
 *   「按工作区哈希共享 profile → 并发冲突」的默认行为，docs/14 §2.1 实证）；
 * - 接管：全执行器 --cdp-endpoint 连 daemon 拉起的共享 Chrome（登录态互通）。
 *
 * 扇出完全复用 mcpadmin（ADR 0004：原生配置唯一真相源），本模块只做条目构造
 * 与编排；dsh 无落盘配置，经 ctrl/store 的 provider 动态注入。
 */
import type {
  AcpMcpServer,
  BrowserChannel,
  BrowserControlConfig,
  BrowserControlMode,
  BrowserControlState,
  ControlFanoutOutcome,
  McpServerEntry,
  SharedChromeStatus,
} from "../contract.ts";
import {
  BROWSER_ENTRY_NAME,
  controlActions,
  logControlAction,
  readBrowserControlConfig,
  writeBrowserControlConfig,
} from "../ctrl/store.ts";
import { installBrowserControlSkill } from "../ctrl/skills.ts";
import { MCP_EXECUTORS, MCP_UNSUPPORTED_EXECUTORS, wrapCmd } from "../mcpadmin/executors.ts";
import { mcpRemove, mcpSave, type McpServiceDeps } from "../mcpadmin/service.ts";
import { join } from "node:path";
import { log } from "../log.ts";
import {
  cdpAlive,
  killTree,
  launchSharedChrome,
  type SharedChromeHandle,
} from "./chrome.ts";

/** dsh 的 ACP 注入（无落盘配置的家伙拿自己的 profile 目录） */
const ACP_EXECUTOR_ID = "dsh";

export interface BrowserControlService {
  readonly getState: () => BrowserControlState;
  readonly setEnabled: (enabled: boolean) => Promise<BrowserControlState>;
  readonly setMode: (mode: BrowserControlMode) => Promise<BrowserControlState>;
  readonly setBrowser: (browser: BrowserChannel) => Promise<BrowserControlState>;
  readonly startSharedChrome: () => Promise<BrowserControlState>;
  readonly stopSharedChrome: () => Promise<BrowserControlState>;
  /** dsh session/new 注入用的条目（启用才有；接管模式在共享 Chrome 存活时才有） */
  readonly acpEntries: () => AcpMcpServer[];
  /** daemon 启动时调：接管模式自动拉起共享 Chrome */
  readonly boot: () => Promise<void>;
  /**
   * daemon 退出前的尽力收尾（复审 P1）：带走自己拉起的共享 Chrome。Windows 上
   * 父进程退出不杀子进程，残留实例会让 CDP 调试端口在关掉工作台后继续暴露。
   * 收编的存量进程（无句柄）无从杀起，跳过——与 stopSharedChrome 同口径。
   */
  readonly dispose: () => Promise<void>;
}

/** 共享 Chrome 的进程态（service 内部，不进配置文件） */
interface ChromeState {
  handle: SharedChromeHandle | null;
  /** 上次健康检查结果（running 的判定口径：进程活着或已收编，且端口有响应） */
  alive: boolean;
  exitReason: string | null;
  /** 启动/停止失败的最近一次错误说明（UI 直接展示，别让用户盲点「启动」） */
  lastError: string | null;
}

export function createBrowserControlService(
  deps: McpServiceDeps,
  opts: {
    readonly profileRoot?: string;
    /** 冒烟注入假启动器（返回收编型 handle，child=null），避免真拉浏览器 */
    readonly launcher?: typeof launchSharedChrome;
  } = {},
): BrowserControlService {
  const profileRoot = opts.profileRoot ?? deps.stateHome;
  const launch = opts.launcher ?? launchSharedChrome;
  const chrome: ChromeState = { handle: null, alive: false, exitReason: null, lastError: null };
  let lastFanout: ControlFanoutOutcome[] = [];

  // ---- 条目构造 ---------------------------------------------------------------

  function profileDirOf(executorId: string): string {
    return join(profileRoot, "browser-profiles", executorId);
  }

  function buildEntry(executorId: string, cfg: BrowserControlConfig): McpServerEntry {
    if (cfg.mode === "takeover") {
      const port = cfg.sharedPort;
      if (port === undefined) throw new Error("接管模式缺 sharedPort（先启动共享 Chrome）");
      return {
        name: BROWSER_ENTRY_NAME,
        transport: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest", "--cdp-endpoint", `http://127.0.0.1:${port}`],
      };
    }
    return {
      name: BROWSER_ENTRY_NAME,
      transport: "stdio",
      command: "npx",
      args: [
        "@playwright/mcp@latest",
        "--browser",
        cfg.browser,
        "--user-data-dir",
        profileDirOf(executorId),
      ],
    };
  }

  // ---- 扇出 / 回收 --------------------------------------------------------------

  async function fanout(cfg: BrowserControlConfig): Promise<ControlFanoutOutcome[]> {
    const outcomes: ControlFanoutOutcome[] = [];
    for (const def of MCP_EXECUTORS) {
      try {
        await mcpSave(deps, def.id, buildEntry(def.id, cfg));
        outcomes.push({ executorId: def.id, ok: true });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        outcomes.push({ executorId: def.id, ok: false, error });
      }
    }
    logControlAction("browser", "entry.write", `写入 ${BROWSER_ENTRY_NAME} 条目：${
      outcomes.filter((o) => o.ok).length}/${outcomes.length
    } 家成功（模式 ${cfg.mode}）`);
    return outcomes;
  }

  async function recall(): Promise<ControlFanoutOutcome[]> {
    const outcomes: ControlFanoutOutcome[] = [];
    for (const def of MCP_EXECUTORS) {
      try {
        await mcpRemove(deps, def.id, BROWSER_ENTRY_NAME, { toVault: true });
        outcomes.push({ executorId: def.id, ok: true });
      } catch (e) {
        // not_found = 本来就没装，不算失败
        const code = (e as { code?: string }).code;
        if (code === "not_found") outcomes.push({ executorId: def.id, ok: true });
        else outcomes.push({ executorId: def.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    logControlAction("browser", "entry.remove", `停用 ${BROWSER_ENTRY_NAME}：${
      outcomes.filter((o) => o.ok).length}/${outcomes.length
    } 家移入停用库`);
    return outcomes;
  }

  // ---- 共享 Chrome --------------------------------------------------------------

  /**
   * 生命周期单飞链（vaultChain 同款）：boot() 自动拉起与 UI 手动启停并发时，
   * 不加锁会 spawn 两个 Chrome——第二个要么被单实例委派吞掉留下死句柄
   * （stop 杀的是死 pid，真 Chrome 还活着），要么起在第二个端口并把
   * 第一次的活句柄覆盖丢。
   */
  let chromeChain: Promise<unknown> = Promise.resolve();
  function withChrome<T>(fn: () => Promise<T>): Promise<T> {
    const run = chromeChain.then(fn, fn);
    chromeChain = run.catch(() => undefined);
    return run;
  }

  function sharedChromeStatus(): SharedChromeStatus {
    const handle = chrome.handle;
    return {
      running: chrome.alive,
      executable: handle?.executable ?? null,
      kind: handle?.kind ?? null,
      port: handle?.port ?? readBrowserControlConfig().sharedPort ?? null,
      exitReason: chrome.exitReason,
      lastError: chrome.lastError,
    };
  }

  async function startChromeLocked(): Promise<BrowserControlState> {
    const cfg = readBrowserControlConfig();
    if (chrome.handle !== null && (await cdpAlive(chrome.handle.port))) {
      chrome.alive = true;
      return state(cfg);
    }
    const result = await launch(
      // 接管模式优先拉用户选的通道（chrome 通道时真 Chrome，否则 Edge 也行）
      cfg.browser,
      join(profileRoot, "browser-shared-profile"),
      cfg.sharedPort,
    );
    if ("error" in result) {
      chrome.lastError = result.error;
      chrome.handle = null;
      chrome.alive = false;
      logControlAction("browser", "sharedChrome.start", `失败：${result.error}`);
      return state(cfg);
    }
    chrome.handle = result;
    chrome.alive = true;
    chrome.exitReason = null;
    chrome.lastError = null;
    result.child?.once("exit", (code) => {
      chrome.alive = false;
      chrome.exitReason = `进程退出（code=${code ?? "?"}）`;
      logControlAction("browser", "sharedChrome.exit", chrome.exitReason);
    });
    // 端口变了（基址被占上浮）→ 持久化 + 若已启用则重写条目
    if (cfg.sharedPort !== result.port) {
      const next = { ...cfg, sharedPort: result.port };
      writeBrowserControlConfig(next);
      if (next.enabled) await fanout(next).then((f) => (lastFanout = f));
      logControlAction("browser", "sharedChrome.port", `调试端口定为 ${result.port}，条目已同步`);
      return state(next);
    }
    logControlAction("browser", "sharedChrome.start", `${result.kind} 就绪 @127.0.0.1:${result.port}`);
    return state(readBrowserControlConfig());
  }

  async function stopChromeLocked(): Promise<BrowserControlState> {
    const handle = chrome.handle;
    if (handle?.child?.pid !== undefined) {
      const killed = await killTree(handle.child.pid);
      // 验尸：taskkill 可能因权限失败——端口真熄灭才算停，否则下次「启动」
      // 会收编一个 UI 声称已停止、实际还占着 profile 锁的实例
      let stillAlive = await cdpAlive(handle.port);
      for (let i = 0; i < 10 && stillAlive; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stillAlive = await cdpAlive(handle.port);
      }
      if (!killed || stillAlive) {
        chrome.exitReason = `停止未完全生效（taskkill ${killed ? "已执行" : "失败"}，调试端口${stillAlive ? "仍存活" : "已熄灭"}）——可能有残留进程占住 profile`;
        logControlAction("browser", "sharedChrome.stop", chrome.exitReason);
      } else {
        logControlAction("browser", "sharedChrome.stop", `已终止（端口 ${handle.port} 熄灭）`);
      }
    } else if (handle !== null) {
      // 收编的存量进程（child=null）无从杀起：只记状态，端口留给用户手关
      logControlAction("browser", "sharedChrome.stop", "实例为收编存量（daemon 无进程句柄），未终止");
    }
    chrome.handle = null;
    chrome.alive = false;
    return state(readBrowserControlConfig());
  }

  const startSharedChrome = (): Promise<BrowserControlState> => withChrome(startChromeLocked);
  const stopSharedChrome = (): Promise<BrowserControlState> => withChrome(stopChromeLocked);

  // ---- 状态组装 -----------------------------------------------------------------

  function state(cfg: BrowserControlConfig): BrowserControlState {
    return {
      config: cfg,
      sharedChrome: sharedChromeStatus(),
      fanout: lastFanout,
      notes: [
        ...MCP_UNSUPPORTED_EXECUTORS.map((u) => ({
          executorId: u.id,
          note: u.id === ACP_EXECUTOR_ID ? "MCP 随会话动态注入（启用后自动生效）" : u.reason,
        })),
      ],
      actions: controlActions().filter((a) => a.domain === "browser").slice(-50),
    };
  }

  async function apply(cfg: BrowserControlConfig): Promise<BrowserControlState> {
    writeBrowserControlConfig(cfg);
    lastFanout = cfg.enabled ? await fanout(cfg) : await recall();
    return state(readBrowserControlConfig());
  }

  return {
    getState: () => state(readBrowserControlConfig()),
    setEnabled: async (enabled) => {
      const cfg = readBrowserControlConfig();
      if (enabled && cfg.mode === "takeover" && !(await cdpAlive(cfg.sharedPort ?? -1))) {
        // 接管模式启用前确保共享 Chrome 活着（起不来也继续写条目，错误在状态里可见）
        await startSharedChrome();
      }
      const fresh = readBrowserControlConfig();
      logControlAction("browser", enabled ? "enabled" : "disabled", enabled ? "浏览器控制启用" : "浏览器控制停用（条目入停用库）");
      if (enabled) installBrowserControlSkill();
      return apply({ ...fresh, enabled });
    },
    setMode: async (mode) => {
      const cfg = readBrowserControlConfig();
      if (mode === "takeover" && cfg.sharedPort === undefined) await startSharedChrome();
      logControlAction("browser", "mode", `模式切换 → ${mode}`);
      return apply({ ...readBrowserControlConfig(), mode });
    },
    setBrowser: async (browser) => {
      logControlAction("browser", "browser", `隔离通道切换 → ${browser}`);
      return apply({ ...readBrowserControlConfig(), browser });
    },
    startSharedChrome,
    stopSharedChrome,
    acpEntries: () => {
      const cfg = readBrowserControlConfig();
      if (!cfg.enabled) return [];
      try {
        // 与落盘路径（mcpSave → wrapCmd）同一口径：Windows 上 npx 这类 .cmd shim
        // 不包 cmd /c，部分 CLI 直接 spawn 会 ENOENT（复审 P2）——dsh 注入同样要包
        const entry = wrapCmd(buildEntry(ACP_EXECUTOR_ID, cfg));
        return [
          {
            name: entry.name,
            command: entry.command,
            args: entry.args,
            ...(entry.env !== undefined ? { env: entry.env } : {}),
          },
        ];
      } catch (e) {
        log.warn("browser acp entry unavailable", { error: e instanceof Error ? e.message : String(e) });
        return [];
      }
    },
    boot: async () => {
      try {
        const cfg = readBrowserControlConfig();
        if (cfg.enabled && cfg.mode === "takeover") {
          log.info("browser control: takeover enabled, starting shared chrome");
          await startSharedChrome();
        }
      } catch (e) {
        // boot 是 void 火后不管的：任何抛错在这里终结，绝不让 daemon 启动崩
        log.error("browser control boot failed", { error: e instanceof Error ? e.message : String(e) });
      }
    },
    dispose: async () => {
      // 尽力收尾：自己拉起的共享 Chrome 带走；已在单飞链上排队也不等它——退出路径不等新启动
      try {
        await withChrome(stopChromeLocked);
      } catch (e) {
        log.warn("browser control dispose failed", { error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
