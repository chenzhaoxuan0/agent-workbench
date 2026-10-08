# Design System — 中性灰阶 + 单一青色强调
> 黑白灰的克制，让内容说话

**Theme:** light

> ⚠ **这份文档在 2026-10-02 被整体重写。**
> 上一版是 *Perplexity 羊皮纸风格参考*（暖白画布 `#faf8f5`、暖调墨色 `#27251e`、
> 「画布永远不用纯白」）。那一版随换皮一并作废，不要再照它写组件。
> 换皮动的是 `src/styles.css` 的 `@theme` 块，本文是它的规范来源，两者必须一致。

---

## 换皮改了什么、为什么

对标 Grok @Bot 的视觉取向：黑白灰、扁平、单色克制。
它的设计哲学是「**最好的 UI 就是没有 UI**」——视觉上把噪声降到最低，
让内容本身成为唯一的层次来源。

| 维度 | 上一版（Perplexity） | 现在 | 理由 |
|---|---|---|---|
| 画布 | `#faf8f5` 暖白羊皮纸 | `#fafafa` 中性浅灰 | 暖调在纯数字界面上会显旧；灰阶更接近「工具」而非「书页」 |
| 卡片 | `#fdfbfa`（比画布亮 1 档，肉眼几乎看不出） | `#ffffff`（比画布亮 1 档，肉眼明确） | 上一版的卡片/画布差只有 5/255，卡片浮不起来，全靠那道阴影撑着 |
| 墨色 | `#27251e` 暖调深黑 | `#0a0a0a` 真黑 | 去掉暖调，中性色阶 R=G=B |
| 次要文字 | `#72706b` | `#525252` | 对比度提高，灰底上更清楚 |
| 辅助文字 | `#92918b` | `#8a8a8a` | 同上 |
| 边框 | `#d1d1cd` 暖灰 | `#e4e4e4` 纯灰 | 去暖调 |
| 强调色 | `#016a71` 深青 | **不变** | 见下 |

### 卡片与画布的关系变了

上一版：卡片只比画布亮一点点，**视觉分离几乎全靠那道 1px 阴影**。
现在：画布是灰的、卡片是纯白的，**色阶差本身就把卡片托起来了**。
阴影从「唯一分隔手段」降级为「锦上添花」，强度也从 `0.08` 降到 `0.06`。

这是换皮里最实质的一处结构性变化，不是换个色值那么轻。

### 为什么保留了青色

黑白灰观感来自**画布与文字**——它们占界面 95% 的像素，这两块已经全部中性化。
青色只出现在这些地方：选中态底色、焦点环、勾选、运行中状态点、已选中标签下划线。

把它去掉不是换皮，是重写 **156 处组件用法**：所有「选中」都要改用
`bg-ink + text-canvas` 的反色表达，所有 `text-teal` 链接都要改成 `text-ink`，
`teal-tint` 的浅填充要变成灰阶——改完之后系统里就没有「颜色承载语义」这回事了，
跟「执行器品牌色」也就彻底分不开了。

**保留单一彩色，本身就是这个设计系统最核心的纪律**（见下方 Don't 第 1 条）。
Grok 的界面是「黑白灰」，没说「全无彩色」。

---

## Tokens

### Colors

| 角色 | Value | Token | 用在哪 |
|---|---|---|---|
| Canvas | `#fafafa` | `--color-canvas` | 页面底色、输入框底 |
| Rail | `#f4f4f4` | `--color-rail` | 侧栏、composer 底、右栏 rail 列 |
| Card | `#ffffff` | `--color-card` | 卡片面（**靠比 canvas 亮一档浮起**） |
| Line | `#e4e4e4` | `--color-line` | 1px 发丝边框、分隔线 |
| Line soft | `#f0f0f0` | `--color-line-soft` | 卡内更浅的分隔 |
| Surface hover | `#f4f4f4` | `--color-surface-hover` | **通用悬停面**。新增，用来消灭组件里写死的色值 |
| Ink | `#0a0a0a` | `--color-ink` | 正文、图标、实心按钮底 |
| Graphite | `#525252` | `--color-graphite` | 次要文字、导航图标 |
| Ash | `#8a8a8a` | `--color-ash` | 辅助说明、时间戳 |
| Teal | `#016a71` | `--color-teal` | **全场唯一彩色**。选中态、焦点环、链接 |
| Teal tint | `#e6f0f0` | `--color-teal-tint` | 选中态浅底 |
| Teal edge | `#a9c6c8` | `--color-teal-edge` | 选中态边框 |
| Gain | `#2f6b4f` | `--color-gain` | diff 新增、ready 状态点 |
| Loss | `#9a4a3c` | `--color-loss` | diff 删除、失败、**「完全放行」警示** |

### 允许存在的彩色：数据，不是装饰

三类彩色**不计入「单色纪律」**，因为它们承载数据而非装饰：

1. **执行器品牌色** —— `RuntimeEntry.presentation.accent`，六家 CLI 各一色，
   出现在 16–20px 身份徽标上。
