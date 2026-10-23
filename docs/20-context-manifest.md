# 20 · Context Manifest —— 注入矩阵改造计划

> 定位收拢的落地计划：**agent-workbench 区别于其他 agent 工具的核心 = 对每个 bot / 每个文件夹的
> memory、skill、context、AGENTS.md、SOUL.md 这些资产的管理**。运行时（CLI + 模型）可换，
> context 是复利资产；对 context 的注入必须是**显式决定**，不是默认倾倒。
>
> 参照系：OpenClaw 源码调查（2026.9.7，本地 `../openclaw`）。它是「存在即注入」——根工作区
> 6 文件默认全量进 system prompt，唯一粒度是 `contextInjection` 总开关（embedded 专用）与
> 字符预算，**没有按文件、按 agent 的开关**；lean 语义靠会话类型白名单承担（子代理只给
> AGENTS.md、cron 不给 MEMORY、心跳零文件）。它的防双注是逐适配器硬编码
> （`extensions/codex/.../attempt-workspace-context.ts:19` 的 `nativeProjectDocBasenames`
> 只在 codex/copilot 生效），没有统一注册表。**这两点都是本计划要做得更好的地方。**

## 0. 现状基线（改造针对的事实）

| 事实 | 位置 | 与目标的差距 |
|---|---|---|
| 注入器已有：semantic / daily 按需 + STANDING **无条件**注入 | `backend/src/memory/injection.ts:80-98` | STANDING 无开关；无 soul / user / agents 来源 |
| 注入开关是**前端全局态**：zustand `memoryScopes` 默认 `["semantic"]`，刷新重置、对所有 bot 一致 | `prototype/src/store/useWorkbench.ts:465` | 不是每 bot、不落盘；渠道/自动化会话吃不到用户的选择 |
| persona（SOUL 语义位）只存不注入 | `prototype/src/core/units.ts:41`、`AddBotDialog.tsx:700-712` | 预留接口未接线 |
| USER.md（关于人的全局层）不存在 | — | 文件对照表里唯一的真空位 |
| AGENTS.md 靠执行器原生读（cwd = rootPath），工作台从不注入 | `bots/registry.ts`（正文住文件夹） | 没有防双注/兜底策略；换不原生读的执行器时岗位说明书静默丢失 |
| 技能只有全局盘点/停用（源内 `.disabled/` 搬文件夹） | `backend/src/skills/inventory.ts:31-75` | 停用是全局的，不是每 bot 绑定 |
| 注入只在 startSession 一次（冻结快照，保前缀缓存） | `injection.ts:13-14`、`runtime/host.ts:1080` | **保留不动**，这是对的 |

## 1. 设计决策（先定死，实现不再摇摆）

### D1 — manifest 是每 bot 一份、写在 bot.json，权威在 daemon

`<rootPath>/.agent-workbench/bot.json` 新增：

```jsonc
"contextManifest": {
  "agentsMd": "auto",       // auto | on | off —— 见 D4，唯一三态项
  "soul": false,            // <rootPath>/SOUL.md
  "user": false,            // <homeDir>/USER.md（全局层，逐 bot 开关）
  "memorySemantic": true,   // MEMORY.md
  "memoryDaily": false,     // memory/daily/<今日>.md
  "memoryStanding": true,   // STANDING.md —— 唯一默认 true 的注入项（安全红线，见 D3）
  "skills": false           // Phase 4 才接线，先占位
}
```

- 字段缺省 = false（agentsMd 缺省 = "auto"）→ bot.json 手删整节 = 回到 lean，语义自洽。
- **host.startSession 从 registry 读 bot 定义拿 manifest**（`runtime/host.ts`），不再信任
  前端传的 scopes。前端 `memoryOptions` 保留为**显式覆盖**通道（`/mem` 指令用）。
  收益：渠道会话（`channels/askBot.ts`）、自动化会话自动吃到每 bot 的选择——现在做不到。
- 乐观锁沿用 bot.json 自增 revision，无新增锁维度（SOUL.md 编辑器另见 D6）。

### D2 — 默认值：新建全关，存量等价迁移

