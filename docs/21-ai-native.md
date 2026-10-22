# 21 · AI-Native —— 全操作可由 agent 驱动（HTTP-RPC 桥 + `aw` CLI + 编排上移）

> 定位：agent-workbench 既是「人用 GUI 操作的工作台」，也是「agent 用命令行操作的对象」。
> **GUI 能做的每件事，外部 agent 都能用一条 CLI 命令完成**——操作面 100% 可 headless，
> 这是 AI-native 的验收判据。daemon 的 RPC 注册表（~155 个方法）已经是现成的全操作面，
> 这份计划做的是三件事：给 RPC 开一扇 HTTP 门、发一个零依赖 CLI、把长在前端 store 里的
> 编排策略上移回 daemon——GUI 与 CLI 走同一条代码路径，不分叉。
>
> 勘察基线：2026-10-22 全仓走查（backend/src 各域、prototype/src 的 store/core、docs/06/07、
> 68 个 smoke 脚本）。参照形态：GitHub CLI（动词层 + `--json` 双输出纪律）、JSON-RPC over
> HTTP、项目内 `/mcp/computer`（Streamable HTTP MCP 先例，docs/14）。

## 0. 现状基线（改造针对的事实）

| 事实 | 位置 | 与目标的差距 |
|---|---|---|
| RPC 全部只挂 WS 通道，HTTP 只有 14 个管理端点 | `backend/src/wsd.ts`（`registerMethod` 注册表）、`backend/src/index.ts`（~155 个方法注册）、httpRoutes `index.ts:834-971` | curl / shell 打不进来；68 个 smoke 脚本各自手搓 WS 帧，无共享客户端 |
| 外部 agent 的唯一文档化入口是 `POST /webhook/bot` | `index.ts:847-876` | 单轮问答触发器，不是操作面 |
| 无 CLI、无 SDK、无方法自描述 | ——（`backend/scripts/` 68 个手搓帧脚本即证据） | 「任意执行器操作本项目」没有门 |
| 聊天编排在前端：附件内联、续聊 vs 新段判定、模型回退链、回显登记 | `prototype/src/store/useWorkbench.ts:1285-1460`（`run()`） | headless 发一条消息需要重演整段 GUI 策略 |
| 出图流水线在浏览器（双模式、SSE 解析、任务历史 localStorage），daemon 只是密钥哑代理 | `prototype/src/core/imageApi.ts`（772 行）、docs/06 §八 | headless 不能出图；密钥本来就在 daemon 侧（`<homeDir>/image-profiles.json`），流水线却不在 |
| 通知聚合、任务栏聚合在前端 + localStorage | `store/useNotifications.ts`（514 行）、`useTaskbar.ts` | headless 查不到「发生过什么」的聚合事实源 |
| 模型偏好与目录口径部分在前端 | `core/modelPrefs.ts`、`core/models.ts`（769 行静态目录） | daemon 只有探测原语（`adapter.models` / `modeldefaults` / `modelcatalog`） |
| docs/07 方法表手工维护已陈旧（`ops.*` 已删仍在表） | `docs/07-wire-protocol.md` §四 | agent 能读到的契约文档不可信 |
| 鉴权与回环基建已就绪 | `backend/src/config.ts:57-133`（token 文件）、`authorize` `index.ts:1033-1060` | **无需改动，全盘复用** |

## 1. 设计决策（先定死，实现不再摇摆）

### D1 — 操作 / 呈现二分：上移的唯一判据

- **操作**：改变「其他客户端也看得见」的事实——会话轮次、bot 定义、git 状态、待办、
  自动化、注入矩阵、出图任务、通知事实……操作必须 100% 住在 daemon。
- **呈现**：只影响本端显示——标签命名与编号、颜色推导、已读标记、「你不在它面前」的
  过滤、侧栏布局。呈现留在 GUI，CLI 不做等价物。
- 落到现状：附件内联是操作（改变实际发出的 prompt 事实）；fork 后的父段视图重建是呈现
  （事实已在 trace / messages 里）。终端标签簿记是呈现（`terminal.list/transcript` 已是
  操作面）；外观颜色推导是呈现（`appearance.read/write` 已是操作面）。

