# Agent Workbench

本地个人统一工作台 —— 一个界面，两种视图，多家 agent 工具平等切换。

**当前阶段：P0 UI/UX 原型。** 不含任何厂商代码，mock 适配器驱动。

---

## 快速开始

```bash
cd prototype
pnpm install
pnpm dev        # http://127.0.0.1:5180
```

其他命令：

```bash
pnpm build      # tsc -b && vite build
pnpm typecheck
```

**用 `127.0.0.1` 而不是 `localhost`。** Vite 在 Windows 上默认只绑 IPv6 `::1`，
本地浏览器工具连不上。配置里已显式绑 IPv4。

需要「真实节奏」演示（事件逐条浮现而非一次性铺满）：

```
http://127.0.0.1:5180/?pace=350
```

---

## 技术栈

```
Vite 7 + React 19 + TypeScript 5.9 + Tailwind CSS v4 + Zustand 5 + Electron（P2）
                            ↓
                  自研 RuntimeAdapter SPI（纯 TS，零框架依赖）
```

**不 fork 任何参考仓库。** 全新写渲染层，四家只当运行时接进来。

完整论证见 [`docs/01-tech-stack.md`](docs/01-tech-stack.md)。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/00-north-star.md`](docs/00-north-star.md) | 需求与北极星。技术选型服务于它 |
| [`docs/01-tech-stack.md`](docs/01-tech-stack.md) | **主文档**：逐层选型、为什么不选什么、许可证核查、分阶段路线 |
| [`docs/02-reference-audit.md`](docs/02-reference-audit.md) | 四个仓库的代码走查实证 |
| [`docs/03-architecture.md`](docs/03-architecture.md) | 三层架构、SPI 契约、两个必须记住的坑 |
| [`DESIGN.md`](DESIGN.md) | 视觉风格参考（Perplexity 风格系统） |
| [`docs/04-design-system.md`](docs/04-design-system.md) | **设计落地**：token、组件映射，以及我在 6 处偏离 DESIGN.md 的理由 |

---

## 目录结构

```
agent-workbench/
├── docs/                    设计文档
└── prototype/               可跑的 UI 原型
    └── src/
        ├── core/            零厂商依赖的领域层 + SPI
        │   ├── units.ts     WorkUnit / Session / Deliverable
        │   ├── events.ts    RuntimeEvent union + TraceRecord
        │   ├── adapter.ts   RuntimeAdapter SPI + Capabilities
        │   └── registry.ts  RuntimeRegistry
        ├── adapters/
        │   └── mock/        六家工具的假实现
        ├── store/           zustand
        └── ui/              组件
```

依赖方向严格单向向下：`ui/ → core/`，`adapters/ → core/`，`core/` 不 import 任何东西。

---

## 视觉

羊皮纸画布 + 单一青色强调 + 完全扁平。设计令牌集中在 `src/styles.css` 的 `@theme`。
字重锁死 400/500，最小字号 11px，全场只有一道投影。

**六家工具的品牌色只出现在 20px 身份徽标上**（数据，不是装饰），
界面其余部分严格守住「单色 + 唯一青色」。
这个取舍和另外 5 处偏离，见 [`docs/04-design-system.md` 第八节](docs/04-design-system.md)。

---

## 交互约定

| 操作 | 键位 |
|---|---|
| 发送 | `Enter` |
| 换行 | `Shift + Enter` |
| 搜索 | `⌘F` |
| 命令面板 | `⌘K` |
| 终端面板 | `` ⌘` `` |

## 面板（对齐 ZCode）

