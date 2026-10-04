# 10 —— 记忆系统施工图（项目记忆 + 总管 + 跨 CLI 检索）

> 立项：2026-10-04　　状态：**规格已定稿，待施工**
> 前置阅读：`docs/03-architecture.md`（现有架构）、`docs/08-bot-server-upgrade.md`（施工图体例）

---

## 〇、执行状态

| 工作包 | 状态 | 备注 |
|---|---|---|
| WP-1 项目记忆文件层 | **完成** | `src/memory/projectMemory.ts`；`smoke:memory1` 全绿 |
| WP-2 字符上限 | **完成** | `src/memory/limits.ts`；超限拒绝且磁盘不变已验证 |
| WP-3 规则注入 | **完成** | `ruleTemplate.ts` + `injection.ts` + `host.ts` 单点接入；`smoke:memory2` 全绿 |
| WP-4 流式扫描器 | **完成** | `scanner.ts` + `bigram.ts` + `redact.ts`；`smoke:memory3` |
| WP-5 追溯搜索 | **完成** | `search.ts`；**真实数据 14,386 块 / 429ms** |
| WP-6 每日总结 | **完成** | `dailyDigest.ts` + `llm.ts`；`smoke:memory4` |
| WP-7 管家 bot | **完成** | `steward.ts`；默认开检索、其余默认关；`smoke:memory4` |
| WP-8 UI 三柱 | **完成** | `prototype/src/ui/MemoryPanel.tsx` + `store/useMemoryPanel.ts` + 设置页重做 |
| WP-9 curator | **完成** | `curator.ts` + 遥测打点接进 `host.ts` + `scheduler.ts` |

**冒烟现状**：`smoke:memory1` ~ `smoke:memory6` 共 **262 项断言全绿，0 失败**；
`backend` 与 `prototype` 双 `tsc --noEmit` 干净；
既有 `smoke-health` / `phase1` / `phase2` / `phase7`（旧三柱路径未被拆）全绿。

**代码落点（实际）**

```
backend/src/memory/
├── projectMemory.ts   WP-1  文件读写 / 布局 / 原子写 / 备份
├── limits.ts          WP-2  2200 上限 / 80% 提醒 / 报错工厂
├── ruleTemplate.ts    WP-3  注入给 agent 的规则文案
├── injection.ts       WP-3  FileMemoryInjector（host 侧契约的实现）
├── scanner.ts         WP-4  通用流式扫描器
├── bigram.ts          WP-4  中文 bigram + 覆盖率打分
├── redact.ts          WP-4  敏感遮蔽
├── search.ts          WP-5  追溯搜索 + 翻上下文
├── dailyDigest.ts     WP-6  每日总结
├── llm.ts             WP-6  后台任务的一次性模型调用
├── steward.ts         WP-7  总管 bot + 权限模型
├── curator.ts         WP-9  状态机 / 备份回滚 / 审查
├── scheduler.ts       WP-6/9 后台调度（日报 cron + curator 空闲触发）
└── memory.ts          Phase 7 旧三柱（保留，v2 WeKnora 继续用）

prototype/src/
├── ui/MemoryPanel.tsx      三柱面板 + 会话搜索
├── store/useMemoryPanel.ts 记忆 RPC 的唯一封装
├── store/useMemoryPrefs.ts 重写（8 后端注册表 → 上限 + 开关）
└── ui/SettingsPage.tsx     只换记忆分区
```

### WP-1 / WP-2 施工记要（2026-10-04）

**产出**
- `backend/src/memory/projectMemory.ts` —— 布局/读写/原子写/备份/备份淘汰
- `backend/src/memory/limits.ts` —— 2200 上限、80% 提醒、`buildOverLimitError`
- `backend/scripts/smoke-memory1.ts` —— 39 项断言，`pnpm smoke:memory1`

**过程中改掉的一个真 bug**：`overLimitError` 最初写成 `return err`（只构造不抛），
靠调用点的 `throw` 侥幸没暴露。已改名为 `buildOverLimitError` 并明确「工厂只构造、
调用点负责 throw」，测试改为直接断言返回值。

**已验证的关键行为**
- 首次 `ensureLayout` 建 `MEMORY.md` + `memory/daily/`，再次调用**幂等不覆盖**
- 超限**拒绝发生在写之前** —— 磁盘内容逐字节未变（这是最要紧的一条）
- 报错文案含「当前用量/上限」+ 现有条目列表，agent 不必回读文件即可整改
- 写前备份到 `backups/<scopeId>/`，内容为覆盖前版本；首次创建不产生备份
- `daily` 超 2200 仍可写（不设上限），`limit === Infinity`，不触发提醒
- 原子写无 `.tmp` 残留；备份稳定收敛到 20 份

### WP-3 施工记要（2026-10-04）

**产出**
- `backend/src/memory/ruleTemplate.ts` —— 注入给 agent 的规则文案（~1000 字符）
- `backend/src/memory/injection.ts` —— `FileMemoryInjector`，实现 host 侧契约
- `backend/src/runtime/host.ts` —— **单点接入**（见下）
- `backend/src/store/db.ts` —— `dispatches` 表 + `memory_meta` 表（curator 遥测）
- `backend/scripts/smoke-memory2.ts` —— 44 项断言，`pnpm smoke:memory2`

