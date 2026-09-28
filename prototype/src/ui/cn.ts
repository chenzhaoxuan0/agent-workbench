import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * twMerge 必须认识我们的自定义字号 token（styles.css @theme 的
 * text-caption / text-body-sm / text-body / text-body-lg）。
 *
 * 默认配置不认识它们，会把 `text-caption` 归进「text-color」冲突组——
 * 于是 `cn("text-caption", "text-ink")` 会把字号类静默丢掉，组件回落到
 * 继承的 14px。这正是「同类组件字号不一致」的根因：丢与不丢取决于
 * className 里有没有后置的颜色类，纯看运气。
 *
 * 注册为 font-size 组后：字号只与字号冲突（保留最后一个），
 * 与 text-ink 等颜色类各归各组、互不吞并。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-caption",
        "text-body-sm",
        "text-body",
        "text-body-lg",
      ],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
