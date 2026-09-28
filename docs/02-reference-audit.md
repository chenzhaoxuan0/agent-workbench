# 参考仓库调研实证

> 本文记录对四个仓库的**实际代码走查**结果，作为 `01-tech-stack.md` 的证据支撑。
> 结论不是凭印象，每一条都能在指定路径复核。

---

## 一、许可证与活跃度

| 仓库 | 许可证 | HEAD | 最近提交 |
|---|---|---|---|
| `zocdeusual/ZCode` | **Apache-2.0** | `872ad96` | 2026-09-21 `feat: open source` |
| `t3code` | **MIT** | `aff9318bf` | 2026-09-22 `fix(web): retry failed attachment uploads` |
| `deepseek-harness` | **MIT** | `00102833df` | 2026-09-22 `Merge PR #4978 … dsh-0.1.7-alpha.2` |
| `pi` | **MIT** | — | — |

四家全部满足「只接受 Apache-2.0 / MIT」的硬约束。**零例外。**

---

## 二、ZCode（`zocdeusual/ZCode`）

### 工程结构

pnpm workspace + turbo，15 个包：

```
packages/rpc  provider  provider-node  shared  services  client
        server  ui  web  desktop  zcode-server-cli  zcode-cua
        formal-proof  model-option-map
apps/zcode-cli
```

### 前端

- `packages/web`：Vite 8 + React 19.2 + `@tailwindcss/vite` 4.2，纯渲染壳
- `packages/ui`：**依赖极重**，直接吃 `provider` / `rpc` / `services` / `client`
  —— 这正是「UI 与内部包焊死」的证据

关键渲染库（都是我们候选清单的来源）：

| 库 | 用途 |
|---|---|
| `@pierre/diffs` | diff 渲染 |
| `@xyflow/react` | 编排流程图 |
| `@xterm/xterm` | 终端 |
| `react-resizable-panels` | 可拖拽分栏 |
| `streamdown` + `shiki` + `katex` + `mermaid` | Markdown 渲染全家桶 |
| `@tanstack/react-virtual` | 虚拟滚动 |
| `radix-ui` + `shadcn` | 组件原子 |
| `motion` | 动效 |
| `zustand` + `swr` | 状态 |

### 值得抄的部分

**`packages/rpc`** —— 文件清单直接说明了它的设计意图：

```
buffer.ts  protocol.ts  serialization.ts  proxy-channel.ts
channelClient.ts  channelServer.ts  persistent-protocol.ts  remote.ts
```

把「传输」抽象成独立层，让本地进程和远程 server 共用一套代码。
**我们的 `TransportDescriptor` 就是这个形态的简化版。**

### 员工模式三件套

`workspaceIdentity` + `automations` + `memory` 已内置约七成，
缺的是渠道、沙箱、常驻调度 —— 与你此前的判断一致。

---

## 三、t3code

### 工程结构

pnpm workspace（`vite-plus` 封装），7 个核心包：

```
packages/client-runtime  contracts  effect-acp  effect-codex-app-server
        shared  ssh  tailscale
apps/server  apps/web  apps/desktop  apps/marketing
native/resource-monitor   ← Rust
```

### 前端

- `apps/web`：React 19.2 + **TanStack Router** + `@base-ui/react` + Tailwind 4
- 状态：**zustand + `@effect/atom-react`** 双轨
- 独有渲染库：`@pierre/trees`（文件树）、`@pierre/diffs`、`@legendapp/list`
- Rust 原生模块：`native/resource-monitor`

### 最有价值的一份文件

**`packages/client-runtime/src/connection/registry.ts`** —— 整个项目最该借鉴的接缝。

```ts
export class EnvironmentRegistry extends Context.Service<EnvironmentRegistry, {
  readonly entries: SubscriptionRef<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>;
  readonly register: (registration: ConnectionRegistration) => Effect<void, ...>;
  readonly remove: (environmentId: EnvironmentId) => Effect<void, ...>;
}> { }
```

