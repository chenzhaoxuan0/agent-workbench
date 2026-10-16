# 14 · 浏览器控制与电脑控制（多执行器统一供能）

> 领域术语见根 `CONTEXT.md` §「浏览器与电脑控制」。本文是设计与实现契约，
> 对应分支 `feat/browser-computer-control`。

## 0. 目标与非目标

**目标**：让工作台接入的全部执行器（13 家 CLI）统一获得两种能力——

- **浏览器控制**：执行器内的模型能操作浏览器（导航 / 快照 / 点击 / 输入 / 截图）。
- **电脑控制**：执行器内的模型能操作真实桌面（截图 / 键鼠 / 窗口），默认停用。

**非目标**（用户拍板，2026-10）：

- **不内置浏览器**：不做 Electron webview / daemon 托管页面，不自研浏览器工具面。
- 不做 MCP server 层确认门（二期）；不做 Chrome 扩展接管模式（二期）；
  不做 UIA 结构化快照（二期）。

## 1. 决策记录（grill 两轮共 12 项）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 工具层架构 | 浏览器 = **官方 playwright-mcp**（不自研）；电脑 = **自研**（无现成可用的官方件） |
| Q2 | 浏览器后端 | 不内置浏览器；**隔离模式（默认）+ CDP 接管共享 Chrome**，扩展模式二期 |
| Q3 | 电脑控制栈 | `@nut-tree-fork/nut-js`（nut.js 官方包已下架 npm，社区续命版，MIT，win-computer-use-mcp 同款），Windows 先行 |
| Q4 | 工具协议 | 细粒度多工具（browser_* 由 playwright-mcp 自带；computer_* 自定义 12 个），不学 ZCode 单 js 工具 |
| Q5 | 会话共享 | 隔离（默认）/ 接管（CDP 共享登录态）双模式可配 |
| Q6 | 扇出 | 全部 13 家一键扇出；**两个能力都默认停用**，显式启用才写入；dsh 走 ACP session/new 参数注入；sdk-bridge 不支持 |
| Q7 | 安全 | 首期：电脑控制总闸 + 急停工具 + 输入租约；各 CLI 自带 MCP 审批不重复造；确认门二期 |
| Q8 | 面板 | 首期：设置页两区（管理面）+ 动作日志（文本流，轮询）；截图流二期 |
| Q9 | 电脑 server 形态 | **daemon 常驻单实例**，HTTP 传输（Streamable HTTP，挂在 daemon HTTP 面上），物理屏幕独占 → daemon 内串行 |
| Q10 | 浏览器默认模式 | 默认隔离；首期实现隔离 + CDP 接管（共享 Chrome 由 daemon 拉起 / 回收） |
| Q11 | 电脑工具面 | 12 工具（见 §4.2） |
| Q12 | 命名 | MCP 条目名 `playwright` / `workbench-computer`；设置页「浏览器控制」「电脑控制」两区；后端 `backend/src/browserctl/` + `backend/src/computerctl/`；SKILL.md **本期就发**（用户指定） |

## 2. 浏览器控制

### 2.1 模式

| 模式 | playwright-mcp 参数 | 语义 |
|---|---|---|
| **隔离**（默认） | `--browser <msedge\|chrome> --user-data-dir <homeDir>/browser-profiles/<executorId>` | 每执行器独立持久 profile。登录态按执行器保留；同执行器两个会话**并发**会抢同一个 profile（playwright-mcp 官方限制），文档写明，规避方式：并发场景切接管模式 |
| **接管** | `--cdp-endpoint http://127.0.0.1:<port>` | 全部执行器连同一个由 daemon 拉起的 Chrome（独立 `--user-data-dir=<homeDir>/browser-shared-profile` + 随机调试端口），共享登录态与标签页 |

事实依据（playwright-mcp README 实证）：

- 默认持久 profile 按「客户端工作区哈希」存放，并发客户端共享同一工作区会冲突
  ——本项目的常态正是多 bot 共用 rootPath，**不能用默认值**，必须显式 user-data-dir。
- `--browser msedge/chrome` 直接用系统浏览器，零下载；Windows 每机必有 Edge。
- Chrome 136+ 对默认 user-data-dir 忽略 `--remote-debugging-port`，接管实例必须独立
  profile —— daemon 拉起的共享 Chrome 正是这么做的。

### 2.2 扇出链路

复用 mcpadmin（ADR 0004），**不新增配置抽象**：

```
设置页开关 → RPC browserControl.setEnabled
  → 逐执行器构造条目（隔离模式条目因 user-data-dir 不同而逐家定制）
  → mcpSave(deps, executorId, entry)          // 12 家落盘配置
  → dsh：不落盘，session/new 时动态注入（见 §2.4）
  → sdk-bridge：跳过（协议带内，能力位不宣称）
停用 → mcpRemove(deps, executorId, "playwright", {toVault:true})  // 进停用库，可恢复
```

条目形态（规范化 `McpServerEntry`，写入侧 `wrapCmd` 自动补 Windows `cmd /c`）：

