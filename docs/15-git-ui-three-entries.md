# Git UI 三分职责改造计划

> 目标：把源代码管理的交互拆成**三个职责分明的入口**，各自回答用户的一个问题——
> 「在哪工作」（分支）/「要不要落库」（提交·推送）/「改了什么」（审阅）。
> 依据：ZCode 源码走查（`packages/ui/src/GitBranchSwitcher.tsx`、`GitActionMenu.tsx`、
> `v4/ConversationStatusPanel.tsx`，2026-10-17）+ 本仓 ADR 0008（git 走 daemon CLI RPC）、
> ADR 0009（分支面收窄）。本文是三分职责的收敛执行计划。

---

## 一、背景与三分原则

ZCode 的 git UI 没有做成一个大而全的「git 工具」，而是三个独立入口：

| 入口 | 回答的问题 | 交互形态 | ZCode 对应 | 我们的家 |
|---|---|---|---|---|
| ① 分支切换器 | 在哪工作 | 轻弹层：列表选一下 | `GitBranchSwitcher` | Composer 顶栏芯片（**已落地**，`56f0953`） |
| ② Git 操作入口 | 要不要落库 | 状态驱动按钮 + 对话框（填表单） | `GitActionMenu` | Composer 顶栏、分支芯片右侧（Phase 2） |
| ③ 改动审阅 | 改了什么 | 文件列表 + diff 视图 | 状态面板 Changes 行 → Review 面板 | 源代码管理页「改动」区（Phase 3） |

**为什么不合成一个入口**（ZCode 源码实证的三个理由）：

1. 三个入口对应三个不同的决策时刻，混在一起则每个时刻都要先翻菜单。
2. ②的触发器是**状态信号**：有改动亮提交图标、领先远端亮推送图标，用户不点开就知道该做什么——这个价值只有独立入口才有（ZCode 注释明说该入口「始终展示、异常时置灰」，消失即信号丢失）。
3. 轻弹层（分支是列表选一下）与重对话框（提交是填表单）是两种交互形态，不该互相迁就。

**源代码管理页的角色**：不是三个入口之外的第四个入口，而是「仓库总管」——分支 + 工作树 + 改动的全景视图。三分入口解决「聊天工作流中的高频动作」，总管页解决「坐下来管理这个仓库」。会话工作树（隔离承重墙，ADR 0008）继续只住在这里。

**绑定口径**：Phase 1–3 所有新入口绑定**激活单元的 rootPath（主工作树）**，与 BranchPicker 现行口径一致。会话工作树的改动状态是后续项（§五）。

## 二、现状盘点

**已就绪（不重做）**：
- ①分支切换器：`prototype/src/ui/BranchPicker.tsx`（搜索 / 切换 / 新建即切换，ADR 0009 窄面）
- 分支与工作树 RPC：`git.status / branches.list / branch.create / branch.checkout / worktrees.*`
- 错误码词表唯一来源：`prototype/src/core/git.ts`（daemon 与前端共用）
- 徽章缓存（TTL 节流 + `markBranch` 即时收敛）：`prototype/src/store/useGit.ts`

**缺失（本计划要做的）**：
- 提交面 RPC 全族（changes / diff / stage / commit / push / identity）——ADR 0008 的「v1 不做清单」里的改动列表/暂存/提交转正
- ②Git 操作入口（触发器 + 提交对话框 + 推送确认）
- ③改动审阅（文件列表 + 单文件 diff）
- smoke 覆盖与 docs/07 登记

## 三、Phase 1：后端提交面（git.* 方法族扩展）

### 3.1 设计

新增 RPC（实现全在 `backend/src/git/repo.ts`，注册在 `backend/src/index.ts`，登记 docs/07）：

| 方法 | params | result / 说明 |
|---|---|---|
| `git.changes` | `{rootPath}` | `{staged[], unstaged[], untracked[]}`：path + 状态码 + added/removed 行数（`--numstat`） |
| `git.diff` | `{rootPath, path, sourceId: staged\|unstaged}` | 单文件 patch 文本（超长截断阈值实现时定） |
| `git.stage` / `git.unstage` | `{rootPath, paths[]}` | 按路径暂存 / 取消暂存 |
| `git.commit` | `{rootPath, message, paths[], stagedOnly?}` | `{commitHash}`；`stagedOnly` 时不碰工作区只提交已暂存 |
| `git.push` | `{rootPath}` | `{branchName, trackingBranchName, remoteName, setUpstream}`；无 upstream 时 `-u` 首推 |
| `git.identity` | `{rootPath}` | `{name, email} \| null`（提交对话框的身份缺失警告用） |
| `git.status` 扩展 | — | result 加 `dirtyFileCount`（porcelain v2 的非 `#` 行本来就在解析，计数零成本） |

**错误码新增**（stderr 话术 → 稳定码，原则同 ADR 0008）：`nothing_to_commit`、`identity_missing`、`push_rejected`（non-fast-forward / 远端拒绝话术族）、`no_remote`。词表仍只写 `prototype/src/core/git.ts`。