| 面板 | 入口 | 对齐要点 |
|---|---|---|
| 会话 | 默认主视图 | ZCode 的 `workspaceMainView: chat` |
| 自动化 | 侧栏底 / 命令 | `AutomationsSection`：双 tab + 四档状态筛选 + 卡片网格 |
| 设置 | 侧栏底 / 命令 | `settingsPageConfig` 三组导航 + `SettingsRow` / `GroupCard` |
| 搜索 | 侧栏底 / `⌘F` | 合并 ZCode 分散的 TaskFind / 会话查找 / 命令搜索 |
| 右侧面板 | 标签页 | `AnimatedSidePanePanel`：可关单个 / 关其他 / 全关 / 恢复 / 拖拽重排 / 总览搜索 / 可见性作用域 |
| 权限对话框 | 自动弹出 | `PermissionDialog`：编号选项 + 选中后统一确认 |

**主视图切换**（`chat` / `automations` / `settings` / `search`）共享同一套外壳，
对齐 ZCode 把「设置」和「自动化」都当主视图而非弹层的处理。

空状态是建议卡片，点一下直接填入输入框并聚焦。
权限卡裁决后会折叠成一行回执（`✓ 写入 xxx · 已允许一次`），不留悬空的按钮。

## Composer 的左右分工

对齐 ZCode 的 `V4ComposerToolbar`：左右各管一件事，不混。

```
📎 @ [n]        🛡 权限模式  Z 执行器  发送
↑ 带什么          ↑ 这条消息怎么跑
```

**左侧**只放输入相关的（附件、引用）。
**右侧**放运行配置（权限模式、执行器、发送）。

> 「更好效果 / 更短时间 / 更低成本」曾是第一轮需求里混进来的概念，
> 已连同 `StartSessionRequest.strategy` 一起从 UI 和 SPI 移除。
> 全文检索无残留。若将来真要做多 agent 编排策略，从这里重新加回成本很低。

### 权限模式

`core/permission.ts`，四档对齐 Claude Code / Codex / ZCode 通用约定：

| 模式 | 读 | 写 | 命令 |
|---|---|---|---|
| 默认询问 | 允许 | 询问 | 询问 |
| 自动接受编辑 | 允许 | 自动 | 询问 |
| 只读规划 | 允许 | 拦截 | 拦截 |
| 完全放行 | 允许 | 自动 | 自动 |

**权限模式和权限对话框是两层东西**：
模式是本次运行**预先声明**的默认策略，作用于所有后续请求；
对话框是单个请求的**具体裁决**，只在需要问的时候出现。

两者通过 `needsDialog()` 联动 —— 切到「完全放行」后对话框不再出现，
而不是变成一个空壳；切到「只读规划」后措辞变成「只读模式已拦下」，
且不提供任何可授权的选项。

「完全放行」在选择器里用警示色标出，因为它一旦点下去，
后面所有授权框都不再出现，用户必须当场知道自己关掉了什么。

### 右侧面板：七条对齐 ZCode 的行为约定

契约在 `core/sidepane.ts`，全部是纯函数，可单测：

```bash
pnpm check:sidepane    # 32 条断言
```

1. **可见性作用域** —— tab 分 `workspace` / `session` / `root-session` 三类。
   会话级页签只属于一条会话，切走就隐藏，不会看到别的会话的 diff。
2. **关激活页签落到右邻** `min(closingIndex, len-1)`，不是左邻也不是第一个。
3. **关非激活页签，激活页不变。**
4. **拖拽重排不改变 `activeTabId`** —— 拖动只是换位置，不顺手切页。
5. **总览 popover** —— 分「已打开 / 最近关闭」，搜索评分权重与 ZCode 一致：
   标题前缀 120 > 词首 90 > 标题包含 70 > 提示 40 > 类型 20 > 其余 1；
   多关键词之间是 AND（每个词都必须命中 title+hint+typeLabel 拼成的 `all` 字段）。
6. **最近关闭存完整 tab**，不是只存 id —— 否则恢复出来的页会丢标题与归属。
7. **溢出判定 + 常驻挂载** —— tab 放不下时入口退化为纯图标；
   `keepMounted` 的页签在面板收起时仍保持内容挂载。

