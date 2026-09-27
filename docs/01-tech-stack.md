# 技术栈选型

> 结论先行，证据在后。所有判断都来自对 `zocdeusually/ZCode`、`t3code`、`deepseek-harness`、`pi` 四个仓库的实际代码走查，不是凭印象。

---

## 一、结论：一句话技术栈

```
Vite + React 19 + TypeScript + Tailwind v4 + Zustand + Electron
                    ↑
              自研 RuntimeAdapter SPI（纯 TS，无框架依赖）
```

**不要 fork 任何一个仓库。** 全新写壳，把四家当运行时接进来。

这一条是全部选型的第一原则。理由是你自己已经识别出的痛点：
ZCode 只做了员工、T3 只做了项目、dsh core 每周大改。而你的两种用法
**共享同一套运行时原语**——目录、agent 定义、会话、技能、权限。既然原语相同，
UI 层就没有必要继承任何一家的历史包袱。UI 是渲染层，底座可换，这正是你自己
写在需求里的"现有资产零迁移"。

---

## 二、四仓库横向对比（实证）

| 维度 | ZCode | t3code | deepseek-harness | pi |
|---|---|---|---|---|
| 许可证 | **Apache-2.0** | **MIT** | **MIT** | **MIT** |
| React | 19.2 | 19.2 | 18.2 | —（无 Web UI） |
| 状态管理 | zustand + swr | zustand + **Effect** | **cordis 插件 DI** | — |
| 路由 | 自研 | **TanStack Router** | 自研 | — |
| 构建 | Vite 8 | Vite (vite-plus/rolldown) | Vite 6 | esbuild / tsgo |
| 样式 | **Tailwind v4** | **Tailwind v4** | lightningcss | — |
| 组件库 | radix-ui + shadcn | @base-ui/react | 自研 primitives | — |
| 桌面壳 | **Electron** | **Electron** + Rust | **Electron 44** | 无（TUI） |
| 状态/事件抽象 | `@zcode/rpc` 通道抽象 | `client-runtime/connection` | cordis 事件总线 | framed CBOR 协议 |
| 核心接缝 | provider registry | **ConnectionRegistration** | ACP | protocol/client |

**四条独立的项目在两件事上完全一致**，这就是最可靠的信号：

1. **React + TypeScript + Tailwind v4 + Vite** — 三个有 Web UI 的项目全中
2. **Electron** — 三个有桌面的项目全中，无一例外

---

## 三、逐层选型

### 3.1 渲染层：React 19 + TypeScript

无争议，跟着 ZCode / t3code 走 React 19（dsh 还在 18.2，是它自己 fork 节奏慢）。

TypeScript 5.9。本机 Node 24.16 / pnpm 11.13 满足全部四个仓库的 engines 要求。

### 3.2 构建：Vite 7

**不跟 t3code 用 vite-plus（rolldown）。** 它是 t3 的自研封装，跟上游绑定；
**不跟 ZCode 用 Vite 8。** 8 太新，插件生态还没跟上。
Vite 7 是当前"稳定 + 生态齐"的甜点。

### 3.3 状态：Zustand

三选一：

| 方案 | 谁在用 | 判断 |
|---|---|---|
| **Zustand** | ZCode、t3code | ✅ 选它 |
| Effect-TS | t3code | ❌ 见下 |
| cordis 插件 DI | dsh | ❌ 见下 |

**为什么不抄 t3 的 Effect-TS**：它的 Effect 依赖不是"状态库"能概括的。
看 `packages/client-runtime/src/connection/registry.ts` 就知道——
`Context.Service` / `Layer` / `SubscriptionRef` / `Schema.TaggedError` /
`Schema.is()` 深度织入每个模块。引入它意味着前端整套逻辑要按 effect 范式重写，
学习成本和迁移成本都很高，而这对"先做 UI 原型"是纯负担。

