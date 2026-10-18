# 对话分叉（fork）：谱系从链升级为树，UI 无损拼接 + 上下文有损前缀的双层分支

（已实施 P1+P2：2026-10-18，落地细化见 docs/18-conversation-fork-impl.md；P3/P4 未做。一条对正文的细化决议：branch 与 revision 入口统一走「意图 + 发送才建段」（不变量 5 扩展到 branch），点分叉不建空段。）

用户在长对话里常需要"回到某轮换个方向再来"或"改掉最后一条消息重发"。本文基于对 Apache Maka 与 ZCode 两个参考实现分支功能的源码调研（对照清单见文末），记录把对话分支引入本项目的选型与边界。决定性约束与 ADR 0012 一脉相承：13 个执行器适配器全是外部 CLI，loop 不在我们手里——不存在"同一 Session 内重置模型上下文"的能力。因此 ZCode 的同会话裁剪游标模型不可用；而 Maka 的"分支 = 新物理 Session"与本项目现有"段（segment）"结构天然同构：`session.start` 已有的 `conversationId + handoff` 参数组合几乎就是 fork 的全部入参。结论：**分支不是新机制，只是谱系从链变树**。

## Considered Options

- **ZCode 同会话 branch-cut 游标（否决，留作 P3 快路径）**：ZCode 的 edit/retry/rewind 不建新会话，只在 `session.revert` 列写 `branchCutAfterMessageID + keptMessageIDs + branchGeneration` 裁剪游标，读取端用纯函数 `selectActiveConversationBranch()` 从 append-only 消息流裁出活跃分支，旧分支留在库里可溯源。前提是 runtime 在自己手里：rewind 后可 `messageHistory.reset()` 重建 provider 历史与派生状态（read-file cache、compact scope 等）。本项目适配器无此能力，同段内 rewind 不存在。P3 可对原生支持 fork 的执行器（如 zcode CLI 自身）经 `AdapterSession` SPI 可选方法走无损快路径。
- **Maka 全量物化复制（否决）**：Maka 把分支实现为全新物理 Session，复制消息、runtime events、artifacts，配幂等 claim 表与 preparing/committed 两阶段协议、崩溃恢复。本项目分支只是"开新段"，无数据搬家；账本本就 host-owned 且跨段连续（divider 合成已验证），读取端逻辑拼接即可。两阶段协议等出现真实的失败恢复需求再引入。
- **Maka 分支=新 Session + 血缘字段 + 读模型折叠（采纳骨架）**：单 Session 内永远线性账本，分支间血缘靠字段表达（parent/branchOf/revision 家族），读取端折叠成逻辑树；edit-and-resend 产生的版本家族在侧栏折叠为一个会话槽位 + "version X of Y" 导航。两个参考实现的跨会话 fork（Maka copy / ZCode `commitForkBundle`）同为"复制出新实体 + 全量 ID 重映射"思路，本项目以"开新段 + 账本区间引用"替代复制。
- **谱系从链升级为树（采纳）**：fork 出的新段与"切换执行器开的段"同构——普通 Session 行，只多三个血缘列。否决"消息级树（parentUuid 链）"——账本是事件流不是消息树，分支边界天然是 turn 边界，树挂在段上而不是消息上。
- **双层策略（采纳，本项目特有）**：UI 层无损（账本逻辑拼接：父段 seq ≤ fork_at_seq 的事件 + 新段全量事件），模型上下文层有损（HANDOFF 转录前缀带 seq 上界）。Maka/ZCode 两层都无损（自持 loop / 复制 runtime ledger），本项目做不到第二层无损；两层保真度不同是产品事实，UI 文案诚实声明"分叉点之前的对话以只读前缀带入"。

## Invariants

1. **分支段是普通段**：fork 出的 Session 走同一 `session.start` 生命周期、同一租户协议、同一 readiness 判定，无特殊执行路径；同谱系同执行器 retention（"切回来还在"）对分支段天然生效。
2. **账本零改动**：不复制、不裁剪、不改写 TraceRecord；分支时间线是读取端投影（父段区间 + 新段全量）。符合 ADR 0012 不变量 1。
3. **UI 无损 / 上下文有损分层声明**：不伪装成交接无损；分支起点的 HANDOFF 内容照旧落 `dispatches` 快照，可追溯"这个分支当时带了什么"。
4. **边界语义二分**（照抄 Maka）：`branch` = through（含所选轮，"从此处分叉"，任意轮入口）；`revision` = before（不含所选轮，编辑重发/回到此轮前，仅最后一轮用户消息可编辑——ZCode `latestQueryEditOnly` 守卫）。
5. **编辑即草稿，发送才 fork**（照抄 Maka）：edit 点击只进 composer 草稿，不建空分支；发送时才建 revision 段并切换；放弃草稿不产生任何持久化。
6. **分叉门禁复用 idle 门禁**：源段 running/awaiting_* 时不允许 fork（等价 Maka 的 `session_busy`）；唯一预留给 P4 侧聊的例外见 Phases。
7. **旧分支永不删**：append-only 账本天然保证。
8. **命名避开 branch**：`BranchPicker` 与 ADR 0009/0010 中 branch 均指 git；对话分支统一叫 fork / 分叉。