**host.ts 的改法（守住了「执行链路只加不改」）**

`MemoryInjector` 声明在 **host 侧**而非从 memory 模块 import —— 依赖方向只能是
`host ← memory 实现`，host 不该知道 MEMORY.md 是什么。构造参数**可选**，
不传 = 记忆系统关闭、派发行为与引入记忆之前逐字节一致，因此所有既有冒烟不受影响。

注入点**只有 `startSession` 一个**。这不是偷懒，是冻结快照的直接推论：
- 续聊不重复注入 → 保住 LLM 前缀缓存
- 切换执行器必开新会话 → 冷启动时自然重新注入（正是我们要的语义）
- daemon 重启后 `resumeSession` 走 CLI 自己的历史 → 不重复注入

`input.prompt` 与 `effectivePrompt` 严格分工：**发给模型用 effective，台账/标题/分发日志用 original**。
`messages` 表里若混入注入内容，UI 上「用户说了什么」就永远说不清了。

**已验证的关键行为**（用 mockperm 回显 prompt 做铁证 —— 它把收到的完整 prompt 塞进 `message.completed`）
- **记忆正文真的到达了模型手里**（assistant 回显里含 `这个仓库用 pnpm`）
- `messages` 表存的是用户原话，**不含**注入内容 —— 两者分列
- `dispatches` 记下注入块 / 注入字符数 / parts / root_path
- 续聊**不新增**分发日志，且续聊 prompt 干净
- 注入器抛异常**不阻断派发**（只记一条 warn）
- 未接注入器的 host 行为与从前完全一致（回归保护）
- 无记忆 / 只有模板占位的项目 → 正常派发，不注入、不写日志

**顺带修的**：smoke 最初因 SQLite WAL 文件被锁而清理失败（Windows EPERM）。
`Store.close()` 本来就有，是 smoke 忘了调。

**回归验证**：`smoke-health` / `smoke-phase1` / `smoke-phase2` 全绿。
`smoke-phase3` 及之后依赖真实外部 CLI，本机 codex 账号侧返回
`404 Model "gpt-6-astra" is not supported by any configured account`，
**与本改动无关**（冒烟用临时目录、无 MEMORY.md，注入器返回 null，代码路径与从前逐字节一致）。

---

## 一、目标形态（锚点）

**一句话：每个项目自己带记忆；总管能跨项目查；日常不用查，追溯才查。**

```
每个项目（bot 文件夹 = rootPath）
├── MEMORY.md              长期事实，2200 字符硬上限，恒注入
├── memory/daily/*.md      每天流水摘要，按天分片，不注入
└── skills/                程序性记忆，默认启用

管家 bot（初始化即存在的默认 bot）
├── 每日 1-2 次定时总结      增量读当天会话 → 写 memory/daily/
├── 跨会话追溯搜索          按路径/日期收窄 → 流式扫描 → bigram 匹配
└── 独占检索权              其他 bot 默认关，可开关

执行器原生会话（各 CLI 自己管，workbench 只读）
~/.claude/projects/**/*.jsonl
~/.codex/sessions/**/*.jsonl
~/.pi/agent/sessions/**/*.jsonl
~/.minimax/v2/sessions/**/*.jsonl
```

**不建的东西**：不建 L2 会话原文副本、不建倒排索引、不上 RAG、不做全局注入层。

---

## 二、决策记录：四个「不建」及其依据

这一节是本文档最重要的部分。**每个否决都基于实测或外部验证，不是偏好。**

### 2.1 不建 L2 会话信封原文副本

**原提案**：workbench 自己在 sqlite 建 `dispatches` 表，抄一份每轮的 prompt/回答/工具/用量。

**否决理由**：
- CLI 原生文件里的信息**比 workbench 能看到的更完整**。pi 存了 `thinkingLevel`、claude 存了 `gitBranch`、mcode 存了 token 计量（`.minimax/v2/sessions/**/messages.jsonl` 的 `message.usage`）。
- 现有 `messages` 表把 prompt 存成一整块（`runtime/host.ts:346`），**无法区分用户原话和注入内容**，注入信息在这一层就已经丢了。
- **终端里直接用的会话 L2 永远抓不到** —— 而这恰恰是用户最看重的价值。

**留下的唯一残件**：一张极小的**分发日志**，只记「哪个 bot 派了哪轮、注入了什么、用了多少 token」，**不抄任何会话原文**。用于 UI 回答「这一轮它到底知道什么」。

### 2.2 不建倒排索引

**原提案**：建 contentless FTS5 索引统一管所有 CLI 的会话。

**否决理由（实测，2026-10-04）**：

在用户机器上真实解析 223 MB 采样数据：

| CLI | 采样源 | 可索引文本 | FTS5 索引 | 索引/源 |
|---|---|---|---|---|
| claude | 40.1 MB | 14.6 MB | 13.3 MB | 0.332 |
| codex | 137.4 MB | 3.9 MB | 2.8 MB | 0.020 |
| pi | 0.9 MB | 0.1 MB | 0.1 MB | 0.137 |
| mcode | 45.0 MB | 6.5 MB | 3.7 MB | 0.083 |
| **合计** | **223.4 MB** | | **19.9 MB** | **0.089** |

