---
name: agent-workbench
description: 操作 agent-workbench 工作台本身——用 aw CLI 驱动会话、待办、git、通知、出图等全部操作面。当用户提到「工作台」「别的 bot」「待办」「通知」，或需要跨 bot 协作、查工作台状态时使用。
---

<!-- agent-workbench-skill: v1（daemon 维护，升级会覆盖；自定义请复制改名） -->

# agent-workbench —— 驾驶你所在的工作台

你正运行在 agent-workbench 的一台 bot 工作区里（本文件夹）。这台工作台本身
**可以被你操作**：GUI 能做的每件事，你都能用一条命令完成——包括指挥别的 bot。

## 入口（按优先级）

1. `aw`（在 PATH 则直接用；`aw --help` 看全部命令）
2. curl 兜底（零安装，任何执行器可用）：

```bash
TOKEN=$(cat ~/.agent-workbench/token)
curl -s -X POST http://127.0.0.1:5281/rpc -H "x-awb-token: $TOKEN" \
  -H "content-type: application/json" -d '{"v":1,"method":"health"}'
```

## 第一条命令：发现，不背诵

```bash
aw methods                 # 160+ 方法的自描述（说明 / 参数形状 / 危险标记），daemon 注册表实时生成
aw methods --domain git    # 按域过滤
```

任何操作先查 `aw methods`——它永远比任何文档（包括本技能）新。

## 高频动作

```bash
aw doctor                                              # 工作台健康自检
aw session chat --bot <id> --text "…" --attach 文件路径  # 指挥另一个 bot 干活（等它回话）
aw call notifications.list --json                      # 你不在时发生了什么（跨端通知事实源）
aw backlog add --goal "…" --unit <id> --root <路径>     # 登记一条待办
aw git status --root <路径>                             # 仓库状态
aw call memory.search --params '{"query":"…"}'         # 检索这台工作台的记忆
aw call image.generate --params '{"profileId":"…","prompt":"…"}'  # 出图（结果落盘回路径）
aw events --session <sid> --follow                      # 实时跟随某个会话的事件流
```

## 纪律

- **stdout 只有数据**，诊断走 stderr；`--json` 拿机器口径；
  退出码 0 成功 / 2 用法错 / 3 RPC 错 / 4 传输错（daemon 不在或 401）。
- 危险面（daemon.stop、git.push、bot.put…）非交互不拦，`--yes` 跳过 TTY 确认。
- token 与 GUI 等权（`~/.agent-workbench/token`，`AGENT_WORKBENCH_HOME` 可改家）——
  它就是钥匙，别写进日志、别外传。
- 本 SKILL.md 由 daemon 维护（见顶部版本标记行），升级会覆盖；想定制请复制一份改名。

## 什么时候用我

- 用户说「让 XX bot 做…」「看看通知 / 待办」「这台工作台…」
- 你需要跨 bot 协作、查工作台状态、或对其他工作区做 git / 记忆操作
- 你想给用户登记待办、查刚才发生了什么、或发起一次出图
