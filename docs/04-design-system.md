# 设计系统落地

> 把 `DESIGN.md`（Perplexity 风格参考）应用到本项目的完整记录。
> **重点是第八节：我在哪些地方偏离了 DESIGN.md，以及为什么。**
> 严格遵守的部分不再逐条罗列。

---

## 一、总体气质

原型的深色 + 多品牌色，与 DESIGN.md 的浅色羊皮纸 + 单青强调几乎没有交集。
这是一次彻底重构，不是换配色。

| | 改前 | 改后 |
|---|---|---|
| 画布 | `#0b0c0f` 近黑 | `#faf8f5` 羊皮纸 |
| 强调色 | 6 种品牌色 | 1 种青 `#016a71` |
| 字重 | 到 600+ | 锁死 400 / 500 |
| 最小字号 | 9px | 11px |
| 圆角 | 4 / 6 / 8px | 6 / 12 / 16 / 9999 四档 |
| 投影 | 到处 box-shadow | 全场仅 1 道 |

---

## 二、Token 层

全部集中在 `prototype/src/styles.css` 的 `@theme`，Tailwind v4 直接生成工具类。

```
画布   canvas  #faf8f5    侧栏 rail #f2efe9    卡片 card #fdfbfa
发丝线 line   #d1d1cd    浅分隔 line-soft #e7e4de
文字   ink #27251e   graphite #72706b   ash #92918b
强调   teal #016a71  teal-tint #e7efef  teal-edge #a9c6c8
语义   gain #2f6b4f（diff +）  loss #9a4a3c（diff − / 错误）
```

圆角严格四档：`btn 6px` / `input 12px` / `card 16px` / `chip 9999px`。

**投影只有一道**：`--shadow-subtle: 0 1px 2px rgba(0,0,0,.08)`，只给卡片用。
其余层级全靠背景色差 + 1px 发丝线区分。

---

## 三、排版

- 字族：系统 Inter 栈 + CJK 回退（PingFang SC / Microsoft YaHei）。**不引 webfont**——本地优先原则
- 字重：只有 400 / 500。全局搜不到 `font-bold` / `font-semibold`
- 字号：11 / 12 / 14 / 16。**最小 11px**，改前满屏 9px / 10px 是最大的可读性问题
- 数字统一 `.tnum`（`tabular-nums`），时间戳和计数不会左右跳动

---

## 四、动效

全系统只有颜色过渡（120ms），无位移、无缩放、无弹跳。
焦点环是 2px 青色 `outline`，不靠阴影——保持扁平。

唯一保留的装饰性效果是输入框聚焦时的青色光晕，
这正是 DESIGN.md 指定的「全系统唯一非结构性视觉效果」。

---

## 五、布局

```
┌──────────────────────────────────────────────┐
│  执行器条（60px，rail 底）                      │
├────────┬────────────────────────┬────────────┤
│ 左栅    │  时间线                 │ 右栅       │
│ 264px  │  内容列 max-w 900px     │ 300px     │
│ rail  │  居中                   │ rail      │
└────────┴────────────────────────┴────────────┘
            输入区（rail 底，紧贴时间线）
```

900px 封顶应用到**阅读列**而非整个布局——
Perplexity 那个 900px 是给「居中文章 + 侧栏」的搜索页设计的，
我们是三栏工作台，整体封顶会浪费横向空间。

---

## 六、组件落地

| 组件 | 对应 DESIGN.md 规范 | 落地要点 |
|---|---|---|
| 执行器条 | Ghost Button 变体 | 六家平级；激活态用 `teal-tint + teal` 边框而非实心青底（六个实心块会互相打架） |
| 视图切换 | Pill Chip | 激活态填 `#016a71` + 白字 |
| 单元列表 | Sidebar Nav Item | 激活态 `teal-tint` 填充，12px 圆角 |
| 时间线卡 | Suggestion Card | Soft Paper 底 + 16px 圆角 + 唯一那道阴影 |
| 建议卡片 | Suggestion Card | 2 列 grid，12px 间距，点击即填入草稿并聚焦 |
| 能力矩阵 | Badge / 状态标签 | 支持=墨色+青勾，不支持=ash+删除线+灰叉 |
| 权限卡 | 强调态 | `teal-tint` 底 + `teal-edge` 边框；裁决后折叠成一行回执 |
| 输入区 | Search Input + Filled Action Button | 羊皮纸底 + 12px 圆角 + 聚焦青晕；发送是全场唯一实心按钮（墨底羊皮纸字） |
| 发送按钮 | Filled Action Button | 全系统唯一的实心填充 |

