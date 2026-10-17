# 提交图与 git 状态自动刷新（对齐 ZCode 收尾两件）

> 承接：ADR 0008（git 走 daemon CLI RPC）、0009（分支面收窄——当时点出 ZCode 分支面
> "外加 commit graph 与 base...HEAD 对比" 但只落了三个分支方法）、0010（三分入口）。
> 本轮补上 ZCode git 面里剩下两块**只读 / 低风险**的拼图。依据：ZCode 源码走查
> （`packages/ui/src/git-graph/*`、`hooks/useGitAutoRefresh.ts`、`lib/gitAutoRefresh.ts`、
> `services/src/git/repo/gitCliRepo.ts` 的 getCommitGraph / buildAutoRefreshWatchPaths，
> 2026-10-17）。

---

## 一、为什么是这两件

对照 ZCode 的 git 面清点（0010 三分入口已全部落地后），缺口按价值排序：

| 缺口 | 判断 |
|---|---|
| **提交图（GitGraph）** | ZCode 分支弹层底栏的标准入口，用户「看历史」的唯一 UI 面。只读、纯增量。**本轮做** |
| **状态自动刷新** | ZCode 靠文件监听驱动 git 状态收敛；我们只有 mount / focus / 60s 侧栏轮询，agent 写完文件徽章最迟一分钟才翻转——② 触发器「状态信号」的价值被迟到削弱。**本轮做** |
| AI 生成提交信息 | docs/15 §六明确暂缓，需 daemon 侧模型调用面（三个选项），**另开 ADR 定夺，不做** |
| checkpoint / discard / merge | ADR 0009 已推迟 / 明确不做，**不做** |

## 二、提交图

### 2.1 数据面：`git.graph`

- `git log HEAD --branches --tags --remotes --date-order --topo-order --skip=N --max-count=N+1
  --format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e`（ZCode 同款；不用 `--all`，排除
  stash / 内部 hidden ref）。
- `%D` 装饰解析成 `refs[{name, kind: head|branch|remote|tag}]`：`HEAD -> main` 拆两条；
  `tag: v1` → tag；带斜杠无 `refs/` 前缀的按远端论（ZCode 同判）。
- `hasMore` 用 maxCount+1 探测；unborn 仓库（一句 stderr 话术族）返回空列表——诚实缺席，
  与 `git.status` 的 `isRepo:false` 同一哲学。
- maxCount 夹 1..200、缺省 50（ZCode 100/200，我们页 50 对齐其前端分页大小）。

### 2.2 UI：`prototype/src/ui/gitGraph/`

- **布局算法移植自 ZCode（Apache-2.0）**的 `layoutAlgorithm.ts` + `layout.ts`，出处登记
  THIRD-PARTY-NOTICES.md。vertex/branch 模型、lane 复用、merge 借道连接点原样保留；
  改写为本仓类型与注释风格。这是本仓**第一段 ZCode 代码移植**（此前只有设计参照）。
- `GitGraphDialog`：泳道 SVG（四色轮转：secondary/teal/highlight/gain，双主题实色）+
  四列表（描述 / 时间 / 作者 / 哈希）；50 条一页，近底部 96px 自动加载更多 + 显式按钮；
  悬停调暗无关线（relatedHashes）；点行选中 + 展开元数据详情脚（**不嵌 diff**——看改动走
  ③ 审阅入口，图只回答「历史长什么样」）。
- **入口唯一**：BranchPicker 弹层底栏「查看提交图」（ZCode 同款）；提交框内嵌的精简
  picker（showFooterActions=false）不带。源代码管理页不加第二入口——历史不是高频动作，
  弹层进图已经一步。
- 暂不做：虚拟滚动（行是轻量 DOM，几百行无压力，ZCode 用 tanstack virtual 我们不引依赖）、
  graph 内 diff 视图、行右键菜单。

## 三、自动刷新

### 3.1 daemon 侧（`backend/src/git/watch.ts`）

- **监听意图不新增 RPC**：`git.status` 心跳（isRepo）到达过的仓库自动挂监听——徽章路径
  本来就 15–60s 打一次 status，从未被问询的仓库不耗句柄。多窗口 / daemon 重启天然幂等。
- 监听路径：工作树根递归 + gitdir + commonDir 递归（链接工作树的 gitdir 在主仓
  `.git/worktrees/` 下，不在工作树根内，必须单挂；commonDir 顺带兜住主仓活动）。
  linux 无递归 watch：根跳过、git 目录退非递归（顶层 HEAD/index/packed-refs 仍兜住提交与
  切分支），对齐 ZCode 的保守 linux 策略。
- **节流是前沿 + 尾沿合并**（默认 60s，env `AGENT_WORKBENCH_GIT_WATCH_INTERVAL_MS` 供
  smoke 覆盖）：首批事件立即广播一条，持续写入期间每分钟至多一条、最长迟到 ≤60s。
  区别于 ZCode 的纯 60s 尾沿防抖——后者在 agent 持续写文件的场景会把刷新无限推后。
- 广播 `git.changed {rootPath}`（**首个无 sessionId 的 RuntimeEvent**）：信号不带货，前端
  自行拉 status/changes；不落盘、不进 `(sessionId, seq)` 判重补拉（独立 seq 计数器）。
  会话泵（adapter #installPump）与 RuntimeHost sink 对无 sessionId 事件直接跳过。
- 生命周期：daemon.stop → 全量停；每分钟存在性清扫回收目录已删的仓库；句柄全丢由下一次
  status 心跳重建。句柄 persistent:false + 定时器 unref，不阻止进程退出。

### 3.2 前端侧（`store/gitAutoRefresh.ts`）

- App 挂载时装一次（幂等安装器）：`git.changed` → 徽章 force 刷新（绕 TTL——事件本身就是
  变化凭证）+ 若源代码管理页 / 改动 store 正指着该仓库则全量 / 重拉。分发只做一遍，
  不在组件里各订各的（一个事件 N 次 status）。
- ZCode 对位物是前端起的 useGitAutoRefresh（60s 尾沿防抖 + refreshToken）；我们把监听
  挪进 daemon 常驻进程，所有客户端共享一份监听，前端只剩订阅。

## 四、验收与登记

- smoke:git 新增两段：graph（HEAD/refs/parents 链、分页 hasMore、skip、unborn 空列表、
  bad_params、not_a_repo）与 watcher（env 压 250ms 节流 → 改文件 → 断言收到 git.changed）。
- docs/07：`git.graph` 注册、`git.changed` 帧说明、`git.status` 副作用注记。
- THIRD-PARTY-NOTICES：ZCode 条目从「无代码留存」改为登记布局算法移植（Apache-2.0，
  附许可文本）。

## 五、后续项（防蔓延清单）

- **AI 生成提交信息**：仍是 docs/15 §六的三选项（直连 provider / 借道执行器 CLI / 暂缓），
  做之前另开 ADR。
- **graph 内 diff / 虚拟滚动**：等真实使用反馈。
- **base...HEAD 对比入口**（推送对话框预览将推的文件）：RPC 面天然支持（`git.diff` 加
  `branch` sourceId 即可），等推送对话框有信息架构诉求再上。
