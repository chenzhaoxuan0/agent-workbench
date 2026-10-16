# Agent Workbench

本地个人统一工作台 —— 一个界面，多个工作区，多家开源 Agent CLI 平等切换。

![主界面](docs/images/main-window.png)

内置终端直接驱动各家 CLI（TUI 交互或 headless 驱动均可），每个 bot 绑定自己的
默认执行器与模型；支持飞书/Telegram 渠道接入、定时自动化、待办（GTD：空闲心跳
提议 + 确认门 + 验收闭环）、记忆系统、出图工作台，以及多执行器统一的
浏览器控制（playwright-mcp 扇出）与电脑控制（总闸 + 急停）。
以 [MIT](LICENSE) 协议开源。

---

## 快速开始

**根目录一条命令起全栈**（前端 5280 + daemon 5281）：

```bash
pnpm install    # 只需在根目录跑一次，装 concurrently
pnpm dev        # 同时起前后端，Ctrl+C 一起停
```

启动后打开 <http://127.0.0.1:5280/>（**用 `127.0.0.1`，不要用 `localhost`**——
Vite 在 Windows 上默认只绑 IPv4）。日志带 `[web]` / `[daemon]` 前缀区分。

其他命令：

```bash
pnpm dev:web      # 只起前端
pnpm dev:daemon   # 只起 daemon
pnpm build        # tsc -b && vite build
pnpm typecheck    # 前后端一起查
pnpm smoke        # daemon 冒烟
```

**daemon 必须起着，否则应用是空的**：侧栏单元来自各 bot 工作目录下的
`.agent-workbench/bot.json`，没建过 bot 就没有 bot.json，侧栏是空的——
这是正常首启状态，不是故障。

---

## 接入的 Agent CLI

`zcode` · Claude Code · OpenAI Codex CLI · `pi` · MiniMax Code（`mcode`）·
DeepSeek Harness（`dsh`）· OpenCode · Hermes · Kimi Code（`kimi`）· Antigravity（`agy`）

三种接入形态：一次性进程（每轮 spawn CLI 翻 JSONL）、ACP 常驻 stdio 子进程
（带真权限审批流）、常驻 HTTP server + SSE（真 patch diff）。详见 `docs/03` §3.3.1。

---

## 技术栈

```
Vite 7 + React 19 + TypeScript 5.9 + Tailwind CSS v4 + Zustand 5 + Electron
                                ↓
        自研 RuntimeAdapter SPI（纯 TS，零框架依赖）+ 本地 daemon（WS + HTTP）
```

**不 fork 任何参考仓库**：渲染层全新编写，参考仓库只当设计与运行时参照。
完整论证见 [`docs/01-tech-stack.md`](docs/01-tech-stack.md)。

---

## 目录结构

```
agent-workbench/
├── docs/                    设计文档与参照地图
├── electron/                Electron 壳（主进程 / preload / 应用图标）
├── backend/                 daemon（5281：WS + HTTP）
│   └── src/
│       ├── runtime/         执行器适配器（zcode / codex / claude / agy / mcode …）
│       ├── terminal/        终端 PTY 会话（node-pty，多窗格）
│       ├── bots/            bot.json 注册表与目录扫描
│       ├── channels/        飞书 / Telegram / webhook / MCP 接入
│       ├── memory/          记忆三柱、守护、每日精炼
│       ├── automation/      定时任务调度
│       ├── backlog/         待办（GTD）：总状态/心跳/余量探针/收件箱统合
│       ├── skills/          技能清单与停用开关（技能源内 .disabled/ 搬运）
│       ├── mcpadmin/        MCP 管理：五家原生配置的外科手术式读写（ADR 0004）
│       └── appearance/      外观文件存取（appearance.json + 壁纸）
└── prototype/               前端（5280：Vite + React 19）
    ├── public/icons/        应用与执行器品牌图标
    └── src/
        ├── core/            领域层 + RuntimeAdapter SPI（零厂商依赖）
        ├── adapters/        daemon 传输适配器
        ├── store/           zustand 状态
        └── ui/              组件
```

