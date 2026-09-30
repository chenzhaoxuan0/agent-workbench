# 08 —— 迈向 Bot 服务器：升级施工图（分工底稿）

> 本文回答一个问题：**把 agent-workbench 从"工作台原型"升级到"本机 Bot 服务器"形态，
> 要动哪些地方、每块怎么验收、谁能和谁并行。**
>
> 定位判断的来历（六个参照仓库 runtime 对比、cherry-studio 考证、dots/Cue/Muse 品类核实）
> 在 2026-09-30 的对话纪要里，本文只放施工结论；cherry-studio 一节待补入 `05-reference-map.md`。
>
> **分工单位 = 工作包（WP）**。每个 WP 标注：涉及面（前端/后端/契约）、前置依赖、规模
> （S ≤ 1 天 / M = 2-4 天 / L = 1 周+）、验收口径。验收口径是硬的，规模是估计。

---

## 一、目标形态（锚点）

**一台跑在本机上的、常驻的 bot 服务器 + 多端轻客户端。**

对齐 2026 年 9 月爆发的"bot 基本单位"品类（OpenAI dots 09-29 / Manus Cue 09-28 / Meta Muse 09-08），
但有两个它们给不了的差异点：**bot 跑在自己的电脑上**（真文件系统、真仓库、无云租金），
**每个 bot 一个真实文件夹**（身份即文件，git 可管）。

目标形态的六条特征，也是后续每个改动的检验标准：

1. bot 是基本单位：命名身份 + 文件夹 + loop 绑定 + 记忆 + 渠道 + 日程，可增删改；
2. 常驻：浏览器关了，daemon 照跑 cron、收 IM、跑会话；
3. loop 在外部：coding bot 用六家执行器（现状不动），日常 bot 未来可换 internal 轻 loop（冻结，见 WP-11）；
4. 记忆跟着 bot 走：三柱路由（已服务端化，Phase 7）；
5. bot 找得到你：IM 渠道 + 手机局域网 + webhook；
6. 可外露：一个 bot 可以被挂到别处（webhook / MCP 面）。

分层一句话：**daemon = bot 服务器（headless，唯一常驻权威）；prototype / 手机浏览器 / IM 网关 = 它的客户端。**

---

## 二、工作包总览与依赖

| WP | 名称 | 涉及面 | 前置 | 规模 | 优先级 |
|---|---|---|---|---|---|
| WP-1 | 执行器真流式（claude/codex 内联翻译） | 后端 | 无 | S | P0 |
| WP-2 | 事件流 seq + 断线重放 | 后端+前端+线协议 | 无（与 WP-3 同人顺手） | M | P0 |
| WP-3 | exportTrace 以落盘账本为准 | 后端 | 无 | S | P0 |
| WP-4 | 能力声明诚实化 | 契约+前后端 | 无 | S | P1 |
| WP-5 | Bot 定义收敛 + channels 字段 | 契约+后端+前端 | WP-4 完成后更顺（非硬依赖） | L | P0 |
| WP-6 | 前端收拢：一切设置读 Bot 对象 | 前端 | WP-5 | M | P1 |
| WP-7 | LAN 暴露 + 鉴权 + 手机适配 | 后端+前端 | 无 | M | P1 |
| WP-8 | IM 网关（waku 移植） | 后端 | WP-5 | M-L | P1 |
| WP-9 | per-bot 外露面（webhook / MCP） | 后端 | WP-5 | M | P2 |
| WP-10 | cherry 语义移植包（四件，可拆） | 契约+后端 | WP-2（幂等 usage 依赖 seq 口径） | S×4 | P2 |
| WP-11 | internal 轻 loop | — | **冻结**（见第四节） | — | P3 |

**并行轨道建议**（最多三人/三会话互不踩脚）：

- **轨道 A · 后端语义**：WP-1 → WP-3 → WP-2 → WP-10（全程在 `backend/src/runtime/` 与 `wsd.ts`）；
- **轨道 B · 契约与产品**：WP-5 → WP-6 → WP-8 → WP-9（契约大件在此轨，一次动完）；
- **轨道 C · 独立小件**：WP-4、WP-7 随时可插，不与 A/B 抢文件。

---

## 三、各工作包详情

### WP-1 执行器真流式 —— claude/codex 适配器改内联翻译

- **现状**：三个真执行器里只有 zcode app-server 是真流式（`adapters/zcode.ts:125` 的
  `onLine → handleLine`）。claude 与 codex 都是先把整轮 stdout 收进数组、`await exit`
  之后再批量翻译：`adapters/claude.ts` `spawnTurn/emitEvents`（212-373 行）、
  `adapters/codex.ts` `spawnTurn/emitEvents`（209 行起）。后果：`message.delta` 是追溯性的，
  UI 无逐字、`sessionStats` 的 ttftMs 失真、轨迹时间轴拉直。
