/**
 * DeepSeek Harness TUI（dst）执行器适配器 —— 纯终端 TUI 形态，无 headless 协议面。
 *
 * dst 是 @deepseek-harness-tui/dsh-tui 的启动器 shim（实测 0.14.0）：裸命令即启动
 * DeepSeek Harness 的 dsh-tui profile 交互界面（底层 `dsh --profile dsh-tui`），
 * 子命令只有 update / migrate / doctor / safe / version 这类 launcher 管理命令，
 * 没有任何 programmatic 入口 —— 没有可以接进 daemon chat 模式的协议通道。
 *
 * 所以这个适配器的价值面在**终端 TUI**：ExecutorAdapter.id 同时就是
 * terminal/terminals.ts 拼装 pwsh 启动命令的命令名（`& 'dst'`），注册这一个
 * 适配器，前端「交互式 Agent CLI (TUI)」菜单里就会出现 dst 并可一键直启。
 * headless 驱动走已有的 dsh 适配器（`dsh acp`，同一官方工具的 ACP 形态），
 * start/reattach 在这里如实拒绝而不是装作能跑。
 */

import {
  adapterError,
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";

export class DstAdapter implements ExecutorAdapter {
  readonly id = "dst";
  readonly displayName = "DeepSeek Harness TUI";
  readonly glyph = "T";
  // dsh-tui profile 底层就是 dsh，模型面与 dsh 适配器一致（DeepSeek 官方长程架构）。
  // daemon 永远不会真的用这份清单驱动 dst（start 拒绝），挂着只为过注册的非空校验
  // 并让设置页的模型展示与 TUI 里实际可选的模型对得上。
  readonly models: readonly ExecutorModelInfo[] = [
    {
      id: "deepseek-official/deepseek-v4-flash" as ModelId,
      displayName: "DeepSeek V4 Flash（默认）",
      contextWindow: 1000000,
      reasoningLevels: ["low", "medium", "high"],
      multimodal: false,
    },
    {
      id: "deepseek-official/deepseek-flash" as ModelId,
      displayName: "DeepSeek V41 Flash",
      contextWindow: 1000000,
      multimodal: false,
    },
    {
      id: "deepseek-official/deepseek-v4-pro" as ModelId,
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1000000,
      reasoningLevels: ["low", "medium", "high", "max"],
      multimodal: false,
    },
  ];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: false, // 无 headless 面，daemon 无法代持会话
    fileDiff: false,
    terminal: false,
    permissions: false,
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: false,
    usage: false,
    multimodal: false,
    streaming: "batch", // 事件流整体不存在，batch 是「没有流」的诚实表述
    steering: "none",
  };

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("dst");
      // `dst version` 输出两行：launcher 版本 + profile 版本行，原样留给 UI
      const out = await execLines(cmd, ["version"], 30000);
      return {
        state: { status: "ready", version: out.split(/\r?\n/)[0]?.trim() || "unknown" },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 dst（npm i -g @deepseek-harness-tui/dsh-tui）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(_req: StartRequest, _sink: AdapterSink): Promise<AdapterSession> {
    // chat 模式对 dst 结构性不可用：没有协议通道可接。指路 dsh（同一工具的 ACP
    // 形态）而不是留一个「点了没反应」的哑会话。
    throw adapterError(
      "tui_only",
      "dst 是 DeepSeek Harness 的纯 TUI 形态，只能在终端里交互使用" +
        "（终端 TUI 菜单一键启动）；headless 驱动请选 dsh 执行器（ACP）",
    );
  }

  reattach(sessionId: SessionId, _ref: string, _rootPath: string, sink: AdapterSink): AdapterSession {
    // 永远不该被调到（start 从不成功 → state.db 里不会有 dst 会话）；
    // 防御式返回一个立即失败的会话，别让 host 拿到 undefined。
    sink({
      type: "error",
      sessionId,
      message: "dst 会话不可恢复：dst 是纯 TUI 形态，daemon 从未持有过它的会话",
      recoverable: false,
    });
    return {
      id: sessionId,
      send: async () => {
        throw adapterError("tui_only", "dst 不支持 headless 驱动（见 dsh 适配器）");
      },
      cancel: async () => {},
      resolvePermission: async () => {},
      externalRef: () => null,
    };
  }

  async disconnect(): Promise<void> {
    // 没有子进程要回收
  }
}