它做的事：注册表不认识任何具体环境，只认识 `EnvironmentId` 字符串；
每家通过 `ConnectionRegistration` 描述自己；注册表负责生命周期、持久化、错误分类。

**我们的 `RuntimeRegistry` 是它的去 Effect 版。**

### 为什么不整体抄 Effect-TS

`registry.ts` 一个文件就用了 `Context.Service` / `Layer` / `SubscriptionRef` /
`Schema.TaggedError` / `Schema.is` / `Scope` / `Semaphore` / `Stream` / `Equal` / `Option`。
`client-runtime` 下 12 个文件全部是这个范式。

引入它 = 前端整套逻辑按 effect 范式重写。对「先做 UI 原型」是纯负担。
**结论：抄形态，不抄依赖。**

### 上游状态

上游 T3 不收 PR。这意味着任何 fork 都没有上游维护兜底。

---

## 四、deepseek-harness（dsh）

### 工程结构

pnpm workspace，**50+ 个顶层包**：

```
packages/acp  agent  api  browser-use  client  code-runtime  core  sandbox
        session  skill  subagent  workflow  schedule  storage  host  …
apps/cli  apps/desktop  apps/desktop-host  apps/web
```

`packages/client/` 下另有 **50+ 个 `ui-*` 包**（`ui-chat` / `ui-plan` / `ui-subagent` /
`ui-trajectory` / `ui-skill` / `ui-schedule` / `ui-workflow-run` …）。

### 架构特点

- **cordis 插件 DI** 贯穿 host 与 client
- 事件溯源做得极细：`verify-v3-event-vocabulary` / `verify-session-format-catalog` 等一堆门禁脚本
- Electron 44 + `electron-builder`，Windows 走 NSIS

### 前端

- `apps/web` 实际是 `dsh-web-frontend`，只是 `@deepseek-ai/dsh-client-web` 壳的 vite build
- React **18.2**（落后于 ZCode / t3code 的 19.x）
- 样式用 `lightningcss`，不用 Tailwind
- 组件是自研 `ui-primitives` + `ui-dockkit`，不是 shadcn

### 唯一值得看的设计思想

`packages/client/ui-slots` 的 README 提出一套「可组合 UI 区」模型：
普通 Slot（父拥有扩展位）、Component Factory（可复用装配）、
Store seat（声明式状态挂载）、Chain（多候选选举）。

思路有价值（**插件化 UI 的正确方向**），但实现是 cordis 插件式的，
在纯 React + zustand 下重建代价不小。

**结论：P5 之后再考虑，当前不引入。**

### 跟进成本

`core` 每周大改（如 0.1.7-alpha.2）。你已识别为「跟进成本失控」，本项目不 fork。

---

## 五、pi

### 关键发现：**pi 根本没有 Web UI**

```
packages/ai  agent  chord  client  coding-agent  durable  protocol
        server  session-backends  telemetry  tui  evals
```

- `packages/tui`：**终端 UI 库**，差分渲染 + NAPI 原生（darwin/linux/win32 三平台）
  不是 React，不适用于桌面工作台
- `packages/client`：**传输中立客户端**，framed CBOR over 任意传输
- `packages/protocol`：协议定义
- `packages/evals`：`vitest-evals` + `autoevals` 评测框架 ← 你的 eval 体系来源

**所以 pi 在「前端界面」这个维度上，对我们几乎没有可复用的东西。**
它的价值在两块：RPC 接入方式（`pi --mode rpc`）和 eval 框架。

---

## 六、横向对比总表