---

## 七、本轮顺带修掉的真实 UX 缺口

这些不是 DESIGN.md 要求的，是实跑时发现"用着难受"的地方：

1. **权限卡点了没反应**。点「允许一次」后卡片毫无变化，用户不知道生效没有。
   → 新增 `permissionDecisions` 状态，裁决后折叠成一行 `✓ 写入 xxx · 已允许一次` 回执。

2. **能力矩阵漏了「沙箱」**。9 项排 2 列会剩孤儿格，而且你自己在需求里写过
   员工模式三件套缺「渠道/**沙箱**/常驻调度」。
   → 补为第 10 项能力，正好凑成整齐 5×2。计数从 `N/9` 改成动态 `N/M`。

3. **空状态是一句没用的提示语**。
   → 换成 4 张建议卡片（Perplexity 的核心交互），点击直接填入输入框并聚焦。

4. **Enter 发送比 Ctrl+Enter 顺手**。常驻底栏里单手敲 Shift+Ctrl 很难受。
   → Enter 发送，Shift+Enter 换行。

5. **策略胶囊点了不切换**（第一版我用 ref 存状态，不触发重渲染）。
   → 改回正经 `useState`。

---

## 八、我偏离 DESIGN.md 的地方

这是最需要你审的部分。共 6 处，每处都有理由。

### 1. 保留六家品牌色（最重要的一处）

DESIGN.md 明确写：

> Don't introduce new accent colors — the system is deliberately monochrome
> with one teal; any second chromatic color breaks the brand's restraint.

但产品的核心命题是「六家工具平等切换，一等公民，不是某家附属品」。
把六个品牌色全部抹掉，等于抹掉了这个命题在视觉上的表达。

**我的处理**：品牌色降级为 **20px 身份徽标**（数据，相当于头像），
只出现在 RuntimeBar 和右栅的运行时标识里，占界面视觉权重 < 2%。
界面其余部分（画布、文字、边框、激活态、按钮）严格守住单色 + 唯一青色。

**判断依据**：头像有颜色不算"第二个彩色"，头像是**内容**不是**装饰**。
如果连这个都不能留，那就得换成"每家一个单色几何图形 + 文字"的无彩方案——
**这个替代方案我随时可以换，你说一声。**

### 2. 引入了两个语义色（gain / loss）

diff 的 `+42 −7` 和错误态需要绿/红，否则不可读。
用的是压暗过的暖调版本（`#2f6b4f` / `#9a4a3c`），不是刺眼的标准绿红，
且**只出现在数字和状态上，不做装饰**。

### 3. 输入区用 14px 而非 16px

DESIGN.md 规定 Search Input 占位文字 16px/1.5。但那是给**首屏 hero 搜索框**的——
一个页面就一个、占满视觉焦点。
我们是常驻底栏，16px 会让输入框比整条时间线的内容都重。
已降到 14px，内边距从 16px 收到 12px。

### 4. 三栏而非「侧栏 + 居中列」

Perplexity 是两栏：左导航 + 居中内容列。
我们需要左栅（工作单元）+ 中栏（时间线）+ 右栅（能力与产出），
因为「多工具平等切换」这个命题要求能力矩阵和执行器选择同屏可见——
折叠成侧栏会破坏这个对比关系。

### 5. 900px 只封顶阅读列

见第五节。三栏工作台整体封顶会浪费横向空间。

### 6. 品牌色徽标用白字而非墨字

六个品牌色亮度差异大（`#D97757` 橙、`#3B82F6` 蓝、`#A855F7` 紫），
墨色字在小尺寸下有的看不清、有的看不清。用白字在全部六个色块上都可读。

---

## 九、还没做的（留给你判断）

- **暗色模式**。DESIGN.md 只定义了浅色。本项目是本地工具，长时间盯着屏幕，
  暗色版大概率是需要的，但设计文档没给依据，所以这轮没做。
- **响应式**。当前按 1280+ 设计。三栏在窄屏需要折叠策略。
- **字体**：现在用系统栈。如果实测 Inter 的字形不满意，可以换本地字体文件
  （保持本地优先，不引 CDN）。

---

## 九、组件分级矩阵（2026-09-28，impeccable 巡检后定稿）

四档字号 + 三档图标 + 三档圆角的**归属表**。同类组件必须落同一档；
新增组件先查这张表再写 className。