**为什么不抄 dsh 的 cordis DI**：cordis 是**服务端**插件体系（`dsh-agent`、
`dsh-api-gateway` 都在用）。前端的 `ui-slots` 虽然借鉴了插件思想，但那是
"可组合 UI 区"的需求，不是"全局状态"的需求。杀鸡用牛刀。

> **但 ZCode 的 `@zcode/rpc` 值得抄形态**：它把传输抽象成
> `buffer / protocol / serialization / proxy-channel`，
> 让"本地进程"和"远程 server"共用一套代码。你的 SPI 应该长成这样——
> **这一点已经落进 `prototype/src/core/adapter.ts` 的 `TransportDescriptor`。**

### 3.4 样式：Tailwind CSS v4

三个项目全用。v4 是 CSS-first 配置（`@theme` 内联），没有 `tailwind.config.js`。
对你的场景（个人工具、暗黑为主、组件密度高）收益明显：改主题不用碰 JS。

### 3.5 组件：shadcn/ui（copy-in）

**关键理由不是审美，是"拒绝巨量 fork 税"这条原则的延伸。**

shadcn 不是依赖，是**把源码复制进你的仓库**。这意味着：
上游改了不会自动污染你，你的 UI 代码完全在自己手里。
对于一个你打算长期自建、且明确拒绝被上游绑架的项目，这是对的形态。

ZCode 用 `radix-ui` + shadcn，t3 用 `@base-ui/react`。
选 shadcn 路线——它自带 radix 版本，社区最大，示例最多。

### 3.6 路由：TanStack Router（**第二阶段再上**）

t3code 已经在用，类型安全的文件路由，很适合"两个视图 + 多层会话"的形态。

**但原型阶段故意不用。** 原型用 zustand 管视图切换就够，
上路由会带来 codegen 和配置摩擦，而 UI 原型迭代要的是秒级热更新。
原型里已经把视图状态收敛在 store，切视图是一行 `setView`。

### 3.7 桌面壳：Electron

三个项目全部选 Electron，Windows 打包（NSIS）路径都验证过。

**不选 Tauri**：四个参考仓库没有一个用，Windows 下要额外装 Rust 工具链，
与"省事"直接冲突。

### 3.8 重型渲染库：现在不装，等需要时再进

全部已核实许可证（见 `02-reference-audit.md`），但原型期不装——
它们会让首次 `pnpm install` 从几秒变成几分钟，拖慢 UI 迭代。

| 库 | 许可证 | 用途 | 证据 |
|---|---|---|---|
| `@pierre/diffs` | **Apache-2.0** | diff 渲染 | **ZCode 和 t3code 独立选了同一个库** |
| `@pierre/trees` | Apache-2.0 | 文件树 | t3code |
| `@xterm/xterm` | MIT | 终端 | ZCode |
| `react-resizable-panels` | MIT | 可拖拽分栏 | ZCode |
| `@tanstack/react-virtual` | MIT | 虚拟滚动 | ZCode |
| `shiki` | MIT | 代码高亮 | ZCode |
| `react-markdown` | MIT | Markdown 渲染 | t3code |
| `motion` | MIT | 动效 | ZCode |
| `@xyflow/react` | MIT | 编排流程图 | ZCode |
| `@dnd-kit/core` | MIT | 拖拽 | ZCode + t3code |
| `recharts` | MIT | 图表 | ZCode |

> **`@pierre/diffs` 值得单独说**：ZCode（Apache-2.0 项目）和 t3code（MIT 项目）
> 在互不知情的情况下都引入了它。这种独立收敛比任何 benchmark 都有说服力。
> 而且它自己也是 Apache-2.0，许可证干净。

---

## 四、SPI：真正需要自研的那一层

上面所有选择加起来都是"抄现成的"。**唯一必须自己写的是适配器 SPI。**

它决定了"多工具平等切换"是 2 个文件还是 20 个文件。

```
新增一家工具 = adapters/<name>/adapter.ts + adapters/<name>/mapper.ts
              core/ 一行不改    ui/ 一行不改
```

参照 t3code 的 `ConnectionRegistration` 形态，但做了三处刻意削减：

