/**
 * MCP 管理契约（MCP Management）—— 设置页「MCP 服务」分区与 daemon `mcp.*` RPC 的共享形态。
 *
 * 领域语言见仓库根 CONTEXT.md 与 docs/adr/0004：
 * - 原生配置文件是唯一真相源：工作台做外科手术式读写，不建镜像账本；
 * - 停用库（Disabled Vault）只留档被移除的条目，恢复时写回；
 * - 乐观锁：变更请求带 UI 读盘时的指纹（expectedSha），盘上变了就报 conflict，
 *   由用户选「覆盖（force）/ 重载 / 取消」。
 */

/** 传输形态：stdio = 本地命令子进程；http/sse = 远端端点 */
export type McpTransport = "stdio" | "http" | "sse";

/** MCP 服务的规范化条目（工作台内部统一形态，写入时按执行器转换） */
export interface McpServerEntry {
  /** 服务名（执行器配置里的键名） */
  readonly name: string;
  readonly transport: McpTransport;
  /** stdio：可执行命令 */
  readonly command?: string;
  /** stdio：命令参数 */
  readonly args?: readonly string[];
  /** stdio：环境变量 */
  readonly env?: Readonly<Record<string, string>>;
  /** http/sse：端点 URL */
  readonly url?: string;
  /** http/sse：请求头 */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 一家执行器的配置文件状态（inventory 头部信息） */
export interface McpFileStatus {
  readonly executorId: string;
  readonly executorName: string;
  /** 配置文件绝对路径 */
  readonly path: string;
  readonly exists: boolean;
  /** 文件里现有条目数（解析失败时缺省） */
  readonly count?: number;
  /** 文件级错误（不存在不算错；解析失败在这里，展示但不禁页） */
  readonly error?: string;
  /** 读盘时文件指纹（变更请求带回做乐观锁） */
  readonly sha?: string;
}

/** 某执行器上的一个服务实例（live = 原生文件里；vault = 停用库留档） */
export interface McpServerInstance {
  readonly executorId: string;
  readonly entry: McpServerEntry;
  /** true = 条目在停用库（原生文件里没有，恢复即写回） */
  readonly disabled: boolean;
}

/** 跨执行器同名聚合行（同名在多家 = 多实例） */
export interface McpServerRow {
  readonly name: string;
  readonly instances: readonly McpServerInstance[];
}

/** `mcp.inventory` 的返回 */
export interface McpInventory {
  readonly files: readonly McpFileStatus[];
  readonly rows: readonly McpServerRow[];
  /** 无持久化 MCP 配置面的执行器（dsh/sdk-bridge：MCP 随会话/协议注入，不落盘） */
  readonly unsupported?: readonly McpUnsupportedExecutor[];
}

/** 无配置面执行器的说明条目 */
export interface McpUnsupportedExecutor {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/** 变更类 RPC 的通用回执：新文件全文（预览落盘内容）+ 新指纹 */
export interface McpMutationResult {
  readonly ok: true;
  /** 变更后的配置文件全文 —— UI 直接展示「落盘后的内容」 */
  readonly newText: string;
  readonly newSha: string;
}

/** `mcp.copy` 的单目标结果 */
export interface McpCopyOutcome {
  readonly executorId: string;
  readonly ok: boolean;
  /** 失败原因（conflict / 已有同名被跳过 / 写入错误…） */
  readonly error?: string;
}