### 字号分级

| 级 | Token | 用途 | 例 |
|---|---|---|---|
| L1 | `text-body-lg` (16) | 页面级标题 | 设置/自动化页 h1 |
| L2 | `text-body` (14) | 区块标题、主输入、当前任务标题 | PaneSection 标题、工作区头部 h1 |
| L3 | `text-body-sm` (12) | **一切可点行/菜单/按钮/输入** | 侧栏动作行、列表行、菜单项、执行器行 |
| L4 | `text-caption` (11) | 辅助信息 | 时间戳、hint、badge、元信息、类型色标 |

规则：同组同档。动作行（侧栏三行、左上浮层、头部图标钮）统一 L3 + 14px 图标；
hint/快捷键统一 L4 + mono。**禁止 text-[Npx] 任意值**（本轮清零 13 处
9px/10px 违规，全部归 L4；glyph 字母标为图形字符，用 L4 + leading-none）。

### 图标尺寸分级

| 档 | size | 用途 |
|---|---|---|
| I1 | 12 | 行内随文、次级操作（菜单项内、行尾钮、时间线） |
| I2 | 14 | 行首/按钮级（动作行、头部按钮、表单控件） |
| I3 | 16 | 面板级（右栏任务栏 rail、执行器 rail 图标） |

### 圆角 / 命中区

- 命中区：行动作 28px（h-7 / p-1.5+14px 图标）；任务栏 rail 40px（h-10 w-10）
- 圆角仍四档：btn 6 / input 12 / card 16 / chip 9999

### 根因修复：twMerge 吞自定义字号 token（2026-09-28）

巡检发现的「同类组件字号不一致」不是手误，是系统性 bug：
`cn()` 里的 tailwind-merge 用默认配置，不认识 `text-caption / text-body-sm /
text-body / text-body-lg` 这些自定义 token，把它们归进「text-color」冲突组——
同一 className 里后缀任何颜色类（text-ink / text-graphite / text-ash…），
**字号类就被静默丢弃**，组件回落到继承的 14px。丢不丢取决于后面有没有
颜色类，纯看运气，所以「看起来随机」。

修复：`ui/cn.ts` 用 `extendTailwindMerge` 把四个字号 token 注册进
font-size 组——字号只与字号冲突（保留最后一个），与颜色类各归各组。
已用浏览器实测校准：侧栏动作行 12、分区 tab 与菜单 11、头部按钮行 14。

### 身份可视化：bot 头像优先（2026-09-28，用户决策）

「员工」更名 **bot**（含 kind 值 `"bot"`）。侧栏单元行按身份分形态：
bot = **圆形大头像**（identity.emoji / 首字母 + teal-tint 兜底），
项目 = 方形字母文件夹标——本质同为 WorkUnit（大文件夹），只是头像优先的
可视化差异。切换器收在分区行 `[bot|项目]` 迷你分段里。

### bot 列表的 GrokBot 式形态（2026-09-28，用户参考图指定）

侧栏 bot 行对齐 GrokBot 的列表结构：**彩色 blob 头像（带双眼）+ 名称 +
在行任务/介绍 + 右侧时间**。

- 头像：44px，颜色 × 形状（圆 / 38% 超椭 / 大圆角方）由单元名哈希出稳定组合，
  白色双眼是吉祥物特征；有日程的 bot 头像右下角挂 teal 角标。
  颜色是**身份数据例外**（同执行器徽标 accent），不违反单强调色规则。
- 行结构：名称（L2 14px medium）+ 右侧最后活动时间（今天=时刻 / 昨天 / 日期）；
  副标题 = 在行任务（最新会话标题）优先，其次身份角色，兜底显示路径。
- 项目行保持方形字母文件夹标——bot 与项目在形态上可一眼区分。

### 统计坞对话框（2026-09-28 第八轮，对齐 dsh StatsPills）

底栏 pills 从纯展示改为**可点击**，各自弹出锚定上方的对话框
（dsh stat-dialog 形态：标题行 + 发丝线 + 两列行网格，同时只开一个）：

- 时间 pill「N 轮 · M 步 · X tok/s」→ **会话统计**：模型用时 / 工具调用用时 /
  首 token 平均（TTFT）/ 输出速度（TPS）。零值行隐藏（dsh 条件渲染同款）；