1. **去掉 Effect / Schema** —— 用纯 TS 判别联合，零学习成本
2. **transport 下沉到工厂** —— UI 只面向"能力"，不面向"怎么连"
3. **强制能力声明** —— 适配器必须显式说自己缺什么，UI 据此做渐进增强

第 3 条最容易被跳过，但它恰恰是真实成本所在。
`@pierre/diffs` 给你渲染 diff，但 OpenCode 没有结构化 diff，
Claude Code 没有 worktree，`pi` 没有终端——**UI 必须在能力缺失时优雅退化，
而不是渲染一个永远空白的面板。** 原型的右栏能力矩阵就是逼自己面对这件事。

已落地：`prototype/src/core/{units,events,adapter,registry}.ts`

---

## 五、许可证核查结果

你的硬约束是"只接受 Apache-2.0 / MIT"。核查了**四仓库本身 + 15 个候选第三方库**：

| 对象 | 许可证 | 可用 |
|---|---|---|
| ZCode | Apache-2.0 | ✅ |
| t3code | MIT | ✅ |
| deepseek-harness | MIT | ✅ |
| pi | MIT | ✅ |
| 15 个候选前端库 | 全部 MIT 或 Apache-2.0 | ✅ |

**零例外，无需替换。** 唯一需要注意的是：若将来直接复用某家的**源码**
而非仅参考设计，需保留其版权声明与 NOTICE 文件。
若坚持 Apache-2.0（如 ZCode），需特别注意其专利授权与修改声明条款。

---

## 六、分阶段路线

| 阶段 | 目标 | 交付 |
|---|---|---|
| **P0（当前）** | UI/UX 原型 | `prototype/` 可跑，六工具平级切换，双视图 |
| **P1** | 接第一个真运行时 | 建议 **ZCode**（HTTP，最简单）验证 SPI |
| **P2** | 加 Electron 壳 | 文件读写、终端、原生菜单 |
| **P3** | 接 ACP | dsh 走 ACP，验证"近零成本"假设 |
| **P4** | 轨迹落盘 + eval | `TraceRecord` → LLM judge → 回归对比 |
| **P5** | 升 monorepo | 拆 `packages/core` / `packages/ui` / `adapters/*` |

**P0→P1 的验证标准很硬**：把 mock 适配器换成真 ZCode，
如果 `ui/` 需要改，说明 SPI 设计错了，回头改 SPI 而不是改 UI。

---

## 七、待你拍板的三个决策点

1. **P1 先接谁？** 建议 ZCode（HTTP 最简单，验证 SPI 成本最低），
   但 dsh 的 ACP 才是"多工具平等"最有说服力的证明。你更想先验证哪个假设？
2. **何时升 monorepo？** 现在单 Vite app + 目录边界，代码量到 P3 左右
   （适配器超过 4 个）就该拆 workspace。
3. **路由何时上？** 建议 P1 之后、Electron 之前。视图层稳定后再引入，
   避免路由抽象反过来限制 UI 结构。

---

## 附：为什么不是"改造升级某个现有项目"

你的原话是"从已有的开源项目的基础上进行改造升级"。**建议调整为：
借鉴而非改造。** 理由：

- **ZCode** 是员工形态最全的，但它的 UI 与它的 `@zcode/*` 内部包深度耦合
  （`packages/ui` 直接依赖 `provider` / `rpc` / `services`）。要抽出通用壳，
  等于重写 UI 层，还背上了 Apache-2.0 的合规成本。
- **t3code** 上游不收 PR，意味着你的改动无人维护、无法回合；
  且 Effect 深度织入，剥离成本极高。
- **dsh** core 每周大改，任何跟进都是无底洞。
- **pi** experimental 栈在推倒重来，且它**根本没有 Web UI**，
  只有 TUI + 协议层——UI 部分你从零写 anyways。

**共同点：四家的 UI 都已经和各自的后端假设焊死了。**
你要的是一个全新的渲染层，那不如就全新写，只借鉴它们的领域建模和接缝设计。
