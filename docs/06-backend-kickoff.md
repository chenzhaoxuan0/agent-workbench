# 后端开工文档 —— Runtime Host 守护进程

> **这份文档是给"后端开工"的新会话用的**，自包含：不依赖任何历史对话，
> 从这里出发可以直接动工。前端会话（当前这个）继续负责 `prototype/`，
> 两边以本文第四、五节的契约为界。
>
> 阅读顺序建议：本篇 → `docs/03-architecture.md` → `docs/05-reference-map.md`。

---

## 一、使命与边界

**做什么**：建一个本地常驻守护进程（下称 daemon），把前端所有"UI 与数据形态完整、执行是模拟"的插槽换成真实执行——真实 agent 会话、真实终端、真实落盘、真实调度。

**不做什么**：
- 不改 `prototype/` 下的前端代码（那是另一个会话的辖区）；
- 不重做已经是真核的浏览器端模块（见第八节——出图 / WeKnora / 本地文件夹来源留在浏览器，daemon 不要重复实现）；
- 不动 `prototype/src/core/adapter.ts` 与 `events.ts` 的契约——它们是双方约定，前端按它渲染，后端按它生产。确需演进契约时，在本会话提出、两端会话对齐后再改。

**硬约束**：仓库 `C:\Users\chenziyu\project\Agent\agent-workbench`；Windows（win32）+ Git Bash；包管理 pnpm；依赖只接受 Apache-2.0 / MIT 许可证（见 `docs/02-reference-audit.md`）。

---

## 二、项目现状速览

- **前端**：`prototype/`，React 19 + zustand + Tailwind v4 + Vite，纯浏览器渲染壳，约 1.8 万行。`pnpm dev` 起 dev server（`vite.config.ts` 配置端口 **5180**；当前会话曾以 5199 跑过一个实例，以配置为准）。
- **文档**：`docs/00-north-star`（产品北极星）、`01-tech-stack`（技术选型）、`02-reference-audit`（参照仓库工程审计）、`03-architecture`（架构）、`04-design-system`（设计决策时间线，含每轮取舍）、`05-reference-map`（功能→参照来源→落点）。
- **完成度三档**（详见与本文同源的评估结论）：
  1. **已是真核**：出图（OpenAI 兼容 API）、WeKnora 客户端（HTTP）、本地文件夹记忆来源（File System Access）、文件树浏览——都在浏览器里，别动；
  2. **UI 完整、执行是模拟**（daemon 的核心工作）：对话运行（mock adapter 编排 timeline 事件）、终端（只读外观）、Ops 三件套（确定性 eval / judge / Arena 全是 staged setTimeout）、权限卡（决策不闸真执行）、自动化（无调度器）、花费账本（种子数据）、会话历史（mock fixtures）；
  3. **显式占位**：右栏 terminal/browser/whiteboard 等"未接运行时"页签，带说明渲染，不是欠账。

---

## 三、代码落点与形态裁决

```
agent-workbench/
├─ docs/            # 文档（本篇所在）
├─ prototype/       # 前端（另一会话辖区，不碰）
└─ backend/         # ← daemon 落这里（新建）
```

**形态**：Node + TypeScript 单进程守护进程。
- **传输**：WebSocket（事件流出）+ REST/JSON（配置与会话管理）。WebSocket 首选 `ws`（MIT）；HTTP 框架用 Fastify（MIT）或裸 `node:http`，按最少依赖原则。
- **进程模型**：`child_process` spawn 各家 CLI；交互式 TUI 终端用 `node-pty`（Windows 走 ConPTY；若构建受阻，Phase 1 先用无 TTY 的 stdio 管道，PTY 单独排期）。
- **语言/运行时**：TypeScript ESM，Node ≥ 22（本机 v24），`tsx` 直跑开发。
- **配置落盘**：daemon 自己的工作目录（建议 `backend/.waku/`，或未来由前端设置指向任意路径——前端已有"SQLite 后端路径可自定义"的字段）。

---

## 四、契约一：RuntimeAdapter（后端的接口规格书）

原文在 `prototype/src/core/adapter.ts`，**这是整个项目的战略接缝**，要点：

- `TransportKind = "acp" | "jsonrpc" | "rpc" | "http" | "process" | "internal"` —— 六家 CLI 的真实接入方式：ACP（JSON-RPC over stdio，dsh 原生）/ Claude Code、Codex 风格 JSON-RPC / pi 的 framed CBOR / ZCode agent-server HTTP / 直接 spawn 解析 stdout / 自研编排器。
- `RuntimeCapabilities`（10 项布尔：resumeSession / fileDiff / terminal / permissions / subagents / worktrees / sandbox / mcp / usage / multimodal）—— **强制显式声明**，UI 靠它做渐进增强，缺什么就不渲染什么面板。
- `RuntimeAdapter` 方法面：`probe / connect / disconnect`、`listSessions / startSession / resumeSession / sendMessage / cancel`、`resolvePermission(sessionId, requestId, decision)`（decision: allow | deny | always）、`events(): AsyncIterable<RuntimeEvent>`（唯一数据出入口）、`exportTrace(sessionId)`（供 judge 消费）。
- `AdapterFactory.models` **非空硬要求**（空清单的执行器注册即拒）；模型清单决定 UI 下拉，不让适配器各自默认。
- `ConnectionState` 五态：not_installed（带 hint）/ stopped / starting / ready（带 version/pid）/ error。
- 验收标准（原文）：**新增一家工具 = 一个 adapter 目录 + 两个文件，core/ 与 ui/ 一行不改**。daemon 侧沿用同一验收：新增执行器不改 daemon 核心。