**安全口径延续**：spawn argv 数组不过 shell；ref/路径校验沿用现有 `check-ref-format` / 前导 `-` 防护；**discard（丢改动）明确不做**——不可逆且无安全网，等 checkpoint 路线（ADR 0009 已推迟）。

### 3.2 交付物与验收

- `smoke:git` 增提交/推送段：本地 bare 仓库当 remote 夹具（`git init --bare` + `remote add`），全程不碰网络；断言 staged→commit→push 全链 + `nothing_to_commit` / `push_rejected` 错误码
- docs/07 方法注册表与错误码段落登记全量
- 验收：夹具仓库里走完「改文件 → stage → commit → push → bare 端可见提交」全链，smoke 全绿

## 四、Phase 2：Git 操作入口（Composer 顶栏落库）

### 4.1 设计

- **触发器**：`BranchPicker` 右侧独立按钮（新组件，ui/ 根，与 picker 家族同层）。状态驱动：`dirty` → 提交图标可点；`ahead > 0` → 推送图标；干净且同步 → 置灰（**始终展示、异常置灰，不消失**——ZCode 踩过的可用性坑）。数据源：`git.status` 的 `dirty / dirtyFileCount / ahead`（徽章缓存路径扩展，TTL 同口径）
- **提交对话框**（DialogShell 复用源代码管理的对话框骨架）：
  - 顶栏：内嵌精简版 BranchPicker（ZCode 在提交框里也嵌了它，`showFooterActions=false` 同款）+ `+N/-N` 行数统计
  - 提交信息多行编辑；「包含未暂存改动」开关（带文件数，ZCode 同款）
  - 动作三连：提交 / 提交并推送 / 仅推送；Enter 走主动作（按状态解析，同 ZCode `resolveGitActionMenuPrimaryAction`）
  - 身份缺失警告条（`git.identity` 返回 null 时）
  - AI 生成提交信息：暂缓（§五）
- **推送确认对话框**：当前分支、upstream、ahead/behind 明细、失败时错误详情可复制（ZCode 同款）
- 非 git 仓库：按钮与 BranchPicker 同口径隐藏

### 4.2 交付物与验收

- 对话页不碰终端完成「改了文件 → 点提交图标 → 填信息 → 提交并推送」全流程
- 触发器图标随仓库状态正确翻转（手动构造 dirty / ahead / 干净三态验证）
- typecheck + check:bridge + smoke 全绿

## 五、Phase 3：改动审阅（源代码管理页「改动」区）

### 5.1 设计

- 源代码管理页在「分支」区**之上**加「改动」区：staged / unstaged 两组文件列表（`+N/-N`、行内 stage / unstage 按钮）
- 单文件 diff：先做**展开式**（点击行内展开 patch 文本，`git.diff` 数据源）；右侧预览 pane 等页面信息架构有诉求再上
- Composer 侧**不加第三个芯片**：改动审阅是「看」不是「做」，轻入口由 ②的提交对话框自带（staged/unstaged 文件预览），全景在总管页

### 5.2 交付物与验收

- 总管页能看 staged/unstaged 明细、展开单文件 diff、行内 stage/unstage
- 与 Phase 2 的提交对话框数据一致（同一 `git.changes` 数据源，无两套口径）

## 六、明确不做 / 后续项（防蔓延清单）

- **AI 生成提交信息**：需要 daemon 侧模型调用面。三个选项——直连 provider（引入模型凭证面，重）/ 借道执行器 CLI（`zcode -p` / `claude -p`，daemon 已有进程面）/ 继续暂缓。实现时另开 ADR 定夺。
- **discard / 逐 hunk 暂存**：不可逆操作，等 checkpoint 式安全网（ADR 0009 已推迟该路线）。
- **会话工作树绑定的改动状态**（会话卡片上的 `+N/-N`）：等会话面板信息架构定型；Phase 1 的 RPC 面天然可复用（传 worktree 路径即可）。
- **merge / rebase / tag**：继续不做（ADR 0009）。

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 提交面对多执行器并发写文件的竞态（agent 正在写、用户同时在提交） | `git.changes` / `git.commit` 每次现拉现提交，不缓存暂存意图；stage 用精确路径不用 `.` |
| push 话术各远端（GitHub/GitLab/内网）差异大，错误归档不全 | `push_rejected` 只认确定性话术族，未识别话术透传首行（ADR 0008 既有口径），不硬造分类 |
| 提交对话框塞进 Composer 顶栏后移动端挤不下 | ZCode 同款处理：窄屏触发器只留图标（`@max-[560px]` 隐藏文字） |
| Phase 2/3 对 Phase 1 的依赖被跳过 | 每个 Phase 独立提交、独立可用；②③只调已登记的 RPC，不造私有通道 |

## 八、里程碑与决策留痕

- Phase 1 → 2 → 3 顺序交付，各自一个（或一组）独立 commit；Phase 2 依赖 Phase 1，Phase 3 依赖 Phase 1。
- Phase 1 落地时新增 **ADR 0010**（git UI 三分职责 + 提交面转正），修订 ADR 0008「v1 不做清单」（改动列表/暂存/提交 移出）；错误码词表唯一来源不变。
- 验收总口径：三分入口各自回答各自的问题，互不代答；任何高频 git 动作不再需要离开对话页或开终端。