→ 全量 1.6 GB 的索引约 **146 MB**（区间 30–530 MB）。

**但空间从来不是真正的理由。真正的理由是需求形态**：

> 追溯搜索是「低频 + 大致知道在哪」。而路径本来就在目录名上：

| CLI | 目录形态 | 查单个项目要扫 |
|---|---|---|
| claude | `~/.claude/projects/C--Users-chenziyu-project-XXX/` | **一个目录** |
| pi | `~/.pi/agent/sessions/--C--Users-chenziyu-project-XXX-` | **一个目录** |
| codex | `~/.codex/sessions/2026/05/08/rollout-*.jsonl` | 日期收窄 + `payload.cwd` 过滤 |
| mcode | `~/.minimax/v2/sessions/2026/06/01/` | 日期收窄 |

范围天然收窄一个数量级。**先缩小再扫 = 秒级；不需要预建索引。**

附带收益：省掉索引陈旧问题、省掉同步维护、省掉 146 MB 数据库、**敏感内容零复制**。

**后悔药**：扫描器接口设计成流式（输入路径 → 输出 `(块, 行号, 时间, 归属)`）。将来若要加索引，把它的输出直接喂 FTS5 即可，不用重写扫描逻辑。

### 2.3 不做 RAG / 不上 WeKnora（针对会话原文）

**否决理由**：

1. **归因会丢（最致命）**。RAG 把出处弱化成相似度分数，而产品硬需求是「搜索结果必须显示归属：哪个 CLI、哪个项目、哪一轮」。关系型数据天然保留，RAG 把它降级。
2. **用户记得关键词**。「我之前在 B 项目怎么处理 X 的」—— `X` 就是词。精确匹配更准、零延迟、零成本。RAG 的价值是「不知道该搜什么」，不是这个场景。
3. **会话是流水不是知识**。大量一次性中间过程（工具输出、调试、「试了 A 不行改 B」），语义重复但零信息量，灌进向量库会互相污染。
4. **成本是数量级差别且可估算**。按实测文本比例推算：全量可索引文本 ≈ 197 MB → 40 万块 → 768 维向量纯存储 ≈ 480 MB，加 WeKnora 文档/元数据/HNSW ≈ **1–1.5 GB**，比 FTS 索引大 7–10 倍而能力上限更低。
5. **实时性**。CLI 文件一直在被写，FTS 增量更新一两条 SQL；RAG 要重新 embedding。
6. WeKnora **至今未接通**（`docs/04-design-system.md:442`：实测 401，待生成 API Key）。

**WeKnora 的正确位置**：`memory/*.md` 溢出区的语义检索（见 §四 WP-9 之后）。v2。

### 2.4 不做全局注入层（L0）

**否决理由**：用户实测经历 —— 全局记忆导致「在 A 项目出现完全不相关的 B 项目记忆」，**直接摧毁对 agent 的信任**。

hermes 与 waku 两个参考实现也都拒绝每轮全量注入（理由是前缀缓存，但结论相同）。

**替代**：取消 L0 注入层，改为**按需检索**。「搜到」与「注入」严格分离。

### 2.5 保留：冻结快照

会话开始时捕获一次，中途不变。依据 `hermes-agent/website/.../features/memory.md:47`：中途增删的记忆立即落盘，但要**下次会话**才进 prompt，目的是保住 LLM 前缀缓存。

---

## 三、三柱定义与默认行为

概念上**保留三柱**（waku 定义，`waku/memory/__init__.py:1-8`），但它们落在**三个不同的存储**里，不再是「一张表的三行」。

| 柱 | 定义（waku 原文） | 本项目落点 | 检索方式 | 默认 |
|---|---|---|---|---|
| **procedural** | SKILL.md 文件 — 怎么行动 | `<rootPath>/skills/` | 不检索，直接进 prompt | **开** |
| **semantic** | facts — 什么是持久为真的 | `<rootPath>/MEMORY.md` | 不检索，直接进 prompt | **开** |
| **semantic 溢出** | 归档但仍重要的事实 | `<rootPath>/memory/*.md` | v2 WeKnora 语义 | 开（按需查）|
| **episodic** | episodes — 发生了什么、什么时候 | CLI 原生会话文件 | 追溯时流式扫描 | **关**（可开关）|

> **schema 层不再有 `pillar` 列** —— 三柱已由存储位置天然区分。概念保留在文档与思考框架里。

**上限数值**（参照 hermes 2200 字符 / 约 800 tokens）：

| 存储 | 上限 | 满了怎么办 |
|---|---|---|
| `MEMORY.md` | **2200 字符** | 注入规则要求 agent 先整合再写；工作台侧校验并报错 |
| `memory/daily/YYYY-MM-DD.md` | 按天分片，**不设上限** | 天然有界 |
| `skills/` | 不设 | 交给 curator（v2） |

> ⚠️ 「semantic 不设上限」**不成立**。不封顶的单一文件半年后就是第二个腐化源。长期事实必须封顶，daily 按天分片才是「不设上限」的正确落点。

---

## 四、组件设计