| 情形 | 初始 manifest |
|---|---|
| 新建 bot | 全 false + `agentsMd:"auto"`（零注入，UI 明示「裸跑」） |
| 存量 bot（bot.json 无 contextManifest） | `{ agentsMd:"auto", memorySemantic:true, memoryStanding:true, 其余 false }` —— 等价现状（全局 scopes 默认 semantic + STANDING 存在即注入），升级无惊喜 |

### D3 — STANDING.md 是唯一「存在即注入」的例外

红线/安全禁令层：文件存在 = 该 bot 的作者已经做了危险边界的声明，注入不需要二次确认。
新 bot 默认 true 是空操作（文件不存在），用户建了 STANDING.md 即生效；显式可关（对外渠道
bot 想彻底裸跑时）。哲学一致性说明：**默认关保护的是「不被倾倒」，不是「不设防」**。

### D4 — AGENTS.md 三态 + 统一防双注注册表（补 openclaw 的坑）

`ExecutorAdapter`（`backend/src/runtime/adapters/types.ts`）新增能力声明：

```ts
/** 该执行器在 cwd 下原生读取的项目上下文文件名（规范大写）。声明后 host 的
 *  auto 策略跳过工作台注入，防止双份 AGENTS.md 进上下文。 */
readonly nativeContextFiles?: readonly string[];
```

`agentsMd` 三态判定（host 在注入前查当前 binding 的 adapter）：

| mode | 行为 |
|---|---|
| `auto`（默认） | adapter 声明含 `AGENTS.md` → **不注入**（原生读取每轮新鲜，优于冻结快照）；未声明 → **注入兜底**（宁双注勿漏注：岗位说明书静默丢失比浪费 token 严重，与 openclaw acpx 通用层「全注」同一取舍） |
| `on` | 永远注入（给确认不原生读的长尾执行器，或想要快照语义的用户） |
| `off` | 永不注入 |

14 家逐个标注是独立核对任务（P2-4），**只标注验证过的**，不确定 = 不标（走注入兜底）。
不学 openclaw 反向禁用 claude 原生 CLAUDE.md 记忆——中立层原则，运行时自己的记忆是它的事。

### D5 — SOUL 落文件、persona 迁移；USER.md 是全局层

- **SOUL**：正文迁到 `<rootPath>/SOUL.md`（与 AGENTS.md 同构：文件即数据库、VS Code 可改、
  重开生效）。`identity.persona` 非空的存量 bot：迁移任务把内容写入 SOUL.md，persona 字段
  只读兼容一个版本后移除。导入探测（`bots/inspect.ts:28` 已识别 SOUL.md/PERSONA.md）统一
  归一到根目录 SOUL.md。注入渲染为只读块（人设由用户维护，bot 不得自改——同 STANDING 框架）。
- **USER**：`<homeDir>/USER.md`，关于「人」的 evergreen 层（作息/偏好/说话风格/常用环境），
  所有 bot 之上共享、逐 bot 开关。写前备份进既有 `backups/` 机制（新增全局 scopeId）。
  隐私红线：**渠道对外 bot 默认关**（对齐 openclaw 群聊剔除 MEMORY 的同一动机）。
- 上限：SOUL / USER 各 2000 字符，超限走既有 `truncateToBudget`。

### D6 — 注入块顺序（红线压轴）

```
AGENTS.md（仅兜底时）→ SOUL → USER → MEMORY.semantic → daily → STANDING
```

- openclaw 顺序 agents→soul→identity→user→…→memory 基本一致，差异：STANDING 放最后，
  利用近因效应强化红线遵守。
- 每节沿用现有 `## <名>` + 只读说明的渲染式；`InjectedPart.scope` 扩为
  `"agents" | "soul" | "user" | "semantic" | "daily" | "standing"`，派发日志/parts UI 自动如实记录。
- 冻结快照语义不变：manifest 变更只影响**下一个新会话**。

### D7 — 预设是宏，不是第二真相

「裸跑 / 基础 / 完整」预设按钮 = 一次性写入一组开关值，落盘的永远只有显式开关。
不做持久化的 preset 字段——避免「预设名」与「开关实态」两处真相漂移。

### D8 — Skills 绑定后置为 Phase 4，粒度 = 名单而非搬文件夹