- 用量 pill「205K tok · 缓存命中 44%」→ **Token 用量**：标题右侧精确总量
  （toLocaleString），行 = 缓存命中 / 未缓存输入 / 缓存读取 / 缓存写入（0 隐藏）/
  输出 / 成本（本项目追加）；
- 上下文环 → 分解面板文案对齐 dsh：「上下文已用 N% ~X / Y」+
  系统提示词 / 工具定义 / 对话消息 三段。

统计投影扩展（session-stats 同款口径）：工具耗时 = tool.started→completed
按 callId 配对；TTFT 以 usage 为轮边界、轮内首个 delta 为首 token 的近似
（pace=0 时为 0，整行隐藏）。

### 新建 bot 对话框（2026-09-28，AGENTS.md 岗位说明书）

「添加 bot」从一键快速新建升级为**高度自定义的创建对话框**
（`ui/AddBotDialog.tsx`，T3 AddProviderInstanceDialog / AutomationEditView 的
双栏形态）：

- 左栏表单：名称（决定头像色形）/ 一句话角色 / 工作目录 / 主执行器绑定
  （未安装的禁选）；AGENTS.md 是 agent 圈开放约定——给 agent 看的 README。
- 右栏 **AGENTS.md 编辑器**：名称与角色在用户未手动编辑前自动同步进模板
  （touched 标记）；工具条提供 agents.md 规范段落插入
  （项目概览/环境提示/代码风格/测试说明/交付说明）与一键重新生成。
- 数据：WorkUnit 新增可选 `agentsMd` 字段承载内容；磁盘扫描来的单元不带
  （文件即数据库），创建的单元真接运行时后应落盘 rootPath/AGENTS.md。

### 工作区文件浏览器（2026-09-28，新增页签）

右栏新增**工作区级**「工作区文件」页签（`workspace-files`，默认第一个打开，
无需会话）：浏览当前工作单元 rootPath 下的**真实文件**。

- 技术路径：浏览器沙箱读不了磁盘，走 File System Access API（Chromium）——
  「选择文件夹」授权一次（纯本地，不经服务器），句柄按根路径缓存于内存，
  刷新页签/切单元不丢；刷新页面后重新授权一次。
- 能力：目录树（node_modules/.git/dist 等自动跳过，深度 5 / 条目 600 上限）、
  文件大小、文本文件点击预览（≤256KB）、刷新（含权限续期）。
- 兼容性：Firefox / Safari 无此 API，页签显式提示改用 Chrome / Edge。
- 会话级的「文件」页签（file.diff 变更）保持不变——一个看磁盘现状，
  一个看会话改了什么。

> 自检脚本 check-sidepane 的类型总数断言同步为 25 / 目录 24，107 项全过。

### 权限模式菜单对齐 ZCode ConfigSelect（2026-09-28）

权限选择器的模式行**去掉能力标签**（旧版「读/写/命令」三枚 tag 用了暗色
主题的硬编码颜色，在浅色羊皮纸上极不协调），改为 ZCode `ConfigSelect`
（display.tsx，mode 类目）的行结构：

- 每模式一个语义图标：默认询问=Hand、自动接受编辑=ShieldCheck、
  只读规划=NotepadText、完全放行=ShieldAlert（随当前模式在触发器上切换）；
- 行 = 图标 + 标题 + 两行描述（min-h-13 items-start gap-3，描述 line-clamp-2），
  选中行 teal-tint + 右缘 Check；
- 危险档（完全放行）图标与文字持续 loss 警示色（ZCode 的 text-warning 同位）。

「读/写/命令」能力矩阵保留在 `core/permission.ts` 数据层（needsDialog 等
判定仍用），只是不再以 tag 形式塞进菜单行。

### 新建 bot 对话框分区化（2026-09-28 第二轮，对齐 waku-agent 定制面）

对照 waku-agent（Harness·Loop·Memory·Eval 四支柱）的配置全景，
对话框从双栏扩展为**分区导航式**（身份 / 系统提示词 / 记忆 / AGENTS.md）：

- **系统提示词**（新增）：对应 waku 的 SOUL.md——「agent 的人设在 SOUL、
  规矩在 AGENTS.md」是其刻意区分；落到 `identity.persona`
  （字段原本就预留）。留空则用运行时默认语气。
- **记忆接入**（新增，可选开关组）：语义记忆·事实 / 情节记忆·事件 /
  程序性记忆·技能 三开关（waku 的 semantic / episodic / procedural 三柱），
  落到 `WorkUnit.memory` 声明字段——真实运行时据此接入对应后端。
