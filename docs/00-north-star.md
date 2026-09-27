# 北极星

> 本项目的需求种子。技术选型服务于它，路线图由它推导。

---

## 一、你怎么工作

日常用文件夹管理所有事务，重度使用多个 coding agent
（ZCode 是主力；Claude Code、Codex、OpenCode、pi、DeepSeek Harness、T3 Code 本机均已安装），
已沉淀大量资产：每个文件夹的 `AGENTS.md`、跨工具可用的 skills、定时自动化。

工作方式天然分成两种：

### 1. 数字员工模式

**一个文件夹 = 一类事务的专人专事。**
用 `AGENTS.md` 当岗位说明书控制一个 agent 的行为，长期、重复地干活
（如 `content` 文件夹负责每日内容创作）。

本质是「**招聘**」，要的是**稳定的身份**：人设、定时触发、聊天渠道、长期记忆、产出归档。
类似 grok bot / OpenClaw 的形态。

### 2. 项目模式

**一个文件夹 = 一个开发项目**（通常已上 GitHub）。
多个 agent 按角色分工协作（架构 / 前端 / 后端），会话短寿、走 worktree / PR。

本质是「**组队施工**」，要的是**可替换的执行器**和任务编排。
类似 Codex / ZCode 的形态。

---

## 二、核心痛点

现有产品的前端只实现了其中一种身份模型，把两种用法割裂成两类软件，
迫使你在「员工软件」和「开发软件」之间来回切换。

**但两者的运行时原语（目录 + agent 定义 + 会话 + 技能 + 权限）其实是同一套。**

---

## 三、目标：一个本地个人统一工作台

| 诉求 | 具体形态 |
|---|---|
| **一个界面，两种视图** | 员工视图（人 / 状态 / 日程 / 最近产出）+ 项目视图（看板 / diff / PR） |
| **一个界面，多家工具平等切换** | ZCode / Claude Code / Codex / OpenCode / pi / dsh 都是可替换的一等公民，不是某家的附属品 |
| **对运行时完整过程的评估优化** | 轨迹记录 → LLM judge → 回归对比的数据闭环 |
| **现有资产零迁移** | AGENTS.md / SKILL.md / automations 继续可用，UI 只是渲染层，底座可换 |

> **已移除**：原「单任务内组合多 agent，按目标选策略（更好效果 / 更短时间 / 更低成本）」一条
> 系第一轮需求里混入的概念，UI 与 SPI 均已清除。轨迹格式与 `subagent.*` 事件类型保留，
> 将来若真要做编排，从这两处接回即可。

---

## 四、约束条件

- 本地优先
- Windows 环境
- 只接受 **Apache-2.0 / MIT** 的开源底座
- 可以 fork 自建，但**拒绝背「巨量 fork 税」**
  （dsh 的 core 每周大改、T3 上游不收 PR，都要用「外挂适配器、不改核心」的策略规避）

---

## 五、对话中已收敛的结论

| 事项 | 结论 |
|---|---|
| 员工模式三件套 | ZCode 已内置约七成（workspaceIdentity + automations + memory），缺渠道 / 沙箱 / 常驻调度 |
| 多工具切换 UI | 只有 T3 Code 现成；provider SPI 开放，新增工具 = 两个适配器文件 |
| runtime 接口 | 不用「拉出来」，各家 headless 接口现成：dsh 走 ACP（近零成本）、pi 走 RPC、ZCode 走 agent-server |
| 任务内组合 | 首选 T3 里写 Orchestrator driver（可包 dsh headless，它原生支持 spawn Claude Code / Codex 子代理）；退路是 ZCode dynamic-workflow |
| eval 体系 | pi 的 `packages/evals`（vitest-evals + autoevals）提供评测框架，ZCode 的遥测（schema v6 + OTLP）提供过程数据，两半拼合 |
| **不推荐的 fork** | dsh core（跟进成本失控）、pi experimental 栈（pico3 → durable 在推倒重来） |

---

## 六、已定的第一步动作（零代码验证）

1. 在 ZCode 里给 `content` 文件夹设 `workspaceIdentity` + 建一个每日 automation
   —— 零代码验证「员工」形态
2. 装 T3 Code，跑通已有的 Claude Code + Codex；试 `dsh --profile acp`，
   验证 dsh 能否出现在 T3 的 provider 列表里 —— 验证整套三层架构的可行性

---

## 七、本项目的定位

> 前两步是**在别人家验证假设**，不需要写代码。
> 本项目是**把验证过的东西收进自己家**——但只收 UI 和接缝，不收内核。

不 fork 任何一家。理由见 `02-reference-audit.md` 第七节：
四家的 UI 都已经和各自的后端假设焊死了。
你要的是一个全新的渲染层，那不如就全新写，只借鉴它们的领域建模和接缝设计。
