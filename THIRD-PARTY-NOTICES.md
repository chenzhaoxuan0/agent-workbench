# 第三方声明（Third-Party Notices）

本项目（MIT）包含来自以下项目的代码与资产。各原始许可文本附于本文件末尾。
设计层面的参照（对齐/借鉴的架构与交互思路，未复制代码）不在此列，
出处见代码注释与 [`docs/05-reference-map.md`](docs/05-reference-map.md)。

## 已并入 / 移植的代码与资产

| 来源项目 | 许可证 | 引入内容 | 引入位置 |
|---|---|---|---|
| gpt_image_playground（CookSleep） | MIT | 出图 API 客户端移植（images/responses 双模式、SSE 解析、供应商映射） | `prototype/src/core/imageApi.ts` 等出图模块 |
| t3code（T3 Tools Inc.） | MIT | 执行器品牌图标 `claude.svg` `codex.svg` `opencode.svg`（取自 marketing harnesses） | `prototype/public/icons/executors/` |
| ZCode（`zocdeusually/ZCode`） | Apache-2.0 | 应用图标曾参照；**当前主图标为本项目原创**，无 ZCode 代码留存 | — |
| pi（Mario Zechner / badlogic，pi-mono） | MIT | 供应商目录形态参照（`core/providerCatalog.ts` 为自写实现） | — |
| hermes-agent（Nous Research） | MIT | 记忆安全扫描器的威胁模式（见下行 pi-hermes-memory） | `backend/src/memory/scanner.ts` |
| pi-hermes-memory | **待确认** | content-scanner 威胁模式移植（prompt 注入 / 角色劫持等正则） | `backend/src/memory/scanner.ts` |
| deepseek-harness（DeepSeek） | MIT | 品牌图标 `dsh`（终端图标取自桌面版资源；headless 适配器为自写实现） | `prototype/public/icons/executors/` |
| kimi-code（Moonshot AI） | MIT | 品牌图标 `kimi.svg` | `prototype/public/icons/executors/` |

> ⚠ **发布前待办**：确认 `pi-hermes-memory` 的许可证。若非宽松许可，
> 需重写 `backend/src/memory/scanner.ts` 的威胁模式（正则模式本身较难构成
> 著作权客体，但发布前确认最稳妥）。
>
> ⚠ 外观系统的取值域与语义常量对齐 Codex-Dream-Skin（theme.json/safe-css），
> 实现为本项目自写；Dream Skin 的许可证未在本仓核查，发布前建议确认。

## 品牌

各 CLI 名称与 logo（Claude、Codex、OpenAI、DeepSeek、MiniMax、Kimi、OpenCode、
Hermes 等）是其各自所有者的商标。本项目中的使用仅用于标识集成关系，
不构成对这些项目的认可或归属声明。

## 原始许可文本

### MIT

以下项目以 MIT 许可证发布：gpt_image_playground（CookSleep）、t3code（T3 Tools Inc.）、
hermes-agent（Nous Research）、kimi-code（Moonshot AI）、pi（Mario Zechner）、
deepseek-harness（DeepSeek）。

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
> of the Software, and to permit persons to whom the Software is furnished to do
> so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### Apache License 2.0

ZCode（`zocdeusual/ZCode`）以 Apache License 2.0 发布。其完整许可文本见
上游仓库根目录的 `LICENSE` 文件；本项目当前无 ZCode 代码或资产留存。
