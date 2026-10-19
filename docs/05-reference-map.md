# 参照地图 —— 每个功能参考了谁、落在哪

> 本文档回答一个问题：**这个项目的每一块能力，参照了哪个开源仓库的什么，
> 最终落在了哪些文件上。**
>
> 与其他文档的分工：
> - `02-reference-audit.md` 是**工程调研**（许可证 / 活跃度 / 工程结构），
>   只覆盖项目起步时的四家；
> - `04-design-system.md` 是**决策时间线**（每轮改动的取舍与理由）；
> - 本文是**功能 → 参照来源 → 落点**的静态地图，随功能演进更新；
>   第十三节起兼作**后端开工指路**（契约指针 / 各仓库服务端入口 / 接真顺序）——契约细节一律指向定义处，不在本文复述。

---

## 一、总览

| 参照来源 | 类型 | 参照领域 | 主要落点 | 本机位置 | 后端契约指针 |
|---|---|---|---|---|---|
| ZCode | 桌面客户端（本机安装 + 本地克隆） | 整个外壳骨架与交互习惯 | `WorkspaceShell.tsx` `useShell.ts` `SettingsPage.tsx` `AutomationsPage.tsx` `PermissionDialog.tsx` | `C:\Users\chenziyu\project\Agent\zocdeusually\ZCode` | `core/adapter.ts` SPI 的语义蓝本（六种 TransportKind）；壳层 localStorage 键为纯前端，后端无涉 |
| deepseekharness（dsh） | 本地克隆（MIT） | 轨迹视图、会话内页签 | `TrajectoryView.tsx` `core/trajectory.ts` 会话页签条 | `C:\Users\chenziyu\project\Agent\deepseek-harness` | `core/events.ts` RuntimeEvent 流 + `core/trajectory.ts` 账本行形态，须由事件流喂饱 |
| waku-agent | 本地克隆 | 记忆三柱与编排、LLM-Ops 支柱 | `useMemoryPrefs.ts` `useOps.ts` `OpsView.tsx` | `C:\Users\chenziyu\project\Agent\waku-agent` | localStorage `agent-workbench:ops` `:memory-prefs` `:memory-orchestration` 三键待换后端落盘 |
| t3code（T3） | 本地克隆（MIT） | 供应商实例管理、模型偏好 | `ProviderInstancesPanel.tsx` `ModelSettings.tsx` | `C:\Users\chenziyu\project\Agent\t3code` | localStorage `agent-workbench:provider-profiles` `:model-prefs` 两键待落盘 |
| pi | 本地克隆（MIT） | 供应商目录、models.json 配置形态 | `core/providerCatalog.ts` `ModelSettings.tsx` | `C:\Users\chenziyu\project\Agent\pi-latest`（badlogic/pi-mono） | `core/providerCatalog.ts` 只读常量，后端无涉 |
| gpt_image_playground | 开源（CookSleep，MIT，本地克隆） | 出图全链路 | `core/imageApi.ts` `useImageStudio.ts` `ImageStudioPage.tsx` `ImageSettingsSection.tsx` | `C:\Users\chenziyu\project\Agent\gpt_image_playground` | `core/imageApi.ts` 请求体 / SSE 解析契约（现为客户端直连） |
| WeKnora | 开源（本地 Docker 部署） | 记忆后端渠道之一 | `core/weknora.ts` | 源码克隆 `C:\Users\chenziyu\project\WeKnora\WeKnora`（Tencent/WeKnora，参照用）；部署根目录 `C:\Users\chenziyu\project\WeKnora`（Docker 容器 + update 脚本） | `core/weknora.ts` 三接口 listKb / saveFact / search（已是真 API 客户端） |
| agents.md 规范 | 规范文档（本地克隆） | bot 的岗位说明书 | `AddBotDialog.tsx` | `C:\Users\chenziyu\project\Agent\zocdeusually\agents.md` | 无 |
| termux-app | 本地克隆（GPL-3.0） | 移动端终端虚拟键盘辅助按键栏形式与排布（2x7 双行网格、倒 T 方向键集群、修饰键粘滞状态机） | `prototype/src/ui/mobile/MobileVirtualKeyBar.tsx` | `C:\Users\chenziyu\project\Agent\termux-app` | 无（纯前端触控交互） |
| GrokBot | 视觉参照 | 侧栏 bot 头像形态 | `Sidebar.tsx` `UnitRow` | 无本地克隆（仅视觉参照） | 无 |