**daemon 的角色**：把每家 CLI 的原生协议翻译成 RuntimeEvent 流的"服务端 adapter 宿主"。前端的 mock adapter（`prototype/src/adapters/mock/`）就是按这套契约写的参照实现——**翻译逻辑的形态看它**。

---

## 五、契约二：RuntimeEvent（WS 推送的数据形态）

原文在 `prototype/src/core/events.ts`，判别联合，daemon 的 WS 帧直接序列化它。全部类型：

| 类别 | type | 载荷要点 |
|---|---|---|
| 会话生命周期 | `session.started` / `session.ended` / `session.status` | sessionId + unitId / reason / status |
| 消息 | `message.delta` / `message.completed` / `reasoning.delta` | messageId、role、text |
| 工具 | `tool.started` / `tool.completed` | callId 配对；toolName、title、input；ok、output |
| 文件 | `file.diff` / `file.changed` | path + additions/deletions/patch；change: created/modified/deleted |
| 权限 | `permission.requested` / `permission.resolved` | kind: file_write/shell/network/tool；risk 三级；decision: allow/deny/always |
| 子代理 | `subagent.spawned` / `subagent.finished` | childId、role、runtimeId |
| 计划 | `plan.proposed` / `plan.step.updated` / `plan.resolved` | PlanStep 状态机（pending/in_progress/done/skipped/blocked），**刻意不做百分比** |
| 用量 | `usage` | input/output/cacheRead/cacheWrite tokens、costUsd、model、decodeMs；计费口径对齐 dsh：billedInput = uncached + cacheRead + cacheWrite |
| 产出 | `deliverable` | kind: file/diff/pr/report/image |
| 错误 | `error` | recoverable 布尔 |

配套约定：
- `TraceRecord`（seq/at/sessionId/unitId/runtimeId/event/durationMs）——每条事件打时间戳落盘即轨迹，**格式与 UI 解耦**，LLM judge 直接消费；
- `isShellTool(toolName)` 的归一化判定在 core（去分隔符小写 + 白名单 + 前缀），daemon 侧做 bash-output 分类时用同一口径；
- 落盘即轨迹：daemon 把每个会话的 `TraceRecord[]` 写 `traces/<date>.jsonl`（append-only）。

---

## 六、开工顺序（Phase 0 → 7）

**Phase 0 — 脚手架**：`backend/` 目录、tsconfig、`ws` + Fastify（或裸 http）、`pnpm dev` 常驻、健康检查端点 `GET /healthz`。验收：daemon 起、日志清、`wscat`/脚本可连。

**Phase 1 — Runtime host（最小闭环）**：probe → spawn 一家真实 CLI（建议先挑 `--print`/单轮模式最简单的一家）→ 翻译成 `session.started / message.delta / message.completed / usage / session.ended` 推送。验收：**用 WS 客户端脚本发一条 prompt，收到真实模型的流式回复与 usage 帧** ——做到这里产品就有第一条真实对话，这是最小闭环的定义。完成后接第二家（权限流）、第三家（diff 流），验证契约泛化性。

**Phase 2 — 终端 PTY**：node-pty + WS 双向帧；注意前端 `TerminalPage` 支持多窗格（每格一条独立 PTY 会话），resize 帧要有。

**Phase 3 — 落盘层**：会话与日志按第七节落 `.waku/`；`resumeSession` 从盘恢复。

**Phase 4 — 权限闸**：`permission.requested` 挂起工具执行 → REST 收 decision → 放行/拒绝；`always` 落规则表。

**Phase 5 — 自动化调度**：daemon 内 cron，到点起会话，运行记录落盘。

**Phase 6 — Ops 真执行**：确定性 eval = 对 dataset 逐条起沙箱会话断言工具触发（0/1）；judge = 真 LLM 调用打分（GEval 形态：命名指标 + 评分步骤 + 阈值，缺 key 整层跳过而非计 0 分）；Arena = 同题 N 执行器各自 throwaway 沙箱，Completion/Quality 双分；结果按 `eval_runs.jsonl` / `compare/history.jsonl` 语义追加。

**Phase 7 — 记忆编排服务端化**：WeKnora 代理（免 CORS 顾虑）、sqlite 后端（state.db，路径可配）、MEMORY.md 写入与三柱路由。浏览器里的 `core/weknora.ts` / `localMemorySource.ts` 保持不动（见第八节）。