现状停用是**全局**的（源目录内搬 `.disabled/`，影响所有 bot）。Phase 4 改为 bot.json
`skills: { enabled: [] | "all" }` 名单制（工作台层拦截，不动文件系统）；注入采用 openclaw
式目录（name + 路径，**不注全文**，agent 按需读，`system-prompt-skills.ts` 同思路）。
全局盘点面板保留。

## 2. 分阶段任务

### P0 · 文档先行（半天）
- [ ] 本计划评审定稿
- [ ] `docs/adr/0014-context-manifest-default-off.md`：默认关 + 防双注注册表 + STANDING 例外的决策记录
- [ ] `CONTEXT.md` 词汇表新增：SOUL.md / USER.md / contextManifest / 裸跑 / 原生读取

### P1 · 数据模型与迁移（后端，~1 天）
- [ ] `backend/src/contract.ts` + `prototype/src/core/units.ts`：`ContextManifest` 类型（前后端同构）
- [ ] `backend/src/bots/registry.ts`：bot.json 读写 manifest；读时按 D2 补默认值（存量迁移 = 读时归一 + 首次保存落盘）；persona → SOUL.md 迁移函数
- [ ] `backend/src/bots/inspect.ts`：导入探测归一 SOUL.md
- [ ] WS `bot.update` 通路带 manifest（沿用 revision 乐观锁，无新协议版本）

### P2 · 注入器与防双注（后端，~1–2 天）
- [ ] `backend/src/memory/projectMemory.ts`：`readSoul(rootPath)` / `readUser(homeDir)` + 备份
- [ ] `backend/src/memory/injection.ts`：`MemoryInjector` → `ContextInjector`，按 manifest 组装、D5/D6 顺序与上限；`opts` 增加 manifest 覆盖位
- [ ] `backend/src/runtime/host.ts:~1080`：startSession 改从 bot 定义读 manifest；agentsMd auto 判定查 adapter 能力
- [ ] `backend/src/runtime/adapters/types.ts`：`nativeContextFiles` 能力位
- [ ] **14 家标注核对单**（P2-4，只标验证过的）：
  claude / codex / gemini / opencode / zcode / cursor / grok / kimi / hermes / mcode / dsh / agy / pi / openclaw —— 每家一条「是否原生读 cwd 下 AGENTS.md」的证据（文档或实验），进 `docs/05-reference-map.md`
- [ ] 派发日志 parts 如实记录新 scope（验收回放依据）

### P3 · UI（前端，~2 天）
- [ ] BotCard / 侧栏单元行：注入徽标（裸跑 = 灰点空态；N 项 = 缩写点列，hover 明细）——「默认全关」的可见性兜底
- [ ] 右栏新 tab「Context」（SidePaneColumn，docs/19 槽位）：manifest 矩阵（每项：开关、来源路径、字符数/上限、上次注入时间）+ 预设宏（D7）+ agentsMd 三态含「此执行器原生读取 ✓」徽标（按当前 binding 的 adapter 能力实时显示）
- [ ] SOUL.md 编辑器：复用 AGENTS.md 的「路径 + sha256 乐观锁」编辑组件（`SettingsPage` 现有模式）；AddBotDialog 的 persona 分区改为 SOUL.md
- [ ] `SettingsPage`：USER.md 全局编辑区
- [ ] **退役** `useWorkbench.memoryScopes`（zustand 全局态）与 `MemoryScopePicker` 的旧语义：Picker 改为「写当前 bot 的 manifest」的快捷开关（per-bot 落盘）

### P4 · Skills 绑定（已完成，2026-10-22）
- [x] bot.json `skills` 名单制（D8，`{ enabled: "all" | string[] }`，`normalizeSkillBinding` 归一）；Context 面板内置绑定编辑器（全部/名单/逐项勾选，空名单=不注入任何技能）
- [x] manifest.skills = true 时注入技能目录（`listCatalogSkills`：全部技能源、启用中、跨源去重、**项目级优先**——用户公共库 400+ 技能时预算截断不能吃掉最相关的项目级技能）
- [x] 注入预算 `SKILLS_IN_PROMPT_MAX = 30`，截断明示

### P5 · 收尾
- [ ] `docs/10-memory-system.md` 增补：注入矩阵节 + 「检索可用时降级注入」（openclaw `memoryToolRouted` 思想）记为未来方向不实现
- [ ] `docs/05-reference-map.md` 补 openclaw 借鉴条目（bootstrap 顺序 / nativeProjectDocBasenames / skills 目录注入 / per-agent workspace 隔离）
- [ ] README 功能段更新