### 4.1 项目记忆文件层（WP-1 / WP-2）

**布局**（新建，不动现有文件）：

```
<rootPath>/
├── MEMORY.md                  长期事实，2200 字符上限
├── memory/
│   ├── daily/2026-10-04.md    当天流水摘要
│   └── <topic>.md             归档但仍重要的事实
└── skills/                    已有（inspect.ts:24 已识别）
```

**工作台职责**：
1. 文件不存在则创建（带模板头）
2. 写前校验字符数，超限则拒绝并返回可执行提示
3. 每次写前备份到 `~/.agentworkbench/backups/<botId>/<ts>.md`，保留 N 份
4. 暴露 `getProjectMemory(rootPath)` / `writeMemoryEntry(rootPath, ...)` 给 RPC

**对接点**：`bots/inspect.ts:210` 已经在检测 `MEMORY.md`，`:12` 的注释明写「刻意不做的：替老文件夹做任何决定」—— **写入路径要新建在它旁边，不改它的只读语义**。

### 4.2 记忆规则注入（WP-3）—— 读写通路的正解

**核心设计问题**：workbench 不拥有工具集，它把活派给 pi/claude/codex 等外部进程。那 agent 怎么读写记忆？

**解法：零适配。**

- **读** = workbench 派发前把 `MEMORY.md` 拼成 prefix 加在用户消息前 → **任何 CLI 都吃到**，不依赖它读不读文件
- **写** = **agent 用它自带的 `write`/`edit` 直接改 `MEMORY.md`** → 每个 CLI 本来就有文件工具，**零适配**

**不需要 MCP，不需要逐家适配。** 这是相对 hermes（用 `memory` 工具做代码级约束）的取舍：更通用、更宽松，靠 prompt 规则 + curator + 备份兜底。

**注入位置**：`runtime/host.ts` 的 `startSession`（`:346` 之前）与 `sendMessage`（`:509` 之前）之前，先拼装。**只在 dispatch 那一刻发生一次**，符合 §2.5 冻结快照。

**规则模板要点**（文案见 WP-3 交付物）：
- 什么时候该写（发现新事实 / 用户纠正 / 约定变更 / 完成的工作）
- 什么时候不该写（琐碎 / 能重新查到 / 大段代码 / 临时路径 / 已在 skills 里的）
- 格式：一条一事、信息密度高、可执行
- 上限提示：当前 N/2200 字符，超过 80% 先整合

### 4.3 通用流式扫描器（WP-4）

**接口契约**（这是全系统的核心抽象）：

```ts
interface ScannedBlock {
  readonly text: string;        // 原始文本（未 bigram）
  readonly ts: number;          // 毫秒时间戳
  readonly cwd?: string;        // 归属项目路径（从 JSON 字段或目录名反解）
  readonly sessionId?: string;
  readonly lineNo: number;      // 源文件行号，供命中后前后翻
  readonly srcPath: string;     // 源文件绝对路径
  readonly cli: 'claude'|'codex'|'pi'|'mcode'|'unknown';
}

interface Scanner {
  scan(opts: { path?: string; since?: number; limitBytes?: number }): AsyncGenerator<ScannedBlock>;
}
```

**四条硬要求**：

1. **容错（fail-open）**。现场扫的是**正在被写入的文件**，必然读到半行 JSON。解析失败**跳过该行继续**，绝不整体抛错。任何一家的格式变了，最多这一家返回空，其余三家照常。
2. **大文本切块**。一块 **300–500 字符**，与源行一一对应。切太细结果碎片化，切太粗无法定位。
3. **路径反解**。claude/pi 从目录名反解（`C--Users-chenziyu-project-X` → `C:\Users\chenziyu\project\X`）；codex/mcode 从 JSON 的 `cwd` / `payload.cwd` 读。**反解不出来就标 unknown，不能瞎猜。**
4. **敏感遮蔽**。命中 `sk-` / `ghp_` / `Bearer ` / `AKIA` 等样式 → **在结果出口遮蔽**，不进日志、不进摘要。**因为不做索引，入口无需过滤，只需出口遮蔽一处。**

**中文检索必须用 bigram**。实测（2026-10-04，Node v24.16.0 / node:sqlite）：

| 查询 | `LIKE '%q%'`（现状） | trigram FTS5 | unicode61 FTS5 | **应用层 bigram** |
|---|---|---|---|---|
| 代理（2 字） | ✓ | **✗** | **✗** | ✓ |
| 天气（2 字） | ✓ | **✗** | **✗** | ✓ |
| 记忆（2 字） | ✓ | **✗** | **✗** | ✓ |
| 网络代理 | ✓ | ✓ | **✗** | ✓ |
| **sqlite 检索** | **✗** | ✓ | ✓ | ✓ |
| 工作台（同义词） | ✗ | ✗ | ✗ | ✗ |

**结论**：`bigram` 完全包含 `LIKE` 能力且多赢跨词查询，**无回归**。trigram 对 2 字中文全灭（需 ≥3 字符），unicode61 对中文基本报废。

