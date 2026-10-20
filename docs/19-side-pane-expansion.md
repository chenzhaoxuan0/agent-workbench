# 右侧栏扩容计划（容器契约 + 通知中心 + 变更审查增强）

> 目标：把右侧标签面板从「4 个 bot 作用域面板」扩成「容器能力完整 + workspace 级面板」
> 的形态。依据：ZCode 源码走查（`packages/ui/src/lib/workspaceSidePane.ts`、
> `AnimatedSidePanePanel.tsx`、`GitPane.tsx`、`useAppPanels.ts`，2026-10-19）+
> MCode 欢迎页（文件 / 侧边对话 / 浏览器 / 终端 / 审查 / 画布 / Mini App 七入口）。
> 本文是对照分析后的收敛执行计划（批次①②）。

---

## 一、三方对照的结论

| 维度 | ZCode（源码实证） | MCode（截图） | 本仓现状 |
|---|---|---|---|
| 标签数 | 19 种类型，欢迎页动态裁剪 | 7 入口 | 4 类（历史/监控/计划/变更） |
| 标签条 | 水平 + dnd 排序 + 总览搜索 + 最近关闭(≤8) + 中键关闭 | — | 水平 + 右键三件套，无排序/总览 |
| 归属 | workspace 级 + 会话级双 scope | — | 纯 bot 级（workspace 预留未实现） |
| 空态 | 「打开标签页」卡片选择页 | 「从这里开始」7 卡片带快捷键 | SidePaneHome 四入口 |

判断：本仓的标签生命周期语义（结构化 id 幂等、关激活落右邻、跨 bot 保活、聚焦记忆）
已对齐 ZCode，差距集中在**容器高级交互**与**面板种类**两层。批次①补容器，批次②补面板。

## 二、批次① 容器与契约层（纯前端，零新依赖）

1. **标签注册表**（`ui/sidePaneTabMeta.tsx`）：图标 / 标题 / 渲染 / 入口清单从
   `SidePanePanel.tsx` 的三处 switch 收拢成一处注册表；core 契约保持不碰 React。
2. **workspace 级 scope**（`tabScope(tab)`）：`visibleTabsForUnit` 让 workspace 级
   tab 恒可见（`null` 作用域只剩 workspace 级）。closeTab 右邻 / closeOther /
   resolveScope 都基于可见集，自动兼容，不需要逐个改。
3. **拖拽排序 `moveTab(state, tabId, toVisibleIndex)`**：只在可见子集内重排、隐藏
   tab 保序。UI 手写 pointer 拖拽（4px 阈值区分点击），顺带补中键关闭 —— 项目零
   dnd 依赖，不为一条水平 tab 条引 @dnd-kit。
4. **最近关闭 + 重开**：core 加通用 `insertTab`；store 持 `recentlyClosed ≤ 8`
   （按 id 去重置顶，三条关闭路径都记录），`reopenClosedTab()` 尾插 + 聚焦。不持久化。
5. **总览弹层**（`ui/SidePaneTabOverview.tsx`）：tab 条最左 ⌄ 锚定 + createPortal
   弹层（手写定位，不引浮层库）；搜索复用 `ui/fuzzySearch.ts`；「打开的标签」+
   「最近关闭」两组；键盘 ↑↓/Enter/Esc 对齐 CommandCenter。
6. **＋新增下拉**：复用 QuickContextMenu（label+icon 菜单正合适），分组
   会话类 / 工作区类。SidePaneHome 改为消费注册表入口清单，卡片带快捷键角标。
7. **快捷键 + 未读 badge**：Ctrl+Alt+B 开关面板、Alt+1..9 激活第 n 个可见 tab、
   Ctrl+Tab 循环；live tab 非激活时来事件打圆点（不计数）。

## 三、批次② 新面板

1. **通知中心**（workspace 级 tab，固定单例 `notify:workspace`）：daemon 事件
   聚合面 —— `session.ended` / `permission.requested` / `error` / `system.notice` /
   `steer.undelivered`（带 source 徽标）+ BacklogSignal 的 `notice`/`proposal` +
   `git.changed` 节流聚合；自动化终态无专用事件，用 `source==="automation"` 的
   `session.ended` 触发 `automation.runs` 补偿解析（不改 daemon）。sessionId 归属
   （unitId/runtimeId）靠订阅期缓存的 `session.started` 映射，缺省时兜底
   `session.list`。**不做 toast**（项目无全局 toast 基建，本轮不建）。
2. **DiffPane 增强**：来源下拉「已暂存 / 未暂存 / 上一轮」。上一轮 =
   `session.events.since` 取最后两个 turn 边界间的 `file.diff` 事件（独立只读路径，
   不碰 useGitChanges 单槽口径，ADR 0010）；`capabilities.fileDiff === false`
   （10/13 家）时禁用并提示。面板头过滤输入：路径过滤 + 命中计数 + 自动展开
   （v1 不做 patch 内高亮）。
3. **自动化 run 一键开监控**：AutomationsPage / HistoryPane headless 条目加「监控」
   入口 → 复用 `openLiveSession`（零新契约）。

## 四、明确不做（本轮）

- **浏览器预览面板**：docs/14 已列非目标（不内置浏览器，Electron 对 http 一律
  openExternal，前端无 webview/iframe）。CDP 截图流是 docs/14 Q8 的「二期」，
  需 daemon 新 RPC + 修订非目标条款，单独立项后再议。
- **side-chat 辅助对话 / 移动端侧栏 sheet / 工件面板**：数据链路评估已完成
  （session.start+send 足够、MobileDrawer 可镜像、deliverable 有契约无生产者），
  留待批次③。
- **tab 内拆分双面板**：ZCode 也未做，不预建。
- **tabs 跨刷新持久化**：维持「数据都在 daemon，tab 只是壳」的既有决策。

## 五、验证

- `pnpm -C prototype check:sidepane`：moveTab / insertTab / tabScope / notify 幂等
  各补断言块。
- `pnpm -C prototype check` + `pnpm -C prototype build` 全绿。
- 手工走查：拖拽排序与中键关闭、最近关闭重开、快捷键、通知聚合（含自动化
  session.ended 补偿）、上一轮来源在 codex/opencode/mcode 三家（fileDiff
  capability 为 true 的执行器）下的表现。
