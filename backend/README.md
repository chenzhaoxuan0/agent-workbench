# backend —— Runtime Host 守护进程

把前端 `prototype/` 里「UI 与数据形态完整、执行是模拟」的插槽换成真实执行：
真实 agent 会话、真实终端、真实落盘、真实调度。**Phase 0–7 全部落地**（docs/06 全部验收）。

- 开工指路与 Phase 划分：`docs/06-backend-kickoff.md`（自包含，从它出发直接动工）
- 线上协议（WS 帧 / REST / 全方法表）：`docs/07-wire-protocol.md`
- 契约唯一事实源：`prototype/src/core/adapter.ts` + `events.ts`（本包以 type-only
  方式引用，编译期强制两端一致，运行时零依赖）

## Phase 地图（全部有冒烟，`pnpm smoke:*` 可随时复跑）

| Phase | 内容 | 冒烟 |
|---|---|---|
| 0 | daemon 骨架：/healthz + WS 帧协议 v1 + 优雅退出 | `pnpm smoke` |
| 1 | Runtime host 最小闭环：zcode 真实对话（流式事件 + usage + 轨迹落盘） | `pnpm smoke:phase1` |
| 1b | codex 第二家执行器（契约泛化性：JSONL 协议零 core 改动接入） | `pnpm smoke:phase1b` |
| 2 | 真实终端：node-pty ConPTY 双向帧，多窗格独立会话 + resize | `pnpm smoke:phase2` |
| 3 | 落盘层：state.db（node:sqlite）+ usage.jsonl + resumeSession 跨重启续命 | `pnpm smoke:phase3` |
| 4 | 权限闸：规则表 + REST 决策 + always 落库自动放行（mockperm 试金） | `pnpm smoke:phase4` |
| 5 | 自动化调度：daemon 内 cron 到点起会话 + 运行记录落盘 | `pnpm smoke:phase5` |
| 6 | Ops 真执行：确定性 eval 0/1 + GEval judge（真 LLM）+ gate/Arena 账本 | `pnpm smoke:phase6` |
| 7 | 记忆编排：三柱 + 路由 + WeKnora 代理 + MEMORY.md 镜像 | `pnpm smoke:phase7` |

## 命令

```bash
pnpm install        # 安装依赖（allowBuilds 已批 esbuild / node-pty）
pnpm dev            # 开发常驻（tsx watch）
pnpm typecheck      # tsc --noEmit
pnpm smoke          # Phase 0 验收
pnpm smoke:phase1   # …逐 Phase 到 smoke:phase7（回归基准线，改动后全跑一遍）
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_WORKBENCH_HOST` | `127.0.0.1` | 监听地址（只认回环，daemon 能 spawn 进程） |
| `AGENT_WORKBENCH_PORT` | `5181` | HTTP + WS 端口（前端 dev server 是 5180） |
| `AGENT_WORKBENCH_HOME` | `~/.agent-workbench` | daemon 集中存储家（state.db / traces / usage / token 落这里）；bot 身份文件不在其中，跟各自工作目录走。旧 backend/.waku 首启自动平迁 |
| `AGENT_WORKBENCH_LOG_LEVEL` | `info` | debug / info / warn / error |

## 渠道：每 bot 一个飞书机器人

渠道由 `bot.json` 的 `channels` 声明，daemon 每 15s reconcile 一次——改完保存，
不重启就生效。

### 驱动方式：lark-cli，不是 SDK

本机装了 `lark-cli`（22 个域：im / docs / drive / base / wiki / sheets / slides /
task / vc / minutes …），它的 `event consume` 已经把飞书长连接、事件解密、
消息内容预渲染全做了：

```bash
lark-cli --profile <profile> event consume im.message.receive_v1 --as bot
# stdout 是 NDJSON；[event]/[source] 进度日志走 stderr
```

**`--profile` 是按调用指定的全局 flag**，于是「每 bot 一个飞书机器人」=
每 bot 一个 profile = 一个飞书应用 = 一条独立长连接。

daemon 侧只做三件本来就是它该做的事：

1. **谁响应** —— 事件从哪个 profile 来就归哪个 bot（连接一对一绑定，不需要 @ 路由表）
2. **会话生命周期** —— 起轮 / 续聊 / 同会话串行（faceless 渠道固定 yolo）
3. **权限如实告知** —— headless 无审批面，UI 在绑定时刻就摆出来

