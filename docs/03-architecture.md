# 架构与 SPI 设计

> 这是本项目**唯一需要原创**的部分。其余全是选型，本文只解释为什么这么切。

---

## 一、三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  ui/            渲染层：员工视图 / 项目视图 / 归一化时间线      │
│                 只认 RuntimeEvent，不认任何厂商                │
├─────────────────────────────────────────────────────────────┤
│  core/          领域层 + SPI：零厂商依赖，零框架依赖            │
│                 WorkUnit · Session · RuntimeAdapter           │
│                 RuntimeEvent union · RuntimeRegistry          │
├─────────────────────────────────────────────────────────────┤
│  adapters/      适配层：每家一个目录                           │
│   zcode/  claude-code/  codex/  opencode/  pi/  dsh/          │
│                 把原生协议翻译成 RuntimeEvent                   │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向严格单向向下。** `core/` 不 import 任何厂商类型，
`ui/` 不 import 任何适配器。

---

## 二、核心洞察：员工和项目是同一个原语

现有产品把你的两种用法做成了两类软件。但它们共享同一套运行时原语：

```
目录 + agent 定义 + 会话 + 技能 + 权限
```

差别只在**关注点**：

| | 员工模式 | 项目模式 |
|---|---|---|
| 关注 | 人设、日程、渠道、长期记忆、产出归档 | 看板、diff、PR |
| 会话寿命 | 长 | 短寿 |
| 隔离方式 | 无 | worktree |
| 本质 | 招聘 | 组队施工 |

所以 `WorkUnit` 只有一个类型，用 `kind: "employee" | "project"` 区分，
**两套视图消费同一个模型**。这是整个 UI 能"一个界面"的前提。

已落地：`core/units.ts`

---

## 三、SPI 契约

### 3.1 三个刻意削减

参照 t3code 的 `packages/client-runtime/src/connection/registry.ts`，
但做了三处削减：

| 削减 | 理由 |
|---|---|
| 去掉 Effect / Schema | t3 的 Effect 深度织入每个模块，引入即重写。纯 TS 判别联合零学习成本 |
| transport 下沉到工厂 | UI 只面向「能干什么」，不面向「怎么连」 |
| 强制能力声明 | 适配器必须显式说自己缺什么，UI 据此渐进增强 |

### 3.2 能力矩阵 —— 最容易被跳过、但最关键

```ts
export interface RuntimeCapabilities {
  resumeSession; fileDiff; terminal; permissions;
  subagents;     worktrees; mcp;      usage;      multimodal;
}
```

适配器**显式声明**自己缺什么，而不是全给 `true`。

这不是洁癖。真实情况是：

- OpenCode 没有结构化 diff、没有权限审批
- Claude Code 没有 worktree
- pi 没有内建终端
- Codex 没有子代理

**UI 必须在能力缺失时优雅退化，而不是渲染一个永远空白的面板。**
右栏的能力矩阵就是逼自己面对这件事。

已落地并**实测验证**：

| 事件 | ZCode (9/9) | OpenCode (5/9) |
|---|---|---|
| 权限审批 | ✅ 出现 | ✅ 不出现 |
| 结构化 diff | ✅ `+42 -7` | ✅ 不出现 |

**UI 代码一行没改，事件流自动退化。** 这是 SPI 设计的验收标准。

### 3.3 归一化事件流

六家工具的原生事件格式完全不同：

- dsh → ACP（JSON-RPC over stdio）
- pi → framed CBOR
- ZCode → HTTP / agent-server
- Claude Code / Codex → JSON-RPC
- OpenCode → 进程 stdout

如果 UI 直接消费原生事件，**每加一个工具就要改一遍渲染层**。
所以适配器必须把它们收敛到 `RuntimeEvent` union：

```
session.*  message.*  reasoning.*  tool.*  file.*
permission.*  subagent.*  plan.*  usage  deliverable  error
```