## Consequences

- **数据层**：`sessions` 加三列（ALTER 迁移，行创建后不可变，与 `conversation_id` 同等）：`fork_of_session`（父段 id）、`fork_at_seq`（父段账本 seq 上界）、`fork_kind`（`branch | revision`）；`upsertSession` 的 ON CONFLICT 不触碰这三列。`conversation_id` 照常继承（每分支头独立 conversation 的变体否决——侧栏折叠可解决呈现，谱系查询保持一棵树）。
- **HANDOFF 加 seq 上界**：`buildHandoffBlock` 从"最近 24 条"改为"截至 fork_at_seq 的转录投影"；普通跨执行器切换的 HANDOFF 行为不变。
- **文件不回滚**：revision 只回退对话上下文，不回退工作区文件（Maka 同此；ZCode 的 workspace checkpoint 体系不做，git 面已承担类似诉求）；切回旧版本时文件残留是预期行为，文案说明。
- **时间线**：divider 合成逻辑平移为 fork 点标记——拼接处插"已从此处分叉 · 引用上文 N 轮（只读前缀）"；拼接投影要求父段先在 sessions 台账（openSession 已有同款"先填台账再渲染"做法）。
- **谱系级回放**：分支时间线跨两段（父段区间 + 新段），需前端拼两次 `session.events.since` 或 daemon 加谱系级查询；本地合成判重沿用"回放不经事件泵"的既有边界。
- **UI 入口与叙事**：任意轮 hover"从此处分叉"（idle 门禁）+ 最后一轮 edit（revision）；侧栏/HistoryDialog 分支列表先做平铺 + 版本家族折叠，不做树视图（两个参考实现都不做树视图是有意的取舍）；RuntimePicker/SwitchHintCopy 等硬编码"切换执行器=开新段"的文案需把分叉叙事并列进去。

## Phases

- **P1 最小闭环**：三列迁移 + "从此处分叉"入口（idle 门禁 + HANDOFF seq 上界）+ 分支时间线拼接渲染 + 侧栏分支列表。
- **P2 编辑重发**：末轮 edit → revision 段 + 版本家族折叠 + version 导航。
- **P3 适配器 opt-in 无损 fork**：`AdapterSession` SPI 加可选 `forkAt(sessionId, seq)`；原生支持的执行器跳过 HANDOFF 走真 fork，不支持则回落 P1 路径，逐适配器评估。
- **P4 侧聊（side conversation）**：Maka side_conversation 语义——父轮运行中可 fork 的门禁例外（唯一例外）、懒创建（首次发送才 fork）、关闭即删、侧聊内隐藏继承的父历史。

## 参考实现对照

- **Maka**（`C:\Users\chenziyu\project\Agent\maka`）：血缘字段 `packages\core\src\session.ts:273-297`；版本家族折叠 `packages\core\src\session-revisions.ts`；复制协调器（idle 门禁/两阶段/幂等 claim）`packages\runtime-host\src\server\session-revision-coordinator.ts`；through/before 切片 `packages\runtime\src\conversation-copy.ts:243-281`；编辑即草稿 `packages\ui\src\revision-staged-context.ts`；取舍文档 `docs\architecture\session-copy-cost-baseline.md`（明确保留 materialized-copy 作为 shared-prefix 的对照组）、`docs\side-conversation.md`。
- **ZCode**（`C:\Users\chenziyu\project\Agent\zocdeusually\ZCode`）：裁剪游标 `SessionRevert` `apps\zcode-cli\packages\contracts\src\interfaces\session-store.port.ts:277-294`；活跃分支纯函数 `apps\zcode-cli\packages\contracts\src\rewind\index.ts:176-215`；rewind 重建派生状态 `apps\zcode-cli\packages\core\src\runtime\methods\rewind-message.ts`；原子 fork `apps\zcode-cli\packages\core\src\runtime\methods\session-fork.ts`；edit/retry/fork 命令组与守卫 `apps\zcode-cli\packages\bootstrap\src\zcode-protocol-v4\commands\handlers\fork-edit-retry.ts`。
