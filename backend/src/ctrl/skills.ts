/**
 * 浏览器 / 电脑控制的配套技能（docs/14 §5）。
 *
 * 技能文本内嵌在代码里随仓库版本化；启用对应能力时装进公共技能源
 * ~/.agents/skills/（.agents 规范公共库，全部执行器都能发现）。
 * 纪律：只在缺失时写入，**绝不覆盖**用户改过的副本；停用不删——
 * 技能没有工具时是惰性文本，删用户目录里的东西不是设置页该做的事。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logControlAction, skillsHomeDir } from "./store.ts";

const BROWSER_SKILL = `---
name: browser-control
description: 用 playwright 的 MCP 工具（browser_*）操作浏览器：导航、读页面、点击、输入、截图。需要打开网页、填表、抓取页面内容、或对 Web 应用做端到端验证时使用。
---

# 浏览器控制（playwright MCP）

你可以通过 MCP 服务 playwright 驱动一个真实浏览器。核心工作流：

1. **先快照，后动作**：\`browser_snapshot\` 返回页面的无障碍树，每个可交互元素带
   \`ref=eN\] 标记。用它定位元素，不要猜坐标。
2. **用 ref 操作**：\`browser_click {element: "搜索框", ref: "e24"}\`、
   \`browser_type {element, ref, text}\`、\`browser_fill_form\`（多字段一次填）。
3. **导航与等待**：\`browser_navigate {url}\` 之后页面自动等加载；动态内容用
   \`browser_wait_for {text}\`。
4. **截图只在做视觉判断时用**（布局对不对、图表长什么样），日常交互靠快照——
   又省 token 又准确。
5. **多标签页**：\`browser_tabs {action: "list"|"new"|"select"}\`。
6. 页面改了就重新 \`browser_snapshot\`（ref 会失效），不要拿旧 ref 硬点。

登录态：浏览器 profile 由工作台管理并持久化，登录一次后续会话直接可用。
同一浏览器的登录态在多个会话间共享（接管模式）或按执行器隔离（隔离模式）。
`;

const COMPUTER_SKILL = `---
name: computer-control
description: 用 workbench-computer 的 MCP 工具（computer_*）操作真实桌面：截图、点击、输入、滚轮、组合键、窗口管理。需要操作浏览器之外的本地应用（安装程序、办公软件、系统设置、旧式界面）时使用。
---

# 电脑控制（workbench-computer）

你通过 MCP 服务 workbench-computer 直接操作用户真实桌面。动作是真实键鼠，
没有沙箱——按之前想清楚。

标准工作流：

1. **先看再动**：\`computer_screenshot\` 拿到当前屏幕（PNG + 尺寸）。
2. **坐标一律相对最近一次截图**，不要跨步骤复用旧坐标（界面可能已变化）。
3. 点击 / 拖拽 / 滚轮：\`computer_click {x,y}\`、\`computer_drag {x1,y1,x2,y2}\`、
   \`computer_scroll {x,y,amount}\`（amount 正数向下）。
4. 输入文本：\`computer_type {text}\`（中文自动走剪贴板，无需关心 IME）；
   快捷键：\`computer_key {combo:"ctrl+s"}\`（键名小写，+ 连接）。
5. **窗口优先于坐标**：\`computer_window_list\` 拿句柄，\`computer_window_activate
   {handle}\` 前置目标窗口，比盲点任务栏可靠。
6. 每步之后截图确认结果，再决定下一步。

错误语义：

- \`CONTROLLER_BUSY\`：另一个会话持有输入权。**不可重试**——等它结束，或调用
  \`computer_stop\` 释放（急停会让出输入权）。
- 工具回复「电脑控制未启用」：总闸被关了，请用户在设置里开启。

高危动作（删除、发送消息、支付、关机类）先向用户说明将做什么并征得同意。
`;

/** 装（或确认已在）公共技能源；返回是否新写入。目标目录来自 ctrl/store 上下文（冒烟可注入临时目录） */
function installSkill(dirName: string, markdown: string): boolean {
  const skillDir = join(skillsHomeDir(), dirName);
  const target = join(skillDir, "SKILL.md");
  if (existsSync(target)) {
    logControlAction(dirName === "browser-control" ? "browser" : "computer", "skill", `技能 ${dirName} 已存在，未覆盖`);
    return false;
  }
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(target, markdown, "utf8");
  return true;
}

export function installBrowserControlSkill(): void {
  const wrote = installSkill("browser-control", BROWSER_SKILL);
  logControlAction("browser", "skill", wrote
    ? "技能 browser-control 装入 ~/.agents/skills/（全部执行器可见）"
    : "技能 browser-control 已在位");
}

export function installComputerControlSkill(): void {
  const wrote = installSkill("computer-control", COMPUTER_SKILL);
  logControlAction("computer", "skill", wrote
    ? "技能 computer-control 装入 ~/.agents/skills/（全部执行器可见）"
    : "技能 computer-control 已在位");
}
