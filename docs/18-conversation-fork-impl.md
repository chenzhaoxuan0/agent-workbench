# 对话分叉实施计划（ADR 0013 落地细化 · P1+P2）

> 决策记录在 `docs/adr/0013-conversation-fork.md`（选型：分支=新物理段、
> 谱系从链变树、UI 无损拼接 / 上下文有损前缀）。本文是 P1（最小闭环）
> + P2（编辑重发）的落地细化：每一步给出现状代码落点（文件:行号，
> 基线 git `f1f3c1d`）与具体改法。
> 前置调研：ZCode `packages/ui` 渲染管线走查（见 docs/17）+ 本仓
> sessions 台账 / HANDOFF / 回放 / 门禁 / Composer 草稿机制专项走查（2026-10-18）。

---

## 〇、对 ADR 0013 的一条细化决议

**"从此处分叉"（branch）与"编辑重发"（revision）统一走「意图 + 发送才建段」。**

点分叉/编辑不立即建空段，而是进入 `pendingFork` 意图态（composer 顶部
显示意图提示条，可取消），首次发送才 `startSession`。这是把 ADR 不变量 5
（"编辑即草稿，发送才 fork"）从 edit 扩展到 branch 入口：

- 避免空段污染侧栏（用户点完分叉就反悔 = 零持久化）；
- branch 与 revision 共用同一条意图→发送链路，少一套机制；
- 与 Maka side_conversation 的懒创建（P4）方向一致，P4 可复用。

UI 上 branch 与 revision 的意图提示条文案不同（"将在此轮之后开启新段分叉"
vs "将编辑此轮并开启新版本"），发送前可见可撤。

---

## 一、现状与代码落点（实施前事实）

| 主题 | 现状 | 落点 |
|---|---|---|
| 迁移机制 | 无版本号，try/catch ALTER 逐列自愈；ADR 0012 加三列（conversation_id/last_seq/turn_count）是直接模板 | `backend/src/store/db.ts:257-268` |
| upsertSession | INSERT 13 列 + ON CONFLICT UPDATE；conversation_id 不进 UPDATE（"行创建后不可变"先例） | `db.ts:319-343`；唯一 insert 调用点 `runtime/host.ts:1001-1015` |
| session.start 契约 | 已有 `conversationId?` 与 `handoff?: { fromSessionId }`（ADR 0012） | 前端 `prototype/src/core/adapter.ts:161-193`；RPC 校验 `backend/src/index.ts:2775-2839`；host 输入 `runtime/host.ts:179-223` |
| HANDOFF | `buildHandoffBlock` = listMessages 取最近 24 条、单条截 4000 字；messages 表**无 seq 列** | `host.ts:1157-1191`；挂载点 `host.ts:933-943`；dispatch 快照 `host.ts:1016-1057` |
| 谱系回放 | openSession 平铺聚合：`(s.conversationId ?? s.id) === lineageRoot` 按 startedAt 排序逐段全量回放，跨段本地重编 seq 防 key 撞 | `prototype/src/store/useWorkbench.ts:763-787`（764 行注释） |
| idle 门禁 | `runtimeSwitchBlocked` 纯函数（busy + active.status ∈ running/awaiting_*）；后端无对应校验 | `useWorkbench.ts:1276-1280`，消费点 selectRuntime:672-715 / openSession:719 / SwitchHintCopy |
| busy | 事件驱动 set 的布尔（run/openSession 置位，session.ended/message.completed 等复位） | `useWorkbench.ts:1028/1059/1093/1300/1308/1319` |
| 轮次 | 账本有 turn.started/turn.completed（events.ts:58-73）但 groupTimelineEvents 丢弃；前端无 turn 分组 | `Timeline.tsx:142-252` default 分支 |
| hover 交互 | UserMessageBubble 无任何 hover 动作 | `Timeline.tsx:296-343` |
| Composer 草稿 | draft 在 zustand（useWorkbench.ts:120/389），外部填自动 focus（Composer.tsx:148-151）；**attachments 是 Composer 本地 useState，不在 store** | `Composer.tsx:57`、`submit()` 302-314 |
| 文案 | SwitchHintCopy 三态、selectRuntime notice、divider 文案 | `RuntimePicker.tsx:415-443`、`useWorkbench.ts:708-712`、`Timeline.tsx:271` |
| 冒烟模式 | spawn daemon → WS RPC 客户端 → check 断言 → 优雅退出；mockperm 夹具每轮挂权限 | `backend/scripts/smoke-phase8.ts`（模板）、`smoke-phase3.ts`（双 daemon 重启） |

关键约束：

