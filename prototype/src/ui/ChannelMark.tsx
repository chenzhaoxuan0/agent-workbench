/**
 * 渠道标记 —— 侧栏那枚小图标。
 *
 * ## 为什么要有这个组件
 *
 * 侧栏原来的做法是每条启用渠道画一个通用 `Radio` 图标，于是三个绑了飞书的 bot
 * 长得一模一样——用户问的正是这个：「哪个 bot 接的是哪个飞书机器人？」通用图标
 * 在结构上就不可能回答这个问题。
 *
 * 飞书能给出答案：`bot/v3/info` 返回应用名和头像。头像是「认脸」，应用名是
 * 「叫得出名字」，两者缺一不可（认不出脸的机器人头像加载失败时至少还有名字）。
 *
 * ## 回落
 *
 * 头像 URL 来自飞书 CDN，可能加载失败（离线 / CDN 抽风）。这时必须回落到通用图标，
 * **不能出破图**——一个破图比一个中性图标更糟，它看起来像 bug。
 */

import { useState } from "react";
import { Radio } from "lucide-react";
import type { LarkBotIdentity } from "../adapters/daemon/client.ts";
import { cn } from "./cn.ts";

export function ChannelMark({
  kind,
  identity,
  label,
  className,
}: {
  kind: string;
  /** 飞书才有：其他渠道这里恒为 undefined，退回通用图标 */
  identity?: LarkBotIdentity;
  label: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const url = kind === "feishu" && identity?.ok === true ? identity.avatarUrl : "";

  if (url !== "" && !broken) {
    return (
      <img
        src={url}
        alt=""
        // 头像是从飞书 CDN 直连的，src 泄露不出什么；但仍写死 referrer 策略
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={cn("h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover", className)}
      />
    );
  }

  return (
    <Radio
      size={9}
      className={cn("shrink-0", className)}
      // 认不出脸时至少把名字说清楚：profile 认不出就用渠道名
      aria-label={label}
    />
  );
}

/** 一行短描述：给 title 属性用。「飞书 · 飞书 CLI · cli_a94d…」 */
export function channelIdentityLabel(kindLabel: string, identity?: LarkBotIdentity, profile?: string): string {
  const who = identity?.ok === true && identity.appName !== "" ? identity.appName : (profile ?? "");
  return who === "" ? `已接渠道：${kindLabel}` : `${kindLabel} · ${who} · ${profile ?? identity?.profile ?? ""}`;
}
