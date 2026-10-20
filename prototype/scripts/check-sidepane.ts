/**
 * 右侧标签面板契约自检 —— 直接跑 core/sidePaneTabs.ts 的纯函数。
 *
 * 这些断言守的是三条行为语义（抄自 ZCode 的血泪）：
 * 1. 结构化 id 幂等：同身份重复打开聚焦复用，不并排开两个；
 * 2. 关激活 tab 落右邻；
 * 3. bot 作用域：切 bot 隐藏不销毁、记忆恢复聚焦、注销回收。
 * 4. 占位口径（sidePaneOccupies）：列渲染、头部按钮态、开合动作三处同源。
 * 跑法：node --experimental-strip-types scripts/check-sidepane.ts
 */
import {
  activateTab,
  closeTab,
  closeVisibleTabs,
  diffTabId,
  EMPTY_SIDE_PANE_STATE,
  historyTabId,
  insertTab,
  liveTabId,
  moveTab,
  notifyTabId,
  openDiffTab,
  openHistoryTab,
  openLiveTab,
  openNotificationsTab,
  openPlanTab,
  planTabId,
  releaseUnits,
  resolveScopeOnUnitChange,
  sidePaneOccupies,
  tabScope,
  visibleTabsForUnit,
  type DiffSidePaneTab,
  type HistorySidePaneTab,
  type LiveSessionSidePaneTab,
  type NotificationsSidePaneTab,
  type PlanSidePaneTab,
  type SidePaneState,
} from "../src/core/sidePaneTabs.ts";
import { asUnitId } from "../src/core/units.ts";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${label}`);
  }
}

const A = asUnitId("bot-a");
const B = asUnitId("bot-b");

function hist(unit: string, name = unit): HistorySidePaneTab {
  return {
    id: historyTabId(asUnitId(unit)),
    type: "history",
    ownerUnitId: asUnitId(unit),
    unitName: name,
    openedAt: 1,
  };
}

function notifyTab(): NotificationsSidePaneTab {
  return { id: notifyTabId, type: "notify", openedAt: 1 };
}

// ---------------------------------------------------------------------------
// openHistoryTab：结构化 id 幂等
// ---------------------------------------------------------------------------

{
  const s1 = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  assert(s1.tabs.length === 1 && s1.activeTabId === historyTabId(A), "打开首个历史 tab 并聚焦");

  // 同一 bot 再开：不并排，原位更新 meta
  const s2 = openHistoryTab(s1, { unitId: A, unitName: "甲改名", focusKey: "run-1" });
  assert(s2.tabs.length === 1, "同 bot 重复打开不并排（id 幂等）");
  assert(s2.activeTabId === historyTabId(A), "重复打开聚焦同一 tab");
  assert(s2.tabs[0]!.unitName === "甲改名" && s2.tabs[0]!.focusKey === "run-1", "复用时合并新 meta 与落点");

  // 落点是「请求参数」不是身份：不带 focusKey 的复用会清掉旧落点（header 点开 = 不落点）
  const s3 = openHistoryTab(s2, { unitId: A, unitName: "甲改名" });
  assert(s3.tabs[0]!.focusKey === undefined, "复用不带 focusKey 时显式清落点");

  // 不同 bot：并排多开
  const s4 = openHistoryTab(s3, { unitId: B, unitName: "乙" });
  assert(s4.tabs.length === 2 && s4.activeTabId === historyTabId(B), "不同 bot 并排多开并聚焦新 tab");
}

// ---------------------------------------------------------------------------
// closeTab：右邻落点
// ---------------------------------------------------------------------------

{
  // 三个 tab（A 历史、B 历史、再开一个 workspace 级占位：这里用第三个 bot 模拟队列）
  const C = asUnitId("bot-c");
  let s = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A });
  s = openHistoryTab(s, { unitId: B });
  s = openHistoryTab(s, { unitId: C });
  assert(s.activeTabId === historyTabId(C), "前置：第三个 tab 为激活");

  // 关中间的 B（非激活）：不动 active
  let n = closeTab(s, historyTabId(B));
  assert(n.tabs.length === 2 && n.activeTabId === historyTabId(C), "关非激活 tab 不动聚焦");

  // 关激活的 C：落右邻 —— C 是最后一个，落新的最后一个（A）
  n = closeTab(n, historyTabId(C));
  assert(n.activeTabId === historyTabId(A), "关最后一个激活 tab 落到（新的）最后一个");

  // 重建三 tab，关中间激活的：落严格右邻
  s = openHistoryTab(n, { unitId: B });
  s = openHistoryTab(s, { unitId: C });
  s = activateTab(s, historyTabId(B));
  n = closeTab(s, historyTabId(B));
  assert(n.activeTabId === historyTabId(C), "关中间激活 tab 落右邻（不是左邻不是首个）");

  // 清空：activeTabId 归空串
  n = closeTab(n, historyTabId(A));
  n = closeTab(n, historyTabId(C));
  assert(n.tabs.length === 0 && n.activeTabId === "", "清空后 activeTabId 归空串");

  // 关不存在的 id：原样返回
  const same = closeTab(n, "nope");
  assert(same === n, "关不存在的 tab 原样返回");
}

// ---------------------------------------------------------------------------
// bot 作用域：过滤 / 解析 / 记忆 / 回收
// ---------------------------------------------------------------------------

{
  const s = openHistoryTab(
    openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" }),
    { unitId: B, unitName: "乙" },
  );
  // 在 B 下激活 B 的 tab 后切走
  const scoped = resolveScopeOnUnitChange(s, B, {});
  assert(scoped.visibleTabs.length === 1 && scoped.visibleTabs[0]!.id === historyTabId(B), "作用域过滤只留当前 bot 的 tab");
  assert(scoped.activeTabId === historyTabId(B), "有可见 tab 时解析出聚焦");

  // 切到无 tab 的 bot：聚焦归空（面板落功能主页），开合不被切换动作翻掉，tabs 不销毁
  const D = asUnitId("bot-d");
  const away = resolveScopeOnUnitChange(s, D, {});
  assert(away.activeTabId === "", "切到无 tab 的 bot 聚焦归空（落功能主页，不强制收起）");
  assert(s.tabs.length === 2, "切走不销毁其它 bot 的 tab");

  // 记忆恢复：上次聚焦记忆命中可见集合时优先取它
  const remembered = resolveScopeOnUnitChange(s, A, { [String(B)]: historyTabId(B) });
  // A 没有记忆 → 沿用 active（B 的 tab，在 A scope 不可见）→ 落 A 的最后一个可见 tab
  assert(remembered.activeTabId === historyTabId(A), "无记忆时落到当前 bot 的可见 tab");

  // 记忆指向已被关闭的 tab：忽略记忆，走兜底（不产生指向不存在 tab 的 active）
  const stale = resolveScopeOnUnitChange(
    { tabs: [hist(String(A))], activeTabId: "" },
    A,
    { [String(A)]: "history:closed-long-ago" },
  );
  assert(stale.activeTabId === historyTabId(A), "过期记忆被忽略，落可见兜底");

  // 回收：B 注销后其 tab 消失，A 保留；激活被回收时归空串
  const rel = releaseUnits(
    { tabs: [hist(String(A)), hist(String(B))], activeTabId: historyTabId(B) },
    [A],
  );
  assert(rel.tabs.length === 1 && rel.tabs[0]!.ownerUnitId === A, "注销 bot 的 tab 被回收");
  assert(rel.activeTabId === "", "激活 tab 被回收时 activeTabId 归空");
  const relKeep = releaseUnits({ tabs: [hist(String(A))], activeTabId: historyTabId(A) }, [A, B]);
  assert(relKeep.activeTabId === historyTabId(A) && relKeep.tabs.length === 1, "无回收发生时原样返回");
}

// ---------------------------------------------------------------------------
// openLiveTab / openPlanTab / openDiffTab：新三类的幂等与归属
// ---------------------------------------------------------------------------

{
  const live1 = openLiveTab(EMPTY_SIDE_PANE_STATE, { unitId: A, sessionId: "42", runtimeId: "zcode", title: "跑批" });
  assert(live1.tabs.length === 1 && live1.activeTabId === liveTabId("42"), "打开监控 tab 并聚焦");

  // 同会话重复开：不并排，title/runtimeId 原位刷新
  const live2 = openLiveTab(live1, { unitId: A, sessionId: "42", runtimeId: "zcode", title: "跑批（改名）" });
  assert(live2.tabs.length === 1, "同会话重复打开监控不并排（id 幂等）");
  const liveTab = live2.tabs[0] as LiveSessionSidePaneTab;
  assert(liveTab.title === "跑批（改名）" && liveTab.runtimeId === "zcode", "监控复用刷新 meta");

  // 不同会话：并排；owner 跟随请求（监控 A 的会话归 A，即使从别处发起）
  const live3 = openLiveTab(live2, { unitId: B, sessionId: "43", runtimeId: "codex", title: "乙的会话" });
  assert(live3.tabs.length === 2 && (live3.tabs[1] as LiveSessionSidePaneTab).ownerUnitId === B, "不同会话并排多开，owner 跟随请求");

  // plan / diff：按 unit 幂等
  const p1 = openPlanTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  const p2 = openPlanTab(p1, { unitId: A, unitName: "甲改名" });
  assert(p2.tabs.length === 1 && p2.tabs[0]!.type === "plan" && p2.tabs[0]!.unitName === "甲改名", "计划 tab 按 unit 幂等并刷新名");
  const d1 = openDiffTab(p2, { unitId: A, unitName: "甲改名" });
  const d2 = openDiffTab(d1, { unitId: B, unitName: "乙" });
  assert(d2.tabs.length === 3 && d2.activeTabId === diffTabId(B), "变更 tab 不同 bot 并排、同 bot 幂等");

  // 作用域过滤对新类型同样生效
  assert(visibleTabsForUnit(d2.tabs, A).length === 2, "A 的作用域只看得到 A 的 tab（history/plan/diff 同口径）");
}

// ---------------------------------------------------------------------------
// closeTab 作用域感知：右邻回落只在当前 scope 的可见集合里挑
// ---------------------------------------------------------------------------

{
  // [history:A, live:B, plan:A]，A scope 下关激活的 plan:A —— 全量右邻没有
  // 更靠后的 A tab，应落「最后一个可见」（history:A），而不是落进 B 的 live
  let s = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  s = openLiveTab(s, { unitId: B, sessionId: "9", runtimeId: "zcode", title: "乙跑" });
  s = openPlanTab(s, { unitId: A, unitName: "甲" });
  const scopedClose = closeTab(s, planTabId(A), A);
  assert(scopedClose.activeTabId === historyTabId(A), "作用域关激活 tab 不落到别的 bot 的 tab 上");
  assert(scopedClose.tabs.length === 2, "被关 tab 移除、他人 tab 保留");

  // 缺省（不传 scope）：保持旧的全量右邻语义 —— live:B 成为落点
  const unscopedClose = closeTab(s, planTabId(A));
  assert(unscopedClose.activeTabId === liveTabId("9"), "缺省 scope 保持全量右邻旧语义");

  // scope 下右邻可见时仍取严格右邻：[live:A, history:A]，关 live:A 落 history:A
  let s2 = openLiveTab(EMPTY_SIDE_PANE_STATE, { unitId: A, sessionId: "7", runtimeId: "zcode", title: "甲跑" });
  s2 = openHistoryTab(s2, { unitId: A, unitName: "甲" });
  const rightNeighbor = closeTab(s2, liveTabId("7"), A);
  assert(rightNeighbor.activeTabId === historyTabId(A), "可见右邻仍取严格右邻");
}

// ---- 占位口径：列渲染 / 头部按钮态 / 开合动作共用（无 tab 也占位 = 功能主页兜底） ----
{
  assert(sidePaneOccupies(A, false, true), "占位：有可见 tab + 未收起 + chat 主视图");
  assert(!sidePaneOccupies(A, true, true), "收起即不占位");
  assert(!sidePaneOccupies(A, false, false), "非 chat 主视图不占位（全局页旁边不挂 bot 面板）");
  assert(!sidePaneOccupies(null, false, true), "还没激活过任何 bot 不占位");
  assert(sidePaneOccupies(B, false, true), "无可见 tab 也占位（功能主页兜底，展开不是死点击）");

  // 回归守卫一：旧的头部按钮态漏了 mainView 条件，停在全局页（tab 开着、未收起）
  // 时按钮亮「已展开」，点一下只把 collapsed 翻成 true —— 画面不动，得点第二下。
  // 现在全局页恒判「不占位」，钮显示展开、点击走展开分支，第一次点就有可见变化。
  const onGlobal = !sidePaneOccupies(A, false, false);
  const afterFirstClick = sidePaneOccupies(A, false, true);
  assert(onGlobal && afterFirstClick, "全局页上点钮必然产生可见变化（无死点击）");

  // 回归守卫二：零 tab 时点展开，旧口径整列不渲染 —— 又一次死点击。现在落功能主页。
  const expandNoTabs = sidePaneOccupies(A, false, true);
  assert(expandNoTabs, "零 tab 点展开面板必有内容（功能主页）");
}

// ---------------------------------------------------------------------------
// workspace 级 scope（通知中心）：恒可见 / 不被回收 / 可作右邻落点
// ---------------------------------------------------------------------------

{
  assert(tabScope(notifyTab()) === "workspace", "notify 是 workspace 级 scope");
  assert(tabScope(hist(String(A))) === "unit", "历史 tab 是 unit 级 scope");

  let s = openNotificationsTab(EMPTY_SIDE_PANE_STATE);
  assert(s.tabs.length === 1 && s.activeTabId === notifyTabId, "打开通知 tab 并聚焦");
  const again = openNotificationsTab(s);
  assert(again.tabs.length === 1 && again.activeTabId === notifyTabId, "通知 tab 单例幂等");

  // 恒可见：任何 bot 视角（含 null 作用域）都看得见 workspace 级 tab
  s = openHistoryTab(s, { unitId: A, unitName: "甲" });
  assert(visibleTabsForUnit(s.tabs, A).length === 2, "A 视角可见 A 的 tab + workspace tab");
  assert(visibleTabsForUnit(s.tabs, B).length === 1, "B 视角仍可见 workspace tab（不随 bot 切换）");
  assert(visibleTabsForUnit(s.tabs, null).length === 1, "null 作用域只剩 workspace tab");

  // bot 注销回收不碰 workspace tab
  const rel = releaseUnits({ tabs: [hist(String(A)), notifyTab()], activeTabId: notifyTabId }, []);
  assert(rel.tabs.length === 1 && rel.tabs[0]!.type === "notify", "注销回收保留 workspace tab");

  // closeTab 右邻可以落到 workspace tab（它在本 scope 可见）
  let s2 = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  s2 = openNotificationsTab(s2);
  s2 = activateTab(s2, historyTabId(A)); // 激活被关的 tab，才是在测「右邻回落」路径
  const fellToNotify = closeTab(s2, historyTabId(A), A);
  assert(fellToNotify.activeTabId === notifyTabId, "关激活 unit tab 可落右邻 workspace tab");

  // resolveScopeOnUnitChange：切到无 unit tab 的 bot 时 workspace tab 兜住聚焦
  const res = resolveScopeOnUnitChange({ tabs: [hist(String(A)), notifyTab()], activeTabId: "" }, B, {});
  assert(res.visibleTabs.length === 1 && res.activeTabId === notifyTabId, "切到无 tab 的 bot 落 workspace tab（不掉功能主页）");
}

// ---------------------------------------------------------------------------
// insertTab（最近关闭重开的落点）
// ---------------------------------------------------------------------------

{
  const s0 = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  const s1 = insertTab(s0, hist(String(B)));
  assert(s1.tabs.length === 2 && s1.activeTabId === historyTabId(B), "尾插新 tab 并聚焦");
  // 同 id 已存在：只聚焦，不并排
  const s2 = insertTab(s1, hist(String(A)));
  assert(s2.tabs.length === 2 && s2.activeTabId === historyTabId(A), "insertTab 撞 id 只聚焦不并排");
}

// ---------------------------------------------------------------------------
// moveTab：可见子集内重排，隐藏 tab 原位保序
// ---------------------------------------------------------------------------

{
  const C = asUnitId("bot-c");
  // 全量 [hist:A, hist:B, hist:C]，B 视角下可见的只有 B —— 无从重排，no-op
  let s = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A });
  s = openHistoryTab(s, { unitId: B });
  s = openHistoryTab(s, { unitId: C });
  const noop = moveTab(s, historyTabId(B), 0, B);
  assert(noop === s, "scope 内只有一个可见 tab 时 moveTab 原样返回");

  // A 视角开 [plan, history, diff]（A 的三个），history 从中段拖到末位
  let a = openHistoryTab(EMPTY_SIDE_PANE_STATE, { unitId: A, unitName: "甲" });
  a = openPlanTab(a, { unitId: A, unitName: "甲" });
  a = openDiffTab(a, { unitId: A, unitName: "甲" });
  // 掺一个 B 的隐藏 tab 在中间，验证「隐藏位原样保留」
  a = openHistoryTab(a, { unitId: B, unitName: "乙" });
  a = activateTab(a, diffTabId(A));
  const moved = moveTab(a, historyTabId(A), 2, A);
  assert(moved.tabs.length === 4, "moveTab 不增删 tab");
  const visibleA = visibleTabsForUnit(moved.tabs, A).map((t) => t.type);
  assert(
    visibleA.join(",") === "plan,diff,history",
    `可见子集按目标序重排（plan,diff,history，实得 ${visibleA.join(",")}）`,
  );
  assert(moved.activeTabId === diffTabId(A), "moveTab 不动聚焦");
  // 原位（fromIndex === clamped）返回同一引用
  const same = moveTab(moved, planTabId(A), 0, A);
  assert(same === moved, "移到原位返回同一引用");
  // 越界目标收拢到末位
  const clampedMove = moveTab(moved, planTabId(A), 99, A);
  assert(
    visibleTabsForUnit(clampedMove.tabs, A).map((t) => t.type).join(",") === "diff,history,plan",
    "越界目标收拢到末位",
  );
  // 不存在的 id / 负 index：no-op
  assert(moveTab(moved, "nope", 0, A) === moved, "moveTab 不存在的 id 原样返回");
  assert(moveTab(moved, diffTabId(A), -1, A) === moved, "负目标索引原样返回");
}

// ---------------------------------------------------------------------------
// moveTab：隐藏 tab 夹在可见 tab 中间（open* 都是尾插，得手工构造排列）
// ---------------------------------------------------------------------------

{
  const planA: PlanSidePaneTab = { id: planTabId(A), type: "plan", ownerUnitId: A, unitName: "甲", openedAt: 1 };
  const diffA: DiffSidePaneTab = { id: diffTabId(A), type: "diff", ownerUnitId: A, unitName: "甲", openedAt: 1 };
  const hiddenB = hist(String(B));
  const s: SidePaneState = { tabs: [planA, hiddenB, diffA], activeTabId: planTabId(A) };
  const moved = moveTab(s, diffTabId(A), 0, A);
  const ids = moved.tabs.map((t) => t.id);
  assert(
    ids.join(",") === `${diffTabId(A)},${historyTabId(B)},${planTabId(A)}`,
    `隐藏 tab 夹中间：可见位按目标序重排、隐藏位原样保留（实得 ${ids.join(",")}）`,
  );
  assert(moved.tabs[1] === hiddenB, "夹在中间的隐藏 tab 对象引用与绝对下标都不变");
}

// ---------------------------------------------------------------------------
// close 系的 null 作用域：与 visibleTabsForUnit(null) 同口径 = 只剩 workspace 级
// ---------------------------------------------------------------------------

{
  const s: SidePaneState = { tabs: [hist(String(A)), notifyTab()], activeTabId: notifyTabId };
  const closed = closeVisibleTabs(s, null);
  assert(closed.tabs.length === 1 && closed.tabs[0]!.type === "history", "null 作用域的「关闭全部」只关 workspace 级 tab");
  assert(closed.activeTabId === "", "聚焦 tab 被关且作用域内无可落 → 归空（null 作用域下 unit tab 也不可见，不越权拾取）");
  const full = closeVisibleTabs(s);
  assert(full.tabs.length === 0, "缺省（undefined）保持全量旧语义");
}

console.log(`\nsidepane 契约：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
