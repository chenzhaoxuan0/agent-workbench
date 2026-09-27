/**
 * 右栏契约自检 —— 直接跑 core/sidepane.ts 的纯函数。
 *
 * 这些都是行为约定（不是样式），单测比肉眼点更可靠：
 * 跑法：node --experimental-strip-types scripts/check-sidepane.ts
 */
import {
  ALL_TAB_TYPES,
  blockedReason,
  buildSearchFields,
  canOpenTab,
  closeOwnerTabs,
  closeTab,
  deriveTabBadges,
  filterAndRankSearchItems,
  getVisibleTabs,
  groupTabTypesByScope,
  HIDDEN_TAB_TYPES,
  listVisibleTabTypes,
  makeTabDraft,
  metaOf,
  NEEDS_RUNTIME,
  normalizeSearchQuery,
  normalizeSidePaneState,
  openTab,
  reorderTab,
  resolveActiveAfterClose,
  resolveActiveForOwner,
  resolveTabsOverflow,
  scopeOf,
  SCOPE_LABEL,
  shouldKeepMounted,
  tabIdFor,
  type SidePaneScope,
  type SidePaneState,
  type SidePaneTab,
} from "../src/core/sidepane.ts";
import { isShellTool } from "../src/core/events.ts";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `\n      期望 ${String(expected)}，实际 ${String(actual)}`);
}

function tab(id: string, scope: SidePaneTab["scope"], ownerId?: string): SidePaneTab {
  return { id, type: "files", title: id, scope, ownerId, openedAt: 1 };
}

const s = (tabs: SidePaneTab[], activeTabId: string): SidePaneState => ({ tabs, activeTabId });

console.log("\n【1】关激活页签落到右邻，不是第一个");
{
  const st = s([tab("a", "workspace"), tab("b", "workspace"), tab("c", "workspace"), tab("d", "workspace")], "b");
  eq("关中间的第 2 页 → 落到原第 3 页", resolveActiveAfterClose(st, "b")?.activeTabId, "c");

  const st2 = s([tab("a", "workspace"), tab("b", "workspace"), tab("c", "workspace")], "c");
  eq("关末页 → 落到右邻（倒数第 2），不是第 1 页", resolveActiveAfterClose(st2, "c")?.activeTabId, "b");

  const st3 = s([tab("a", "workspace"), tab("b", "workspace")], "a");
  eq("关第 1 页 → 落到第 2 页", resolveActiveAfterClose(st3, "a")?.activeTabId, "b");

  const st4 = s([tab("a", "workspace")], "a");
  eq("关唯一一页 → state 变 null（面板收起）", resolveActiveAfterClose(st4, "a"), null);

  const st5 = s([tab("a", "workspace"), tab("b", "workspace"), tab("c", "workspace")], "a");
  eq("关非激活页 → 激活页保持不变", resolveActiveAfterClose(st5, "b")?.activeTabId, "a");
}

console.log("\n【2】可见性作用域");
{
  const st = s(
    [
      tab("w1", "workspace"),
      tab("s1", "session", "S1"),
      tab("s2", "session", "S2"),
      tab("r1", "root-session", "R1"),
    ],
    "w1",
  );
  eq("S1 下只看到工作区级 + 属于 S1 的", getVisibleTabs(st, "S1").map((t) => t.id).join(","), "w1,s1");
  eq("S2 下同理", getVisibleTabs(st, "S2").map((t) => t.id).join(","), "w1,s2");
  eq("R1 下看到 root-session 的那页", getVisibleTabs(st, "R1").map((t) => t.id).join(","), "w1,r1");
  eq("无会话（null）只看到工作区级", getVisibleTabs(st, null).map((t) => t.id).join(","), "w1");
}

console.log("\n【3】重排不改变 activeTabId");
{
  const st = s([tab("a", "workspace"), tab("b", "workspace"), tab("c", "workspace")], "b");
  const next = reorderTab(st, "a", "c");
  eq("顺序变为 b,c,a", next.tabs.map((t) => t.id).join(","), "b,c,a");
  eq("activeTabId 不变", next.activeTabId, "b");
  eq("拖到自己身上是 no-op", reorderTab(st, "a", "a"), st);
}

console.log("\n【4】owner 收窄后的激活修正");
{
  const st = s([tab("w1", "workspace"), tab("s1", "session", "S1"), tab("s2", "session", "S2")], "s2");
  eq("s2 不可见时优先落到会话型页", resolveActiveForOwner(st, "S1").activeTabId, "s1");
  const st2 = s([tab("w1", "workspace"), tab("s1", "session", "S1")], "w1");
  eq("当前页仍可见就不动", resolveActiveForOwner(st2, "S1").activeTabId, "w1");
  const st3 = s([tab("w1", "workspace"), tab("s1", "session", "S1")], "s1");
  // 切到无会话：s1 不可见，回落顺序是「会话型优先 → 可见集最后一个」
  // 此处可见集只有 w1，所以落到 w1 —— 与 ZCode 的 findLast ?? at(-1) 一致
  eq("切到无会话 → 可见集只剩工作区级，落到它", resolveActiveForOwner(st3, null).activeTabId, "w1");
}