### D2 — `POST /rpc`：同一注册表、同一信封，不开第二套路由

- 请求体 `{v:1, method, params}`（`id` 可缺省，daemon 回填），响应即 WS 响应信封：
  `{v:1, ok:true, result}` / `{v:1, ok:false, error:{code, message, data?}}`。
- **HTTP 语义映射**：传输层错误（未鉴权 401、未知路由 404、超限 413）用状态码；
  RPC 层错误一律 200 + body `ok:false`（JSON-RPC over HTTP 惯例）——curl 退出码不撒谎，
  错误细节在 body，CLI 退出码从 body 推。
- 鉴权全盘复用现有 authorize / token 面（`x-awb-token` 头——CLI 能设头，不像浏览器）。
- 流式不进 /rpc：事件流、终端 PTY 维持 WS（见 D4）。
- 不做批量调用——agent 自己并行发请求即可。

### D3 — `aw` CLI：透传层兜底 + 动词层高频，零依赖

- 新目录 `cli/`（独立 pnpm 包，与 backend 隔离——CLI 不得背上 node-pty / nut-js）。
  node ≥22 原生 fetch + WebSocket，**运行时零依赖**。bin 名 `aw`。
- 连接发现：`--url` > `AGENT_WORKBENCH_URL` > `http://127.0.0.1:5281`；
  token：`--token` > `AGENT_WORKBENCH_TOKEN` > `<homeDir>/token`
  （`AGENT_WORKBENCH_HOME` 同样尊重）。
- 两层命令面：
  - **透传层** `aw call <method> [--params JSON | --params-file -]`：全方法直达，agent 的
    兜底面。**GUI 有而 `call` 打不到的操作 = 缺口 bug**（回归判据，见 §3.6）。
  - **动词层** `aw bot list` / `aw session chat` / `aw backlog add` / `aw git status` ……
    只覆盖高频域（人机工效），长尾一律走 `call`，**不做 ~155 个方法的全量动词化**。
- 输出纪律：stdout 只放数据（默认紧凑人类可读，`--json` 强制机器口径），诊断走 stderr；
  退出码：0 成功 / 2 用法错 / 3 RPC 错（error.code 进 stderr 首行）。
- `aw methods`：方法自描述清单（D6）；`aw doctor`：自检（P5）。

### D4 — 事件面不加新端点：seq 游标已够

- 补拉：`session.events.since` / `session.trace`（per-session 单调 seq 游标，docs/08 WP-2 既有）。
- 跟随：`aw events [--session <id>] [--since <seq>] [--follow]`——`--follow` 走 WS 订阅转
  stdout JSONL，Ctrl-C 即断，seq 已落盘可续。
- 跨会话的「发生过什么」聚合事实由 D5 的 `notifications.list` 承担，不加全局事件端点。

### D5 — 编排上移清单（逐项裁决，GUI 与 CLI 同路径）

| 项 | 现位置 | 处置 |
|---|---|---|
| 附件内联（文本抽取进 prompt） | `useWorkbench.run()` | **上移**：`session.send` / `session.chat` 接受 `attachments: 路径[]`，daemon 侧抽取内联——agent 传路径即可，不必自己读文件拼 prompt |
| 续聊 vs 新段判定（含 session_not_live 降级链） | 同上 | **上移**：新编排方法 `session.chat`（找活会话→续聊；不活→start），headless 一条命令闭环一轮对话 |
| 模型回退链（visible→hint→retired→首个可见） | `visibleModelsFor` / `isModelAvailable` | **上移**：`session.chat` 的 model 支持 `"auto"`，回退链在 daemon 判 |
| 回显登记 / 去重 | `registerEcho` / `consumeEcho` | **留前端**（纯视图）；事实已在 trace，CLI 读 `session.messages` |
| fork 父段前缀回放 | `useWorkbench` | **留前端**（视图重建）；`session.start(fork)` 与 messages 读取面已够 |
| 出图流水线（images/responses 双模式、SSE、尺寸 hack） | `core/imageApi.ts` | **上移**：`image.generate`（daemon 跑 SSE 与双模式）；任务历史从 localStorage 迁 daemon store。修订 docs/06 §八（ADR 0015） |
| 出图保存位置 | `core/imageSave.ts`（File System Access 句柄） | **留浏览器**；CLI 侧 `--out <dir>` 路径参数化 |
| 通知聚合与自然键去重 | `useNotifications.ts` | **上移**：daemon 聚合成事实源，`notifications.list` 查询；已读标记与「你不在它面前」过滤留客户端 |
| 任务栏「正在播放」 | `useTaskbar.ts` | **留前端**（呈现）；数据源（session.list / 事件流）已可查 |
| 终端标签簿记 | `TerminalSessionManager.ts` | **留前端**（呈现）；`terminal.list` / `transcript` 已是操作面 |
| 外观颜色推导 | `core/appearance.ts` | **留前端**（呈现）；`appearance.read/write` 已是操作面 |
| 模型偏好 | `core/modelPrefs.ts` | **上移收敛**：并入既有 `adapter.modeldefaults` / `modelcatalog`，前端只留读展示 |
| 手动工作状态覆盖 | `useWorkState.ts` | **补齐映射**：busy 已对应 `backlog.state.forceBusy`，其余是纯显示 |

