# Context Manifest：注入默认关、每 bot 矩阵、统一防双注注册表

agent-workbench 区别于其他 agent 工具的定位收拢为「对每个 bot / 每个文件夹的 memory、skill、context、AGENTS.md、SOUL.md 的管理」：运行时（CLI + 模型）可换，context 是复利资产。对照系 OpenClaw（2026.9.7 源码调查）是「存在即注入」——根工作区 6 文件默认全量进 system prompt，唯一粒度是 embedded 专用 `contextInjection` 总开关与字符预算，lean 语义靠会话类型白名单（子代理仅 AGENTS.md、cron 无 MEMORY、心跳零文件）承担，防双注逐适配器硬编码（`nativeProjectDocBasenames` 只在 codex/copilot 生效）。本 ADR 记录三个反着来的决策，完整任务清单见 docs/20。

## Considered Options

**注入默认值**

- **照抄 openclaw 存在即注入（否决）**：它服务「一个全知全能的个人助理」的单一心智；本产品管理一个 bot 舰队，有的 bot（写公众号、跑批、对外渠道）就该简洁运行。默认倾倒与「context 是显式资产」的定位矛盾。
- **默认关但按会话类型给白名单（否决）**：openclaw 的 lean 语义挂在会话类型（子代理/cron/心跳）上，用户不可见不可选；「用户可以管理、可以选择」是这个定位的产品承诺，粒度必须落到用户手上。
- **每 bot 一份 manifest、新建全关、存量等价迁移（采纳）**：bot.json 新增 `contextManifest` 节（agentsMd 三态 + soul/user/memorySemantic/memoryDaily/memoryStanding/skills 布尔），字段缺省 = false，手删整节回到 lean，语义自洽。存量 bot 读时归一为 `{agentsMd:"auto", memorySemantic:true, memoryStanding:true, 其余 false}`——等价升级前行为，无惊喜。
- **STANDING 例外：存在即注入（采纳）**：红线/安全禁令是作者刻意做的危险边界声明，注入不需要二次确认；「默认关」保护的是不被倾倒，不是不设防。对外渠道 bot 可显式关。

**AGENTS.md 是否由工作台注入**

- **第一轮默认注入（否决）**：主流 CLI 全兼容该格式且以 cwd 原生读取，原生读取每轮新鲜、优于工作台的 startSession 冻结快照；默认注入造成确定性的双份上下文。
- **永不注入（否决）**：14 家执行器并非家家原生读（openclaw 的 gemini 后端连 system prompt 都不传，靠原生 cwd 发现；acpx 通用层反而全注）。一刀切不注入会让长尾执行器静默丢失岗位说明书。
- **三态 + 统一注册表（采纳）**：adapter SPI 新增 `nativeContextFiles` 能力位（补 openclaw 逐适配器硬编码的坑）；`agentsMd: auto`（默认）= 声明原生读取则跳过、未声明则注入兜底——宁双注勿漏注，岗位说明书静默丢失比浪费 token 严重，与 openclaw acpx 通用层「全注」同一取舍。只标注验证过的执行器，不确定 = 不标（走兜底）。不学 openclaw 反向禁用 claude 原生 CLAUDE.md 记忆——中立层原则，运行时自己的记忆是它的事。

**manifest 权威位置**

- **前端持有、随请求传 daemon（否决）**：现状即此（zustand 全局 `memoryScopes`），刷新即重置、对所有 bot 一致，且渠道/自动化会话吃不到用户选择——这恰是要修的缺陷，不能保留。
- **bot.json 持有、daemon 在 startSession 自读（采纳）**：与「文件即数据库」「AGENTS.md 正文住文件夹」同一哲学；飞书消息进来的会话与工作台会话注入自动一致。前端 `memoryOptions` 降级为显式覆盖通道（`/mem` 指令）。

## Consequences

- SOUL 落文件 `<rootPath>/SOUL.md`（与 AGENTS.md 同构），`identity.persona` 内容迁移后废弃；USER 落 `<homeDir>/USER.md` 全局层（关于人，逐 bot 开关，渠道对外 bot 默认关）。两者各 2000 字符上限，走既有 `truncateToBudget`/备份/redact 管线。
- 注入块顺序 AGENTS（仅兜底）→ SOUL → USER → MEMORY.semantic → daily → STANDING（红线压轴，近因效应）；`InjectedPart.scope` 扩为 agents/soul/user/semantic/daily/standing，派发日志如实记录。
- 冻结快照语义不变：manifest 变更只影响下一个新会话（保 LLM 前缀缓存）。
- 预设（裸跑/基础/完整）是一次性写开关的宏，不持久化为独立模式——避免预设名与开关实态两处真相。
- 技能绑定后置 Phase 4：名单制（bot.json `skills` 节）替代全局搬 `.disabled/` 文件夹；注入只注目录（name+路径，不注全文）。
- 明确不做：memory MCP 工具（docs/10 §4.2）、反向禁用执行器原生记忆、HEARTBEAT.md/DAILY.md/PROJECTS.md/KNOWLEDGE.md（openclaw 已退役或不存在，心跳/每日精炼已有对应物）、检索降级注入（openclaw `memoryToolRouted` 思想记入 docs/10 未来节）。