| 维度 | ZCode | t3code | dsh | pi |
|---|---|---|---|---|
| 许可证 | Apache-2.0 | MIT | MIT | MIT |
| React | 19.2 | 19.2 | 18.2 | 无 |
| 状态 | zustand + swr | zustand + Effect | cordis DI | 无 |
| 路由 | 自研 | TanStack Router | 自研 | 无 |
| 构建 | Vite 8 | vite-plus | Vite 6 | esbuild |
| 样式 | Tailwind 4 | Tailwind 4 | lightningcss | 无 |
| 组件 | radix + shadcn | base-ui | 自研 | 无 |
| 桌面 | Electron | Electron + Rust | Electron 44 | 无（TUI） |
| 接缝抽象 | `@zcode/rpc` | `connection/registry` | cordis 事件总线 | protocol/client |
| 前端可复用度 | **中**（焊死内部包） | **中**（Effect 织入） | **低**（cordis + 自研件） | **无** |

---

## 七、给我们的三条可执行结论

1. **抄接缝，不抄实现。** t3 的 `ConnectionRegistration` + ZCode 的 `packages/rpc`
   传输抽象 = 我们 SPI 的骨架，已落进 `prototype/src/core/adapter.ts`。

2. **组件库清单直接抄 ZCode。** 它的 `@pierre/diffs` / xterm /
   `react-resizable-panels` / `streamdown` 组合是经过实战检验的，
   许可证全部干净（已逐个核实）。

3. **pi 只当协议端和 eval 框架用。** 别指望它提供 UI。

---

## 八、头部栏与底部状态栏的出处（2026-09-27 增补）

本轮给外壳补了两块 chrome，出处与取舍记录如下。

### 头部栏 `ui/WorkspaceHeader.tsx` ← ZCode

ZCode 的「头」实际是两层：`DesktopTopOverlay`（左上浮层：侧栏开关、任务前进/后退、
新建任务）+ `WorkspaceHeader`（48px 会话区顶栏：路径按钮、任务标题、右侧动作区）。
本原型是 web 布局、没有自绘窗口拖拽区，两层合成一条 48px 头部（`h-12 border-b`），
挂在会话视图顶部 —— 与 ZCode 的 WorkspaceHeader 一样是 **task 级**的，
设置 / 自动化 / 搜索各有自己的页头，不重复挂。

| 本项目按钮 | ZCode 对应物 |
|---|---|
| 侧栏开关 PanelLeftClose/Open | DesktopTopOverlay 的 logo/侧栏开关（Windows 下 hover 换图标） |
| 后退/前进 + Alt+←/→ | `useWorkspaceTaskNavigation` 的 canTaskNavBack/Forward + 弹栈 |
| Folder 按钮 + 路径弹层 | `WorkspaceContextPath`（tooltip 内完整路径 + 绑定信息） |
| 新建任务 SquarePen | DesktopTopOverlay 的 MessageCirclePlus |
| 帮助 CircleHelp 下拉 | `WorkspaceHelpMenuButton` |
| 终端 SquareTerminal（按下态） | `WorkspaceTerminalToggleButton` |
| 右栏 PanelRightClose/Open（按下态） | `WorkspaceSidePaneToggleButton` |

差异：ZCode 的历史栈存「任务 id」三元组（task/Automations/PluginStore），
我们的导航目标是「主视图 + 设置分区 + 单元 + 会话」四元组；
记账用**订阅 diff**（`store/useNav.ts` 的 bindNavRecorder）而不是改各处 action，
action 层零耦合，新增导航入口不用记得入栈。

### 底部状态栏 `ui/StatusBar.tsx` ← dsh

dsh 的底栏 = `ContextMeter`（上下文占用环 + 分解面板）+ `StatsPills`
（速度 / 缓存命中 / 轮次 / token 对话框），挂在 composer 卡片下方。
本原型做成**全局底栏**（h-7，横贯全宽），口径照搬：

- 环：`percent = round(最后一轮 input+output / 模型 contextWindow)`，
  14px SVG 环（r=5.5，strokeDasharray 按百分比），点开三段分解面板；
- pills：`↑计费输入 ↓输出`（K/M 缩写）、`缓存 N%`（接近 100% 时保留一位小数，
  防部分命中显示成 100%）、`tok/s`（≥10 取整）、`N 轮 · M 步`、成本 `$x.xxx`；