---

## 视觉

**中性灰阶 + 单一青色强调 + 完全扁平**，支持亮暗双主题与全屏壁纸
（画布只刷一层半透明底色，壁纸从最底层透出，终端透明度独立可调）。

设计令牌集中在 `src/styles.css` 的 `@theme`——**改配色只改那一个块**。
允许存在的彩色只有三类，且都是数据不是装饰：执行器品牌色、bot 身份色、
任务分组色。判据是「换掉它用户就认不出那是谁」。

---

## 交互

| 快捷键 | 功能 |
|---|---|
| `⌘K` | 命令面板 |
| `⌘F` | 搜索 |
| `⌘B` | 收起 / 展开侧栏 |
| `⌘,` | 打开设置 |
| `Esc` | 关闭弹层 |
| `Ctrl + =` / `Ctrl + -` / `Ctrl + 0` | 内容放大 / 缩小 / 复位（Electron） |

终端跟随 bot：切换 bot 时自动激活它的专属终端标签（进程保持存活），
首次进入则以该 bot 绑定的默认执行器 + 工作目录新建 TUI。

---

## 密钥放在哪

原则：**密钥只存 daemon 侧文件，浏览器永不持有**（出图请求也由 daemon 代理转发，
顺带免了 CORS）。文件就是普通 JSON/文本，agent 可以直接 Read/Write 改。

想**集中管理**：把密钥放进 `<homeDir>/.env`（`KEY=VALUE` 逐行，`#` 注释），
配置里对应字段写引用 `"env:KEY"`。daemon 每次调用时实时读这个文件——
**改完立即生效，不用重启**；系统环境变量里有同名项时以系统为准（CI/无头覆盖用）。
`.env` 里的值**不会**被注入 daemon 进程环境（终端与 CLI 子进程继承不到它）。

| 凭证 | 位置 |
|---|---|
| 出图供应商 API Key | `<homeDir>/image-profiles.json`（设置页「出图」编辑，密钥不回显；或 `env:` 引用） |
| WeKnora（语义记忆检索） | `<homeDir>/state.db` kv（设置页「记忆」配置；或 `env:` 引用） |
| 飞书 appId/appSecret | 经 lark-cli 进**系统钥匙串**；bot.json 里的旧明文重绑一次即迁移 |
| Telegram botToken | 各 bot 的 `bot.json`（支持 env 引用） |
| Webhook secret | 各 bot 的 `bot.json` |
| Agent CLI 登录态 | 各 CLI 自己管（`codex login` / `claude login`…），本项目不经手 |
| daemon 访问 token | `<homeDir>/token`（自动生成，本地鉴权用） |

`<homeDir>` 默认 `~/.agent-workbench`，可用 `AGENT_WORKBENCH_HOME` 改。

---

## 参考与致谢

本项目**不 fork 任何参考仓库**，但架构、交互与视觉大量参照了开源社区的成果。
代码中以 `对齐 ××` / `借鉴 ××` / `移植自 ××` 注释标注出处（200 余处）；
「每个功能 → 参照来源 → 落点」的完整地图见
[`docs/05-reference-map.md`](docs/05-reference-map.md)，
起步时四家仓库的代码走查实证见 [`docs/02-reference-audit.md`](docs/02-reference-audit.md)。

### 架构与实现参照