### P6 · 记忆技能 Skill 化与官方技能收敛（已完成，2026-10-22）
- [x] **两个官方基础技能，一种使用形式**：`workbench-context`（记忆检索，docs/20 本线）与
  `agent-workbench`（驾驶工作台，docs/21 P6 线）都是 bot init 时在工作空间初始化的技能，
  正本集中 daemon（`backend/src/skills/`，`skillSync.ts` 通用契约），落盘 `.agents/skills/`
  规范位
- [x] **版本标记契约统一**：`<!-- <name>-skill: vN -->`——只在「不存在 / 更旧 / force」落笔；
  无标记但内容与迁移正本（`LEGACY_CONTEXT_SKILL_MD`）一致 = 无标记时代 daemon 种的可认领
  升级；改过的 = 用户自建不碰。此前的 `ensureFile` 只补缺永不升级（改进正本存量永远留旧版）
  退役（骨架 MD 的 ensureFile 后由 P7 整体退役——未经编辑不落盘）
- [x] **落点收敛**：`skills/` 旧位降级为兼容位（只升存量不新建），规范位唯一 `.agents/skills/`
- [x] **触发与兜底**：`initWorkspace`（bot init / 保存 / 补充 Init 按钮同一条路）内 sync 两技能，
  `workbench.skill.sync` RPC 兜底存量与升级；播种失败只 warn 不炸 init（增强件统一姿态）
- [x] **漂移防线**：`smoke:ai-native-skill` 断言仓库根自用副本与 daemon 正本逐字节一致；
  `smoke:prog-init` 断言迁移判定（认领升级 / 用户自建不碰）

### P7 · 上下文体验五点（2026-10-23 用户裁定）
- [x] **MD 正文未经编辑不落盘**：initWorkspace 不再写 MEMORY/STANDING/SOUL 骨架、putBot 不再写
  AGENTS.md 占位——空文件既污染目录也可能混进注入（注入侧 hasSubstantiveContent 本就跳过，这次
  把「盘上也不留」补齐）。设置页对未创建文件挂浅色「未创建 · 0 注入」标；六个文件配推荐代写
  模板（空文件一键填入，已有内容仅展示不覆盖）
- [x] **技能目录防双注**：执行器原生发现自己的技能目录（.agents/skills 标准），工作台侧注入
  是给不列技能的执行器补目录索引——UI 挂 ⚠ 注记，「完整」预设不再开 skills（默认本就全关）
- [x] **每 bot 自定义预设**：bot.json `contextPresets` 存命名清单快照（多条，自定义1/2…）+
  `contextPresetActive` 选中指针。预设行（2026-10-23 四次定稿，胶囊气泡样式）= 默认 /
  自动保存草稿（未选中时的开关改动落这里）/ 自定义N（× 删）/ ＋存为自定义预设（建即选中）/
  取消选中。**指针模型**：选中具名预设后的开关改动就地更新该预设本体，不跳自动保存、
  不因内容与默认一致跳回默认；「裸跑」一词 UI 全面改英文 Bare。输入框胶囊同一份名单（本轮
  覆盖语义）。「注入开关未写入」卡死修复：patchUnitContext 冲突时拉盘上真值自愈重试一次
- [x] **设置面归拢（四次编辑面收敛）**：总设置页「上下文清单」分区不动（随时入口）；
  bot 设置弹窗（编辑态）、右栏原 Context 面板、胶囊「编辑各文件」三处合并为右栏
  「bot 设置」面板（tab id 仍 context:*，AddBotDialog 以 embedded 形态承载身份/
  上下文/技能/渠道/导入全部分区，保存后不关面板）；侧栏齿轮/右键/工作台头衔/远控
  「配置渠道」全部落右栏，悬浮条 Layers 上下文钮与右键「上下文清单」并入齿轮，
  新建 bot 仍走弹窗（useShell editUnitId/edit 相关 API 退役）
- [x] **bot 设置·工作区技能页**：只管本 bot 工作目录内的技能源，置顶名单存 bot.json
  `pinnedSkills`（缺省 = agent-workbench / workbench-context 两个官方基础技能），停用与全局页
  同一条路（.disabled/ 搬运）