> trigram 的这个问题 hermes 独立记录过（`hermes_state_fts.py` 模块注释）：*「1-2 char CJK terms fall through to a LIKE table scan — measured 3-6s CPU per query on multi-GB installs」*，他们的解法是原生 tokenizer `cjk_unicode61`，**Node 的 node:sqlite 装不了原生扩展，故采用应用层等价实现**。

**同义词（如「工作台」查不到「agent-workbench」）是关键词检索的硬天花板，只能靠 embedding，v2 再说。**

### 4.4 跨会话追溯搜索（WP-5）

**执行顺序（省时间的关键）**：

1. 有 `path` 提示 → 直接定位到对应目录（claude/pi 一步到位）
2. 否则按 CLI + 日期范围收窄
3. 流式扫描 → 逐块 bigram 匹配（内存 O(1)，不建倒排）
4. 排序：**时间倒序为主**（没有历史命中数据可加权 —— 索引已砍）
5. 返回时带完整归属 + 源文件行号，**支持前后翻**（`lineNo` 已在块里）

**性能预期**：单项目目录几十 MB → 秒级。退化为全量 1.6 GB → 数十秒，仅在用户明确要求时发生。

### 4.5 每日总结任务（WP-6）

**这是「不建索引」方案成立的前提，必须做对。**

| 规则 | 做法 |
|---|---|
| **增量** | 维护 `~/.agentworkbench/digest-state.json`：已处理文件的 `path → {mtime, size}`。只处理新增或 mtime 变化的。 |
| **幂等** | 输出文件名含日期（`2026-10-04.md`）。同日重跑 → **整份重写而非追加**。 |
| **失败不阻塞** | 任务失败只记日志，**绝不影响日常对话**。定时器异常要吞掉。 |
| **切分** | 按 **天 + 项目** 双层。一个总结不能覆盖所有项目。 |
| **触发** | 每天 1–2 次，优先在空闲时段（避开活跃对话）。 |
| **成本** | 范围是「当天所有会话」，用**便宜小模型**。 |

**摘要内容规范**：只写「值得三个月后还查得到」的事 —— 决定、结论、约定、踩过的坑。**不写流水账。**

### 4.6 管家 bot 与权限模型（WP-7）

**权限矩阵**：

| 主体 | 追溯搜索 | 依据 |
|---|---|---|
| 管家 bot | **默认开** | 它就是干这个的 |
| 普通项目 bot | **默认关** | 防 §2.4 的污染问题 |
| 普通项目 bot（用户开启） | 开 | `bot.crossSearch: boolean` 字段 |

**铁律：搜到 ≠ 注入。**
- 管家搜到别的项目的条目 → **必须标注归属**
- 管家自己决定要不要把结果用进回答，**工作台不自动注入**
- 跨项目记忆**永不进入**项目 bot 的 prompt prefix

**管家作为默认 bot**：初始化时创建，标记 `role: 'steward'`，不参与普通 bot 列表的路由逻辑，有独立的对话外壳。

### 4.7 curator（WP-9，v1 只埋字段）

用户明确要求 curator **在范围内**（防记忆腐化），但 v1 先只做一件事：**把遥测字段埋进 schema**。

> **为什么不能后补**：curator 的全部判断都依赖这些历史数据。没埋就永远算不出「14 天没用过」。

**现在就要有的字段**（`memory_meta` 表）：

```
path            TEXT PRIMARY KEY    -- 记忆条目相对路径
bytes           INTEGER
char_used       INTEGER
use_count       INTEGER DEFAULT 0   -- 被注入过几次
last_used_at    INTEGER
hit_count       INTEGER DEFAULT 0   -- 被搜索命中过几次
last_hit_at     INTEGER
state           TEXT DEFAULT 'active'   -- active | stale | archived
pinned          INTEGER DEFAULT 0
created_at      INTEGER
```

**v1 之后**（WP-9 后续）：两阶段状态机（确定性流转 + LLM 审查）、pin、备份回滚、`--dry-run`、空闲触发。参数参照 hermes：`stale 14 天 / archive 30 天 / interval 7 天 / min_idle 2 小时`、**永不自动删除**。

---

## 五、UI 形态（WP-8）

对话框内一个「记忆」区块，三行：

| 行 | 状态 | 显示 | 交互 |
|---|---|---|---|
| 技能 | 常亮 | `已装载 N 个` | 展开看清单 |
| 记忆 | 常亮 | `已注入 N 条 · 2,100/2,200 字符` ← 百分比（hermes 做法）| 展开看本轮注入了什么 |
| 会话搜索 | **默认灰** | — | 点开 = 搜索框 + 结果列表 |

**搜索结果每条必带归属**：`哪个 CLI · 哪个项目 · 什么时候 · 片段`，并提供「在原文件打开」。

**必须能看到的**：每一轮**注入了什么**。这是判断记忆有没有起作用、或者什么时候搞混了，唯一能查的依据。

**前端现状要重做**：`prototype/src/store/useMemoryPrefs.ts:19-26` 声明了 8 种后端（sqlite/weknora/supabase/mem0/zep/langmem/notion/local-folder），`SettingsPage.tsx:435-436` 把后 5 种标了 coming。**新架构下这套注册表整体作废**，改为「三柱开关 + 管家权限 + 上限数值」。

---

## 六、工作包与依赖