console.log("\n【5】关闭语义");
{
  // closeOwnerTabs 关的是「该 owner 可见的」页。workspace 级页对每个 owner 都可见，
  // 所以它也会被关掉 —— 这正是 ZCode closeVisibleSidePaneTabs 的语义。
  const all = s([tab("w1", "workspace"), tab("s1", "session", "S1")], "s1");
  eq("关 S1 可见集 → 工作区级页也在内，返回 null", closeOwnerTabs(all, "S1"), null);

  const mixed = s(
    [tab("s1", "session", "S1"), tab("s2", "session", "S2")],
    "s1",
  );
  eq("只关 S1 自己的页，S2 保留", closeOwnerTabs(mixed, "S1")?.tabs.map((t) => t.id).join(","), "s2");
  eq("全部关完返回 null", closeOwnerTabs(s([tab("s1", "session", "S1")], "s1"), "S1"), null);
  eq("closeTab 走右邻回落", closeTab(s([tab("a", "workspace"), tab("b", "workspace")], "a"), "a")?.activeTabId, "b");
}

console.log("\n【6】打开：同 id 复用而非叠新页");
{
  // 注意 tab() 辅助函数把 type 固定成 "files"，复用判定会比对 type，所以这里要显式构造
  const cap = (): SidePaneTab => ({
    id: "capabilities",
    type: "capabilities",
    title: "能力",
    scope: "workspace",
    openedAt: 1,
  });
  const st = s([cap()], "capabilities");
  const again = openTab(st, { id: "capabilities", type: "capabilities", title: "能力", scope: "workspace" });
  eq("页签数不增加", again.tabs.length, 1);
  eq("type 不同则视为新页", openTab(st, { id: "files", type: "files", title: "文件", scope: "session" }).tabs.length, 2);
}

console.log("\n【7】搜索评分与多关键词 AND");
{
  const items = [
    { id: "files", searchFields: buildSearchFields("文件", "文件", "文件变更") },
    { id: "trace", searchFields: buildSearchFields("轨迹", "轨迹", "运行轨迹") },
    { id: "sub", searchFields: buildSearchFields("子代理", "子代理", "子代理") },
    { id: "lat", searchFields: buildSearchFields("Latency", "latency trace", "英文标签") },
  ];
  eq("标题前缀命中", filterAndRankSearchItems(items, normalizeSearchQuery("轨"))[0]?.id, "trace");
  eq("两个词都命中才算（AND）", filterAndRankSearchItems(items, normalizeSearchQuery("文件 变更"))[0]?.id, "files");
  eq("缺一个词就不命中", filterAndRankSearchItems(items, normalizeSearchQuery("文件 轨迹")).length, 0);
  eq("空查询返回全部", filterAndRankSearchItems(items, []).length, 4);
  eq("大小写不敏感", filterAndRankSearchItems(items, normalizeSearchQuery("LATENCY"))[0]?.id, "lat");
  eq("标题命中权重高于类型命中", filterAndRankSearchItems(items, normalizeSearchQuery("l"))[0]?.id, "lat");
}

console.log("\n【8】溢出判定");
{
  ok("6 个 tab 在 200px 里放不下", resolveTabsOverflow({ addButtonInside: true, addButtonWidth: 26, tabCount: 6, viewportWidth: 200 }));
  ok("3 个 tab 在 400px 里放得下", !resolveTabsOverflow({ addButtonInside: true, addButtonWidth: 26, tabCount: 3, viewportWidth: 400 }));
}

console.log("\n【9】常驻挂载");
{
  ok("面板可见 → 挂载", shouldKeepMounted(true, []));
  ok("面板不可见但有 keepMounted 页 → 仍挂载", shouldKeepMounted(false, [{ ...tab("x", "workspace"), keepMounted: true }]));
  ok("面板不可见且无 keepMounted 页 → 不挂载", !shouldKeepMounted(false, [tab("y", "workspace")]));

  const mount = ["browser", "browser-use", "bash-output", "terminal"] as const;
  for (const t of mount) {
    ok(`${t} 由 makeTabDraft 标为 keepMounted`, makeTabDraft(t, "S1").keepMounted === true);
  }
}