1. 前端 `sessions[]` 是易失运行态——fork 列表/折叠每次现拉 `fetchSessions()`
   （现有两处调用 useWorkbench.ts:769/1070 是模板）；`DaemonSessionRow`
   （daemon/client.ts:1322-1332）需加 fork 三列。
2. openSession 落位顺序硬约束（review P0）：selectUnit → selectRuntime → 大 set，
   fork 切段沿用，否则被自家 idle 门禁拦。
3. 回放不经事件泵：拼接/判重全在读取端处理（useWorkbench.ts:764/783 既有做法）。
4. **前端不持有可靠的 daemon 侧 seq**（timeline 项 id 回放时本地重编）——
   fork_at_seq 的解析必须放 daemon 侧（见 B2）。

---

## 二、P1 实施步骤

### B1. 三列迁移（`backend/src/store/db.ts`）

- 照抄 257-268 模板，紧随其后加：

  ```sql
  ALTER TABLE sessions ADD COLUMN fork_of_session TEXT
  ALTER TABLE sessions ADD COLUMN fork_at_seq INTEGER
  ALTER TABLE sessions ADD COLUMN fork_kind TEXT   -- 'branch' | 'revision'
  ```

- 同步：`SessionRow` 接口（db.ts:20-47，注释"行创建后不可变"）、
  `toRow` 反序列化（db.ts:1231-1253）、`upsertSession` INSERT 列清单
  （db.ts:319-343）——**三列只进 INSERT，不进 ON CONFLICT UPDATE**
  （conversation_id 同款先例）。
- host 侧：`HostSession`（host.ts:129-177）/ `StartSessionInput`
  （host.ts:179-223）/ insert 点（host.ts:971-1015）/ `toSession`
  （host.ts:867-888）补三列读写。

### B2. 契约扩展 + anchor→seq 解析（daemon 侧）

- `StartSessionRequest`（prototype/src/core/adapter.ts:161-193）加：

  ```ts
  /** 对话分叉（ADR 0013）：在源段某轮边界开新段。发送才建段（意图态见 docs/18 §〇）。 */
  fork?: {
    ofSessionId: string;
    /** 锚点：助手消息 id（message.completed，UI 主入口「从回复处分叉」）或
        用户消息 id（message.delta role=user，编辑重发 revision 用） */
    anchorMessageId: string;
    /** branch=含锚点轮整轮（through）；revision=锚点轮之前（before，编辑重发） */
    kind: "branch" | "revision";
  };
  ```

- **seq 解析放 host**（前端没有可靠 seq）：`session.start` 处理时扫源段账本
  （traceSink.readSessionNdjson，index.ts:2905-2908 有现成用法）定位
  anchorMessageId：
  - `branch`：fork_at_seq = 该轮 turn.completed 的 seq（含整轮，含助手回复）；
  - `revision`：fork_at_seq = 锚点轮之前最后一个事件的 seq（不含该轮）。
- RPC 校验（index.ts:2775-2839，与 worktree/handoff 同口径"给了但不合法
  = bad_params"）：ofSessionId 在台账存在、anchorMessageId 在源段账本可解析、
  kind ∈ {branch, revision}。
- 解析结果连同原始 fork 入参写进新段 sessions 行（B1 三列）；
  `conversationId` 照常继承（谱系仍是一棵树一个根，ADR 决议）。

### B3. HANDOFF seq 上界（`backend/src/runtime/host.ts:1157-1191`）

- `buildHandoffBlock` 增加可选上界参数：fork 启动时改走 **trace 账本投影**
  ——readSessionNdjson 过滤 `seq ≤ fork_at_seq` 的 user/assistant 消息事件，
  再套既有 24 条 / 单条 4000 字上限（messages 表无 seq 列，不能走 listMessages）。
- 无 fork 的普通跨执行器切换行为完全不变。
- dispatches 快照机制不变（injectedBlock 照落，可追溯"这个分支当时带了什么"，
  ADR 不变量 3）。

### B4. 行形状透传

- `session.list` RPC 响应（index.ts:2852 → host.listSessions）补 fork 三列；
- 前端 `DaemonSessionRow`（daemon/client.ts:1322-1332）+ `Session` 类型
  （prototype/src/core/units.ts:313）+ 映射处补三列；
- `UnitHistoryEntry`（index.ts:1529-1552）补三列（侧栏/HistoryDialog 用）。

### B5. 分叉入口 UI（`prototype/src/ui/Timeline.tsx` + store + Composer）

