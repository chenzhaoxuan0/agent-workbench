# host 拥有对话账本：trace 事件体系升格为 canonical source，执行器会话降为租户

对话页允许中途切换执行器，但会话绑定单一 runtimeId：切换即前端清空时间线、以新执行器开新会话，旧会话无人收尾也无路回看——用户视角即"丢上下文"。数据其实都在（traces NDJSON 全事件、state.db messages 文本投影、各 CLI 原生历史），丢的是"呈现"与"回得去的路"。参照 Apache Maka（孵化中）的架构决策——会话上下文的 canonical 副本归 host（Runtime Event Log），一切界面与恢复都是这份日志的投影——本文记录把同一原则移植到本项目的落地决策。与 Maka 的关键差异：它的无损切换依赖自持 agent loop（原生模型 backend 每轮从账本重投影），本项目 13 个适配器全是外部 CLI、loop 不在我们手里，因此只移植"账本归 host"的原则与租户协议，不移植 event→provider 重投影 runtime。

## Considered Options

- **禁止切换执行器、只允许切模型（否决）**：执行器是一等公民（模型按执行器各存一份），且各执行器可跑模型集合不同，模型切换在能力面上替代不了执行器切换。多执行器是本产品立身之本。
- **跨执行器原样迁移上下文（否决）**：各执行器上下文本体是私有领地（进程内会话、原生 session 文件、thread id），格式互不通用，不存在通用迁移格式；伪造的迁移是失真仿制品。
- **host 拥有账本 + 执行器会话为租户（采纳）**：已有的 TraceRecord 体系（append-only NDJSON + per-session 单调 seq + `session.events.since` 双层读通道）升格为 canonical 对话账本；UI 时间线、历史回看、上下文交接全部改为账本投影；执行器会话是租户——可丢弃、可恢复，账本不依赖租户存活。切换执行器从"清空重来"改为"谱系边界事件"。
- **会话谱系（conversation lineage）建模（采纳）**：聊天页一段对话 = 一条 conversation（谱系），由若干 segment（= 现有 Session，每段绑定一个执行器）组成。`sessions.conversation_id` 列关联；切换开新段、切回可续接旧段、时间线跨段连续渲染。否决了"前端本地记忆谱系"——投影必须来自账本侧事实，否则刷新即丢。
- **一次性只读转录交接替代摘要交接（现阶段采纳）**：跨执行器带上文的唯一诚实机制是把旧段消息投影构造 HANDOFF block 拼进新段首条消息（复用 memory 注入挂载点），opt-in、有损、透明。摘要生成交接需要直连模型调用路径，记入 future work。

## Invariants

1. **账本 append-only**：TraceRecord NDJSON 只追加；一切投影（UI 时间线 / 历史展开 / 交接块）永不改写账本。
2. **本地合成事件仅为延迟优化**：`pushUserBubble` / `pushNotice` 等前端本地合成允许存在（降低首帧延迟），但重建投影（`session.events.since`）时以账本为准；账本侧补发用户轮事件后，本地合成退化为纯优化。
3. **seq 单调且跨代持久**：per-session seq 落库（`sessions.last_seq`），daemon 换代续号不重置，`afterSeq` 补拉语义跨代成立。
4. **切换执行器是谱系边界事件，不清灭历史**：切换产生新 segment 与同谱系关联，旧段事件保留、可展开、可回接；门禁（idle-only）保证切换发生在段静止时。
5. **执行器会话是租户**：旧段不因切换被 cancel；readiness（进行中 / 可恢复 / 仅历史）以 host 台账判定（impl 存活 + cli_ref），不依赖适配器自觉发 `session.ended`。

## Consequences

- **用户轮入账本**：`dispatchSend` 写 DB 同时 emit 用户消息事件，`session.events.since(0)` 重建的时间线从此完整（此前重建会缺用户轮）。
- **turn 边界显式化**：新增 `turn.started` / `turn.completed`（host 层发射，不动适配器）；`session.status` 字符串状态机保留兼容，但账本不再借用它表达轮次。
- **seq 持久化 + trace 写失败可见**：`sessions.last_seq` 落库；trace 写入从 fire-and-forget 吞错改为可观测（log + kv 计数器）。canonical 账本的持久诚实性是前提。
- **前端时间线改为账本投影**：timeline 不再"新会话即清空"，改为谱系投影 + 段间 divider（divider 是 UI 聚合产物，不入账本）；`openSession`（用现有 `selectSession` 空位）打通"历史会话接回聊天页"。
- **切回来还在**：谱系内切回某执行器，若该段 live 或 cli_ref 可恢复则续接该段而非新开（Maka conversationKey 语义）；续接失败显式回落新段并提示，不静默。
- **携带上下文切换 opt-in**：默认不带；勾选后旧段最近 N 轮转录作为 HANDOFF block 进入新段首条消息——文案需诚实声明该内容会进入新执行器原生历史。
- **Future work（本 ADR 不实施）**：event→provider 重投影 runtime（需自持 loop，届时 Maka 文档为蓝图）；SQLite 事件表与 tool.output 结构化保真（查询加速，账本查询现走 NDJSON 扫描够用）；摘要生成交接（需直连模型 backend）；`tool.delta` 工具输出流（codex outputDelta 等适配器侧信息保真）。
