# AI-Native 操作面：HTTP-RPC 桥、`aw` CLI 一等公民、操作/呈现二分

agent-workbench 的使用者和操作者不只是人：用户手边的任意执行器（zcode / claude / codex / opencode……）应当能操作这个工作台本身——GUI 能做的每件事，agent 用一条命令也能做，即 AI-native。勘察（2026-10-22）：daemon RPC 已近全覆盖（~155 个方法、统一 method/id 信封、seq 事件游标、token 鉴权），但 RPC 只 WS 可达，无 CLI / SDK / 方法自描述；聊天编排、出图流水线、通知聚合、模型偏好等操作逻辑长在 prototype 前端，docs/06 §八还把出图明确决策为「留在浏览器」。本 ADR 记录三个决策，完整任务清单见 docs/21。

## Considered Options

**外部 agent 的门怎么开**

- **教 WS 协议 / 发 SDK 包（否决）**：每个消费者都要实现 WS 客户端与帧配对——`backend/scripts` 下 68 个 smoke 各自手搓帧就是这门课的学费；SDK 又是一层要单独维护的真相。
- **HTTP-RPC 桥复用同一注册表 + 零依赖 CLI（采纳）**：`POST /rpc` 直接调 wsd 的 registerMethod 注册表，同信封、同错误码、同鉴权；curl 一行可达，`aw` CLI（node≥22 原生 fetch/WebSocket，零运行时依赖）做人机工效层。注册表仍是唯一事实源，不开第二套路由。
- **直接做 MCP server（否决，后置）**：工具面要裁剪、依赖执行器侧 MCP 生态；CLI 先行，MCP 等真实需求出现再做（参照 `/mcp/computer` 先例）。

**GUI-only 编排逻辑怎么办**

- **CLI 侧复刻一份编排（否决）**：两套事实，漂移只是时间问题。
- **前端逻辑全部上移（否决）**：File System Access 句柄、颜色推导、终端标签簿记是纯呈现，上移无收益。
- **操作/呈现二分逐项裁决（采纳）**：操作 = 改变其他客户端也可见的事实（附件内联、续聊判定、模型回退链、出图流水线、通知聚合、模型偏好——上移 daemon，GUI 改薄为同路径调用）；呈现 = 只影响本端显示（回显登记、fork 视图重建、已读标记、「你不在它面前」过滤——留 GUI，CLI 不做等价物）。

**docs/06 §八「留在浏览器」**

- **维持原决策（否决）**：与 AI-native 目标直接冲突——出图与模型偏好是操作，headless 必须可达。
- **整节推翻（否决）**：句柄类与呈现类留浏览器仍是对的。
- **逐项修订（采纳）**：出图流水线（`image.generate`——密钥本就在 daemon 侧 `image-profiles.json`）与模型偏好上移；出图保存句柄、外观推导、终端簿记留浏览器。docs/06 §八表加修订标注指向本 ADR。

## Consequences

- `POST /rpc`：body `{v:1, method, params}`，响应同 WS 信封；RPC 层错误一律 200 + `ok:false`，传输层错误才用 401/404/413；鉴权复用 authorize/token（`x-awb-token` 头）。
- `cli/` 新包 + `aw` bin：透传层 `aw call`（全方法兜底，GUI 有而 call 打不到 = 缺口 bug）+ 动词层（仅高频域）；stdout 只放数据、`--json` 机器口径、退出码映射；`aw events` 用既有 seq 游标补拉、`--follow` 走 WS——事件面不加新端点。
- 编排上移：`session.chat`（attachments 路径化 + 续聊判定 + model `"auto"` 回退链）、`notifications.list`（daemon 聚合事实源，已读标记留客户端）、`image.generate`（任务历史入 store）、模型偏好并入 `adapter.modeldefaults`/`modelcatalog`。前端对应策略代码退役删除，不做双轨。
- registerMethod 扩展元数据（description / paramsHint / danger），自宿主方法 `rpc.methods`；docs/07 §四方法表改脚本生成，手工表退役。danger 只用于 CLI 人机确认（`--yes` 跳过），不构成 agent 拦截。
- 权限不加第二套：token 即边界，CLI 与 GUI 等权；公网暴露维持 docs/13 tunnel 轨道。
- 明确不做：批量 RPC、~155 方法全量动词化、终端 CLI 化、npm 发包、MCP server 预做。