- groupTimelineEvents 给 `user.message` 项补记 `messageId`（anchor 用）；
- `UserMessageBubble`（296-343）加 hover 动作（`group/msg` 已有 hover 语境）——
  **实测修正（2026-10-18 二次）**：分叉入口从用户消息移到**助手消息底部 meta 行**
  （参考 ZCode ConversationAssistantTextActions 的轮尾动作行）：
  - 助手消息底部 meta 行：**左 = 时间 + 「分叉」按钮**（图标+文字，流式中/
    busy 禁用；锚点 = 该条回复的 messageId，branch=through 含本轮），
    **右 = 模型 · token 上下行**（usage 事件由 groupTimelineEvents 并入助手块，
    不再独立成行，**不显示计费**）；时间从消息头部挪到底部。
  - 用户消息只留**铅笔编辑入口**（末轮 latestQueryEditOnly + idle 门禁 +
    echo 回填 user-N 锚点就绪）→ **就地编辑**（参考 ZCode UserInputRowView）：
    原位把气泡替换为编辑器（预填原文，Enter 重发 / Shift+Enter 换行 / Esc 取消），
    重发 = `store.editAndResend`：revision 意图 + 立即 run（不经过 composer）。
  - 初版「纯 hover + 气泡上方独立行」的教训：hover 显示触屏不可触发、位型
    不合惯例，实测找不到入口；CDP 验证脚本 `verify-fork-button.ts`
    （smoke:ui:forkbutton）覆盖：助手分叉按钮存在/可用、usage 并入、无计费、
    就地编辑 → revision 分叉标记 → 新内容进新段的端到端链路。
- 点击 → store 设 `pendingFork: { ofSessionId, anchorMessageId, kind }` +
  （revision 时）`setDraft(原文)`——draft 自动聚焦已有现成机制；
  branch 则聚焦空 composer；
- Composer 顶部意图提示条（`Timeline.tsx` Composer 上方或 Composer 内部）：
  branch 文案"发送后将从所选轮之后开启新段（所选轮之前的对话以只读前缀带入）"；
  revision 文案"发送后将在新段替换此轮重新开始（此轮之前保留）"；右侧
  "取消"按钮清意图（零持久化）；
- 已知限制（文档 + 提示条 tooltip 声明）：编辑重发不还原附件
  （attachments 是 Composer 本地态，不在 store）。

### B6. run() 编排（`prototype/src/store/useWorkbench.ts:916-1152`）

- `run()` 开头检查 `pendingFork`：激活时**绕过续聊判定（1015-1054）与
  retention（1061-1118）**，直接走 startSession 分支（1120-1146），
  请求带 `fork` 参数 + `conversationId: active.conversationId ?? active.id`
  照常继承；成功后清 pendingFork；
- 失败回落：startSession 抛错时按既有 fail() 路径处理，pendingFork 保留
  （用户可重试或取消）。

### B7. 分支时间线拼接（openSession `useWorkbench.ts:763-787`）

谱系聚合从"平铺全量"升级为**树路径回溯**：

1. `fetchSessions()` 拿全谱系行（含 fork 三列）后，从目标段沿
   `fork_of_session` 逐级上溯得到祖先链（根段 → … → 目标段）；
2. 祖先段回放结果（`adapter.eventsSince`，afterSeq=0 全量）在读取端过滤
   `seq ≤ 该段 fork_at_seq`（每个子段记录的是它父段的上界）；
   目标段全量；**兄弟分支排除**（不在路径上的段不回放）；
3. 跨段本地重编 seq 防 key 撞（764/783 既有做法照旧）；
4. 拼接点（父段截断处 → 子段首事件）插 **fork 标记行**（新 kind
   `fork.point`，与 `segment.divider` 并列）：文案
   "已从此处分叉 · 引用上文 N 轮（只读前缀）"——N = 过滤后父段的轮数；
   执行器切换的 divider 合成逻辑（Timeline.tsx:118-140）保持不变，
   fork 拼接点优先于 executor divider（同一位置两者只出现 fork 标记）；
5. "先填台账再渲染"与 selectUnit → selectRuntime → 大 set 落位顺序保持；
6. 无 fork 的旧谱系走原平铺路径（零回归）。

### B8. 侧栏 / HistoryDialog 分支呈现（P1 部分）

- `HistoryListRow`（Sidebar.tsx:1026-1115）与 `HistoryRow`
  （HistoryDialog.tsx:538-661）：条目有 fork 三列时加徽标
  "↳ 分叉自 <父段标题>"（branch）/ "↳ v2"（revision）；
- P1 不做折叠，平铺 + 徽标即可（两个参考实现都不做树视图是有意取舍）。

### B9. 文案并列（诚实叙事）