- **改动**：把翻译搬进 `onLine` 逐行内联做——两个协议都是行分隔 JSON，逐行可译
  （init / stream_event / assistant / user 行即时 sink；`result` 行的终态聚合与
  usage / status 仍留到 exit 后统一收尾）。现有"delta 已实时推 + result 全文发
  message.completed"的双写语义保持不变。
- **验收**：`claude -p` / `codex exec` 轮次中 UI 逐字出现；`ttftMs` 非零且量级合理；
  mockperm 与 zcode 路径行为不变；冒烟脚本（`scripts/smoke-phase*.ts`）全绿。
- **参照**：本项目 `zcode.ts` app-server 路径（同构先例）。

### WP-2 事件流 seq + 断线重放

- **现状**：host 给每条事件盖了 `TraceRecord{seq, at}`（`runtime/host.ts`），但 WS 帧只有
  `{v:1, type:"event", event}`（`adapters/daemon/client.ts:88-104`），seq 没上线；
  断线时 close 处理只 reject 挂起 RPC，断线窗口内的事件永久丢失。对照：ZCode v4 帧
  带 `fromSeq/toSeq`，dsh 用 tail page 修 gap——这是六家里"事件流可靠性"的标配，我们没有。
- **改动**：
  1. WS 事件帧升级为带 `sessionId` + `seq`（沿用 host 已有的 TraceRecord seq，线协议加可选字段，`v` 不动）；
  2. 新 RPC `session.events.since(sessionId, afterSeq)`：热数据读 host 500 事件环，冷数据读落盘 trace 文件（WP-3 之后天然成立）；
  3. 前端 `DaemonClient` 记录每会话 `lastSeq`，`close` 后重连成功时对跟踪中的会话逐个 since 补拉，按 `(sessionId, seq)` 去重后进适配器队列。
- **验收**：devtools 手动断 WS → 期间 turn 继续跑 → 重连后时间轴无缺口、无重复；
  前端重放口径与 eval 断言共用同一个 `(sessionId, seq)`。
- **参照**：cherry-studio `AgentRuntimeEvent` 的幂等 id 思路、ZCode v4 topic 帧（考证见对话纪要）。

### WP-3 exportTrace 以落盘账本为准

- **现状**：落盘已经是对的——`runtime/trace.ts` 把每条 TraceRecord append-only 写
  `<home>/traces/<date>.jsonl`（带 `{"v":1,"format":"trace"}` 文件头）。**错的只是取用面**：
  `session.trace` RPC 返回的是内存 500 事件环（`index.ts:398-402` → `host.sessionEvents()`），
  超过 500 条的会话导出的 trace 是残本，eval/judge 消费到的是假完整。
- **改动**：`session.trace` 改为读 trace 文件、按 sessionId 过滤、NDJSON 返回；
  500 环降级为纯热缓存（WP-2 的 since 热路径继续用它）。大文件可加 `afterSeq` 游标参数。
- **验收**：造一个 >500 事件的会话，exportTrace 行数 = 落盘行数；`docs/06 §五`"落盘即轨迹"口径成立。

### WP-4 能力声明诚实化

- **现状**：`RuntimeCapabilities`（`core/adapter.ts`）粒度不够：它说得清"有没有权限流"，
  说不清"流式是真的还是批的""steer 能到哪个边界"。后者目前藏在适配器实现里，UI 与
  排期都容易误期（claude/codex 每轮 spawn 新进程，物理上无法 mid-turn steer）。
- **改动**：`RuntimeCapabilities` 增加两个字段：
  - `streaming: "realtime" | "batch"`；
  - `steering: "mid-turn" | "turn-end" | "none"`；
  各执行器如实声明（zcode app-server = realtime/mid-turn 候选；claude、codex = batch/turn-end；
  mockperm 跟 mock）。UI 据此渐进增强：batch 档不渲染假打字机光标。
- **纪律**：改 `core/adapter.ts` 一处，`backend/src/contract.ts` 的 re-export 让 typecheck
  自动红掉所有没跟上的适配器——这是 `docs/06` 契约纪律的机械保障，照走。

### WP-5 Bot 定义收敛 + channels 字段（契约大件，轨道 B 核心）

- **现状盘点**：Bot 的字段其实已经大半存在，但**家分了三处**——
  - 身份/绑定/记忆声明/日程：`core/units.ts` `WorkUnit`（identity / bindings / memory / schedule 都在）；
  - loop 偏好：浏览器 localStorage `agent-workbench:provider-profiles` / `:model-prefs`（前端）；
  - cron 与会话台账：daemon state.db（Phase 3/5）。
  致命伤：**浏览器关掉后 daemon 不知道任何 bot 的完整定义**——cron 只知道 unitId，
  没有模型、没有记忆路由、没有渠道。always-on 无从谈起。