> 上述 git 克隆（含 WeKnora 源码）已于 2026-09-29 全量 `git pull --ff-only` 同步至各自上游 HEAD；
> WeKnora 源码带一处本地定制（docker-compose.yml 将 neo4j 端口映射改为 17474/17687，
> 规避 Windows Hyper-V 动态保留端口），pull 时用 `--autostash` 保留，勿还原；
> 同名备选目录（`dsh`、`dshwork`、`t3codeuse`、`pi`）均非上游克隆，真正的克隆以上表为准。

---

## 二、ZCode —— 外壳骨架的总蓝本

ZCode 是工作台布局与交互习惯的**总参照**，几乎每个壳层文件都有它的对应物。

| ZCode 的概念 / 组件 | 本项目落点 | 备注 |
|---|---|---|
| `WorkspaceShellLayout`（侧栏 / 右栏 / 底部面板 / 主列） | `WorkspaceShell.tsx` | 侧栏 264px 起可拖拽，宽度持久化到 localStorage；"收起即归零不留常驻窄条" |
| 右栏标签页面板 | `SidePane.tsx` + `useSidePane.ts` | 契约在 `core/sidepane.ts`，标签页状态从 useShell 拆出避免两处实现分叉 |
| `BASE_SETTINGS_SECTIONS` | `SETTINGS_SECTIONS`（useShell.ts） | basics / agentCapabilities / dataAndStats 三组结构照搬，内容按本项目资产重排 |
| SettingsGroupCard / 设置覆盖层 | `SettingsPage.tsx` | 设置是 absolute inset-0 全屏覆盖层（shell 压暗不卸载），不是主视图 |
| `AutomationsSection` | `AutomationsPage.tsx` | tab + 状态筛选 + 卡片网格 + 空态模板宫格；两条口径：分组以卡片徽章为准、切 tab 重置筛选 |
| `AnimatedTerminalPanel` | `TerminalPanel.tsx` 的 dock 变体 | 30% 高可开关；page 变体是本项目扩展（见第八节） |
| `V4InteractionDialogs` | `PermissionDialog.tsx` | 权限卡作为 composer 上方 bottom dock 打断，而非居中模态 |
| 命令中心 / newTask / Esc 退出 | `useShell.ts` 快捷键层 | ⌘K 命令中心；⌘F 并入同一入口（ZCode 无独立搜索视图）；⌘N 新任务；Esc 关设置回 chat |
| 消息 id 常驻原则 | 侧栏等全部空态 | ZCode 每个功能都有 message id → 本项目"功能不能因为当前为空就消失" |

**服务端参照入口**：通道抽象 `packages/rpc/src/channels.ts`（`channelServer.ts` / `channelClient.ts`）——`RuntimeAdapter` 事件流的后端对应物；执行端服务化看 `packages/server/`、`packages/provider-node/`、`packages/services/`。

---

## 三、deepseekharness（dsh）—— 轨迹与会话内页签

你明确要求轨迹"完全对照 dsh 的位置，转换认知 0 成本"。

| dsh 的概念 | 本项目落点 | 备注 |
|---|---|---|
| `TrajectoryView`（账本形态） | `TrajectoryView.tsx` + `core/trajectory.ts` | 类型色标行（系统/用户/助手/工具/计划/权限/子代理/变更/产出）+ 单行摘要 + 内联「→ 结果」+ 展开详情 |
| 轮次 sticky 头 | `TrajectoryView.tsx` | 第 N 轮 + token / 步数 / 工具直方图数据 |
| 工具栏（折叠轮次 + 搜索） | `TrajectoryView.tsx` | 全收起 / 全展开 + 文本过滤 |
| view-selection（ConversationSession tabs） | `useShell.conversationView` + 页签条 | 轨迹与 Chat 并列为会话头页签；激活占据整个会话视口、composer 保持底部（composer-overlay 语义） |
| models 配置文件方式 | `ModelSettings.tsx` | 自定义模型多行表单录入（id / 显示名 / 窗口 / 价格），叠加 pi models.json 预览 |
| 三泳道时间轴（TrajectoryTimeline） | **未移植** | 待真实运行时的精确计时接入后再补 |

**服务端参照入口**：会话账本落盘 `packages/session/session-persistence-jsonl/`，格式版本化与迁移 `packages/session/session-format*/`（v1→v4 的演进现场），投影层 `session-projection/`；ACP 协议实现 `packages/acp/`；轨迹 UI 对照面 `packages/client/ui-trajectory/`。

---

## 四、waku-agent —— 记忆与 LLM-Ops 两大支柱

