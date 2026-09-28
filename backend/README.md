# backend —— Runtime Host 守护进程

把前端 `prototype/` 里「UI 与数据形态完整、执行是模拟」的插槽换成真实执行：
真实 agent 会话、真实终端、真实落盘、真实调度。

- 开工指路与 Phase 划分：`docs/06-backend-kickoff.md`（自包含，从它出发直接动工）
- 线上协议（WS 帧 / REST）：`docs/07-wire-protocol.md`
- 契约唯一事实源：`prototype/src/core/adapter.ts` + `events.ts`（本包以 type-only
  方式引用，编译期强制两端一致，运行时零依赖）

## 命令

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发常驻（tsx watch）
pnpm typecheck      # tsc --noEmit
pnpm smoke          # Phase 0 验收：自起 daemon → /healthz → WS 握手 → 帧回环 → 优雅退出
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_WORKBENCH_HOST` | `127.0.0.1` | 监听地址（只认回环，daemon 能 spawn 进程） |
| `AGENT_WORKBENCH_PORT` | `5181` | HTTP + WS 端口（前端 dev server 是 5180） |
| `AGENT_WORKBENCH_HOME` | `<backend>/.waku` | daemon 工作目录（state.db / traces / jsonl 落这里） |
| `AGENT_WORKBENCH_LOG_LEVEL` | `info` | debug / info / warn / error |