| 仓库 | 许可证 | 参照内容与主要落点 |
|---|---|---|
| **ZCode**（`zocdeusually/ZCode`） | Apache-2.0 | 外壳骨架总蓝本：Shell 布局「收起即归零」、设置覆盖层、命令中心、自动化页两条口径、空态原则（功能不因空而消失）；MCP 配置同步的原子写与坏文件 fail-stop 规范、技能扫描策略（点目录跳过）→ MCP / 技能管理 |
| **t3code**（T3） | MIT | 供应商实例管理（ProviderInstancesPanel）、模型偏好系统（隐藏/排序/自定义模型）、harness 品牌图标、opencode 接入形态（serve + SSE） |
| **deepseek-harness**（dsh） | MIT | 轨迹账本与轮次头、会话内页签、StatsPills/ModelsSection；其 ACP 协议实现是 dsh/mcode/hermes/kimi 四家 acp 接入的参照 |
| **waku / waku-agent**（Sean Chen / ShenSeanChen） | MIT | 记忆三柱（语义事实/情节事件/程序性技能）与编排、管家（steward）机制 |
| **pi**（badlogic/pi-mono） | MIT | 供应商目录、models.json 配置形态 |
| **pi-hermes-memory**（Chandra Teja） | MIT | 记忆安全扫描器的威胁模式移植（prompt 注入 / 角色劫持拦截）→ `backend/src/memory/scanner.ts` |
| **Codex-Dream-Skin**（Codex Dream Skin Studio） | MIT | 外观系统契约：theme.json 十组色、safe-css 变量域、透明度方向与「只染背景不染文字」的钉死行为 |
| **gpt_image_playground**（CookSleep） | MIT | 出图工作台全链路移植（images/responses 双模式、SSE 解析、供应商映射） |
| **cc-switch** | MIT | MCP 多执行器管理的操作参照：单键外科手术式写入、首写字节备份、Codex TOML 字段分侧与 opencode local/remote 转换、Windows `cmd /c` 包装等写安全规范与交互（预设库 / 粘贴导入 / 落盘预览）→ MCP 管理 |
| **playwright-mcp**（Microsoft） | Apache-2.0 | 浏览器控制本体：启用即把官方 server 扇出进各执行器原生配置（不 fork 不自研工具面）；持久 profile 并发冲突的显式 `--user-data-dir` 对策、`--cdp-endpoint` 接管共享 Chrome、`--browser` 系统通道零下载 → `backend/src/browserctl/`（docs/14） |
| **@nut-tree-fork/nut-js**（nut.js 社区续命版，官方包已下架 npm） | MIT | 电脑控制运行时：键鼠 / 截图 / 窗口；DPI 换算、BGRA→PNG 编码、中文剪贴板绕 IME 的坑位解法对照 win-computer-use-mcp（qq306863030/deepfish-extensions，MIT） → `backend/src/computerctl/runtime.ts` |
| **anthropic-quickstarts**（Anthropic） | MIT | computer-use-demo 的动作集与「截图 → 坐标动作」范式 → `computer_*` 12 工具形状（任何视觉模型开箱会用） |
| **cherry-studio** | GPL | **只看思路未抄码**：dsh SDK 进程内嵌形态的对比参照，最终选了 ACP；借鉴「resume token 事件化」 |
| **VS Code** | MIT | 终端集成模式（terminalInstance / xtermTerminal 的会话持久化与分屏） |
| **OpenClaw**（OpenClaw Foundation） | MIT | 渠道插件抽象（ChannelPlugin）与渠道编排 |
| **GrokBot / Meta Muse** | 闭源 | 侧栏彩色 blob 头像、时间线思考折叠与工具卡片、行结构与相对时间 —— **仅视觉与交互参照，未复制任何代码或资产** |
| **WeKnora**（Tencent） | MIT（含第三方组件声明） | 记忆后端渠道之一（知识库 listKb / saveFact / search 客户端为自写实现） |
| **agents.md 规范**（OpenAI） | MIT | bot 岗位说明书（AGENTS.md）格式 |

第三方代码与资产（移植代码、品牌图标）的著作权与许可声明，
见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

### 接入的开源 Agent CLI

上表「接入的 Agent CLI」所列九家均为开源项目：
Claude Code、OpenAI Codex CLI、OpenCode、DeepSeek Harness、MiniMax Code、
Kimi Code、Hermes（Nous Research）、pi（badlogic/pi-mono）、ZCode。
名称与 logo 归各自所有者，本项目中的使用仅用于标识集成关系。