### 记忆侧（`useMemoryPrefs.ts` + 设置记忆分区）

| waku 的概念 | 本项目落点 | 备注 |
|---|---|---|
| 记忆三柱：语义事实 / 情节事件 / 程序性技能 | `MemoryRoutes`（semantic / episodic / procedural 各指向后端 id 数组） | 分开用有分开用的用法，合起来有合起来的用法 |
| `.waku/state.db` | SQLite 后端的 `dbPath` 字段 | 可自定义任意路径，含「默认」恢复 |
| 后端注册表 | `MemoryBackend[]`（weknora / local-folder / sqlite 三类） | 行展开可编辑，配置 JSON 预览 + localStorage 键名标注（透明化） |
| 多后端检索并集 / 写入广播 | 编排模型的 route 与 gate 逻辑 | 每个 bot 可覆盖全局路由 |
| MEMORY.md 镜像 | 记忆设置中的镜像行 | |
| 检索门控（retrieval gate） | 门控参数（模型 / 阈值下拉） | |

### Ops 侧（`useOps.ts` + `OpsView.tsx`，对照 `docs/evals.md` 四条铁律）

| waku 的铁律 / 模块 | 本项目落点 | 备注 |
|---|---|---|
| 两类 eval 永不混合 | 确定性卡 vs judge 卡分开 | 确定性：`dataset.jsonl` 行形态（id/input/expect_tool/expect_in_args），0 或 1，无模型裁判；judge：DeepEval GEval 形态（命名指标 + 评分步骤 + 阈值 0.6），每次评分是一次真实 LLM 调用 |
| `make gate` 发布门 | `GateCard` + `runGate` | 确定性 100% 且 judge 全过阈值才 PASS；分阶段进度条 |
| eval 历史表（`eval_runs.jsonl`） | `gateHistory` | 追加只写，一行一次 gate，FAIL 原因随行保存 |
| `waku/ops/arena.py` | `ArenaCard` + `runArena` | 同一 prompt × N 启用执行器（各取当前模型）；Completion / Quality 双分刻意分开；一场一行 |
| `waku/ops/compare_history.py` | `arenaHistory` | `compare/history.jsonl` 语义，上限 50 场滚动 |
| 花费永久（`usage.jsonl`） | `usage` + `SpendCard` | 每次 LLM 调用追加一行；美元由 token 估算，token 是 ground truth；近 14 天按日柱状 + 按供应商汇总 |
| dashboard 的 Ops 页签 | 会话头「Ops」页签 | 运营视图不渲染 composer；「打开轨迹」直连轨迹页签（trace 内联的轻量替代） |
| 三泳道时间轴 | **未移植** | 同 dsh，待真运行时 |

**服务端参照入口**：`waku/memory/`（semantic / episodic / procedural 三目录 + `retrieval_gate.py` + `consolidation.py`）；`waku/ops/`（`arena.py` `judge.py` `release_gate.py` `compare_history.py` `pricing.py` `dashboard.py`）；编排入口 `waku/app.py`，状态库 `waku/db.py`，会话运行时 `waku/runtime/session.py`。

**刻意偏离**：waku 的确定性套件是 83 个 pytest 文件 + coding.jsonl 沙箱 verify，原型只移植了 dataset.jsonl 的 5 行形态；Arena 无 SSE 直播（错峰 setTimeout 模拟）也无 throwaway home 沙箱；judge 缺 key 时整层跳过而非计 0 分（沿用 waku 语义）。接真运行时只换执行端。

---

## 五、t3code（T3）—— 供应商实例管理

| T3 的概念 | 本项目落点 | 备注 |
|---|---|---|
| Providers 页（左实例列表 + Switch / 右编辑器） | `ProviderInstancesPanel.tsx` | 左：图标 + 名称 + 版本 + 状态行 + 启用 Switch + 「默认」徽标；右：显示名行内编辑 / 端点+协议+启动参数 / 环境变量表 / Models 内嵌管理 / Advanced 健康检查步进 |
| Checked 全量刷新 | `probeAll()` | 执行器实例偏好 `runtimePrefs`（enabled/displayName/endpoint/launchArgs/envVars/lastCheckedAt） |
| `providerModelPreferences` + `customModels` | `modelPrefs` + `visibleModelsFor` | 每个 CLI 各自记住模型（全局单模型在切执行器时必然非法）；隐藏 / 排序 / 收藏 / 自定义模型；可见性判定唯一入口，含 getSnapshot 引用稳定的分槽缓存注释（React 19 无限循环踩坑记录） |