- **改动**：
  1. 契约：`WorkUnit` 增加 `channels` 字段（`{ kind: "telegram"|"discord"|"webhook", config: …, enabled }[]`）——这是唯一缺失的领域字段；
  2. **家收敛到磁盘**，顺着项目自己的"文件即数据库"哲学：每个 bot 的 rootPath 下落一份机器可读清单（建议 `<rootPath>/.agent-workbench/bot.json`，或 AGENTS.md frontmatter，二选一在动工时定），内容 = WorkUnit 全量（含 loop 绑定、记忆路由、渠道、日程）；
  3. daemon 新增 bot registry：启动时扫描（或按需注册）各 bot 清单文件，cron / IM / webhook 从这里取完整定义；前端降级为"编辑器 + 缓存"，localStorage 五键迁移为清单文件的写穿缓存。
- **验收**：新建 bot → 关浏览器、清 localStorage → daemon 重启 → 侧栏 bot 仍在（磁盘扫描）、
  cron 仍按定义触发、IM 渠道配置仍在。AGENTS.md 仍是身份的源文件（`units.ts` 头注释的承诺不破）。
- **规模说明**：L 的原因在迁移与两端耦合，不在字段本身；建议单独一个会话专职做，期间轨道 A 不动 `core/units.ts`。

### WP-6 前端收拢：一切设置读 Bot 对象

- **现状**：`ProviderInstancesPanel` / `ModelSettings` / 记忆设置 / 自动化页各自读写
  自己的 localStorage 键，与 WorkUnit 的绑定关系靠约定。
- **改动**：全部改读写 WP-5 的清单文件（经 daemon RPC），localStorage 键保留一版
  只读迁移后废弃；侧栏一个 bot 行 = Bot 对象的投影（`kind: "project"` 的单元走原逻辑不动）。
- **验收**：任一设置改动 → 磁盘清单文件 diff 可见 → 换浏览器打开配置一致。

### WP-7 LAN 暴露 + 鉴权 + 手机适配

- **现状**：监听已支持 env 覆盖（`config.ts:51`，`AGENT_WORKBENCH_HOST`，默认 127.0.0.1）——
  **缺的不是监听是鉴权**：WS/REST 完全裸奔，绑 0.0.0.0 等于把执行器和终端 PTY 送给局域网；
  prototype 无窄屏适配审计。
- **改动**：
  1. 首启生成 token 落盘（`<home>/token`），REST/WS 全部要求鉴权头或 `?token=`（WS 必须查）；
  2. `0.0.0.0` 仅显式 opt-in（env），文档写明风险；
  3. prototype 窄屏 pass：侧栏抽屉化、composer 安全区、轨迹单列——一次 playwright 移动视口跑查；
  4. README 加"手机同一 WiFi 打开 `http://<pc-ip>:5181`"一节。
- **验收**：手机浏览器完成一轮真实会话（发消息、看流式、批权限）；无 token 的外部请求全 401。

### WP-8 IM 网关（waku 移植）

- **现状**：无。daemon 有 cron"到点起会话"的先例（Phase 5，`automation/scheduler.ts`），
  但没有"消息进来 → 起/续会话 → 回出去"的入站通道。
- **改动**：daemon 新增 `channels/` 模块：Bot 的 channels 绑定（WP-5）→ 收 IM 消息 →
  找到/创建该 bot 的会话 → `sendMessage` → 订阅事件流取 `message.completed` → 回 IM。
  语义对齐 waku gateway（MIT，`waku/gateway/runner.py`）：**单 bot 串行排队**（多消息排队不并发）、
  长任务先回执后补结果。首版只做 Telegram 或 Discord 一家（动工时定），第二家抄第一家的模板。
- **验收**：在 IM 里 @bot 说"看看 X 仓库的 lint 报错并修掉" → 本机跑真实会话 → IM 收到结果文本；
  连发三条消息 → 串行执行不乱序。
- **安全**：IM 侧 bot 权限档默认取 Bot.loop.mode（yolo 只允许显式配置），权限卡语义在 IM 侧
  降级为"预先声明档位"（headless 无审批面，与 claude -p 同理）。

### WP-9 per-bot 外露面（webhook / MCP）

- **改动**：入站 webhook（`POST /bot/:id/hook` → 触发会话，鉴权走 WP-7 token + per-bot secret）；
  MCP server 面：daemon 起一个 MCP stdio/HTTP server，把"给某 bot 发一条消息并等完成"暴露为一个
  tool——**别的 AI 客户端（含 ZCode 本体）就能把你的 bot 当工具调**，这就是"挂到别的地方"的最小实现。