- 计费口径：`billedInput = uncachedInput + cacheRead + cacheWrite`。

差异与诚实声明：dsh 由 token-meter 投影驱动；本原型从归一化事件流现场派生
（`core/sessionStats.ts`），为此给 `usage` 事件加了可选的
`cacheReadTokens / cacheWriteTokens / decodeMs`（对齐 dsh 的
TokenUsageProjection / SessionStatsProjection 字段名）。上下文三段分解
（system/tools/messages）事件流里没有，是**启发式估计**，面板里有脚注说明，
真实适配器接入后应换成运行时上报。

### 开合去重与统计坞归位（2026-09-28 增补）

实测对照 ZCode 后修掉两处「自创」交互：

- **面板收起即归零**。ZCode 的侧栏收起后宽度趋近 0（桌面端 4px 内缩）、
  `WorkspaceSidebarCollapsedRail` 从未挂载（死代码），侧栏自身品牌行没有收起按钮；
  唯一开关在头部，图标随状态在 PanelLeftClose/Open 间切换，收起后点它重开。
  本原型照做：删掉侧栏品牌行与收起窄条上的重复开关，`collapsedSize="0px"`，
  内容保持挂载由 Panel 裁剪（对齐其 opacity-0 + pointer-events-none 策略）。
- **右栏开关二选一**。ZCode 的 `WorkspaceHeaderActionSection` 只在右栏关闭时渲染
  开关按钮；打开时关闭按钮在右栏自己的标签条末端（`AnimatedSidePanePanel` 的
  `closeSidePaneButton`，同为 PanelRightClose 图标）。本原型同步：头部按钮条件渲染，
  标签条末端加「收起右栏」。
- **统计坞归位**。dsh 的 StatsPills + ContextMeter 本来就挂在 composer 卡片正下方，
  此前做成全局底栏是过度发挥。现移入 `ui/StatsDock.tsx`（composer 下方一行：
  快捷键提示居左，pills + 占用环 + 模型居右），全局底栏删除。

---

## 九、前端全面对齐轮（2026-09-28，对照 packages/ui/src 逐块盘点）

本轮对 ZCode 前端做了三块完整盘点（会话区/composer、三个主视图与路由、侧栏与窗口 chrome），
按盘点结论完成结构性对齐：

| 对齐项 | ZCode 实现 | 本项目现状 |
|---|---|---|
| 主视图路由 | `WorkspaceMainView = chat \| automations \| plugin-store` | `MainView = chat \| automations`（无插件市场） |
| 设置页 | 全屏覆盖层 `WorkspaceSettingsLayer`（absolute inset-0，shell 不卸载） | `settingsOpen` 覆盖层，Esc/返回工作台退出（退出统一回 chat） |
| 搜索 | `CommandCenterDialog`（⌘K 顶部浮层，作用域页签 + 键盘导航），非主视图 | SearchPanel 主视图删除，能力并入 CommandCenter（全部/命令/会话/工作单元/自动化） |
| 侧栏顶部 | NewTaskButtonGroup(⌘N) → 搜索(⌘K) → 自动化(CalendarClock) | 同构三行，ghost 行风格 |
| 侧栏底部 | WorkspaceSidebarFooter：账号菜单 + 设置齿轮 | 账号行（占位）+ 设置齿轮；搜索/自动化不再重复出现在底部 |
| 用户消息 | 时间线右对齐气泡（rounded-tr 切角） | `run()` 写入用户事件，Timeline 渲染右对齐气泡 |
| 发送按钮 | brand 底图标钮（ArrowUp），运行中变实心方块停止 | 图标化（ArrowUp/Square），mock 无取消通道，停止只翻 busy |
| 权限请求 | composer 正上方 bottom dock 卡片（V4InteractionDialogs），非模态 | PermissionDialog 改 dock 卡片，挂 Timeline 与 Composer 之间 |
| 空态 | 时段问候（5/9/12/14/18/23 点换档） | EmptyState 加时段问候 |
| 快捷键 | ⌘B 侧栏 / ⌘N 新建 / ⌘[/] 导航 / ⌘, 设置 / ⌘K 命令中心 | 全部落地（⌘[ / ⌘] 与 Alt+←/→ 并存）；设置分区导航 ⌘, 直达 |

