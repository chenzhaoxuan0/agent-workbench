# 线上协议 v1 —— 前端 ↔ daemon 的帧契约

> `prototype/src/core/events.ts` 定义的是**数据形态**（daemon 往外推什么）；
> 本文定义的是**传输语义**（帧怎么封包、方法怎么调用、错误怎么表达）。
> Phase 0 已实现并冻结，实现在 `backend/src/wsd.ts`，验收在 `backend/scripts/smoke-health.ts`。
>
> 与 `adapter.ts` / `events.ts` 同一纪律：改这份协议 = 两个会话先对齐。

---

## 一、通道划分

| 通道 | 载体 | 用途 |
|---|---|---|
| 事件流 | WebSocket `ws://<host>:<port>/ws` | daemon → 前端推 `RuntimeEvent`；前端 → daemon 调方法 |
| 管理面 | HTTP REST | `/healthz` 及后续配置类端点（无会话数据，重连由 WS 通道负责） |

默认 `127.0.0.1:5181`（前端 dev server 是 5180），环境变量见 `backend/README.md`。
**daemon 只绑回环**——它能 spawn 任意进程，不对外网开门。

## 二、信封（envelope）

所有 WS 帧都是单条 JSON 文本，`v` 固定为 `1`。

**前端 → daemon（请求）**

```json
{ "v": 1, "id": "c-17", "method": "health", "params": null }
```

- `id`：前端生成的任意字符串（建议单调），daemon 原样回填；并发调用靠它配对。
- `params`：可缺省；各方法的 schema 随方法定义，本文不集中枚举。

**daemon → 前端（响应，必与请求配对）**

```json
{ "v": 1, "id": "c-17", "ok": true,  "result": { "…": "…" } }
{ "v": 1, "id": "c-17", "ok": false, "error": { "code": "unknown_method", "message": "no such method: xyz" } }
```

**daemon → 前端（推送，无 id）**

```json
{ "v": 1, "type": "hello", "daemon": { "version": "0.1.0", "pid": 1234, "uptimeMs": 42 } }
{ "v": 1, "type": "event", "event": { "type": "message.delta", "…": "…RuntimeEvent…" } }
{ "v": 1, "type": "terminal", "terminalId": "term_…", "kind": "data", "data": "…" }
```

- 客户端 TCP 连上即收到 `hello`，之后 `event` 帧里的 `event` 就是 `events.ts` 的 union 原样序列化。
- **会话生命周期（agent loop 语义）**：`session.started` 之后，每一轮 turn 完成发
  `message.completed` + `usage` + `session.status`（idle/failed/running）——**会话保持开启**，
  同会话 `session.send` 续聊即 agent loop（上下文连续）。`session.ended` 只在真关闭时发：
  `session.closed` / 执行器退出。turn 失败可重试（同一会话再 send 即可）。
  这套语义与 T3 的编排一致（thread 长存、turn 完成是独立里程碑、会话开始后锁定模型实例、
  参数面只暴露执行器自告的旋钮——无采样位、无轮次预算），T3 源码考证见
  `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` 与
  `docs/internals/overview.md`。
- `terminal` 帧是终端数据流（`kind: "data" | "exit"`，exit 带 `exitCode`）——高频且非契约事件，独立于 `event` 流，不落轨迹。
- **解析不出 `id` 的帧**（非 JSON / envelope 不合法）回 `id: null` 的错误帧——这是唯一允许 `id` 为 null 的场景。

## 三、错误码

| code | 语义 |
|---|---|
| `bad_frame` | 非 JSON，或 envelope 不满足 `{ v:1, id:string, method:string }` |
| `unknown_method` | 方法未注册 |
| `internal` | handler 抛错且未带 `code`；带 `Error.code` 属性时原样透传 |

## 四、方法注册表

