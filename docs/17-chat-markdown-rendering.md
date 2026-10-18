# 对话内容富渲染改造计划（markdown + 流式 + 高亮）

> 目标：把聊天时间线里助手最终输出从「手写极简 markdown」升级为完整 GFM 富渲染，
> 并补齐流式打字机、语法高亮与自动吸底滚动。
> 依据：ZCode 仓库（`zocdeusually/ZCode`）渲染管线源码走查（2026-10-18，
> 重点 `packages/ui/src/components/ai-elements/message.tsx`、`code-block.tsx`、
> `lib/shikiHighlighter.ts`）+ 本仓现状核实（MarkdownContent.tsx / Timeline.tsx /
> HistoryDialog.tsx / docs/01-tech-stack.md §3.8）。本文是收敛后的执行计划。

---

## 一、问题与根因

助手最终输出"看起来像纯文本"的根源在 `prototype/src/ui/MarkdownContent.tsx`
（243 行手写零依赖解析器，随 8585086 引入）。它的能力边界：

| 已支持 | 缺失（原文裸露，观感即纯文本） |
|---|---|
| 围栏代码块（无高亮）、复制按钮 | **表格**（`\|` 竖线裸露） |
| `#`/`##`/`###` 三级标题 | **链接**（`[t](u)` 原文） |
| `>` 引用 | **有序列表、嵌套列表、任务列表** |
| `- `/`* ` 平铺无序列表 | 斜体、删除线、图片、分隔线 |
| 行内 code、`**bold**` | **语法高亮**（代码是纯 `<pre><code>`） |

另有两个体验短板（本次一并解决）：

1. **无打字机效果**：后端适配器已在 WS 上广播增量式 assistant `message.delta`
   （`backend/src/runtime/adapters/zcode.ts:239`、`claude.ts:714`，与
   reasoning.delta 同为增量拼接语义），但前端 `Timeline.tsx:151-160` 把它丢弃，
   最终答案只在 `message.completed`（Timeline.tsx:172-174）一次性出现。
2. **无自动滚动**：Timeline 容器（`Timeline.tsx:61`）只是 `overflow-y-auto`，
   全仓无吸底/滚动锚定逻辑。

---

## 二、ZCode 渲染管线走查结论（参考对象）

ZCode 的 Web/桌面聊天正文渲染核心在 `packages/ui/src/components/ai-elements/message.tsx`
（`MessageResponse`，L1314-1660），技术选型与关键设计：

### 2.1 选型

| 库 | 版本 | 许可证 | 角色 |
|---|---|---|---|
| `streamdown` | 2.5.0 | **Apache-2.0**（已核实 node_modules） | 正文主渲染器：react-markdown 的流式替代品，remark/rehype 体系 |
| `shiki` | 4.0.2 | MIT | 代码高亮（本仓 docs/01-tech-stack.md §3.8 已预审） |
| `@pierre/diffs` | 1.1.22 | Apache-2.0 | 代码查看器（本次不引入，聊天场景过重） |
| `use-stick-to-bottom` | 1.1.3 | MIT | 贴底滚动（本次手写等价 hook，不引入） |
| `@streamdown/{cjk,math,mermaid}` | — | — | 插件（本次不需要，留作后续增强） |

streamdown 同时解决"静态渲染质量"与"流式容错"两件事，且是
ZCode 实际采用 + Apache-2.0 干净，优于预审清单里的 react-markdown
（后者流式容错需自研，最终仍会收敛到同生态）。

### 2.2 值得移植的设计模式（按优先级）

1. **流式/静态双模式**：只有活跃流式消息走 `mode="streaming"`
   （`parseIncompleteMarkdown` 容错未闭合代码块 + 分块缓存增量渲染）；
   完成态/历史固定 `mode="static"`——一举解决性能、重挂载、
   "对已完成文本误补 `**`"三个问题（message.tsx L700-706、L1628-1633 注释）。
2. **流式期间禁用昂贵增强**：`enableSyntaxHighlighting={!renderStreaming}`、
   `renderMermaid={!renderStreaming}`（L1567、L1570）——流式围栏被反复拆分/
   重挂载，异步 highlighter 叠加更新会触发 React #185 类竞态。
3. **单条消息级错误边界**：`MessageResponseMarkdownBoundary`（L708-748）——
   markdown 渲染崩溃时降级 `whitespace-pre-wrap` 纯文本，不冒泡炸整个时间线。