- **纪律**：每上移一项，GUI 同步改为调同一方法，前端旧策略代码**退役删除**——不做
  「daemon 新增、前端旧路保留」的双轨，那正是要消灭的漂移源。

### D6 — 方法自描述：注册表带元数据，docs/07 §四 变生成式

- `registerMethod(name, handler)` 扩展可选元数据 `{description, paramsHint, danger?}`——
  注册点就在 index.ts 各方法旁，**注释即元数据**，不另立文档。
- 自宿主方法 `rpc.methods`：返回全量 `{method, description, paramsHint, danger}`，
  `aw methods` 与文档生成脚本共用它。
- `backend/scripts/gen-methods-table.ts`：从注册表导出 docs/07 §四 表格，**手工表退役**，
  `ops.*` 陈旧问题根治。
- danger 只标真危险面（`daemon.stop`、`git.push`、`computerControl.actions`、
  `permissions.rules` 写、`bot.put`），用于 CLI 交互确认提示；`--yes` 跳过，
  agent 非交互模式不受阻——它有自己的人类在环。

### D7 — 权限不加第二套：token 即边界

- CLI 持 token = 与 GUI 等权。本地个人工具的心智不变：daemon 只绑回环 / LAN，
  token 文件即钥匙。
- 公网暴露继续走 docs/13 的既有轨道（tunnel），本计划不碰。

### D8 — MCP server 形态后置

- 项目已有 `/mcp/computer` 先例（Streamable HTTP，docs/14）。若后续确有「执行器在原生
  MCP 里直接操作工作台」的需求，再做 `/mcp/workbench` 或 `aw mcp`（stdio），工具面从
  `rpc.methods` 元数据生成白名单子集。**先用 CLI 的真实使用驱动决策，不为对称性预做。**

## 2. 分阶段任务

### P0 · 文档先行（半天，已完成 2026-10-22）
- [x] 本计划评审定稿
- [x] `docs/adr/0015-ai-native-operation-surface.md`：HTTP-RPC 桥 + `aw` CLI + 操作/呈现二分（含 docs/06 §八修订）
- [x] docs/06 §八表头加修订标注（指向 ADR 0015）
- [x] `CONTEXT.md` 词汇表新增：AI-native / 操作面 / 呈现 / `/rpc` 桥 / `aw` / 透传层·动词层 / `rpc.methods`

### P1 · HTTP-RPC 桥（后端，已完成 2026-10-22）
- [x] `httpd.ts`：`POST /rpc` 路由，handler 直调 wsd 注册表（同错误信封、同鉴权面）——实现为 wsd 抽出统一分发器 `dispatchRpc`，WS 与 HTTP 共用同一条调用路径
- [x] HTTP 语义映射与 401/404/413（含坏信封 400）传输层路径
- [x] `smoke:ai-native-rpc`：health 回环、鉴权拒绝、`ok:false` 信封、WS 同路径一致性、`daemon.stop` 走 /rpc 退出码 0（流式拒绝清单顺延：当前全方法是请求/响应形，无流式方法可拒，D2 的「流式留 WS」由 D4 承担）