`plan.*`（proposed / step.updated / resolved）是为了给右栏的 `plan-detail` 页签一个真实数据源：
ZCode 那一页看的是 agent 提计划、用户批/改/否的完整过程，只靠 `message.delta` 反推是反推不出来的。

**新增事件类型 = 改 union + 各适配器补一个 mapper，渲染层不动。**

已落地：`core/events.ts` + `ui/Timeline.tsx`

### 3.3.1 两种接入形态（pi / mcode 实证，2026-10-03）

daemon 侧适配器有两种成熟形态，按目标 CLI 的协议能力选：

| 形态 | 进程模型 | 适配器 | 适合的 CLI |
|---|---|---|---|
| **一次性进程** | 每轮 spawn 一个 CLI 进程，stdout JSONL 翻完即退 | `claude.ts` / `codex.ts` / `pi.ts` | 有 `-p` + JSON 输出模式 |
| **常驻 stdio 协议** | 会话首推 spawn 一次，stdin/stdout 即协议通道，断连即退 | `zcode.ts`（agent-server）/ `mcode.ts`（ACP）/ `dsh.ts`（ACP） | 有常驻服务模式（`mcode acp`、`dsh acp`，接法参考 t3code 的 `packages/effect-acp` client） |
| **常驻 HTTP server** | spawn 无头服务（随机端口 + 密码），HTTP API 驱动 + SSE 事件流 | `opencode.ts`（`opencode serve`，t3code OpenCodeServerOwner 同款） | client-server 架构的一等接口是 HTTP 而非 stdio |

- **pi**（`pi --mode json -p`）：事件流含 thinking/text/toolcall 三路 delta 与
  `tool_execution_*`，usage 带真实计费；多轮靠 `--session-id`（daemon 生成、首轮即知，
  externalRef 恒非空，reattach 零成本）。
- **mcode**（`mcode acp`）：完整 ACP——`session/prompt` 阻塞到轮末，反向
  `session/request_permission` 翻成 `permission.requested`（唯一有真审批流的非 mock 执行器），
  `tool_call` content 块带 `{type:"diff"}`（结构化 diff 能力），`session/load` 把外部会话
  连历史一起接回。
- **dsh**（`dsh acp`，= `--profile acp`）：automation-only ACP，与 mcode 同构但更瘦——
  权限请求只有 allow-once/reject-once 两档、无 diff 块、usage 无成本字段；reattach 走
  `session/resume`（要求 cwd 一致且原持有者已释放，实测跨进程恢复历史通过）。
  cherry-studio 的接法是进程内嵌 `@deepseek-ai/dsh-sdk-client` SDK（GPL，只看思路）——
  daemon 以子进程协议为中心，选 ACP 免厂商依赖；cherry 可借鉴的是 resume-token
  事件化，这一点契约里已有（session.ref / externalRef）。
  启动有个坑：npm 全局 dsh shim 指向源码 checkout（依赖 tsx，本机已失效），
  实际可用的是桌面版 `cli/bin/dsh.cmd`——适配器解析 shim 内容拿到
  `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` 原生 spawn，绕开 cmd.exe
  在带空格路径上的转发碎裂。
- **opencode**（`opencode serve`，HTTP 形态）：Basic 认证（用户名 opencode +
  `OPENCODE_SERVER_PASSWORD`）+ SSE `/event` 全局流按 sessionID 过滤；prompt 用
  `prompt_async` + `session.idle` 轮完成信号（避开阻塞 POST 的 undici 5min 头超时）；
  本轮文件变更 finalize 后 `GET /session/:id/diff` 拉真 patch（SSE 的 session.diff
  事件是 revert 快照，实测恒空）；权限走 `permission.updated` 事件 +
  `/permission/:id/reply {reply:"once"|"always"|"reject"}`；会话按项目落盘全局可寻址，
  新 serve 进程凭 sessionID 直接续。本机凭据已配（MiniMax/qwen/智谱），但用户默认
  模型 zhipuai-coding-plan 已失效，model=null 会撞 "Model not found"——catalog hint
  有提示。