console.log("\n【10】页签类型全集：24 种，元数据 / 作用域 / 目录无缺口");
{
  eq("类型总数 = 24（ZCode 19 类，一类多形态时逐个展开）", ALL_TAB_TYPES.length, 24);
  eq("无重复", new Set(ALL_TAB_TYPES).size, ALL_TAB_TYPES.length);

  const missingMeta = ALL_TAB_TYPES.filter((t) => !metaOf(t).title || !metaOf(t).typeLabel || !metaOf(t).hint);
  eq("每种都有 title / typeLabel / hint", missingMeta.join(","), "");

  const badScope = ALL_TAB_TYPES.filter((t) => !SCOPE_LABEL[scopeOf(t)]);
  eq("每种都有合法作用域", badScope.join(","), "");

  // 目录（可见集合）必须 = 全集 − 隐藏集合
  const visible = listVisibleTabTypes();
  eq("目录里 23 种（treemapping 被隐藏）", visible.length, 23);
  eq("treemapping 是唯一的隐藏类型", [...HIDDEN_TAB_TYPES].join(","), "treemapping");
  ok("隐藏类型不出现在目录里", !visible.includes("treemapping"));

  // 分组必须恰好覆盖目录里的每一种，且不重不漏
  const groups = groupTabTypesByScope();
  const flat = groups.flatMap((g) => g.types);
  eq("三段分组总数 = 目录总数", flat.length, visible.length);
  eq("分组后无重复", new Set(flat).size, flat.length);
  ok("分组顺序 = workspace → session → root-session", groups.map((g) => g.scope).join(",") === "workspace,session,root-session");
  const scopeMismatch = flat.filter((t) => groups.find((g) => g.types.includes(t))?.scope !== scopeOf(t));
  eq("每种都被分进自己作用域的段", scopeMismatch.join(","), "");
  const noneGrouped = ALL_TAB_TYPES.filter((t) => !flat.includes(t));
  eq("唯一没进目录的是隐藏类型", noneGrouped.join(","), "treemapping");
}

console.log("\n【11】normalizeSidePaneState 过滤隐藏类型");
{
  const st = s([{ ...tab("a", "workspace"), type: "git" }, { ...tab("b", "workspace"), type: "treemapping" }], "a");
  const out = normalizeSidePaneState(st);
  eq("treemapping 被剔除", out?.tabs.map((t) => t.id).join(","), "a");
  eq("激活页仍可见则保留", out?.activeTabId, "a");

  const onlyHidden = s([{ ...tab("b", "workspace"), type: "treemapping" }], "b");
  eq("过滤后为空 → 整个 state 变 null", normalizeSidePaneState(onlyHidden), null);
  eq("入参 null → null", normalizeSidePaneState(null), null);

  const lostActive = s([{ ...tab("b", "workspace"), type: "treemapping" }, tab("a", "workspace")], "b");
  eq("激活页被过滤掉 → activeTabId 清空而非指向不存在的页", normalizeSidePaneState(lostActive)?.activeTabId, "");
}

console.log("\n【12】页签 id 形态与打开前置条件");
{
  // 工作区级不带归属；会话级必须带，否则两条会话共用一页
  eq("工作区级 id 就是类型名", tabIdFor("git", null), "git");
  eq("工作区级传了 ownerId 也不带（全局页不认归属）", tabIdFor("git", "S1"), "git");
  eq("会话级 id 带归属", tabIdFor("files", "S1"), "files@S1");
  eq("会话树根级 id 带归属", tabIdFor("bash-output", "R1"), "bash-output@R1");
  eq("带 subject 时再缀一段（code-viewer 一文件一页）", tabIdFor("code-viewer", null, "src/app.tsx"), "code-viewer:src/app.tsx");

  const d = makeTabDraft("files", "S1");
  eq("draft 的 scope 取自类型", d.scope, "session");
  eq("draft 的归属 = ownerId", d.ownerId, "S1");
  eq("draft 的标题取自 TAB_META", d.title, "文件");
  eq("带 subject 时标题取文件名", makeTabDraft("code-viewer", null, "src/core/sidepane.ts").title, "查看 · sidepane.ts");

  // 两条会话各有各的一页，互不串
  const a = makeTabDraft("files", "S1");
  const b = makeTabDraft("files", "S2");
  ok("不同会话生成不同 id", a.id !== b.id);

  const scopes: SidePaneScope[] = ["workspace", "session", "root-session"];
  for (const scope of scopes) {
    const types = ALL_TAB_TYPES.filter((t) => scopeOf(t) === scope);
    ok(`${scope} 级有页签（${types.length} 种）`, types.length > 0);
  }
  eq("工作区级无需会话即可开", canOpenTab("git", null), true);
  eq("会话级无会话开不了", canOpenTab("files", null), false);
  eq("会话树根级无会话开不了", canOpenTab("subagent", null), false);
  eq("有会话就能开", canOpenTab("files", "S1"), true);
  eq("开不了时给出原因", blockedReason("files", null), "需先打开一条会话");
  eq("能开时无原因", blockedReason("git", null), null);

  // 未接运行时的页签必须都写明缺什么
  const needsRuntime = ALL_TAB_TYPES.filter((t) => NEEDS_RUNTIME[t]);
  for (const t of needsRuntime) {
    const n = NEEDS_RUNTIME[t]!;
    ok(`${t} 写明了缺什么 + 什么时候接`, Boolean(n.needs && n.when));
  }
  ok("无运行时的页签没被藏起来（仍在目录里）", needsRuntime.every((t) => listVisibleTabTypes().includes(t)));
}