### 已知剩余差异（有意保留或待真适配器）

- **员工/项目双身份视图**：本项目北极星（ZCode 没有），保留；
- **执行器运行时（RuntimePicker）**：六工具平等切换是产品核心，composer 里保留
  （ZCode 只选模型，因为它是单一执行器）；
- **StatsDock（dsh 出处）**：按用户要求挂在 composer 下方，非 ZCode 结构；
- **窗口 chrome**（app-region 拖拽、窗控按钮、更新 pill）：web 原型不适用；
- **虚拟化时间线 / 每工具 renderer**：接真运行时后按事件量决定；
- **automations 编辑整页替换 / OffPeak 任务列表**：ZCode 有完整编辑器，
  原型为 mock 卡片列表，结构已对齐（tab + 状态筛选 + 卡片 grid）。

### 头部与右栏细对齐（2026-09-28 第二轮，对照源码 className 逐项复刻）

- **右栏标签条**：页签从「下划线式」改为 ZCode `SidePaneTabTrigger` 的**等宽胶囊**——
  h-7、flex-basis 156px（min 60 / max 156，先收缩后滚动）、激活填充 `bg-selected`
  （本设计系统映射为 teal-tint）、无下划线；关闭钮激活常显、未激活 hover 浮现
  （未激活时 pointer-events-none，不拦截点击）；总览入口（ChevronsDown）固定**最左**；
  右区对齐 `AnimatedSidePanePanel`：＋ → 分隔线 → 收起右栏，「清空」移除
  （ZCode 的关闭全部在页签右键菜单与总览里，本原型右键关闭其他已有）。
- **头部**：底边框改半透明（`border-border/50` → 本项目 border-line/60），
  侧栏品牌行、右栏标签条同步，保证顶带是同一条更轻的线；
  标题后补 **Ellipsis 更多菜单**（TaskActionMenuContent 同构：置顶/重命名/归档 —
  复制路径/复制会话 ID — 查看调用轨迹 — 反馈；复制与轨迹为真实动作，其余标注占位）；
  工作区弹层补**分支行**（GitBranch + worktree 分支 / main）。
- 侧栏默认宽度 264/持久化、右栏 45% 展开（max 65%、min 240px）均与 ZCode 同参数。

### 左上浮层归位与设置返回按钮（2026-09-28 第三轮）

- **DesktopTopOverlay 落地**（`ui/DesktopTopOverlay.tsx`）：侧栏开关 / 前进 / 后退 /
  新建任务从工作区头部上移到**左上浮层**——绝对定位、宽度对齐侧栏（用持久化的
  sidebarWidth），侧栏收起后浮层原地收成 w-fit、开关换 PanelLeftOpen，头部让出
  152px 安全区（ZCode 的 headerWindowControlsPaddingClass pl-38 同参）。
  品牌标 hover 变形复刻 logo 复合按钮的双图层 opacity 过渡；新建任务带
  `transition-[width,opacity]` 300ms 收展（showNewTaskButton = !isSidebarVisible）。
  工作区头部回归 ZCode 的纯 TitleSection + ActionSection 结构。
- **侧栏顶部改空占位**：ZCode 的侧栏顶部是 h-12 拖拽条，品牌由浮层承载，不再重复。
- **设置返回按钮移位**：从面包屑移入左导航列顶部（ZCode 的
  `TID_SETTINGS_BACK_BUTTON`），面包屑只呈现 设置 / 分区 路径。

### dsh 轨迹账本 + 底栏速度常驻（2026-09-28 第四轮）