选型判据：**CLI 有结构化非交互输出就别起常驻进程**（少一条生命周期要管）；
**需要反向流（权限/审批/steer）才值得常驻**。

---

## 3.4 右栏页签契约（**已移除**，本节仅存档）

> 2026-10 用户决定：这个产品不要右栏。`core/sidepane.ts`、`store/useSidePane.ts`、
> `scripts/check-sidepane.ts` 与命令面板里那条入口一并删除。
> 下面这一节保留为历史契约记录 —— 真要重做右栏，照这里的设计重新落一遍，
> 比修复一堆没人渲染的死代码便宜。

右栏是照 ZCode 的 `workspaceSidePane.ts`（2069 行）建的，行为层面对齐，不只是样式。

**24 种页签类型，三种归属**（ZCode 里散落在 `isSidePaneTabVisibleForParent` 的 if 分支，这里显式化）：

| 归属 | 数量 | 含义 | id 形态 |
|---|---|---|---|
| `workspace` | 11 | 整个工作区共享，切会话不隐藏 | `git` |
| `session` | 10 | 归属某条会话，切走即隐藏 | `files@<sessionId>` |
| `root-session` | 3 | 归属会话树根 | `bash-output@<rootId>` |

**归属不是装饰**。会话级页签看不到别的会话的 diff 是硬约束，
所以 id 里必须带 owner —— 两条会话共用一页会直接串数据。

抄下来的五条行为约定（`core/sidepane.ts` 是纯函数，`pnpm check:sidepane` 95 条断言守着）：

1. **关激活页签落到右邻** `min(closingIndex, len-1)`，不是左邻也不是第一个
2. **重排不改变 `activeTabId`** —— 拖动只是换位置，不该顺手切页
3. **批量补齐不能抢焦点** —— `syncOwner` 显式守住原焦点；
   ZCode 的「批量打开最后一个激活」只适用于用户主动打开的场合
4. **过滤发生在状态边界** —— `normalizeSidePaneState` 在入口滤掉隐藏类型，
   而不是散落在渲染时（ZCode 的 `normalizeWorkspaceSidePaneState` 滤掉 treemapping）
5. **搜索评分** 标题前缀 120 > 词首 90 > 标题包含 70 > 提示 40 > 类型 20 > 其余 1，
   多关键词 AND

**「功能可见」由「+」目录承担，不由预置承担。**
23 种可见页签全在目录里（treemapping 按 ZCode 口径隐藏），
缺运行时的照常开门，菜单行里直接写「待接：node-pty 真 PTY（当前只有外观）（P2 桌面壳）」。
**看不见 = 功能不存在**，所以没有「因为当前是空的所以先藏起来」这种优化。

总览弹层有三组，不只是两组：**已打开 / 最近关闭 / 可打开的标签**。
第三组是搜「没开过的页签类型」的入口 —— ZCode 给每种**类型**都备了 `typeLabel` + `searchHint`，
这两样只有在「能按类型搜」时才划算，只搜已开的页签的话根本用不上。
只做两组的话，23 种里没开过的那十几种等于不存在：得先知道它叫什么，再去菜单里手动翻。

`TAB_ORDER` 用 `satisfies` + `Exclude<..., never>` 做编译期穷尽断言：
加了一种页签却忘了加进目录，`tsc` 阶段就挂，不会等到上线后菜单里少一项。

### 徽标为什么是派生的

标签条放不下时会横向裁剪，被裁掉的那一页你根本看不见。
徽标是「看不见但有事」的最后一个信号 —— 没有它，裁剪等于静默丢功能。

徽标**不存进 tab**，而是 `deriveTabBadges(events, ownerId)` 从事件流现算。
存进 tab 就得有人负责更新，而更新点分散在事件到达、开关页签、切会话三处，
漏一处就是一个永远过期的数字。现算则天然不会有陈旧值。