2. **bot 身份色** —— `BOT_COLORS` × `BOT_SHAPES`，由单元名哈希出稳定的「颜色 × 形状」，
   同一个 bot 永远长一样（`Sidebar.tsx` 的 `botAvatarStyle`）。
3. **任务分组色** —— 写作/巡检的圆点。

判据：**换掉它用户就认不出那是谁。** 反过来，任何「让页面好看一点」的彩色都不允许。

### Typography

- **Family**: Inter, Segoe UI Variable Text, system-ui，带 PingFang SC / Microsoft YaHei 回退
- **Weights**: 400, 500。**没有 600+**，层次靠颜色和间距，不靠字重
- **Sizes**: 11 / 12 / 14 / 16px
- **Line height**: caption 1.43 · body-sm 1.43 · body 1.43 · body-lg 1.43
- **Letter spacing**: 全局 0

数字（时间戳、计数、token 数）一律加 `.tnum`（`font-variant-numeric: tabular-nums`），
避免数值变化时字符跳动。

### Spacing & Shapes

- **Base unit**: 4px
- **Density**: compact
- **Spacing**: 4 / 8 / 12 / 16 / 32px
- **Radius**: cards 16 · inputs 12 · buttons 6 · chips 9999（四档，不越界）
- **Shadow**: 全场只有一道 `0 1px 2px rgb(0 0 0 / 0.06)`

### Layout

- **Page max-width**: 900px
- **Section gap**: 32px
- **Card padding**: 16px
- **Element gap**: 8px
- **Sidebar**: 264px 起，可拖拽，最大视口 50%
- **主列**：在 1280px 视口下约 1076px（右栏默认收起，见 README「渐进披露」）

---

## Components

### Suggestion Card
`bg-card` + 16px 圆角 + 12px 纵向内边距 + `shadow-subtle` + `hover:bg-surface-hover`。
纯白面浮在灰画布上，**不靠边框**。标题 14px/500 ink，副文 14px graphite。两列网格。

### Composer Input
`bg-canvas` + 12px 圆角 + `border-line`，聚焦时 `border-teal` +
`shadow-[0_0_0_3px_rgb(1_106_113/0.12)]`。**全系统唯一的装饰性效果**（青色光晕）。
放在 `bg-rail` 上，比自己的容器亮一档。

### Filled Action Button
`bg-ink`（#0a0a0a）+ `text-canvas` + 6px 圆角。
**全场唯一的实心按钮样式**——发送、停止、设置页的主操作都用它。

### Ghost Button
透明底 + graphite 文字 + 1px line 边框 + 6px 圆角。悬停转 `bg-line-soft` + ink。

### Pill Chip
9999px 全圆角。激活态填 `bg-teal-tint` + `text-teal`。

### Badge
`bg-teal` + 白字 + 9999px + 11px/500。标记「新」等状态，不换颜色。

---

## Do's and Don'ts

### Do

- 画布用 `#fafafa`，**卡片用纯白**——两者拉开明度差是卡片浮起的唯一依据
- 正文 `#0a0a0a`，次要 `#525252`，辅助 `#8a8a8a`
- 青色只用于：选中态底、焦点环、勾选、链接、运行中状态点
- 圆角严格四档：卡片 16 / 输入 12 / 按钮 6 / 胶囊 9999
- 字重只在 400 / 500
- 悬停底色**一律走 `--color-surface-hover`**，不要在组件里写死色值
- 数字加 `.tnum`

### Don't

- ❌ **不要引入第二个 UI 彩色。** 系统是「中性灰 + 唯一青色」，第二个彩色会打破克制
- ❌ **不要用 600+ 字重。** 层次靠颜色和间距
- ❌ **不要在组件里写死 hex 色值。** 换肤只能改 `styles.css` 一个文件。
  唯一例外是上面「允许存在的彩色：数据」那三类
- ❌ **不要给输入框用纯白。** 它的容器是 rail（#f4f4f4），纯白会和卡片混
- ❌ **不要给青色上文字以外的用法**（不要拿它画图标）
- ❌ **不要加投影。** 除卡片那道 `shadow-subtle` 外一律不加
- ❌ **不要加渐变、模糊、装饰性插图**
- ❌ **不要在卡片上同时加边框和阴影**——二选一，白卡片靠明度差就够了

---

## 速查

```
canvas      #fafafa     页面底
rail        #f4f4f4     侧栏 / composer 底
card        #ffffff     卡片
line        #e4e4e4     边框
line-soft   #f0f0f0     卡内分隔
hover       #f4f4f4     通用悬停

ink         #0a0a0a     正文
graphite    #525252     次要
ash         #8a8a8a     辅助

teal        #016a71     唯一彩色：选中 / 焦点 / 链接
teal-tint   #e6f0f0     选中底
gain        #2f6b4f     新增 / ready
loss        #9a4a3c     删除 / 失败 / 完全放行
```

### Tailwind v4

所有令牌在 `src/styles.css` 的 `@theme` 块里声明，Tailwind 自动生成工具类
（`bg-canvas` / `text-graphite` / `border-line` / `hover:bg-surface-hover` …）。
**改配色只改那个块，不要去组件里覆盖。**