**服务端参照入口**：协议契约 `packages/contracts/`，Effect 化执行器连接 `packages/effect-acp/` 与 `packages/effect-codex-app-server/`，连接层 `packages/client-runtime/src/connection/`。

---

## 六、pi —— 供应商目录与模型配置

| pi 的资产 | 本项目落点 | 备注 |
|---|---|---|
| providers 目录 41 家（id / name / baseUrl / api / keyEnv） | `core/providerCatalog.ts` | 脚本生成常量；`ProviderSettingsSection` 的第三方目录选型 |
| models.json 的 providers 字典 | `ModelSettings.tsx` | 自定义模型表单 + pi models.json 配置预览（配置透明化） |

**服务端参照入口**：`packages/protocol/` + `packages/server/` + `packages/session-backends/`；模型目录 `packages/ai/src/model-catalog.ts`（自定义模型经 `models-store.ts` 合并）；models.json 读取在 `packages/coding-agent/src/config.ts`。

---

## 七、gpt_image_playground（CookSleep）—— 出图全链路

逻辑移植自 `openaiCompatibleImageApi.ts` + `imageApiShared.ts` + `serverSentEvents.ts` 主链路。

| playground 的能力 | 本项目落点 | 备注 |
|---|---|---|
| images 模式（generations JSON / edits FormData `image[]`） | `core/imageApi.ts` `callImagesApi` | 纯文本生图 / 参考图改图双端点 |
| responses 模式（tools: image_generation + tool_choice=required） | `callResponsesImageApi` | 推理力度 reasoningEffort + 专职图像模型 imageGenerationModel |
| 流式 partial images | SSE 解析 + pending 任务卡实时过渡图 | `stream=true` + partial_images(0–3)；多张拆并发单发 |
| `ApiProfile` 字段全集 | `ImageProfile` + `ImageSettingsSection.tsx` | 多 profile 管理（生效 Switch + 两段确认删除，新增自动选中编辑）；response_format=b64_json / codexCli / 透明背景方法 / 超时 |
| codexCli 中转 | `prependCodexCliSizePrompt` + prompt 改写守卫前缀 | 丢弃 size/quality 参数，尺寸写成 prompt 前缀；文案沿用原仓库 |
| paramCompatibility 本质规则 | `buildGenerationBody` / 参数选择器 | gpt-image*（size/quality/output_format/moderation/background）vs dall-e 族（standard/hd + response_format） |
| b64_json / url 双路径解析 + 防御式报错 | `parseImagesApiResponse` / `getApiErrorMessage` | error.message 优先；流式 / 透明背景不支持 hint 文案原文 |
| mock-image-api | e2e 验证端点 | b64 模式 + CORS 全开，headless 走通全链路 |

**服务端参照入口**：无——原仓库为纯客户端直连，参照价值全在 API 客户端三文件（见本节首行）。后端若收代理，请求体 / SSE 解析契约以 `core/imageApi.ts` 现状为准。

**未移植**（接真时再补）：fal.ai 供应商族、自定义 HTTP 服务商映射、透明背景 local 方法的 canvas 抠图后处理、遮罩编辑器。

---

## 八、WeKnora —— 记忆后端渠道之一

| WeKnora 的接口 | 本项目落点 | 备注 |
|---|---|---|
| `X-API-Key` 直连 | `core/weknora.ts` | listKb / saveFact（manual knowledge）/ search（hybrid-search 跨库，`knowledge_base_ids` 数组） |
| 部署形态 | 记忆编排的一种后端类型 | 本地 Docker 18080；baseUrl/apiKey/kbId 三字段；401 属预期（需在 WeKnora 前端生成 API Key） |

**服务端参照入口**：hybrid-search 处理器 `internal/handler/knowledgebase.go`，服务入口 `cmd/server/`，Go 客户端参照 `client/retrieval.go`。

---

## 九、agents.md 规范 —— bot 的岗位说明书

| 规范的概念 | 本项目落点 | 备注 |
|---|---|---|
| AGENTS.md 作为 agent 身份源文件 | `AddBotDialog.tsx` | 高度自定义创建流程：名称 / 根目录 / 角色 / 人设 / 执行器与模型绑定 / AGENTS.md 正文（这个 bot 被设计用来做什么）/ 记忆三层路由覆盖 |
| 身份加载 | `WorkUnit.identity`（role / persona / sourcePath / loadedAt） | bot 单元侧栏行显示角色为副标题 |

---

## 十、GrokBot —— 视觉细节参照