只给有实际含义的类型计数：`git`/`files` 变更文件数（去重）、`trace` 待裁决权限数、
`developer-tools`/`tools` 失败调用数、`bash-output` shell 调用数、
`plan` 未完成步骤数、`subagent` 进行中数量。
`capabilities`/`deliverables` 这类「内容就是全部」的页不给数字，给了只是噪声。

### 事件流里踩到的两个真 bug

**1. 适配器的事件队列不能是「一排等待者」。**
旧写法 `waiters[]` + emit 时 shift 一个：只要 emit 时消费者还没重新挂上等待
（`resolve` 只把续体排进微任务，不会同步跑），这一条就丢了。
后果是**同步连发的事件只有第一条能活下来** —— 一次跑 6 条 `file.diff` 只剩 1 条，
所有靠事件驱动的页签看起来都像「没数据」。改成「缓冲 + 单槽」后修复。
这也是真实适配器必须守的契约：运行时不能因为 UI 还没调 `next()` 就丢事件。

**2. 子代理的 childId 必须在 await 之前定下来。**
原先 `subagent.spawned` 与 `subagent.finished` 各算一次 `Date.now()`，中间隔着 `await`，
开 pace 时两次必然不同，配不上对，子代理页会永远停在「进行中」。

### 3.5 执行器与模型：两个正交维度

「用哪个 CLI」和「这个 CLI 这次用哪个大脑」是**两个独立决策**，不是父子关系。

```
Claude Code  →  只能接 Anthropic（3 个）
Codex        →  只能接 OpenAI（3 个）
OpenCode     →  厂商中立（8 个）
pi           →  厂商中立（8 个）
ZCode        →  厂商中立（8 个）
dsh          →  以 DeepSeek 为主，但 ACP 是协议层，跨厂商（4 个）
```

所以**可选模型集由适配器逐家声明**（`AdapterFactory.models`，同 `capabilities` 的强制声明口径），
UI 不写任何厂商 if。`RuntimeRegistry.register` 拒收空清单 ——
空清单意味着这个执行器没法开工，要在注册那一刻就炸，不能等用户点了发送才发现。

`StartSessionRequest.model` 是**必填** `ModelId`，不是可选的裸字符串。
留成 optional 等于「有时有模型有时没有」，结果就是每个适配器各自决定默认值 —— 六家六个口径。

### 三个刻意不做的简化

**1. 不存全局单一模型。** 切成全局的那个在换执行器时必然出现非法组合：
ZCode 选了 `claude-sonnet-5`，切到 Codex 后它根本不接 Anthropic 的模型。
现在的口径是 `runtimeModels: Record<runtimeId, ModelId>` —— 各存各的，切回来时你上次选的那个还在。

**2. 不用「模型支持视觉」去禁选。** 曾用
`spec.multimodal && !runtime.capabilities.multimodal` 拦，
结果 Codex（`multimodal: false`）的 3 个模型全是视觉模型 → **全部禁用 → 一个模型都选不了的死路**。
支持视觉的模型在只走文本的 CLI 上照样能跑绝大多数 agent 任务。
真正该禁的只有**纯视觉模型**（`visionOnly`），所以单独拆了这个字段。
「每家执行器至少有一个可选模型」已钉成断言 —— 不变量比具体规则重要。

**3. 默认模型不取菜单第一个。** 菜单第一个是最便宜的旗舰，
默认落在那等于每次按 4~40 倍价跑；可默认落在最便宜档又可能不够干 agent 的活。
现在的优先级是 **均衡 → 旗舰 → 快速**，默认落在「大多数 agent 任务的起点」。

`RuntimeBinding.modelHint` 是**每个工作单元**的模型偏好：
写公众号的员工用 Haiku 跑量、写代码的项目用 Opus —— 都是 ZCode，但不该同价。
它是 hint 不是命令，指向一个该 CLI 不接的模型时静默忽略。
回落顺序是 **用户所选 → 本 hint → 执行器默认**，每一级都过合法性校验。