- **验收**：curl 一个 webhook 触发 bot 干活并拿到回执；在 ZCode 里通过 MCP 调用本机 bot 成功。
- **参照**：waku 的多 gateway 共用 `respond()` 的 seam 哲学（`waku/app.py` 头注释）。

### WP-10 cherry 语义移植包（四件，每件独立可做）

对照 cherry-studio `src/main/ai/runtime/types.ts` 的 `AgentRuntimeEvent`，逐件抄设计不抄代码（AGPL）：

1. **resume-token 事件化**（S）：`externalRef()` 现在靠前端轮询；改为 `usage` 旁随一条
   `{type:"session.ref", sessionId, ref}` 事件主动下发。契约加一个 union 分支即可。
2. **幂等 usage**（S）：usage 事件加 `requestId`（driver 命名，如 `claude:<cliSessionId>:<n>`），
   落库幂键——重放/补拉不重复计费（依赖 WP-2 的重放机制，否则无意义）。
3. **steer 档位事件**（M）：`steer.queued` / `steer.boundary` / `steer.undelivered` 三个事件，
   host `pendingSends` 现在只有"轮落定后发"一档；补齐"没赶上 → 转下轮"的显式事件，前端时间轴
   不用猜消息顺序。真 mid-turn 只有望 zcode app-server 档后续跟进（WP-4 的 steering 声明先立住边界）。
4. **孤儿会话回收**（M）：daemon 重启后对外部 CLI 会话（claude jsonl / codex thread）做
   list + stale reclaim 的治理面——cherry 的 `orphanSessionReclaim` 语义，防 cli_ref 漂积。

### WP-11 internal 轻 loop —— 冻结

**冻结条件**：WP-5 落地且出现"不需要 coding CLI 的日常 bot"的真实需求（提醒 bot、IM 陪伴 bot）
才解冻。解冻时的参照已备好：cherry aiSdk 双物种（chat 走进程内 ToolLoopAgent、agent session 走
外部运行时，同一注册表共存）+ pi `agent-loop.ts`（MIT，外层 follow-up / 内层 steering 的双循环
骨架可直接照抄语义）。`TransportKind: "internal"` 槽位已预留，无需改契约。

---

## 四、契约纪律（改动红线，全部 WP 适用）

1. **唯一事实源**：契约类型只活在 `prototype/src/core/`（adapter.ts / events.ts / units.ts），
   `backend/src/contract.ts` 只 re-export——改契约先改 core，typecheck 红线自动揪出没跟上的适配器（`docs/06`）。
2. **线协议演进**：WS 帧只加可选字段、`v` 头不动；落盘格式升版学 `trace.ts` 的文件头做法
   （首行 `{"v":1,...}`），行内容永不原地改义（`docs/07`）。
3. **新事件类型** = events.ts 加 union 分支 + 各适配器补 mapper + 渲染层零改动
   （`adapter.ts` 头注释的验收标准原文）。
4. **能力新增** = `RuntimeCapabilities` 加字段 + `FULL_CAPABILITIES` 对照更新 + 各执行器如实声明，
   UI 只做渐进增强，不为缺能力渲染空壳。

## 五、不做清单（本轮明确不碰）

- **不整体二开 cherry-studio、不换 Electron 宿主**——AGPL-3.0（已核实 LICENSE）+ 宿主形态
  与"headless 常驻 bot 服务器"矛盾；cherry 只抄契约设计。
- **不自研 LLM agent loop**（WP-11 冻结条款）。
- `docs/05` 未移植清单维持后置：三泳道时间轴、Arena SSE 直播、fal.ai 供应商族、遮罩编辑器、
  透明背景 canvas 后处理。
- 多用户、云同步、移动原生 App（手机 = 浏览器/PWA，不写 App）。
- t3code 式 Effect 化——`adapter.ts` 头注释已否决过一次，不再议。

## 六、里程碑（三个可演示切片）

| 里程碑 | 内容 | 演示脚本 |
|---|---|---|
| **M1 地基可靠** | WP-1 + WP-2 + WP-3 + WP-4 | 关浏览器 → turn 继续跑 → 重开无缺口无重复；claude turn 逐字出现；>500 事件会话 trace 完整导出 |
| **M2 Bot 是基本单位** | WP-5 + WP-6 + WP-7 | 清 localStorage + 重启 daemon，bot 与其 cron 完好；手机浏览器与桌面看到同一 bot 同一会话 |
| **M3 Bot 找得到你** | WP-8 + WP-9（WP-10 穿插） | Telegram 里 @bot 修 lint → 本机真实会话 → IM 回报；ZCode 经 MCP 把本机 bot 当工具调通 |

每个里程碑结束跑一遍 `scripts/smoke-*.ts` 全家 + e2e outbox 验证脚本（项目既有的验收闭环）。