- 隔离：`{name:"playwright", transport:"stdio", command:"npx", args:["@playwright/mcp@latest","--browser",<b>,"--user-data-dir",<dir>]}`
- 接管：`{name:"playwright", transport:"stdio", command:"npx", args:["@playwright/mcp@latest","--cdp-endpoint",<url>]}`

### 2.3 共享 Chrome（接管模式）

- 发现顺序：Chrome 常见安装路径（Program Files / Program Files (x86) / LocalAppData）
  → Edge 同款兜底（Chromium 系均可，提示用户实际拉起的是哪家）。
- 启动参数：`--remote-debugging-port=<空闲端口> --user-data-dir=<homeDir>/browser-shared-profile
  --no-first-run --no-default-browser-check`；子进程由 daemon 持有，daemon 退出即终止。
- daemon 启动时若「接管模式 + 已启用」自动拉起；端口变化在启用/切换模式时重写条目。
- 生命周期动作（启动 / 停止 / 状态）记入动作日志；启动/停止失败原因经
  `SharedChromeStatus.lastError` 透出到设置页。**生命周期单飞**：boot 自动拉起
  与 UI 手动启停经同一条互斥链（并发启动会触发 Chrome 单实例委派，留下杀不掉
  的活实例）。停止走 taskkill /T /F 并**验尸**（调试端口真熄灭才算停）。收编
  存量实例前校验 `/json/version` 自报 Chromium 系，防止误收用户日常浏览器。

### 2.4 dsh 注入（无落盘配置的特例）

`dsh.ts` 的 `session/new` / `session/resume` 参数 `mcpServers` 由 `ctrl/store.ts`
提供的 `acpMcpServers()` 动态给出（两个能力的条目按 ACP 形状转换：stdio →
`{name, command, args}`，http → `{name, type:"http", url}`）。注入失败（dsh 拒收
某形态）时降级为空数组并 log warn，不阻断会话。

### 2.5 动作日志的诚实边界

playwright-mcp 是**执行器的子进程**，浏览器工具调用不经过 daemon，工作台看不到
每次 click/type。首期动作日志只记**工作台侧事件**：启用 / 停用 / 模式切换 / 条目
写入结果 / 共享 Chrome 启停。执行器内的操作流水属二期（需自研 server 才可见）。

## 3. 电脑控制

### 3.1 形态

daemon 常驻**单实例** MCP server，Streamable HTTP，挂在 daemon HTTP 面：
`POST /mcp/computer`（RawHttpRoute，裸路由，token 豁免——daemon 只绑回环，与
stdio MCP 桥 `src/mcp.ts` 同级信任）。各执行器条目：
`{name:"workbench-computer", transport:"http", url:"http://127.0.0.1:5281/mcp/computer"}`。

物理屏幕是独占资源：所有工具调用在 daemon 内经**输入租约**串行（见 §3.3）。

### 3.2 工具面（12 个，动作集对齐 Anthropic computer use 范式）

| 工具 | 说明 |
|---|---|
| `computer_screenshot` | 全屏截图（JPEG base64）+ 图像尺寸；**坐标一律相对当次返回的图像** |
| `computer_screen_size` | 当前坐标系宽高（与截图同源，DPI 换算后的物理像素口径） |
| `computer_click` / `computer_double_click` / `computer_right_click` | 坐标点击 |
| `computer_drag` | 从 (x1,y1) 拖到 (x2,y2) |
| `computer_scroll` | 坐标处滚动 `amount`（正=向下） |
| `computer_type` | 输入文本；含非 ASCII 时走剪贴板 + Ctrl+V 绕 IME（win-computer-use-mcp 的成熟做法） |
| `computer_key` | 组合键，`"+"` 连接（如 `ctrl+shift+t`），键名小写 |
| `computer_window_list` | 可见窗口清单（句柄 / 标题 / 位置尺寸） |
| `computer_window_activate` | 按句柄或标题激活窗口 |
| `computer_stop` | 急停：释放租约、中止当前动作（kill switch，ZCode 同款语义） |

### 3.3 安全模型

- **总闸**：`<homeDir>/computer-control.json` 的 `enabled:false`（默认）→ server
  对一切 tools/call 回「电脑控制未启用」。设置页开关 + RPC `computerControl.panic`
  可即时关闸。
- **端点双闸**（复审 P0 补强）：`/mcp/computer` 除回环豁免 token 外，工具层还
  强制 ①`Origin` 若存在必须是本地源（403）——否则任意网页的跨源 simple request
  （text/plain POST，无需预检）都能借端点操作真实桌面；②`content-type` 必须
  `application/json`（415）——浏览器想伪造它就必须过 CORS 预检，而预检只放行
  本地源。两层与 authorize 的回环判定构成纵深防御。