- [x] **Guardian 轻量模型默认跟随总管**：默认 model 留空 = 不向 CLI 传 --model（用其默认模型），
  runner 默认对齐总管（mcode）；前端不再显示推荐占位名，切执行器不再自动挑模型

## 3. 验收清单

1. 新建 bot → 派发日志零注入 parts，UI 显示「裸跑」
2. 存量 bot 升级后行为等价：semantic + standing 照旧注入，其余不注
3. codex 等已标注执行器：AGENTS.md **不双注**（parts 无 agents 项）；未标注执行器 + auto：AGENTS.md 注入兜底
4. VS Code 改 SOUL.md / USER.md → 重开工作台生效（文件即数据库回归测试）
5. `/mem` 显式覆盖仍可用（覆盖优先于 manifest）
6. 渠道会话（飞书起的消息）按该 bot 的 manifest 注入，与工作台会话一致
7. persona 存量迁移：老 bot 的 persona 内容出现在 SOUL.md 且注入生效

## 4. 明确不做（防 scope 蔓延）

- 不做 memory MCP / memory 工具（docs/10 §4.2 既定立场不变）
- 不反向禁用执行器原生记忆（claude 的 CLAUDE.md 是它自己的事，中立层）
- 不引入 HEARTBEAT.md / DAILY.md / PROJECTS.md / KNOWLEDGE.md（openclaw 已退役或本就不存在；
  心跳已是合成 bot、每日精炼已有 daily 分片，无需重复造文件）
- 不做检索降级注入（memoryToolRouted）与 WeKnora 联动——记入 docs/10 未来节
- 预设不持久化（D7）；manifest 不做继承/模板机制（先有显式矩阵，模式抽象等真实需求出现再说）

## 5. 落地记录（2026-10-22，P0–P4 全部完成）

**已落地**：D1–D8 全部按计划实现。

实现要点与计划的偏差：

- **STANDING 移到注入块末位**（原实现它在首位）——按 D6 红线压轴，这是行为变化但属计划内。
- **`session.start` 每次经 `botRegistry.getBot` 重扫盘**拿 manifest（计划已预见的成本）；合成 bot
  （steward/heartbeat）定义若未经 registry hydrate，由调用侧再归一一次兜底（`index.ts` / `askBot.ts`）。
- **MemoryScopePicker 没有删除而是重写**：从全局前端态改为「写当前 bot manifest」的快捷开关；
  `useWorkbench.memoryScopes` 全局态已退役删除。
- **AddBotDialog 内部字段名仍叫 persona**（UI 草稿概念），落盘一律走 `soulMd` → putBot 物化；
  编辑回填优先读 `b.soulMd`，老 bot 回落 `identity.persona`。
- **技能目录的项目级优先排序**（P4 实测发现）：用户公共库 400+ 技能时，先用户级的枚举序会让
  预算截断吃掉项目级技能——恰是最不该丢的。`listCatalogSkills` 项目级源先于用户级。
- **冒烟**：`pnpm -C backend smoke:context`（22 项断言：归一语义 / auto 判定 / 六节顺序 /
  /mem 覆盖 / 空模板跳过 / 技能目录与名单过滤 / persona 迁移 / hydrate 归一）。修过的真 bug：
  writeUser 漏传 USER_CHAR_LIMIT（沿用了 MEMORY 的 2200）。

**执行器标注（P2-4 终态：10/14）**：zcode / codex / claude / opencode / cursor / grok / kimi /
hermes / dsh / pi 已标注，证据注释在各 adapter。未标注 4 家：mcode（源码只见「提示补建
AGENTS.md」，未见自动加载）、agy（无源码可核）、openclaw（其作为执行器的工作区解析语义复杂，
不注不损）、mockperm（测试夹具）。未标注 = auto 走工作台注入兜底。

**验收对照**（docs/20 §3）：1–5、7 已由冒烟与 typecheck 覆盖；3 的「不双注」依赖运行时实跑，
当前由 auto 判定单测 + adapter 声明保证逻辑正确，真机跑一遍 codex 会话看派发日志 parts 即可闭环；
6（/mem 覆盖）协议保留，前端指令入口未接（原状）。