**「批量补齐页签」不能抢焦点。** ZCode 的「批量打开最后一个激活」只适用于
用户主动打开；按会话补齐页签时若沿用它，会话一切换焦点就落到刚补出来的最后一页上。
`useSidePane.syncOwner` 显式守住了原焦点。

## 侧栏：功能全部常驻可见

对齐 ZCode `WorkspaceSidebar` 的完整能力集。**一条原则：功能不能因为「当前为空」就消失。**

| ZCode message id | 本项目落点 |
|---|---|
| `projectsSection` | 工作单元区（可拖拽排序 `reorderSection`）|
| `addProject` | 「添加员工 / 添加项目」按钮 |
| `noProjects` | 空态文案 |
| `conversationsSection` / `newConversation` | 展开的会话列表 + 「新建任务 ⌘N」|
| `noConversations` | 「该工作单元下还没有任务」|
| `organize` / `organizeGrouped` / `viewByWorkspace` / `organizeChronologicalList` | 组织方式 4 选 1（按分组 / 按单元 / 按时间 / 含归档）|
| `sortBy` / `sortByUpdated` / `sortByCreated` | 排序 2 选 1 |
| `taskGroup.newGroup` / `toggleAllTaskGroups` | 任务分组区（可折叠 + 新建）|
| `toggleArchivedTasks` | 已归档区（可展开，带样例数据）|
| `unavailableLocalDirectory` | 「目录不可用」徽标（带样例单元）|
| 远端工作区 | 「连接远端」入口 |
| 折叠导轨 | 侧栏收起态 |

**之前的问题**：这些能力我做成了「有数据才渲染」，空数组直接不输出，
于是新增功能在页面上根本看不见。样例数据（归档会话、目录不可用单元、
任务分组）就是为了让这些状态**可被看到**。

### 自动化：两个从 ZCode 抄来的口径

1. **分组以卡片实际展示的状态徽章为准**，不是内部字段。用户在列表上看到什么颜色，
   就落在哪一组。
2. **切 tab 即回到「全部」筛选**，不恢复上次那个 tab 的旧筛选。

频率描述用**结构化 `scheduleRule`** 而非裸 cron 字符串。
只解析 cron 会把「每 30 个月」误显成「每月」、把一次性的「40 分钟后」误显成「每 1 小时」——
后者在样例数据里专门验了，显示的是「自定义」。

---

## 原型验证到什么程度

不是「能编译」，是实跑验证过的：

- ✅ `tsc -b` 与 `vite build` 均通过（383 KB / gzip 119.5 KB）
- ✅ 浏览器实跑，console 零 error / 零 warning
- ✅ 六家工具平级显示，连接状态正确（5 家 ready，dsh 演示未安装态）
- ✅ 归一化事件流端到端跑通：推理 → 消息 → 子代理 → 权限审批 → 工具调用 → diff → 用量 → 产出 → 会话结束
- ✅ **能力降级实测**：同一套 UI，切到 OpenCode（5/10 能力）后
      权限审批与结构化 diff 事件**自动不出现**，渲染层零改动
- ✅ 建议卡片 → 草稿预填 → 聚焦 → 发送，全链路可用
- ✅ 权限对话框**两步确认**实测：点未选中项只移动选中态，确认需再点「确定」
- ✅ 自动化 6 条样例覆盖全部 scheduleRule 分支，频率描述与下次运行均算对
- ✅ 搜索按 scope 分组命中，回车跳转

---

## 下一步（待你拍板）

1. **P1 先接哪个真运行时？** 建议 ZCode（HTTP 最简单，验证 SPI 成本最低）；
   若想验证「多工具平等」最有说服力的假设，则选 dsh 的 ACP
2. **何时升 monorepo？** 建议适配器超过 4 个时（预计 P3）
3. **TanStack Router 何时上？** 建议 P1 之后、Electron 之前

详见 [`docs/01-tech-stack.md` 第七节](docs/01-tech-stack.md)。