- **默认模型（可选）**：主执行器切换后给出该 CLI 有效清单的模型 hint
  （T3 的 modelSelection 语义），不选即「自动」。
- AGENTS.md 分区保持模板同步 + 段落插入；touched 后不被覆盖。

waku 要点备忘：SOUL.md 可由 agent 用 update_soul 追加规则（append-only，
上限 8000 字符）；记忆门控 fail-open；整理（consolidation）攒 N 次交换
由 small_model 提取 facts + episode；技能 = SKILL.md frontmatter 常驻扫描、
正文按关键词命中注入（每次最多 2 个）——这些是接入真运行时后的行为契约。

### 添加自定义模型：dsh 多行表单 + pi 配置预览（2026-09-28 第九轮）

设置页的「添加自定义模型」从单输入框升级为 **dsh `CustomProviderCard` 的
models 数组形态**：多行草稿（模型 id* / 显示名 / 窗口 / 输入价 / 输出价），
「添加一行」连加、「全部添加」批量入库；逐行校验（id 必填 + 查重，
窗口支持 256K / 1M 速记解析——dsh parseCapacity 同款，1K=1000、1M=1_000_000），
错误按行定位。附 **pi models.json 形态的配置预览**（providers → models 条目，
contextWindow 展开为精确数值），强化「加模型 = 往配置写一条」的直觉。
pi 仓库已更新克隆至 Agent/pi-latest（6f75515），其 models.json schema
（providers 字典 + ModelDefinition）是 dsh 与本项目自定义模型的共同源头。

### 模型供应商管理（2026-09-28 第十轮，对齐 dsh ModelsSection + pi 目录）

设置模型分区顶部新增**供应商管理层**（`ProviderSettingsSection` +
`useProviderProfiles` store，localStorage 持久化）：