---

## 七、存储设计（语义已在前端定稿，照搬即可）

`.waku/` 目录（waku-agent 语义，`docs/04` 有完整决策记录）：

```
.waku/
├─ state.db                  # SQLite：会话、消息、自动化、权限规则（路径用户可配）
├─ usage.jsonl               # 每次 LLM 调用一行，追加只写，重置不清 —— 美元由 token 估算，token 是 ground truth
├─ traces/<date>.jsonl       # TraceRecord 流，每轮必落（tracing is always on）
├─ eval_runs.jsonl           # 一行一次 gate（确定性通过数 + judge 均分 + verdict + 失败原因）
├─ compare/history.jsonl     # Arena 记分板，一场一行，上限 50 场滚动
└─ memory/                   # 语义事实 / 情节 / 程序性三柱 + MEMORY.md 镜像
```

**前端 localStorage 键平移清单**（前端原型期的持久化，Phase 3 起逐键迁到 daemon；键名即语义）：

| 键 | 内容 | 迁移去向 |
|---|---|---|
| `agent-workbench:ops` | gate 历史 / Arena 记分板 / usage 账本 | `eval_runs.jsonl` / `compare/history.jsonl` / `usage.jsonl` |
| `agent-workbench:image-studio` | 出图供应商 profiles + 任务历史 | profiles 留浏览器（含 API key，不出本机即可）；历史可迁 |
| `agent-workbench:memory-prefs` / `memory-orchestration` | 记忆后端注册表 + 三柱路由 | Phase 7 迁 daemon，浏览器键保留为缓存 |
| `agent-workbench:provider-profiles` / `model-prefs` / `runtimePrefs`（在 workbench store 内） | 供应商 / 模型偏好 / 执行器覆盖 | 迁 daemon 配置文件，前端改缓存 |
| `agent-workbench:sidebar-width-px` / `side-pane-size` | 纯 UI 状态 | 留浏览器，不迁 |

追加只写 + 容量上限滚动（前端实现：MAX_GATE_RUNS=50 / MAX_ARENA_RUNS=50 / MAX_USAGE=4000）是已定稿的语义。

---

## 八、不要重做的模块（已是真核，留在浏览器）

> **2026-10 修订（ADR 0015 / docs/21）**：「留在浏览器」的判据改为**操作/呈现二分**——
> 出图客户端与模型偏好是**操作**（其他客户端可见的事实），上移 daemon
> （`image.generate`、`adapter.modeldefaults`）；File System Access / IndexedDB 句柄类
> 与纯呈现逻辑（外观推导、终端簿记）仍留浏览器。行级修订随 docs/21 P4 落地标注。

| 模块 | 位置 | 为什么留 |
|---|---|---|
| 出图客户端 | `prototype/src/core/imageApi.ts` | 直连 OpenAI 兼容端点已端到端验证；浏览器直连 + 用户自己的 key，daemon 无需经手 |
| 出图保存位置 | `prototype/src/core/imageSave.ts` | File System Access 句柄在用户手里，daemon 不经手 |
| WeKnora 客户端 | `prototype/src/core/weknora.ts` | WeKnora 本地 Docker CORS 全开，浏览器直连已通 |
| 本地文件夹记忆来源 | `prototype/src/core/localMemorySource.ts` | 授权句柄在浏览器 IndexedDB，纯本地索引检索 |

Phase 7 若需要它们服务端化（例如统一记账），做成**可选代理**而不是替换——浏览器直连路径保留。

---

## 九、验证纪律

- **不依赖前端验收**：每个 Phase 用独立脚本（`backend/scripts/smoke-*.ts`）走 WS/REST 驱动 daemon，断言事件序列。前端对接是另一会话的工作。
- **冒烟基准**：Phase 1 的验收脚本（发一条 prompt → 断言收到 `session.started → message.delta* → message.completed → usage → session.ended`）是此后所有改动的回归线。
- ** headless 纪律**：前端会话的经验——headless Chromium 从 IndexedDB 反序列化文件系统句柄会崩（环境限制，已记录 `docs/04`）；涉及文件句柄的验证用真浏览器手测或 daemon 侧脚本。
- **契约变更纪律**：要改 `adapter.ts` / `events.ts` 时，先在两个会话间对齐（本文档第一节），改完两端各自更新测试。

---

## 十、背景速查（给新会话的扩展阅读）

- 六家执行器的协议细节与参照仓库：`docs/05-reference-map.md`（ZCode/dsh/waku/T3/pi 各自贡献了哪些形态）；
- 设计决策的时间线与理由（含"为什么不做百分比计划条"这类细节）：`docs/04-design-system.md`；
- 架构分层与拒绝巨量 fork 税的验收标准：`docs/03-architecture.md`；
- 记忆三柱与 Ops 四铁律的上游：`C:\Users\chenziyu\project\Agent\waku-agent`（`docs/evals.md`、`waku/ops/`）；
- 供应商实例管理交互的上游：`C:\Users\chenziyu\project\Agent\t3code`。
