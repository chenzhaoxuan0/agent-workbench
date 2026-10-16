# git 操作走 daemon spawn git CLI + wire 协议 RPC，不引入 JS git 库

「源代码管理」（分支 / 工作树管理，交互范式对齐 VSCode SCM）的执行面全部由 daemon spawn 本机 `git` 二进制完成（`backend/src/git/repo.ts`，经 `runtime/exec.ts` 的 resolveCommand 解析 PATH），以 `git.*` 方法族暴露到 wire 协议（docs/07 已登记全表）。前端只拿结构化 result 与带错误码的 error，不知道任何命令行细节。

## Considered Options

- **isomorphic-git / nodegit（纯 JS 实现）**（否决）：零外部依赖是唯一优点，代价是行为面与 git CLI 永远存在偏差 —— porcelain v2、worktree 子命令、merge 冲突语义都要靠库自己的复刻，出错时用户拿 `git worktree` 手工排查对不上号。本产品的前提本来就是「本机装了各家 Agent CLI」，git 在 PATH 里不是新增假设。
- **simple-git（CLI 的 JS 包装库）**（否决）：底层同样 spawn git，多一层包装却拿走了对 argv 的控制；我们需要的错误归档（stderr 话术 → `branch_not_merged` / `worktree_dirty` / `branch_checked_out_elsewhere`）必须自己贴 stderr 做，库反而碍事。
- **daemon spawn git CLI（采纳）**：与执行器 CLI 的接入方式同构（`resolveCommand` 已解决 Windows npm shim 的坑），行为与命令行 100% 一致，用户可以随时用终端里的 git 验证我们没说谎。代价是依赖本机 git（与依赖 codex / claude CLI 同级的前提）与逐命令进程开销 —— 个人工作台规模下都无感。

## Consequences

- **危险操作的交互契约走错误码，不走 message 解析**：`branch_not_merged` → UI 确认后 `force:true`（`-D`）重试；`worktree_dirty` → 确认后 `--force`；`branch_checked_out_elsewhere` 带 `data.path`，UI 引导「打开那个工作树」。这三条与 VSCode 的行为一一对应，是 `git.*` 方法族的稳定 API。
- **工作树默认路径采用 VSCode 约定** `<仓库父目录>/<仓库名>.worktrees/<分支名>`：工作树落在仓库目录之外，不会被构建产物 / 扫描误伤，也和 VSCode 用户的既有习惯一致。
- **会话工作树的语义是 ensure，不是 create**：`StartSessionRequest.worktree {path, branch}` 在 daemon 侧幂等兑现（在则复用、不在则建；分支已存在则检出而非 -b 重建）。这取代了前端原先写死的 mock 填充（`.wt/session` + `feat/session`）—— 那个占位在 daemon 真正支持 worktree 后会到处建树，已删除。
- **UI 按 `RuntimeCapabilities.worktrees` 渐进增强**：「在此工作树启动会话」只对声明该能力的执行器开放（目前仅 codex），能力声明跟实现走。
- **v1 范围**：分支（创建/切换/删除/重命名/merge，远程只读）+ 工作树（创建/列表/删除/reveal）+ 会话工作树。改动列表 / 暂存 / 提交 / rebase / tag 是明确的后续项，`git.*` 命名空间为它们预留 —— 追加方法对 wire 协议是非破坏性演进（docs/07 §五）。
- daemon 在非 git 仓库目录上的调用返回 `{isRepo:false}` 而非报错：侧栏分支标记与面板空态都依赖这个「诚实的缺席」而不是异常流。