### 价格是快照，不是契约

厂商调价与换窗口的频率远高于我们发版。`ModelSpec` 的每一条都带 `asOf` + `source`，
`pnpm check:models` 会断言这两列不为空 —— 将来有人手改数字却忘了更新来源，当场挂掉。

当前目录（2026-09-27 核实）：

| 模型 | 输入/输出 $/1M | 窗口 | 档位 |
|---|---|---|---|
| Claude Fable 5.1 | 10 / 50 | 1M | 旗舰 |
| Claude Opus 5.5 | 4 / 20 | 1M | 旗舰 |
| Claude Sonnet 5 | 2 / 10 | 1M | 均衡 |
| Claude Haiku 4.5 | 1 / 5 | 200K | 快速 |
| GPT-6 Astra | 10 / 50 | 1.1M | 旗舰 |
| GPT-5.1 Codex | 2.50 / 20 | 400K | 均衡 |
| GPT-5.6 Luna | 0.20 / 1.20 | 1.1M | 快速 |
| DeepSeek V4 Pro | 0.435 / 0.87 | 1M | 旗舰 |
| DeepSeek V4 Flash | 0.14 / 0.28 | 1M | 快速 |

**已退役的不进目录** —— 收进来就是让用户能选到一个必然失败的选项：
`deepseek-chat` / `deepseek-reasoner`（2026-07-24）、`gpt-5-codex`（2026-07-23）、
Claude Opus 4.1 及更早。这条也有断言守着。

成本是真的从所选模型的单价算出来的（`usage` 事件按 `input/output tokens × 该模型单价` 折算），
不是写死的常数 —— 否则「换模型成本纹丝不动」，这个功能等于没做。

### 3.6 模型设置：按 CLI 记偏好（参考 T3code）

用户能**自定义每个 CLI 里能选到哪些模型**。结构对齐 T3code 的
`providerModelPreferences` + `customModels`（`packages/contracts/src/model.ts`、
`apps/web/src/components/settings/ProviderModelsSection.tsx`）：

```ts
ProviderModelPrefs = {
  hiddenModels   // 从选择器里藏起的内置模型
  modelOrder     // 用户显式排序；没排过的排最后，不被丢掉
  favoriteModels // 收藏，在菜单里提到最前
  customModels   // 用户自己加的、内置目录里没有的模型
}
```

**按 CLI 记而不是改一份全局列表**：同一个模型在 Claude Code 里要留、在 OpenCode 里要藏 ——
只有「按 provider 记偏好」才表达得出来。

四条从 T3code 抄来且必须保留的语义：

1. **自定义模型不能被隐藏**。用户亲手加的东西不会自己把它藏掉
   （T3code 对 `isCustom` 的 switch 是 disabled）。
2. **删除要连带清理引用**。删一个自定义模型时把它从 `modelOrder` / `favoriteModels` 一并摘掉 ——
   留着悬空引用，排序表会永远占着一个不存在的槽位。
3. **排序只在组内交换**。收藏项与普通项各自成段，上移一项不会把它挪进另一段。
4. **落盘读取容错**。只挑认识的字段；旧版本的裸字符串 slug 与对象形式都接受。
   理由同 `normalizeWorkspaceSidePaneState` —— 归一必须发生在边界。

### 一个被自检抓出来的移植 bug

`nextHiddenForBulkToggle` 我最初照 T3code 写：「全藏了就全显，没全藏就全藏」。
但我们多了一条 `normalizePrefs` 的兜底 —— **全藏状态存不住，会被自动放回一个**。
于是第二次点「全部显示」走进了「全藏」分支，又被兜底放回一个，
**这个按钮永远点不动**。

修法是把判定条件从「是否全藏」改成「当前可见数 ≤ 1」。
不变量（至少留一个）比具体规则重要，规则要围着不变量写。

### 可见性判定只有一个入口

