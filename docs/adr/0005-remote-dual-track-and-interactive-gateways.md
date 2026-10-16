# 远控双轨制与交互式渠道网关

移动端远程控制采用「近场扫码直连（Mobile Layout）」与「离场 IM 渠道（Channel Gateways）」双轨融合架构：桌面端统一由远控中心（Remote Console）分发连接；手机 Web 端革命性重构为结构化自适应视图与手势底部抽屉；IM 渠道在飞书基础上增补微信（iLink Bot 官方协议）、Telegram 与 Discord，且全面升级为支持确认门（Confirmation Gate）远程按钮审批的交互式网关。

## Considered Options

- **纯 Web 优先（否决）**：仅提供手机浏览器访问，IM 渠道仅作单向通知。否决原因：手机浏览器依赖常驻网络或内网穿透，离开 Wi-Fi/Tailscale 即失联，无法达成"随时随地唤醒与轻量交互"的目标。
- **纯 IM 优先（ZCode 现行方案，否决）**：将远控全部压在 IM 聊天机器人上。否决原因：IM 聊天受限于平台字符排版与附件格式，无法在移动端提供沉浸式的代码 Diff 审查、富交互工具折叠与全量终端回看。
- **无状态 Faceless yolo 通道（原 docs/08 路线，否决）**：IM 渠道因无桌面审批弹窗而固定以 yolo（免审批）执行。否决原因：缺乏确认门防护导致远程高危操作不可控；通过 Telegram Inline Buttons 和 Discord Message Components，完全能够原生承载实时审批。

## Consequences

- 桌面端顶栏增设远控中心入口，动态生成附带局域网 IP 与受限 Token 的配对码（Pairing QR），手机原生扫码即入。
- 手机 Web 放弃原有的 xterm 终端画布挤压方案，重构为以消息气泡、Thinking 折叠、Tool 卡片与 Bottom Sheet 审批为核心的 Mobile Layout。
- 微信渠道对接腾讯官方 iLink Bot 协议，支持桌面扫码配对与 Token 双模式，规避非官方 Hook 的风控封号隐患。
- Telegram 与 Discord 从简单轮询升级为全双工交互网关，支持命令集与交互式审批回传。