- `SwitchHintCopy`（RuntimePicker.tsx:423-441）：在"切换执行器 = 开新段"旁
  并列"分叉 = 回到某轮换方向开新段（上文以只读前缀带入）"；
- `selectRuntime` notice（useWorkbench.ts:708-712）与 fork 意图提示条呼应；
- divider / fork 标记文案区分两种边界（切换执行器 vs 分叉）。

---

## 三、P2 实施步骤（编辑重发 + 版本家族）

- **入口**：B5 的"编辑重发"按钮（仅末轮用户消息，idle 门禁）→
  `setDraft(原文)` + `pendingFork { kind: "revision" }`；
- **发送**：B6 同链路 startSession，`fork.kind = "revision"`，
  fork_at_seq = 锚点轮之前（B2 解析）；
- **版本家族折叠**：侧栏/HistoryDialog 把 revision 兄弟段按
  `(fork_of_session, fork_at_seq)` 分组折叠为一个槽位，槽位标题取最新版本，
  展开显示 "version 1..N"（按 startedAt 排序）+ "version X of Y" 导航
  （Maka `packages/core/src/session-revisions.ts` 模式）；
  `unit.history` 查询侧（index.ts:1653 起）补 fork 字段支撑分组；
- **文件不回滚**：revision 只回退对话上下文不回退工作区文件（ADR 决议），
  切回旧版本文件残留是预期行为——版本导航 tooltip 说明。

---

## 四、验证

- `pnpm typecheck` 全仓；
- **新增 `backend/scripts/smoke-fork.ts`**（模板 smoke-phase8.ts + mockperm
  夹具 + smoke-phase3 双 daemon 模式）：
  - 带 fork 参数 session.start → sessions 行三列正确落库；
  - HANDOFF dispatch 快照只含 seq ≤ fork_at_seq 的前缀消息；
  - fork 段 `session.events.since` 只返回本段事件；
  - 坏 anchor / 未知 ofSessionId / 非法 kind → bad_params；
  - daemon 重启后三列仍在（迁移 + 持久化）；
- 手动清单：
  - [ ] 任意轮"从此处分叉"→ 意图提示条 → 发送 → 新段时间线 =
        父段只读前缀 + fork 标记 + 新段内容（富文本渲染，docs/17 地基）
  - [ ] 末轮"编辑重发" → 草稿预填 → 发送 → revision 段 + 版本家族折叠 +
        version 导航
  - [ ] 源段 running/awaiting 时入口被门禁禁用
  - [ ] 取消意图零持久化（台账无新行）
  - [ ] 侧栏/HistoryDialog 分支徽标 + 跨重启可见
  - [ ] 普通切换执行器路径零回归（无 fork 的谱系回放不变）

---

## 五、改动文件清单

| 区域 | 文件 | 动作 |
|---|---|---|
| B 后端 | `backend/src/store/db.ts` | 三列迁移 + Row/toRow/upsertSession |
| | `backend/src/runtime/host.ts` | StartSessionInput/HostSession/insert/toSession + buildHandoffBlock 上界 + anchor 解析 |
| | `backend/src/index.ts` | session.start fork 校验 + session.list/unit.history 行形状 |
| B 契约 | `prototype/src/core/adapter.ts` | StartSessionRequest.fork |
| | `backend/src/contract.ts` | 镜像 |
| B 前端 | `prototype/src/core/units.ts` | Session 类型 |
| | `prototype/src/adapters/daemon/client.ts` | DaemonSessionRow + startSession 透传 |
| | `prototype/src/adapters/daemon/adapter.ts` | startSession fork 透传 + 前缀翻译 |
| | `prototype/src/store/useWorkbench.ts` | pendingFork 意图 + run() 编排 + openSession 树拼接 |
| | `prototype/src/ui/Timeline.tsx` | hover 动作 + fork 标记行 + messageId 归并 |
| | `prototype/src/ui/Composer.tsx` | 意图提示条 |
| | `prototype/src/ui/RuntimePicker.tsx` | 文案并列 |
| | `prototype/src/ui/Sidebar.tsx` / `ui/HistoryDialog.tsx` | 分支徽标 + 版本家族折叠 |
| 测试 | `backend/scripts/smoke-fork.ts` + package.json 脚本 | 新增 |
| 文档 | `docs/adr/0013-conversation-fork.md` | 状态行"草案：未实施"→ 已实施（P1+P2） |

不改动：账本 TraceRecord 格式（读取端投影，ADR 不变量 2）、TraceSink、
权限闸、Retention 逻辑（对分支段天然生效，ADR 不变量 1）。
