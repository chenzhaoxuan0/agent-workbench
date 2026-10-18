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
  EMPTY_SIDE_PANE_STATE,
  historyTabId,
  openHistoryTab,
  releaseUnits,
  resolveScopeOnUnitChange,
  sidePaneOccupies,
  visibleTabsForUnit,
  type HistorySidePaneTab,
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

console.log(`\nsidepane 契约：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