- **轨迹页签重写**（`core/trajectory.ts` + TracePane）：对齐 dsh `ui-trajectory` 的
  账本骨架——会话统计（轮次/步数/LLM 耗时/工具耗时/输出速度/四桶 token/成本/事件数，
  口径同 session-stats 投影：LLM 耗时=ΣdecodeMs、工具耗时=tool.started→completed
  按 callId 配对、速度=decodeTokens/(decodeMs/1000)）→ 折叠轮次 + 搜索工具栏 →
  Turn 分组账本（轮头带 token/步数/工具直方图，行带类型色标 USER/助手/工具/计划/
  权限/子代理/变更/产出、工具行内联 `→ 结果`、行详情可展开）。
  时间轴三泳道待真实运行时的首 token 计时接入后再补。
- **修复**：`run()` 的用户事件此前用占位 sessionId，右栏轨迹按会话过滤后
  用户行被滤掉（轮次恒为 0）——改用真实 sessionId 并前置插入时间线。
- **底栏速度常驻语义**：dsh 的 TimePill 面文本在零数据时退化为纯文本而非隐藏；
  本项目底栏照做——「N 轮 · M 步」常驻，跑任务后速度（tok/s）/缓存/成本出现。
  此前「看不到速度」是因为零数据时整组显示占位文案，现已按 dsh 语义修正。
- **助手消息去气泡**：对齐 ZCode，助手行正文直接落在画布上（前缀弱化），
  用户消息保持右对齐气泡。

### 右栏页签改右缘竖排任务栏（2026-09-28 第五轮，用户决策偏离 ZCode）

ZCode 的右栏页签横在面板顶部，页签多时挤压视线。用户决策改为**右缘竖排任务栏**
（VS Code activity bar 形态），此为有意偏离并记录：

- 页签本体 = 右缘 44px 竖排图标栏：激活态 teal-tint 填充 + 左缘 teal 指示条；
  badge（变更/文件/计划/bash-output 计数）挂图标右上角；hover 露出关闭钮；
  拖拽纵向重排、右键关闭其他保留。
- 面板顶条只承担「当前页签名 + 动作」（恢复/清空/＋/收起右栏），
  总览入口移到任务栏底部。
- 横排时代的溢出检测（barRef + ResizeObserver + resolveTabsOverflow）随之删除。

### 执行器/模型选择器对齐 T3code（2026-09-28 第六轮，对照 apps/web 源码）

- **composer 选择器重写**为 T3 `ProviderModelPicker` 形态：360×346 双栏弹层——
  左 rail（★ 收藏视图 + 六执行器图标，选中项右缘 teal 指示条，未安装半透明）+
  右区（搜索框 → 模型列表 → 底部「打开模型设置」入口）。列表行：名称 + 档位 +
  价格/窗口 + 选中勾 + 常驻收藏星标；★ 视图聚合全部执行器的收藏（跨执行器
  选择即切换执行器，同 T3 favorites 语义）；↑↓/Enter/Esc 键盘导航。
- **设置模型分区改三组**：收藏 → 全部 → 已隐藏（T3 `groupModelsForDisplay`），
  工具行改计数式「N 模型 · N 收藏 · N 隐藏」，隐藏行直接给「显示」开关
  （替代旧版底部 chips 区）。数据层（providerModelPreferences + customModels）
  此前已按 T3 语义建模，本轮零改动。
- **顺带修真 bug**：`visibleModelsFor` 的单槽记忆缓存在多执行器并发读取时
  相互踩踏（rail 计数一查，订阅者的 getSnapshot 就返回新数组），React 19
  无限循环白屏——缓存改按 runtimeId 分槽。

### 侧栏整理（2026-09-28 第七轮，用户决策）

- 顶部【员工】【项目】两个大按钮移除，身份切换收进分区行——
  `[员工|项目] 迷你分段切换 + 单元计数 + 按分组/按更新菜单` 同排完成；
- 「连接远端」从列表区移到底部 footer，与设置齿轮并排（图标钮，
  ZCode 的 WorkspaceSidebarFooter 同位）。