4. **React key 编排**：key 含 sessionId/主题/字号等设置项但**不含 streaming 模式**
   ——模式切换不卸载子树；设置变化才强制重挂载（L857-883）。
5. **链接三分类**：http(s) → 可点（button + 安全分流）；工作区文件 → 图标 +
   编辑器菜单；**其它协议 → 不可点 span**（rehype-harden 前置规整 href，
   `file://`/未知 scheme 拦为 `[blocked]`）。
6. **shiki 高亮基建**（`lib/shikiHighlighter.ts`）：highlighter 按
   `theme:language` 缓存；token 缓存 key 用"前 100 + 后 100 字符 + 长度"；
   纯文本语言（text/log/plain）短路不进 shiki；cache-hit 回调用
   `queueMicrotask` 推迟避免同步 setState 嵌套更新。
7. **有序列表 `list-inside`**：两位/三位编号在 `overflow-hidden` 气泡里
   会被截断（`markdown-list.tsx` L33-52 注释）。
8. **思考过程故意不走 markdown**：thought 超长且流式追加，逐 chunk 重跑
   markdown 解析会越来越卡（`reasoning.tsx` L555-560 注释）——
   本项目 ThinkingBlock 保持纯文本，有先例背书。
9. **样式不套 prose**：每个 markdown 元素自定义 renderer + Tailwind 类，
   字号跟随 UI token 缩放——与本项目四档字号令牌体系天然吻合。

**不照搬的部分**：表格的 1400 行虚拟滚动条/CSV 导出（`markdown-table.tsx`，
过度工程，本次横向滚动容器够用）；`@pierre/diffs` 代码查看器；mermaid/math
插件；虚拟滚动 live-tail 拆分（`@tanstack/react-virtual` 尚未引入）。

---

## 三、实施步骤

### 步骤 1：安装依赖

```
cd prototype && pnpm add streamdown shiki
```

当前零 markdown 依赖（pnpm-lock.yaml 已核实），无遗留冲突。

### 步骤 2：重写 `prototype/src/ui/MarkdownContent.tsx`（核心）

保持导出名 `MarkdownContent({ content, className, streaming? })`，
`Timeline.tsx:664` 现有调用点不破坏。内部改为 `<Streamdown>`：

- `mode={streaming ? "streaming" : "static"}`、`parseIncompleteMarkdown={streaming}`、
  `animated={false}`（防历史文本整段重闪烁）
- **完整组件映射，样式严格走项目令牌**（canvas/rail/card/line/line-soft、
  ink/graphite/ash、四档字号 + `--aw-font-scale`）：
  - 标题 h1-h6 递减阶梯——**保留现有"标题阶梯只用四档字号"的教训注释**
    （`text-title` token 不存在导致层级反转的前车之鉴，MarkdownContent.tsx:20-29）
  - 段落 `text-ink leading-relaxed`；`ul` list-disc + marker:text-ash；
    `ol` **list-inside**（ZCode 教训）；li 内段落转行内
  - `blockquote`：border-l-2 border-line pl-3 text-graphite
  - `a`：http(s) → `target=_blank rel=noreferrer`；**其它协议 → 不可点 span**
  - `table`：外层 `overflow-x-auto` 容器 + 表头 bg-rail + 单元格 border-line
  - `img`：max-w-full rounded 懒加载；`hr`：border-line
  - 行内 code：沿用现有样式（bg-line-soft font-mono text-[0.88em]）
- **CodeBlock 升级**：保留现有头部（语言标签 + 复制按钮，67-98 行），
  正文接入 shiki（见步骤 2b）
- **新增 `MarkdownBoundary`**：单条消息渲染崩溃 → 降级 `whitespace-pre-wrap`
  纯文本（ZCode 模式 3）

实现时先对照 node_modules 里 streamdown 2.5.0 的 d.ts 核实 props 签名；
全量组件覆写后预计无需 import 它的 `styles.css`（若基础布局缺失再补，
并检查 Tailwind v4 `@source` 是否需要扫描 streamdown dist——ZCode 在
styles.css L8 这么做过）。

### 步骤 2b：新建 `prototype/src/ui/shikiHighlighter.ts`

- `import("shiki")` 懒加载单例 highlighter（首个代码块才加载，不拖累首屏）
- highlighter 按 `theme:language` 缓存；token 缓存 key 用
  "前 100 + 后 100 字符 + 长度"（ZCode 模式 6）