| GrokBot 的形态 | 本项目落点 | 备注 |
|---|---|---|
| 彩色 blob + 双眼吉祥物头像 | `Sidebar.tsx` `UnitRow` | 「颜色 × 形状」由单元名哈希出稳定组合——同一个 bot 永远长一样；这是身份数据而非 UI 装饰 |
| 行结构 | `UnitRow` | 标题 + 相对时间（今天显示时刻 / 昨天 / 日期）+ 副标题（行内任务优先，其次身份角色） |
| 日程角标 | 头像右下 teal 圆点 | |

---

## 十一、非仓库参照与原创部分

- **File System Access API 模式**：本地记忆来源（`core/localMemorySource.ts`）建立的模式——showDirectoryPicker + IndexedDB 句柄仓 + 权限恢复/重新授权——被出图保存位置（`core/imageSave.ts`）直接复用。这是项目内自引用，不是外部参照。
- **原创 / 无参照**：mock 适配器体系（`adapters/mock/`）、会话统计派生（`core/sessionStats.ts` 的 toolMs/ttftMs）、终端多窗格工作台（`TerminalPage.tsx`，双入口并存是本项目对 ZCode dock 终端的扩展）、outbox 式验证脚本模式（playwright-core + headless shell，每轮改动跑一遍）。
- **已知环境限制**：headless Chromium 在「从 IndexedDB 反序列化文件系统目录句柄」时渲染进程原生崩溃（shell 与 full 构建皆然），出图保存位置的 e2e 用 IDB shim + 假句柄走通应用路径；原生句柄 roundtrip 是真 Chrome 标准模式，手测无碍。

---

## 十二、许可证状况

参照仓库均满足「只接受 Apache-2.0 / MIT」的硬约束：ZCode（Apache-2.0）、t3code / deepseek-harness / pi / gpt_image_playground / waku-agent（MIT）、WeKnora（Apache-2.0）。逐仓库的 HEAD 与活跃度证据见 `02-reference-audit.md`（waku-agent、gpt_image_playground、WeKnora 三家为后期引入，尚未补入该审计表）。

---

## 十三、接真顺序 —— 后端开工清单

> 契约的唯一事实源在仓库内：`prototype/src/core/adapter.ts`（`RuntimeAdapter` SPI：probe / connect / listSessions / startSession / resumeSession / sendMessage / cancel / resolvePermission / events / exportTrace；`TransportKind` = acp | jsonrpc | rpc | http | process | internal；能力开关见 `RuntimeCapabilities`）与 `prototype/src/core/events.ts`（归一化事件流）。本节只放指针与顺序，不复述契约。

1. **一个真实执行器走通全链路**——把 `adapters/mock/` 换成一个真进程适配器：startSession → sendMessage → events → exportTrace 端到端。协议建议 ACP 先行，参照有两份：dsh `packages/acp/`、t3code `packages/effect-acp/`。
2. **会话持久化对齐 dsh 账本形态**——`session-persistence-jsonl` 的落盘方式 + `session-format` 的版本迁移思路，替掉内存态；轨迹视图（`core/trajectory.ts`）从同一条账本读，前后端天然同构。
3. **Ops 执行端换真**——dataset runner / judge / gate / usage 落盘照 `waku/ops/` 实现，替掉 mock 的错峰 setTimeout 与 localStorage `agent-workbench:ops`；`eval_runs.jsonl`、`usage.jsonl` 行形态已在 §四写明。
4. **记忆编排后端**——三柱路由 + weknora / local-folder / sqlite 三后端连通；`core/weknora.ts` 已是真 API 客户端可直接复用，SQLite 后端对齐 waku 的 `.waku/state.db` 语义（§四）。
5. **出图代理（可缓）**——原型已客户端直连真 API；仅在需要隐藏 key / 统一计费 / 服务端落盘时再收进后端，届时以 `core/imageApi.ts` 为契约。
6. **补齐各节未移植清单**——三泳道时间轴（§三/§四）、Arena SSE 直播与 throwaway home 沙箱（§四）、waku 83 项 pytest verify 形态（§四）、fal.ai 供应商族 / 遮罩编辑器 / 透明背景 canvas 后处理（§七）。

---

## 十四、playwright-mcp 与 nut.js —— 浏览器 / 电脑控制

设计文档 `docs/14-browser-computer-control.md`；术语见根 `CONTEXT.md` §「浏览器与电脑控制」。