| 方法 | 状态 | 说明 |
|---|---|---|
| `health` | **已实现** | params 无；result 同 `GET /healthz` 响应体 |
| `daemon.stop` | **已实现** | ack `{ stopping: true }` 后优雅退出（退出码 0） |
| `adapter.list` | **已实现** | 已注册执行器摘要 `{id, displayName, glyph, models[], capabilities}` |
| `adapter.probe` | **已实现** | params `{runtimeId}`；result 为契约 ProbeResult |
| `session.start` | **已实现** | params `{runtimeId, unitId, unitName?, rootPath, prompt, model?, mode?}`；result 为契约 Session；后续事件经事件流推送 |
| `session.send` | **已实现** | params `{sessionId, text}`；多轮续聊 |
| `session.cancel` | **已实现** | params `{sessionId}` |
| `session.list` | **已实现** | result 为契约 Session[]（按开始时间倒序），含累计 stats |
| `permission.resolve` | **已实现** | params `{sessionId, requestId, decision: allow\|deny\|always}`；`always` 的规则表落盘在 Phase 4 |
| `terminal.create` | **已实现** | params `{cwd?, shell?, cols?, rows?}`；result `{terminalId, shell}`；数据经 `terminal` 帧推送 |
| `terminal.input` | **已实现** | params `{terminalId, data}` |
| `terminal.resize` | **已实现** | params `{terminalId, cols, rows}`（多窗格各自独立 resize） |
| `terminal.kill` | **已实现** | params `{terminalId}`；exit 帧随后到达 |
| `terminal.list` | **已实现** | 活跃终端清单 |
| `automation.create` | **已实现** | params `{unitId, unitName?, runtimeId, rootPath, prompt, model?, mode?, cron}`（5 字段 cron，创建时即校验） |
| `automation.list` / `automation.runs` | **已实现** | 定义清单 / 指定 id 的运行记录（一行一次，含 session_id 与终态） |
| `automation.setEnabled` / `automation.delete` | **已实现** | 启停与删除 |
| `automation.runNow` | **已实现** | 立即起一次（runId + sessionId），会话结束态回灌运行记录 |
| `ops.evalRun` | **已实现** | params `{datasetName, rows[{id,input,expect_tool?,expect_in_args?}], runtimeId, judgeMetrics?}`；确定性 0/1 + GEval judge（真 LLM 调用，缺裁判整层跳过）；落 eval_runs.jsonl（50 滚动） |
| `ops.arenaRun` | **已实现** | params `{prompt, runtimeIds[], judgeMetric?}`；Completion 机械分 / Quality 裁判分；落 compare/history.jsonl（50 滚动） |
| `memory.save` / `memory.search` / `memory.list` | **已实现** | 三柱（semantic/episodic/procedural）写入广播、检索并集、逐柱清单；sqlite 后端 LIKE 兜底，WeKnora 语义增强不可达时记错误不炸 |
| `memory.routing.get/set` | **已实现** | pillar → backends[] 路由表（kv 落盘，调用时可 per-bot 覆盖） |
| `memory.weknora.config.get/set` | **已实现** | WeKnora baseUrl/apiKey（读取掩码）/kbIds |
| `memory.mirror` | **已实现** | 读 `.waku/memory/MEMORY.md`（语义柱写入时自动重生成） |
| `session.resume` | **已实现** | params `{sessionId}`；从 state.db 的 cli_ref 接回执行器，之后 send/cancel 照常 |
| `session.messages` | **已实现** | params `{sessionId}`；落盘的对话流（user/assistant），前端重载会话用 |
| 自动化 / Ops / 记忆方法 | Phase 5–7 | 落地时在此表登记 schema |

**为什么有 `daemon.stop`**：Windows 上跨进程 SIGTERM 不可投递（冒烟实证，`child.kill("SIGTERM")` 后子进程无动于衷）。程序化退出一律走协议；SIGINT/SIGTERM 处理器保留给终端 Ctrl+C 与 Unix。这是 Phase 0 的一个硬结论，后续 PTY / 子进程管理会反复遇到，处置口径一致：**能走协议的走协议，信号只当人肉兜底**。

**Phase 1 执行器事实（zcode）**：daemon 的 zcode 执行器走 **`zcode app-server --stdio`（ZCode Protocol v1）全能力路径**——真流式 delta、工具事件、权限反向流（与 Phase 4 权限闸闭环）、真 usage、跨进程 resume。前提是本机安装的 zcode CLI 带有 fork 补丁 `awb/standalone-app-server`（app-server 入口补 standalone 引导 + 认证头端口内接；两处都在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`，已实测并提交到 zcode 克隆的该分支）。CLI 未打补丁时 daemon **自动降级**到 `zcode -p --json` 回退路径（真实回复/usage/多轮仍在，无流式/工具/权限事件），进程生命周期内不再回头。

## 五、版本与演进

- 不兼容变更升 `v`；届时 daemon 同时监听新旧 `v` 一个过渡期。
- 只加方法、只加可选字段不算不兼容，`v` 不动。
- `RuntimeEvent` 本体的演进仍走 `events.ts`（契约纪律见 `docs/06` §一/§九），本文只管封包层。

## 六、REST（管理面）

| 端点 | 说明 |
|---|---|
| `GET /healthz` | `{ ok, name, version, pid, uptimeMs }` |
| `GET /api/permissions/rules` | 权限规则清单 |
| `POST /api/permissions/rules` | 新增规则 `{pattern, decision, runtimeId?, kind?}` → `{id}` |
| `DELETE /api/permissions/rules?id=N` | 删除规则 |
| `POST /api/permissions/resolve` | 审批决策 `{sessionId, requestId, decision}`（与 WS `permission.resolve` 同义） |
| 其他 | JSON 404 `{ ok:false, error:{ code:"not_found", … } }` |

会话数据不走 REST（都在 WS 事件流），管理面只放配置与审批类端点。