- 纯文本语言（text/log/plain/…）短路直接返回 raw token，不进 shiki
- 用 `codeToTokens` 产出 token → React span 内联样式渲染，
  **全程无 dangerouslySetInnerHTML**（本仓现有 XSS 面干净，保持）
- 主题跟随应用亮暗主题（appearance store），选一对轻量主题
  （如 github-light / github-dark）
- `streaming` 期间不高亮（纯 pre/code），完成态切 static 后自动补上
  （ZCode 模式 2）

### 步骤 3：Timeline 接入流式打字机 + 自动吸底（`prototype/src/ui/Timeline.tsx`）

- **归并逻辑**（151-174 行）：`message.delta role:"assistant"` 参照
  reasoning.delta（162-170）的连续拼接模式，归并成 `streaming: true` 的
  `assistant.message` 项；`message.completed` 到达时若前一项是**同 messageId**
  的流式项则原位替换为全文并置 `streaming: false`（key 不变，不重挂载，
  ZCode 模式 4）；messageId 不匹配则新开一项；中间穿插 tool/thinking 事件
  则断开归并
- **AssistantMessageBlock**（645 行）增加 `streaming` prop 透传给
  MarkdownContent；流式态可显示光标/脉冲提示
- **吸底滚动**：为 61 行滚动容器加 ref，手写 ~30 行 `useStickToBottom` hook
  （用户距底 <40px 视为"贴底"，贴底时内容变化自动滚到底；上滚则暂停；
  可选加"回到底部"浮标）。不引入 use-stick-to-bottom（零冗余依赖 ethos）
- 历史回放（openSession）与移动端复用同一 Timeline，自动受益，无需另改

已知取舍：每个 delta 触发 `groupTimelineEvents` 全量重建——reasoning.delta
已经是同一模式且可接受；streamdown streaming 模式自带分块缓存，重解析成本
可控。若实际卡顿再考虑 ZCode 的 live-tail 拆分优化（不在本次范围）。

### 步骤 4：HistoryDialog 历史转录升级（`prototype/src/ui/HistoryDialog.tsx`）

482-535 行转录列表中，`kind === "assistant"` 的行从纯 `<p>` 换成
`<MarkdownContent content={e.text} />`（static 模式，紧凑 className）；
用户/工具/思考行保持纯文本（工具输出本就 mono、思考走 ZCode 模式 8）。

### 步骤 5：文档同步（`docs/01-tech-stack.md` §3.8）

把 streamdown（Apache-2.0，ZCode 采用）和 shiki 标记为"已引入"，
注明取代预审清单里 react-markdown 的原因（流式能力 + 同生态）。

---

## 四、验证清单

- `pnpm typecheck`（根命令，前后端一起；本仓无测试框架）
- 手动清单（`pnpm dev`）：
  - [ ] GFM 全要素：表格 / 链接 / 有序・嵌套・任务列表 / 斜体删除线 /
        分隔线 / 行内代码 / 图片
  - [ ] 代码块：多语言高亮、长行横向滚动、复制按钮、纯文本语言短路
  - [ ] 中文排版、亮暗主题切换、字号缩放（`--aw-font-scale`）
  - [ ] 流式：打字机逐字出现、流式中未闭合 ``` 不炸、completed 后高亮
        补上且无闪烁、滚动贴底/上滚暂停
  - [ ] 历史回放（openSession）与移动端布局正常
  - [ ] HistoryDialog 转录里 assistant 走 markdown
  - [ ] 构造异常 markdown 确认错误边界降级纯文本

---

## 五、改动文件清单

| 文件 | 动作 |
|---|---|
| `prototype/package.json` + lockfile | 新增 streamdown、shiki |
| `prototype/src/ui/MarkdownContent.tsx` | 重写（streamdown + 组件映射 + 错误边界） |
| `prototype/src/ui/shikiHighlighter.ts` | 新建（懒加载/双层缓存/纯文本短路） |
| `prototype/src/ui/Timeline.tsx` | assistant delta 归并 + streaming 透传 + 吸底滚动 |
| `prototype/src/ui/HistoryDialog.tsx` | assistant 行走 markdown |
| `docs/01-tech-stack.md` | §3.8 状态同步 |

不改动：`core/events.ts` / 后端 contract（数据已到位）、ThinkingBlock /
ToolCallBlock（纯文本先例）、用户气泡、Composer。

与 docs/18（对话分叉实施计划）的衔接：两者都改 `groupTimelineEvents`，
本计划先行落地，分叉的时间线拼接直接复用本文的渲染与流式地基。
