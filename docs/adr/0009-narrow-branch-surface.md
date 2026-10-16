# 分支面收窄到 ZCode 窄模型：只做「在哪个分支上工作」

ADR 0008 把源代码管理面板的分支面对齐了 VSCode SCM 全范式（创建/切换/删除/重命名/合并）。实跑后复盘（对照 ZCode 的 git 面收窄实践）：面板真正承载的决策只有「会话在哪个分支上工作」，其余操作是低频、且有更好的去处。本文记录收窄决策；执行面（spawn git CLI、错误码契约、`--porcelain -z`）仍循 ADR 0008。

## Considered Options

- **保留 VSCode 全范式**（否决）：合并/改名/删除合计吃掉 4 个错误码（`branch_not_merged` / `branch_is_current` / `merge_conflicts` / `no_merge_in_progress`）、两套 UI 确认流（未合并强删、合并冲突横幅）和一个对话框组件。其中面板合并的体验天花板天然低——冲突了还是得去终端解决（错误文案自己承认）；确认流一多，用户无脑点确认，防护效果递减。
- **对齐 ZCode 窄面（采纳）**：ZCode 的分支面只有列出 / 新建并切换 / 切换（外加 commit graph 与 base...HEAD 对比），没有任何合并、改名、删除入口；安全网靠 checkpoint 快照兜底而非事前确认流。我们的会话隔离已有工作树层兜底（脏树强删仍有确认），分支级操作留给终端——个人工作台，终端永远在。
- **同时引入 ZCode 式 checkpoint**（推迟）：checkpoint 影子仓库是另一条安全网路线（约 900 行的新子系统），与本次收窄正交。先收窄，兜底需求出现再说。

## Consequences

- **分支面最终形态**：`git.branches.list`（本地+远程，远程作为新建工作树基点）/ `git.branch.create`（新建即切换，`checkout -b --no-track`，不再有 `checkout:false` 选项）/ `git.branch.checkout`。`git.branch.rename`、`git.branch.delete`、`git.merge`、`git.merge.abort` 从 wire 协议移除（**不兼容变更**，daemon 与前端同仓同发，无过渡期问题）。
- **错误码词表删 4 个**：`branch_not_merged`、`branch_is_current`、`merge_conflicts`、`no_merge_in_progress`（词表唯一来源仍是 prototype/src/core/git.ts）。保留 `dirty_worktree`（切换覆盖防护）、`branch_checked_out_elsewhere`（引导打开那个工作树）、`branch_exists`、`invalid_branch_name`。
- **工作树层原样保留**：会话隔离的承重墙与分支面正交。`worktree_dirty` 强删确认、活跃会话防拆、`ensureWorktree` 幂等兑现、默认路径约定都不动。
- **`git.worktree.create` 不再接受双空形态**：branch 与 commitish 至少其一（RPC 层 `bad_params`，repo 层防御性同判）。原「从当前 HEAD 建 detached 树」是无调用方的死路径，顺手清除。
- **新建工作树的远程基点用法不变**：远程分支仍可作为 commitish 建树（会话隔离工作流的入口之一）。
- **分支清理去终端做**：会话槽位的分支复用（ensureWorktree）让分支增长天然有界；真要清理，终端 `git branch -D` 一行的事。若日后面板删除需求强烈，回补入口的成本是局部的（RPC + 一段确认流）。
