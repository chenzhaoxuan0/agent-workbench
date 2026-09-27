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