发消息、markdown、附件、文档、云盘、多维表**不在本仓库实现**——那是 CLI 的
能力，由 agent 在轮次里自己调。两个地方各有一套飞书实现，三个月后你不知道该信谁。

### 配置

```jsonc
// <rootPath>/.agent-workbench/bot.json
{
  "id": "bot-researcher",
  "channels": [
    {
      "kind": "feishu",
      "enabled": true,
      "accounts": [
        { "id": "main", "profile": "cli_a94d3ea8b5f99cc0", "mentionOnly": true }
      ]
    }
  ]
}
```

- **只填 profile 名，不填 appId/appSecret。** 凭据由 profile 自己管，密钥根本
  不进 agent-workbench 的文件。`lark-cli profile list` 查已有 profile。
- 要多个机器人就在飞书开放平台各建一个应用、各自 `lark-cli profile add`，
  然后给同一个 bot 挂多个账号。
- `mentionOnly` 默认 true：群聊里只在被 @ 时应答，否则 bot 会接话接成旁白机。
- 飞书侧要开：机器人能力 + 事件订阅 `im.message.receive_v1`（CLI 走长连接，
  不需要公网 URL）。这几项 CLI 查不到，`lark-cli doctor` 只能验到凭据那一层。

### 诊断与出站

- `channel.diagnose { botId, accountId }` —— 逐项说清断在哪：lark-cli 在不在、
  profile 能不能用、bot 身份 ready 没有、事件订阅要你去哪确认。查不到的明说
  查不到，不编一条看起来有用的检查项。
- `channel.send { botId, accountId, receiveId, text }` —— **主动出站**。
  没有它 bot 只能被动回话，日程、告警、自动化结果全都不成立。

### 验

`pnpm smoke:feishu`（不需要真 profile，验解析与 reconcile）；真连通要有真
profile + 开放平台开好事件订阅。

### Windows 注意事项

`lark-cli` 是 npm shim，`spawn("lark-cli")` 直接 ENOENT。走
`runtime/exec` 的 `resolveCommand`（它把 shim 解析成 `node + 脚本`），
**不要**用 `shell: true`——那会把 prompt 里的引号送进 cmd 转义地狱。
## 执行器现状（诚实清单）

- **zcode**：**首选 `zcode app-server`（ZCode Protocol v1）全能力**——真流式 delta、
  工具事件、权限反向流（接 Phase 4 闸）、真 usage、同会话多轮、跨进程 resume。
  前提：本机 zcode CLI 带 fork 补丁（分支 `awb/standalone-app-server`，见
  `docs/07` §四）。未打补丁的安装自动降级到 `zcode -p --json` 回退路径
  （真实回复/usage/`--resume` 多轮；无流式/工具/权限事件）。
- **codex**：`codex exec --json` JSONL 事件流。有工具事件（command_execution/
  file_change）、usage、resume 多轮；审批恒为 never（exec 模式）。
- **mockperm**：权限闸与审批流的试金石（每轮必发 permission.requested 并挂起）。

## 硬结论（踩过的坑，别再踩）

- Windows 跨进程 SIGTERM 不可投递 → 程序化退出只走 `daemon.stop` 协议方法。
- npm .cmd shim 必须 parse 出真 node 脚本路径 spawn（cmd /c 兜底会被
  含双引号的 prompt 打碎——judge 冒烟实证）；`src/runtime/exec.ts`。
  **且 bootstrap 这类 workspace 依赖是 tsc 产物**：改它们的 src 必须先重建该包
  再打 cli bundle，否则改动静默丢失（app-server 补丁一度"看似无效"即是此因）。
- 一次性 CLI spawn 后立即 end stdin（codex 会停在 stdin 读取）；**长驻协议进程
  （zcode app-server）相反，stdin 就是协议通道，关了 = 优雅退出**。
- 权限挂起要先注册 pending 再广播 requested（闸的自动放行是同步的）。
- zcode 冷恢复（session/resume）必须带 workspace，缺了报 "Session is not active"；
  reattach 的引导是异步的，send 必须等 ready 门。