- **目录数据来自 pi**（pi-latest packages/ai/src/providers/*.ts 的
  createProvider 声明，脚本提取 41 家 → `core/providerCatalog.ts`：
  id / name / baseUrl / api / keyEnv）；
- **添加卡双模式**（dsh SegmentedControl 同款切换）：
  「第三方模型提供商」= 目录选一家 + API 密钥（留空走环境认证，
  hint 显示约定的 keyEnv 名）+ 自定义设置折叠（显示名 / 端点覆盖）；
  「自定义模型 API」= Provider ID（小写连字符正则 + 查重）/ 显示名 /
  API 地址 / 协议三选（openai-completions / openai-responses /
  anthropic-messages）/ 密钥 / 模型目录多行（id / 显示名 / 窗口 256K 速记）；
- **行列表**：凭据状态点（实心已配 / 空心缺）+ Custom 标 + 编辑 / 删除
  （两段确认）；「打开配置文件」以配置预览折叠面板等价呈现；
- ⚠ 凭据边界：原型期 key 明文存 localStorage（本地单用户妥协）；
  dsh 是 secret 入凭据库、配置只留 apiKeyEnv 引用名——接真运行时须照做。

### 供应商实例面板（2026-09-28 第十一轮，逻辑对齐 T3 Providers 页）

设置模型分区重构为 **T3 ProviderSettingsPanel 的实例逻辑**，
主体换成 `ui/ProviderInstancesPanel.tsx`（六家执行器 = provider instance）：

- **左列实例列表**（240px）：图标 + 名称 + 版本徽章 + 状态行
  （已就绪 · http / 未安装 · acp…）+ **启用 Switch**；
  停用的执行器整体压暗，composer 选择器（rail / 列表 / 收藏聚合）同步隐藏；
- **右列编辑器**：Display name（铅笔行内编辑）/ Runtime（端点覆盖 +
  传输协议只读 + 启动参数）/ Environment（KEY-VALUE 变量表，可增删）/
  Models（内嵌该 CLI 的模型清单管理）；
- **顶栏**：「已检查 刚刚」+ 刷新（probeAll 全量重探测）；
  Advanced 提供健康检查间隔步进（原型期本地态）；
- dsh 式 API 供应商卡（pi 目录 + 兼容协议）保留，作为页面下半的独立分区。

store：`useWorkbench.runtimePrefs`（enabled / displayName / endpoint /
launchArgs / envVars / lastCheckedAt）+ `probeAll()` 全量重探测。

### 设置分区合并：执行器并入「执行器与模型」（2026-09-28，用户决策）

独立「执行器」分区撤销（其内容单薄、与模型管理同域）：
`SettingsSectionId` 收敛为 chat 之外的 general / appearance / models /
shortcuts / skills / memory / hooks / permissions / usage / trace / track；
「模型」分区更名**「执行器与模型」**，构成 = 执行器实例面板（T3 逻辑）+
默认执行器与探测策略（原执行器分区并入）+ API 供应商（pi 目录）。

### 合并页瘦身（2026-09-28，用户决策）

「执行器与模型」合并首版偏臃肿，按 T3 标准收敛：

- **默认执行器行**并入编辑器（Display name 下方：当前默认徽章 /
  「设为默认」按钮），左列实例行加「默认」小徽标；
  原「默认执行器」六行 GroupCard 删除（与左列表信息重复）；
- **Models 管理器默认折叠**：summary 行 = Models + 计数
  （N 模型 · N 收藏 · N 隐藏），点击展开完整清单管理；
- **探测策略**（能力探测 / 未安装工具两开关）并入面板底部独立小卡
  （原执行器分区残留）。

### 设置记忆分区：waku 三柱式（2026-09-28，接上轮 bot 分区化）

设置 → 记忆从骨架升级为 waku 三柱结构（store/useMemoryPrefs，localStorage 持久化）：

- **语义记忆 · 事实**：启用开关 + 存储后端（sqlite/supabase/mem0/zep/langmem）+
  检索条数 top K（默认 4）；
- **情节记忆 · 事件**：启用 + 存储后端（sqlite/notion）；
- **程序性记忆 · 技能**：启用注入（SKILL.md 关键词命中、每轮最多 2 个）+
  技能目录展示；
- **检索门控**：小模型先判断是否检索（fail-open）+ 门控模型（默认
  claude-haiku-4-5）；**整理频率** 每 N 次交换（默认 6，waku 同参）；
- **MEMORY.md 人读镜像** 开关 + 导出占位。

与每 bot 的 `WorkUnit.memory` 接入开关互补：这里是全局后端与策略，
per-bot 只声明「接哪几类」。真运行时据此接 SQLite FTS5 / 远端后端。

### 语义记忆后端接入 WeKnora（2026-09-28，用户本地 Docker 部署）

语义记忆存储后端新增 **weknora** 渠道（`core/weknora.ts` HTTP 客户端 +
设置记忆分区的连接卡与实测面板）：

- **API 面**（对齐 WeKnora internal/router）：`X-API-Key` 头鉴权；
  `GET /knowledge-bases` 拉取列表；`POST /knowledge-bases/:id/knowledge/manual`
  写入事实（ManualKnowledgePayload {title, content}，异步解析入库）；
  `POST /knowledge-bases/:id/hybrid-search` 语义+关键词混合检索
  （SearchParams {query_text, match_count, thresholds}）；
- **CORS**：WeKnora 服务端 AllowOrigins \* 且放行 X-API-Key，浏览器可直连；
- **本地部署实况**：docker 映射 18080（非 8080），默认值已改并做旧默认迁移；
  实测 401 → 服务连通，仅待用户在 WeKnora 前端生成 API Key 填入
  （key 加密存 tenants.api_key，不从环境变量挖取——安全边界正确）；
- 实测面板：写入一条事实 / hybrid-search 检索，直接打真服务。

接真运行时后：bot 会话中 waku 检索门控命中的事实查询走 weknoraSearch，
整理（consolidation）产出的 facts 走 weknoraSaveFact。

### WeKnora 知识库按记忆层归属（2026-09-28，用户需求）

WeKnora 里的知识库并非都做语义记忆——**每个记忆层独立勾选各自的
WeKnora 知识库（多选）**：

- 数据：`weknoraSemanticKbIds / weknoraEpisodicKbIds`（旧单 `weknoraKbId`
  自动迁移为语义层单选）；
- 检索跨库：`hybrid-search` 的 `knowledge_base_ids` 数组（WeKnora
  SearchParams 原生支持一次跨多库），语义检索 = 全部勾选库的并集；
- 写入：语义事实进**第一个勾选的语义库**（主库）；
- 多来源：个人文件夹 / 文件在 WeKnora 里传成一个知识库（WeKnora 本身
  支持 KB 内文件夹结构），勾选到语义层即成为 personal 记忆来源之一。

### 本地文件记忆来源（2026-09-28，用户需求「文件类的记忆」）

语义记忆新增**本地文件来源**渠道（不经 WeKnora 直连）：
`core/localMemorySource.ts` + 设置记忆分区的「本地文件来源」卡。

- **接入**：File System Access API 授权本地文件夹（纯本地）；
  目录句柄结构化克隆存入 **IndexedDB**，跨刷新恢复；授权过期行上
  显示「重新授权」（requestPermission 需用户手势）；
- **索引**：递归扫描 markdown / 文本（跳过 node_modules 等，深度 4 /
  200 文件 / 单文件 200KB 上限），内容缓存在内存；
- **检索**：关键词 AND 评分（所有词都要命中；文件名命中加权 ×3），
  返回路径 + 命中上下文摘录，top K 复用语义记忆的检索条数；
  跨全部来源合并排序（searchAllLocal）；
- 设置页提供「检索测试」（同 WeKnora 实测面板的形态）。

渠道总览（语义记忆事实可同时来自）：sqlite 本地 / WeKnora 多知识库
（跨库检索）/ 本地文件夹直连——三渠道可并存，真运行时按门控结果合并。

### 记忆层多后端镜像（2026-09-28，用户需求）

一个记忆层可以**同时启用多个存储后端**：

- 数据：`semanticStores` / `episodicStores` 从单选改为多选数组
  （旧单值自动迁移；情节层补入 weknora 渠道——KB 归属复选早已按层分列）；
- **检索 = 并集**：全部启用后端各查一遍合并返回
  （实测面板已演示 WeKnora hybrid-search + 本地文件来源跨渠道合并）；
- **写入 = 广播**：事实写入同时落全部启用后端（镜像——单后端故障不丢记忆；
  sqlite/supabase 等由真运行时执行，原型期演示 WeKnora 渠道）；
- UI：后端行从下拉改为多选 chips（Check + teal-tint 点亮）；
  WeKnora 连接卡在任一层启用 weknora 时出现。

### 记忆编排重构：后端注册表 + 三层路由（2026-09-28，waku 落地完成）

设置记忆分区重写为 waku 三柱的**编排模型**（`useMemoryOrchestration`）：

- **后端注册表**：每个后端是独立实例（类型 / 名称 / 启停 / 连接配置），
  同类型可注册多个（两个 WeKnora KB = 两个后端实例）；添加入口按类型
  展开（weknora = 地址+Key+测试连接拉 KB；local-folder = 文件夹选择器；
  sqlite 内置；云端类型真运行时接入后开放）；
- **三层路由**：语义 / 情节 / 程序性各路由到一组启用的后端
  （chips 多选；写入广播 / 检索并集）；
- **门控与整理**：检索门控（fail-open）/ 门控模型 / 整理频率 /
  语义检索条数 / MEMORY.md 镜像 全部落位；
- **实测卡**：写入广播（全部启用的 weknora 后端）+ 检索合并
  （weknora hybrid-search + 本地文件夹关键词，跨渠道并集）。

旧 MemorySelect 单后端、WeknoraCard 散卡、LocalSourcesCard 独立卡全部
被注册表 + 路由的统一模型吸收删除。

### 门控模型改为已接入模型选择（2026-09-28，用户需求）

记忆分区的「门控模型」从自由文本输入改为**下拉选择**：选项聚合全部
启用执行器的可见模型（跨执行器按模型 id 去重，行文案带来源执行器名）。
若当前值不在清单（如手改过 localStorage），自动置顶「当前值」选项防丢失。

### 后端可编辑 + 配置透明化（2026-09-28，用户需求）

后端注册表的每一行**展开即可编辑**（此前只读）：
- 通用：名称行内改；
- weknora：API 地址 / API Key / 知识库 ID 三个输入；
- local-folder：「更换文件夹」按钮——重新选择器授权新目录，句柄存原键位、
  sourceId 就地更新（A→B 无需删除重建）；
- 路由 chips 与门控参数全部就地生效。

**配置透明化**：分区底部「配置文件」折叠面板——右上角标注实际存储位置
（localStorage · agent-workbench:memory-orchestration），正文渲染当前
生效的完整 JSON（后端注册表 + 三层路由 + 门控）。真运行时落 .waku/ 后
此面板改为展示同一文件的路径与内容。

### SQLite 后端数据库路径可配置（2026-09-28，用户需求）

SQLite 后端展开配置新增**数据库文件路径**输入（默认 `.waku/state.db`，
可指向任意自定义文件如 `D:/memories/state.db`），旁有「默认」一键恢复。
写入 `MemoryBackend.dbPath`，真运行时接入后按此路径打开 / 迁移数据库。

### 轨迹升格为会话头页签（2026-09-28 第二轮，认知 0 成本）

轨迹入口从右侧栏页签**移到会话头部「对话 | 轨迹」页签**
（对齐 dsh ConversationSession tabs + view-selection）：激活轨迹后
占据整个会话视口，composer 与权限卡保持在底部（composer-overlay 语义）。

- `useShell.conversationView: "chat" | "trajectory"`（dsh view-selection 同构）；
- `ui/TrajectoryView.tsx`：工具栏（折叠轮次 + 搜索）+ 轮次 sticky 头 +
  类型色标账本行（展开详情），数据从 timeline 派生（core/trajectory.ts）；
- 右栏 TracePane 移除（trace 从 SESSION_TABS / TabContent 退出，
  类型与 TAB_META 保留供迁移）。

### Ops 页签 —— LLM-Ops 支柱（2026-09-28，对齐 waku-agent）

会话头第三个页签「Ops」（对话 | 轨迹 | Ops），整体对照 waku-agent 的
`waku/ops/` + `evals/`（docs/evals.md 的四条铁律逐一落地）：

- **两类 eval 永不混合**：确定性 eval 卡（dataset.jsonl 行形态：
  id/input/expect_tool/expect_in_args，0 或 1，无模型裁判）与
  LLM-as-judge 卡（GEval 形态：命名指标 + 评分步骤 + 阈值 0.60，
  0–1 打分，每次评分是一次真实 LLM 调用）分开两张卡；
- **发布门（make gate）**：确定性必须 100% 且 judge 全过阈值；
  verdict 横幅 + 分阶段进度（staged setTimeout 模拟，数据形态与真实一致）；
- **追加只写账本**：gate 历史（eval_runs.jsonl 语义）、Arena 记分板
  （compare/history.jsonl 语义）、花费账本（usage.jsonl 语义，每次
  LLM 调用一行、美元由 token 估算）统一落 `agent-workbench:ops`
  localStorage 键，页脚标注键名（透明化原则）；
- **Arena**：同一 prompt × N 个启用执行器（各取当前模型），
  Completion / Quality 双分分开记，记分板一场一行；
- **与轨迹的关系 = 轻叠加**：Ops 是运营仪表盘（waku dashboard Ops
  页签同构），占据会话视口且不渲染 composer / 权限卡；工具栏
  「打开轨迹」一键跳回轨迹页签看原始 trace。

flaky 用例（draft-message，18% 失败率）让 gate 的 FAIL 态在演示中可见。

### 出图工作台 —— gpt_image_playground 移植（2026-09-28）

侧栏顶部动作区新增「出图」入口（新建任务/搜索/自动化/出图），
独立功能主视图 `ui/ImageStudioPage.tsx`（与自动化页同构：
h-12 面包屑顶带 + 卡片输入区 + 结果画廊）。

生成逻辑移植自 CookSleep/gpt_image_playground（MIT，核心是
`openaiCompatibleImageApi.ts` + `imageApiShared.ts`）：

- `core/imageApi.ts`：OpenAI 兼容 images API 客户端 —— 纯文本
  `POST /v1/images/generations`（JSON body）、参考图
  `POST /v1/images/edits`（FormData `image[]`）；b64_json / url
  双路径解析为 dataURL；防御式错误提取（error.message 优先）；
  AbortController 超时（600s，同仓库 DEFAULT_API_TIMEOUT）。
- 参数按模型族切换（paramCompatibility 本质规则）：gpt-image*
  走 size/quality(auto|low|medium|high)/output_format，dall-e-3
  走 standard|hd + response_format=b64_json；模型选择器内置
  gpt-image-2.5-sunburst（仓库默认）/ gpt-image-2 / 1 / dall-e-3，
  也可手填任意兼容模型名。
- `store/useImageStudio.ts`：ApiProfile（baseUrl/apiKey/model/timeout）
  + 任务历史（一次生图 = 一条任务），落 `agent-workbench:image-studio`
  localStorage 键；图片是 dataURL，配额满按「最旧优先」丢图重试。
- 未移植（原型不需要）：流式 partial_images、/responses 工具模式、
  fal.ai、自定义 HTTP 服务商映射、遮罩编辑。

验证：gpt_image_playground 自带 mock-image-api（b64 模式，CORS 全开）
起本地服务，浏览器端到端走通 配置→生成→画廊→持久化→刷新恢复，
无 key 时生成按钮禁用。