```
WP-1 项目记忆文件层  ──┐
WP-2 字符上限        ──┼──► WP-3 规则注入（接 host.ts）
                      │
WP-4 流式扫描器      ──┼──► WP-5 追溯搜索 ──┐
                      │                      ├──► WP-7 管家 bot
                      └──────► WP-6 每日总结 ─┘
WP-9 curator 遥测字段（独立，只加表）

WP-8 UI（依赖 WP-3 + WP-5）
```

**建议施工顺序**：WP-1 → WP-2 → WP-3（第一个可演示切片：agent 能读到项目记忆）→ WP-4 → WP-5（第二个切片：能追溯搜索）→ WP-6 → WP-7 → WP-8 → WP-9。

---

## 七、代码落点

### 新增

```
backend/src/memory/
├── projectMemory.ts   项目记忆文件读写、布局、备份
├── limits.ts          2200 上限校验与报错文案
├── ruleTemplate.ts    注入给 agent 的规则文案
├── injection.ts       规则拼装 + prefix 渲染
├── bigram.ts          中文 bigram 化（Lucene CJKAnalyzer 语义）
├── redact.ts          敏感内容遮蔽
├── scanner.ts         通用流式扫描器（4 家容错解析 + 路径反解）
├── search.ts          跨会话追溯搜索
├── dailyDigest.ts     每日总结任务 + 增量状态
├── curator.ts         curator 状态机（v1 只放遥测表）
└── steward.ts         管家 bot 逻辑与权限判定
```

### 修改

| 文件 | 改动 | 风险 |
|---|---|---|
| `runtime/host.ts` | `:346` / `:509` 之前插入记忆拼装 | **中** —— 执行链路核心，但只加不改 |
| `index.ts` | 注册新 RPC；`memory.save/search/list` 降级为 shim 转发新实现 | 低 |
| `bots/registry.ts` | Bot 定义加 `role` / `crossSearch`；初始化时建管家 | 低 |
| `bots/inspect.ts` | 资产扫描加 `memory/daily`；保持只读语义不变 | 低 |
| `store/db.ts` | 新增 `memory_meta` 表（curator 遥测） | 低 |
| `automation/cron.ts` | 接每日总结定时任务 | 低 |
| `prototype/src/store/useMemoryPrefs.ts` | **整体重做** | 低（纯前端）|
| `prototype/src/ui/SettingsPage.tsx` | 记忆设置页重做 | 低 |

### 不动

- `runtime/adapters/*.ts`（7 个适配器）—— **执行链路一行不改**
- `store/db.ts` 的旧 `memory` 表（`:108-115`）—— 保留不动，新数据走文件
- `memory/memory.ts` 的 weknora 配置（`kv: memory.weknora`）—— 保留，v2 要用

---

## 八、契约纪律（红线）

1. **不复制会话原文到任何自建存储。** 扫描器只读，产物只在内存和结果里流转。
2. **扫描器必须 fail-open。** 单行解析失败、单家格式变更、单文件损坏 —— 最多该家返回空，绝不整体失败。
3. **敏感内容不在任何日志、结果、摘要里明文出现。** 遮蔽在出口统一做。
4. **7 个 adapter 一行不改。** 记忆只加在 dispatch 之前，不侵入执行。
5. **三柱概念保留**，schema 层不再有 `pillar` 列。
6. **`搜到 ≠ 注入`。** 跨项目记忆永不进项目 bot 的 prompt。
7. **`MEMORY.md` 封顶 2200 字符。** 「不设上限」只对 daily 分片成立。

---

## 九、不做清单（v1 明确不碰）

- L2 会话原文副本
- 倒排索引 / FTS5 索引表
- RAG / embedding（WeKnora 接线）
- dsh（`.dsh/sessions/*.zstd`）解析
- 自动沉淀（老会话 → 项目记忆的 LLM 提炼）
- 旧会话文件迁移
- 多 bot 共享同一 rootPath 的记忆隔离策略
- curator 状态机本体（v1 只埋字段）

---

## 十、验证纪律

沿用项目既有惯例：每个 WP 配一个 `scripts/smoke-memory<N>.ts`，挂到 `package.json` 的 `smoke:memory<N>`。

**必须有的验收场景**：

| # | 场景 | 通过标准 |
|---|---|---|
| 1 | 项目无 `MEMORY.md` | 自动创建且带模板头 |
| 2 | agent 读到项目记忆 | 切到任一 CLI（claude/pi/mcode），首轮能引用 `MEMORY.md` 内容 |
| 3 | 写超 2200 字符 | 拒绝并返回含「当前 N/2200 + 建议整合哪些」的可执行提示 |
| 4 | **CLI 正在写文件时扫描** | **不崩**，跳过半行，其余行正常返回 |
| 5 | 2 字中文搜索 | 「代理」「记忆」均能命中 |
| 6 | 跨词搜索 | 「sqlite 检索」能命中（LIKE 做不到） |
| 7 | 敏感遮蔽 | 含 `sk-` 的行不出现明文 |
| 8 | 路径反解 | claude/pi 目录名能反解出 cwd；解不出标 unknown |
| 9 | 增量总结幂等 | 同日重跑两次 → `daily/2026-10-04.md` 内容不重复 |
| 10 | 权限隔离 | 普通 bot 默认搜不到；管家能搜；`crossSearch=true` 后普通 bot 能搜 |
| 11 | 单家失效 | 故意喂一份坏格式的 codex 文件 → claude/pi/mcode 照常返回 |