### P2 · 方法元数据与自描述（后端，已完成 2026-10-22）
- [x] `wsd.ts`：registerMethod 元数据参数 + `rpc.methods` 自宿主方法（另加 `applyMethodMeta` 集中表通道——155 处注册形态混合，逐点改第三参不现实；集中表 + 启动 fail-fast 校验同防漂移）
- [x] 高频方法补 description / paramsHint —— 落地为全量 155 条（`backend/src/methods.meta.ts`）
- [x] danger 标注 7 个真危险面：daemon.stop / git.push / git.worktree.remove / bot.put / computerControl.setEnabled / mcp.save / mcp.remove（computerControl.actions 经 handler 实读是只读审计流，危险标注改挂 setEnabled）
- [x] `gen-methods-table.ts` + docs/07 §四替换为生成表（156 方法 29 域，锚点内勿手改）

### P3 · `aw` CLI（已完成 2026-10-22）
- [x] `cli/` 包 + bin（`pnpm -C cli link --global` 本地安装，.cmd shim 由 pnpm 生成；不发 npm）
- [x] 连接 / token 发现、`call` 透传层、`--json` / 退出码纪律（0 成功 / 2 用法 / 3 RPC 错 / 4 传输错——比计划多一档，agent 脚本可区分「daemon 不在」与「方法报错」）
- [x] 动词层首批：bot list/put/inspect/ask、session list/send/messages/cancel、backlog list/add/done（验收语义，新建议先执行后验收）、git status/commit、methods、events（补拉 + --follow）、doctor
- [x] `smoke:ai-native-cli`：起 daemon → `aw` 建 bot → 加待办 → 读状态 → 退出码矩阵，19 项断言（headless 无 GUI）；`session chat` 动词随 P4a 落地

### P4 · 编排上移（可按项独立落地，每项 ~0.5–1 天）
- [ ] P4a `session.chat`（附件路径化 + 续聊判定 + model `"auto"` 回退）+ GUI `run()` 改薄
- [ ] P4b `notifications.list` + daemon 聚合事实源 + GUI `useNotifications` 改薄
- [ ] P4c `image.generate` + 任务历史入 store + GUI 出图改薄 + docs/06 §八行项修订
- [ ] P4d 模型偏好并入 `adapter.modeldefaults` / `modelcatalog`
- [ ] 每项：前端旧策略代码退役删除 + 对应 smoke 扩展

### P5 · 收尾（~0.5 天）
- [ ] `aw doctor`（端口 / token / 执行器探测 / 版本）
- [ ] README 功能段；docs/00 北极星补一句（工作台可被 agent 操作 = 「数字员工模式」的自举）
- [ ] 「GUI 操作 × CLI 等价命令」对照表（本文件附录或独立文件），作为长期回归清单

## 3. 验收清单

1. `curl -X POST …/rpc -d '{"v":1,"method":"health"}'`、`aw call health`、GUI 状态栏同一事实
2. headless 全流程：无 GUI 起 daemon → `aw bot put` 建 bot → `aw session chat` 发消息（带附件路径）→ `aw session messages` 读到完整轮次
3. 事件不丢：`aw events --since` 补拉结果与 WS 订阅同源同 seq
4. docs/07 §四由生成脚本产出，与注册表零漂移（冒烟里跑 diff）
5. P4 每项落地后：typecheck + 全量既有 smoke 绿 + GUI 冒烟（`smoke:ui*`）不回退
6. 「GUI 操作 × CLI 等价命令」对照表全绿（GUI 的每个操作域都有 CLI 等价物，或明确列入 D1 呈现豁免）

## 4. 明确不做（防 scope 蔓延）

- 不做批量 RPC、不做事件流的 HTTP 推送化（维持 WS）
- 不做 ~155 方法全量动词化（长尾走 `aw call`）
- 不做终端 PTY 的 CLI 复用（agent 有自己的终端）
- 不做 npm 发包与全局安装器（`pnpm link --global` 即可，发布另议）
- 不加第二套权限系统（D7）；不碰公网暴露（docs/13 轨道不变）
- MCP server 后置（D8），不预做工具面
- 呈现项不做 CLI 等价物（D1 豁免清单即边界）
