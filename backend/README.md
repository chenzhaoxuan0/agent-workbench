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
| `AGENT_WORKBENCH_HOME` | `<backend>/.waku` | daemon 工作目录（state.db / traces / jsonl 落这里） |
| `AGENT_WORKBENCH_LOG_LEVEL` | `info` | debug / info / warn / error |

## 执行器现状（诚实清单）

- **zcode**：`zcode -p --json` 单轮 + `--resume` 多轮。真实回复/usage/会话 id；
  无流式 delta（整段单块）、无工具事件、无权限反向流 —— `-p` 路径的能力边界，
  详见 `src/runtime/adapters/zcode.ts` 头注释（app-server 升级路径已探明并留档）。
- **codex**：`codex exec --json` JSONL 事件流。有工具事件（command_execution/
  file_change）、usage、resume 多轮；审批恒为 never（exec 模式）。
- **mockperm**：权限闸与审批流的试金石（每轮必发 permission.requested 并挂起）。

## 硬结论（踩过的坑，别再踩）

- Windows 跨进程 SIGTERM 不可投递 → 程序化退出只走 `daemon.stop` 协议方法。
- npm .cmd shim 必须 parse 出真 node 脚本路径 spawn（cmd /c 兜底会被
  含双引号的 prompt 打碎——judge 冒烟实证）；`src/runtime/exec.ts`。
- 一次性 CLI spawn 后立即 end stdin（codex 会停在 stdin 读取）。
- 权限挂起要先注册 pending 再广播 requested（闸的自动放行是同步的）。