console.log("\n【13】bash-output 只认 shell 类工具");
{
  for (const n of ["Bash", "bash", "run_shell", "execute_command", "terminal.exec", "LocalShell", "powershell"])
    ok(`${n} 算 shell 调用`, isShellTool(n));
  for (const n of ["Write", "Edit", "Read", "web_search", "Task"])
    ok(`${n} 不算 shell 调用`, !isShellTool(n));
}

console.log("\n【14】徽标从事件流派生，不存进 tab");
{
  const sid = "S1" as never;
  const diff = (path: string, s: string) =>
    ({ type: "file.diff", sessionId: s, path, additions: 1, deletions: 0 }) as const;
  const started = (callId: string, name: string) =>
    ({ type: "tool.started", sessionId: sid, callId, toolName: name, title: name, input: null }) as const;
  const done = (callId: string, ok: boolean) =>
    ({ type: "tool.completed", sessionId: sid, callId, ok }) as const;

  const events = [
    diff("a.ts", sid),
    diff("a.ts", sid), // 同一文件重复计数吗？不
    diff("b.ts", sid),
    started("c1", "Bash"),
    done("c1", true),
    started("c2", "Write"),
    done("c2", false),
  ];
  const b = deriveTabBadges(events, "S1");
  eq("git 按去重后的文件数计", b.get("git"), 2);
  eq("files 与 git 同源同值（同一会话）", b.get("files"), 2);
  eq("shell 调用进 bash-output", b.get("bash-output"), 1);
  eq("失败的工具调用进 developer-tools", b.get("developer-tools"), 1);
  eq("Write 不进 bash-output（isShellTool 过滤）", b.get("bash-output"), 1);
  ok("没有数据的类型不给徽标（不制造噪声）", !b.has("capabilities") && !b.has("deliverables"));

  // 作用域：会话级徽标只算本会话
  const other = "S2" as never;
  const mixed = deriveTabBadges([diff("a.ts", sid), diff("z.ts", other)], "S1");
  eq("git 是工作区级，跨会话全算", mixed.get("git"), 2);
  eq("files 是会话级，只算本会话", mixed.get("files"), 1);

  // 待裁决权限
  const perm = deriveTabBadges(
    [
      { type: "permission.requested", sessionId: sid, requestId: "p1", kind: "shell", detail: "x", risk: "low" },
      { type: "permission.resolved", sessionId: sid, requestId: "p1", decision: "allow" },
      { type: "permission.requested", sessionId: sid, requestId: "p2", kind: "shell", detail: "y", risk: "low" },
    ],
    "S1",
  );
  eq("已裁决的不计，未裁决的计", perm.get("trace"), 1);

  // 计划：只算没做完的
  const plan = deriveTabBadges(
    [
      {
        type: "plan.proposed",
        sessionId: sid,
        planId: "x",
        title: "t",
        steps: [
          { id: "s1", title: "a", status: "done" },
          { id: "s2", title: "b", status: "pending" },
          { id: "s3", title: "c", status: "skipped" },
        ],
      },
    ],
    "S1",
  );
  eq("计划徽标 = 未完成且未跳过的步骤", plan.get("plan"), 1);

  // 子代理：只算没结束的
  const sub = deriveTabBadges(
    [
      { type: "subagent.spawned", sessionId: sid, childId: "a", role: "r", runtimeId: "x" },
      { type: "subagent.spawned", sessionId: sid, childId: "b", role: "r", runtimeId: "x" },
      { type: "subagent.finished", sessionId: sid, childId: "a", ok: true },
    ],
    "S1",
  );
  eq("子代理徽标 = 进行中数量", sub.get("subagent"), 1);

  eq("空事件流没有任何徽标", deriveTabBadges([], "S1").size, 0);
}

console.log(`\n${"─".repeat(46)}`);
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log(`${"─".repeat(46)}\n`);
process.exit(fail === 0 ? 0 : 1);