- **输入租约**：单一 controller（按 MCP 会话头 `mcp-session-id` 识别，无头则按
  匿名全局）。他者持有时返回 `CONTROLLER_BUSY`（借 ZCode 错误码语义：不可重试，
  需当前持有方退出或急停）。租约空闲 TTL 120s 自动释放；**执行失败（参数错 /
  运行时坏 / 被作废）当场弃权**，不占满 TTL。
- **急停取消语义**（复审 P0 补强）：`computer_stop` / `panic` 递增**输入代际**，
  已在队列中等待的动作按旧代际拒绝执行——急停拦下的是整批待执行动作。
  正在执行中的那一个原生调用无法中断，这是已记录的硬边界（回执文案如实说明）。
- **动作日志**：每次 tools/call 记（会话、工具、参数摘要、成败、耗时），环形
  缓冲 500 条，RPC 可查——观测与追责，不是审批。
- 高危确认门（删除 / 发送 / 支付类挂起等人放行）：二期。

**已知边界**（复审记录）：mcp-session-id 由客户端自报、不做登记校验（信任模型
= 回环本机进程，与 stdio MCP 桥同级）；未发会话头的客户端合并为同一「anonymous」
租约身份；正在执行的原生输入不可中断；同执行器两个会话并发会抢隔离模式的同一
profile（playwright-mcp 官方限制，docs/14 §2.1）；daemon 重启后端口变化由 boot
对齐兜底（电脑条目重写、共享 Chrome 端口持久化）。

### 3.4 运行时（@nut-tree-fork/nut-js）

官方 `@nut-tree/nut-js` 已从 npm 下架（2026-10 实证 404），采用社区续命版
`@nut-tree-fork/nut-js@^4.2.6`（MIT，win-computer-use-mcp 同款）。**懒加载**：
仅首次启用 / 首次工具调用时动态 import，daemon 常规启动不载原生模块；导入失败
降级为工具报「runtime unavailable」，不掀翻 daemon。桌面操作收敛在
`DesktopRuntime` 接口后（生产 nut 实现 / 冒烟 fake 实现），便于无副作用的回归测试。

已知边界：DPI 缩放坐标系（截图物理像素 vs 鼠标逻辑像素）在 win-computer-use-mcp
中需要专门换算；首版以「nut.js 自身 screen.width/height 与截图同口径」为不变量，
多显示器混合 DPI 场景留待实测修。

## 4. 契约与 RPC 面

契约类型唯一事实源在 `prototype/src/core/control.ts`（backend/src/contract.ts
re-export，docs/06 契约纪律）。

| RPC | 说明 |
|---|---|
| `browserControl.get` | 配置 + 共享 Chrome 状态 + 扇出结果 + 动作日志尾 |
| `browserControl.setEnabled {enabled}` | 启用=逐家 mcpSave + dsh 生效；停用=逐家 mcpRemove 进停用库 |
| `browserControl.setMode {mode}` | 切隔离 / 接管；接管时自动重写条目 + 按需拉起共享 Chrome |
| `browserControl.setBrowser {browser}` | 隔离模式的浏览器通道（msedge/chrome） |
| `browserControl.sharedChrome.{start,stop}` | 共享 Chrome 生命周期 |
| `computerControl.get` | 配置 + 租约持有方 + 动作日志尾 |
| `computerControl.setEnabled {enabled}` | 总闸 |
| `computerControl.panic` | 急停：释放租约 + 总闸关 |
| `computerControl.actions` | 动作日志分页 |

配置落盘：`<homeDir>/browser-control.json` / `<homeDir>/computer-control.json`。

## 5. 技能分发

启用对应能力时，把内置技能装进公共技能源 `~/.agents/skills/`（仅当不存在时
写入，绝不覆盖用户已改过的副本）；停用不删（技能无工具时是惰性文本）：

- `browser-control/SKILL.md`：playwright-mcp 工具用法——snapshot 优先（ref 寻址，
  省 token）、截图仅视觉需要时、标签页管理、失败重试模式。
- `computer-control/SKILL.md`：workbench-computer 工具用法——先截图再操作、
  坐标相对最近截图、中文输入由工具内处理、CONTROLLER_BUSY 语义、急停。

## 6. 参照来源（同步进 README 参照表）

| 仓库 | 许可证 | 参照内容 |
|---|---|---|
| microsoft/playwright-mcp | Apache-2.0 | 浏览器控制本体（官方 server 直接扇出）；持久 profile 并发限制与 --user-data-dir 对策、--cdp-endpoint 接管、--browser 系统通道 |
| @nut-tree-fork/nut-js（nut.js fork） | MIT | 电脑控制运行时：键鼠 / 截图 / 窗口 |
| win-computer-use-mcp（qq306863030/deepfish-extensions） | MIT | Windows 全部坑的对照实现：DPI 换算、中文剪贴板绕 IME、BGRA 通道 |
| anthropics/anthropic-quickstarts（computer-use-demo） | MIT | computer_* 动作集与坐标范式（截图→坐标动作） |
| ZCode | Apache-2.0 | CONTROLLER_BUSY 租约语义、急停工具、动作日志/观测面板的产品形态（实现未抄——其原生层闭源） |