| 参照的能力 | 本项目落点 | 备注 |
|---|---|---|
| playwright-mcp 官方 server 整体 | `backend/src/browserctl/service.ts` 扇出编排 | **不 fork 不自研工具面**：启用即把 `npx @playwright/mcp@latest` 写进各执行器原生配置（复用 ADR 0004 的 mcpadmin 通道） |
| 持久 profile 按工作区哈希共享 → 并发冲突 | 隔离模式显式 `--user-data-dir`（每执行器一目录） | 官方 README 实证的限制；本项目多 bot 共用 rootPath 是常态，必须绕开默认值 |
| `--cdp-endpoint` 接管已有浏览器 | 接管模式 + daemon 拉起共享 Chrome（`browserctl/chrome.ts`） | 独立 user-data-dir + 调试端口 9333 起（Chrome 136+ 拒绝默认目录开调试口）；启动前 `/json/version` 健康检查收编存量 |
| `--browser msedge/chrome` 系统通道零下载 | 隔离模式默认 msedge | Windows 每机必有 Edge |
| nut.js 键鼠 / 截图 / 窗口（@nut-tree-fork/nut-js，官方包已下架 npm） | `backend/src/computerctl/runtime.ts` | 懒加载；DPI 换算（逻辑/返回图宽）、BGRA→PNG（node:zlib 自写编码器，包不带 imageToJpg）、中文剪贴板绕 IME —— 三坑的解法全部对照 win-computer-use-mcp |
| Anthropic computer use 动作集（screenshot/click/type/key/scroll…） | `computer_*` 12 工具（`computerctl/server.ts`） | 坐标相对当次返回图的范式；动作名对齐让任何视觉模型开箱会用 |
| ZCode 的 CONTROLLER_BUSY / 急停 / 主 agent 独占 | 输入租约 + `computer_stop` + 总闸 + panic RPC | **实现未抄**（ZCode 原生层闭源），只借产品语义 |

**服务端参照入口**：playwright-mcp `src/`（工具面与 profile 逻辑）；win-computer-use-mcp `mcp/computer-use-mcp/`（Windows 坑对照）；anthropic-quickstarts `computer-use-demo/`（动作 schema）。

**未移植**（二期）：Chrome 扩展接管模式（`--extension`）、MCP server 层高危确认门、UIA 结构化快照（ZCode 式 state_id/elements）、截图流面板。

---

## 十五、termux-app —— 移动端终端虚拟按键栏

设计落点：`prototype/src/ui/mobile/MobileVirtualKeyBar.tsx`；许可证声明见 `README.md` 与 `THIRD-PARTY-NOTICES.md`。

| Termux 的概念 / 布局 | 本项目落点 | 备注 |
|---|---|---|
| `extra-keys` 两行七列网格（`DEFAULT_IVALUE_EXTRA_KEYS`） | `MobileVirtualKeyBar.tsx` 主网格 | Row 1: `ESC / - HOME ↑ END PGUP`；Row 2: `TAB CTRL ALT ← ↓ → PGDN`。彻底消除单行横向滚动的低效，所有高频终端操作键一屏直达 |
| 倒 T 方向键与导航集群（`HOME ↑ END PGUP` / `← ↓ → PGDN`） | 4 列导航区 | 上下垂直对齐、左右居中围绕、行首/行尾与翻页成列，极大提升移动端光标与命令历史翻查效率 |
| 修饰键（`CTRL` / `ALT`）粘滞与锁定机制 | `ModifierState`（off → active → locked） | 单击一次生效后自动复位，双击锁定常驻；配合唤出 `Ctrl+C/D/Z/L/A/E` 快捷指令条，解决手机软键盘无 Ctrl 的痛点 |
| 副键上滑手势（`{key: '-', popup: '|'}`） | `isSwipedUp` 触控手势 | 键位上滑触发副键（`-` 上滑为 `|`，`/` 上滑为 `\`，`ESC` 上滑为 `CLR` 清屏，`CTRL` 上滑为 `^C` 中断等） |
| 长按自动连发（`PRIMARY_REPETITIVE_KEYS`） | `isRepetitive` 定时器 | 方向键与翻页键长按 320ms 后以 70ms 间隔平滑连击，无需反复狂点屏幕 |

> **开源许可证边界严正说明：**
> Termux（`termux-app`）基于 GPL-3.0 协议开源，本项目基于 MIT 协议开源。
> 本项目**未复制或包含任何 Termux 的 Java / Android 源代码或二进制资产**，仅参考其按键排布的网格形式与交互逻辑，在 React 19 + TypeScript 环境下独立全新开发。