`resolveVisibleModels(declared, prefs)` 是唯一口径，设置页 / 选择器 / 右栏「能力」页
全都读它。这不是洁癖 —— 本项目已经因为「UI 和自检各写一套口径」踩过两次：

- 一次是按 `multimodal` 禁选，把 Codex 变成一个模型都选不了的死路
- 一次是右栏「能力」页读声明清单、选择器读有效清单，导致「设置改了但只在一处生效」

### ⚠ 自定义模型会打穿 `useShallow`

`resolveVisibleModels` 里的自定义模型由 `customToSpec` **每次现造新对象**，
所以 `useShallow` 的逐元素引用比较永远不相等 → 缓存永不命中 →
React 19 报 `getSnapshot should be cached` + `Maximum update depth exceeded`，
**一添加自定义模型立刻白屏**。而且在添加之前完全看不出来。

修法是在 store 里按**输入引用**（`declared` / `prefs` 本身都是稳定的）做一层引用记忆，
`selectVisibleModels` 因此返回引用稳定的数组，调用方连 `useShallow` 都不需要 ——
加了反而会掩盖引用不稳定这个真问题。

---

## 四、零迁移：文件即数据库

```
content/
  AGENTS.md      ← workspaceIdentity 从这里解析，不入库
  skills/        ← 技能目录，原样可用
  automations    ← 定时，原样可用
  drafts/        ← 产出归档，原地落盘
```

UI 是**渲染层**。删掉整个工作台，资产一行没动。
所有身份、调度、记忆都从磁盘读，不维护影子数据库。

这是「拒绝巨量迁移成本」在数据层的落地方式。

---

## 五、已落地的目录结构

```
prototype/
  src/
    core/                  ← 零厂商依赖
      units.ts             WorkUnit / Session / Deliverable
      events.ts            RuntimeEvent union + TraceRecord
      adapter.ts           RuntimeAdapter SPI + Capabilities
      registry.ts          RuntimeRegistry
    adapters/
      mock/
        adapter.ts         六家工具的假实现
        fixtures.ts        样例工作单元
    store/
      useWorkbench.ts      zustand
    ui/
      RuntimeBar.tsx       执行器切换条
      UnitList.tsx         左栏：员工/项目双视图
      Timeline.tsx         归一化事件流渲染
      RightPanel.tsx       能力矩阵 + 产出归档
      Composer.tsx         输入区 + 策略选择
```

---

## 六、两个必须记住的坑

### 坑 1：zustand v5 + 派生数组 = 无限重渲染

```ts
// ❌ 每次 getSnapshot 返回新数组引用
export const selectUnitDeliverables = (s) => s.deliverables.filter(d => d.unitId === s.activeUnitId);

// ✅ 必须配 useShallow
const deliverables = useWorkbench(useShallow(selectUnitDeliverables));
```

不配 `useShallow` 的症状：React 19 报
`The result of getSnapshot should be cached` → `Maximum update depth exceeded` → 整棵树白屏。

**这是开发这个原型时实际踩到并修掉的第一个 bug。**

### 坑 2：注册表订阅回调里不能改注册表

```ts
// ❌ 自触发死循环
registry.subscribe((entries) => {
  store.setState({ entries });
  for (const e of entries) { registry.setState(...); }   // 又触发 emit
});

// ✅ 订阅只镜像，探测放独立一次性任务
registry.subscribe((entries) => store.setState({ entries }));
void (async () => { /* 探测 */ })();
```

---

## 七、目录边界（为将来拆 monorepo 预留）

现在单 Vite app，因为原型期要的是秒级热更新，不是工程结构完美。

**但导入方向从第一天就锁死：**

```
ui/       → core/
adapters/ → core/
core/     → （不 import 任何东西）
```

升 monorepo 时，`core/` 整体搬成 `packages/core` 即可，
`ui/` 搬成 `packages/ui`，`adapters/*` 各自成包。**纯机械操作。**

升级时机：适配器超过 4 个，或需要 Electron 主进程共享 `core/`（预计 P3）。