> 场景 4 和 11 是**最容易被忽略但最要命**的两条 —— 容错是这套东西唯一的防线。

---

## 十一、v2 待议

- WeKnora 接线（服务 `memory/*.md` 溢出区的语义检索）
- dsh zstd 解析
- 自动沉淀（老会话 → 项目记忆）
- curator 状态机本体
- embedding（同义词检索天花板）
- 多 bot 共享 rootPath 的隔离

---

### WP-4 / WP-5 施工记要（2026-10-04）

**产出**
- `backend/src/memory/scanner.ts` —— 通用流式扫描器
- `backend/src/memory/bigram.ts` —— 中文 bigram + 覆盖率打分
- `backend/src/memory/redact.ts` —— 敏感遮蔽
- `backend/src/memory/search.ts` —— 追溯搜索 + `loadContext` 翻上下文
- `backend/scripts/smoke-memory3.ts` —— 57 项断言

**一个结构性选择：不按字段名写死解析器**

四家 schema 毫无共性（claude 顶层 `content`、codex 是 `payload` 两层嵌套、
pi 是 `message.sections`、mcode 的会话**还是目录**）。写死四套精确路径，
必然随对方 CLI 升级一起烂掉。改成「通用递归抽取 + 噪声黑名单」：
噪声有明确清单（id/哈希/路径/版本/**各家塞在会话里的配置快照**——
codex 的 `state.permissions`、pi 的 `sections.skills`），对方加字段时我们自动吃到。

**实测定位到的四家形态**

| CLI | 正文 | cwd | 备注 |
|---|---|---|---|
| claude | `message.content[].text` | `cwd` | 目录名还编码了路径 |
| codex | `payload.content[].text` | `payload.cwd` | 噪声最多 |
| pi | `message.content[].*` | `cwd` | `sections.*` 是系统提示词，纯噪声 |
| mcode | `message.content[].text` | **无** | 会话是目录，内含 `messages.jsonl` + `manifest.json`，**两者都没有 cwd** |

> **mcode 的 1 GB 会话没有项目归属。** 这是实测结论，不是偷懒。
> 解析不出来就标 `unknown`，绝不瞎猜。workbench 自己派发的那部分可以从
> `dispatches` 表反查到 rootPath；终端里直接用的 mcode 会话则无法归属。

**过程中修掉的三个真 bug**
1. `listMcodeSessions` **从不递归** —— 真实布局深达 4 层
   （`sessions/YYYY/MM/DD/<会话>/messages.jsonl`），我最初只查直接子目录。
   单元测试没暴露，因为 fixture 恰好浅了一层；**真实数据跑起来立刻暴露**。
2. `MIN_TEXT=16` 把 14 字的中文整句悄悄丢了（JS 里中文 1 字 = 1 码元）→ 降到 8。
3. 枚举才是瓶颈（本机 879+93+895 个文件），不是读取。**`since` 存在时先按 mtime
   整个文件跳过**，真实扫描从几分钟降到 **429ms / 14,386 块**。

**真实数据实测**（本机 `~/.claude ~/.codex ~/.pi ~/.minimax`）：
扫到 14,386 块 / 101 文件 / **429ms**，四家都有命中。

**诚实标注的局限**
- 同义词（「工作台」查不到「agent-workbench」）是关键词检索的硬天花板，只能靠 embedding
- 一条真实命中是「全局**代理**（global agent）按 0.7 缩放」—— bigram 语义上正确
  （`代理` 确实在 `全局代理` 里），但语义上答非所问。**这就是关键词检索的边界**

### WP-6 / WP-7 施工记要（2026-10-04）

**产出**：`dailyDigest.ts`、`llm.ts`、`steward.ts`；`smoke-memory4.ts` 45 项断言。

**日报的四条纪律**（`dailyDigest.ts` 头注释里也写了一遍）
- 增量：`digest-state.json` 记 `path → {mtime, size}`
- 幂等：输出按日期命名，**同日重跑整份重写**（不是追加）
- 失败不阻塞：任何一步炸了只进报告的 `skipped`，**绝不往上抛**
- 归属解析不到 → **不写**，绝不猜

**权限模型钉在入口**：`stewardSearch(requester, opts)` 先查权限，没权直接抛
`CrossSearchDenied`，不给「悄悄返回空」的机会。报错文案写清了**为什么默认关**
（引用了用户自己的 A/B 项目污染经历）和两条出路。

**「搜到 ≠ 注入」是结构性保证**，不靠约定：注入器 `FileMemoryInjector.build`
只接**一个** `rootPath`，只读那个文件夹的 `MEMORY.md`；跨项目检索结果
**没有任何一条通路**能流进项目 bot 的上下文。冒烟里用 A/B 两个项目实测了这一点。

**注入时同步打点** `memory_meta`（`host.ts` 里的 `markMemoryUsed`）——
不打点的话 curator 会把每条都当成 active，整套判断失效。

### WP-9 施工记要（2026-10-04）

**产出**：`curator.ts`（状态机 + 备份/回滚 + 审查）、`store/db.ts` 的遥测读写、
`index.ts` 的 `curator.run` / `memory.telemetry` RPC；`smoke-memory5.ts` 41 项断言。

**六条纪律全部照搬 hermes 并逐条验**：永不删除（只归档）、动手前备份、
pinned 全跳过、空闲触发非 cron、首次推迟一整个间隔、dry-run 不写盘。

**两处我主动加严的**
1. 报告**永远**声明「LLM 审查一条都没执行」，不只在有建议时声明
2. **模型编的条目路径一律丢弃**（`known` 集合外直接 continue）—— LLM 会幻觉路径

**一个必须在测试里处理的坑**：`runCurator` 会真调 LLM，冒烟里塞了不存在的
CLI 名（`NO_LLM`）让 `resolveCommand` 立刻失败。否则 600 秒超时会把冒烟挂死。

### 冒烟抓出来的两个真问题（2026-10-04，RPC 面验收 `smoke:memory6`）

**1. 权限漏洞：报个不存在的 bot 名就能拿到跨项目检索权**

`steward.search` 的身份解析原本写成：

```ts
const def = await botRegistry.getBot(p.botId);
return stewardSearch(def ?? { id: p.botId, role: STEWARD_ID, crossSearch: true });
```

`getBot` 查不到时的回落是「当管家」—— 任何调用方传一个不存在的 `botId`
就自动获得 steward 级检索权。**这恰好是这套权限模型要防的事。**

修法：三种情况严格分开

| 输入 | 处理 |
|---|---|
| 不给 `botId` | 工作台自身的调用（设置页试跑等）→ 按管家算 |
| 给了、查得到 | 按该 bot 定义判权限 |
| 给了、查不到 | **拒绝**（`unknown_bot`）—— 绝不回落成管家 |

**2. 交互式搜索没有时间窗 = 分钟级**

全量 1.6 GB 扫一遍要几十秒到几分钟，不能挂在 RPC 上等人。
`steward.search` 默认加 `since = 365 天前` + 每家 128 MB 上限；
mtime 预筛会把老文件整个跳过，比全量快两个数量级。
真要翻更早的显式传 `sinceDays` 放宽。

> 这个默认值同时是**产品判断**：「追溯」天然是近的事件优先，
> 三个月前的对话本来就极少被翻出来。要全量翻就显式要求。

## 十三、后端调度（WP-6 / WP-9 收尾，2026-10-04）

`memory/scheduler.ts` 把两件后台活挂起来（daemon 启动即 `start()`）：

| 活 | 触发 | 说明 |
|---|---|---|
| 每日总结 | cron，默认 `17 3,14 * * *`（一天两次，避开整点） | 写 `<rootPath>/memory/daily/<日期>.md` |
| curator | **间隔 7 天 + 用户空闲 2 小时** | 刻意不接 cron —— 「空闲多久」是 cron 给不了的判据 |

三条纪律：
- **同一分钟绝不跑两次**（先落盘再干活，崩了也不会重跑）
- **失败绝不外溢**（只记日志，不影响日常对话）
- **首次运行推迟一整个间隔**（装好后先别动）

> 这里是 `memory_scheduler` 在 `index.ts` 里的接线点；`lastActivityAt` 从
> `sessions` 表的最后 `startedAt` 推。

### 性能实测与取舍（无索引的真实代价）

`smoke:memory6` 顺带量了**无索引搜索的真实成本**：

| 范围 | 耗时 |
|---|---|
| 受限搜索（1.5 MB/家） | **115 ms** |
| 受限搜索（8 MB/家，`smoke:memory3` 真实数据段） | **429 ms** |
| 无上限全量（1.6 GB） | **分钟级 CPU**（实测两个进程各烧 300s+） |

**这是「不建索引」的真实代价，不是意外。** 所以 `steward.search` 的默认值取
「够快」而不是「够全」：`since = 365 天前` + 每家 128 MB 上限。

> 想更快就**给范围**：面板默认带 `pathHint`，管家按项目/按时间收窄后是秒级。
> 这是无索引方案必须付出的使用习惯 —— 拿「每次都全扫」换「不用维护索引」。

## 十二、背景速查（给新会话的扩展阅读）

| 想知道 | 去读 |
|---|---|
| 三柱定义、检索门控、consolidation | `waku-agent/waku/memory/__init__.py:1-8`、`waku-agent/docs/architecture.md:28-36` |
| 有界记忆、冻结快照、字符上限、容量管理 | `hermes-agent/website/.../features/memory.md` |
| curator 机制（状态流转/pin/备份/回滚/dry-run） | `hermes-agent/website/.../features/curator.md` |
| 中文 FTS 的坑与 cjk_unicode61 | `hermes-agent/hermes_state_fts.py`（模块注释） |
| 现有记忆代码现状 | `backend/src/memory/memory.ts`、`backend/src/store/db.ts:334-370` |
| 现有 bot 资产约定 | `backend/src/bots/inspect.ts:23-28` |
| 现有执行链路 | `backend/src/runtime/host.ts:346 / :380 / :509` |
