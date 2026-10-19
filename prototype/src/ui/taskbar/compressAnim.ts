import { useAppearance } from "../../store/useAppearance.ts";

/**
 * 任务栏压缩/展开动画的 DOM 例程 —— 不引动画库，Web Animations API 手写
 * FLIP 式 ghost：一张代表「这场对话」的迷你卡片随载体矩形从 start 过渡到
 * end，位移与缩放全交给 transform（合成器友好）。
 *
 * 几何约定（两个方向共用一套 delta）：
 * - compress（对话区 → chip）：ghost 铺在 start（对话区矩形）上，从恒等
 *   变换动画到 delta = translate(chip−对话区) ∘ scale(chip/对话区)；
 * - expand（chip → 对话区）：ghost 铺在 end（对话区矩形）上，从 delta
 *   动画回恒等变换 —— 即「从 chip 的位置与尺寸长回整块对话区」。
 * transform-origin 固定 0 0，两个矩形精确首尾衔接。
 *
 * 动效档（外观设置的 motion + prefers-reduced-motion 双重判定）：
 * - off：ghost 不起飞，落点 chip 也不 pop——状态变化本身就是反馈；
 * - reduced：ghost 不起飞，落点 chip 做 160ms 的轻微缩放弹一下（无位移）；
 * - standard：完整路径动画（约 340ms，cubic-bezier(0.2,0,0,1) 的「吸入」手感）。
 */

export type MotionPref = "off" | "reduced" | "standard";

export function currentMotionPref(): MotionPref {
  const m = useAppearance.getState().activeProfile.surface.motion;
  if (m === "off") return "off";
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return "reduced";
  }
  return m === "reduced" ? "reduced" : "standard";
}

/** 等 n 帧（双 rAF 是「React 提交 + 浏览器布局完成」的最小可靠等待） */
export function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (k: number): void => {
      if (k >= n) resolve();
      else requestAnimationFrame(() => step(k + 1));
    };
    requestAnimationFrame(() => step(1));
  });
}

export interface GhostContent {
  title: string;
  sub: string;
  dotCls: string;
  avatarColor: string;
  avatarImg?: string;
}

/** 落点元素的轻弹（reduced 档的替代反馈；standard 档 ghost 落地后也补一下） */
export function popElement(el: Element | null): void {
  if (!(el instanceof HTMLElement)) return;
  el.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.92)" },
      { transform: "scale(1)" },
    ],
    { duration: 160, easing: "ease-out" },
  );
}

/** 迷你卡片：对话的代表形象。compress 从整块对话区起飞时它只是中央一张小卡，
 *  周围留空 —— 用户读到的是「那场对话被收拢成这张卡」，而不是像素级复刻。
 *  内容用 createElement + textContent 组装（标题是外部数据，不走 innerHTML）。 */
function buildCard(content: GhostContent): HTMLDivElement {
  const card = document.createElement("div");
  card.className =
    "absolute left-1/2 top-1/2 flex max-w-[320px] -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-card border border-line bg-canvas px-4 py-3 shadow-subtle";

  const dot = document.createElement("span");
  dot.className = `h-2 w-2 shrink-0 rounded-full ${content.dotCls}`;

  const avatar = document.createElement("span");
  avatar.className = "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full";
  if (content.avatarImg !== undefined) {
    const img = document.createElement("img");
    img.src = content.avatarImg;
    img.alt = "";
    img.className = "h-full w-full object-cover";
    avatar.appendChild(img);
  } else {
    avatar.style.background = content.avatarColor;
    const eyes = document.createElement("span");
    eyes.className = "flex gap-1";
    for (let i = 0; i < 2; i++) {
      const eye = document.createElement("span");
      eye.className = "h-2 w-0.5 rounded-full bg-white/90";
      eyes.appendChild(eye);
    }
    avatar.appendChild(eyes);
  }

  const textCol = document.createElement("span");
  textCol.className = "flex min-w-0 flex-col leading-tight";
  const title = document.createElement("span");
  title.className = "truncate text-body-sm font-medium text-ink";
  title.textContent = content.title;
  const sub = document.createElement("span");
  sub.className = "truncate text-caption text-ash";
  sub.textContent = content.sub;
  textCol.append(title, sub);

  card.append(dot, avatar, textCol);
  return card;
}

export function playGhost(opts: {
  start: DOMRect;
  end: DOMRect;
  content: GhostContent;
  direction: "compress" | "expand";
}): void {
  const { start, end, content, direction } = opts;
  if (start.width <= 0 || start.height <= 0 || end.width <= 0 || end.height <= 0) return;

  // 载体矩形：compress 铺在起点（动画恒等 → delta）；expand 铺在终点（delta → 恒等）
  const base = direction === "compress" ? start : end;
  const ghost = document.createElement("div");
  ghost.className =
    "pointer-events-none fixed z-[80] overflow-hidden rounded-card border border-line bg-canvas-solid shadow-subtle";
  ghost.style.left = `${base.left}px`;
  ghost.style.top = `${base.top}px`;
  ghost.style.width = `${base.width}px`;
  ghost.style.height = `${base.height}px`;
  ghost.style.transformOrigin = "0 0";
  ghost.appendChild(buildCard(content));
  document.body.appendChild(ghost);

  // compress：start → end 的正变换；expand：把铺在 end 上的载体先变到 start
  // 的位置与尺寸（逆变换），再动画回恒等 —— 两个方向都精确首尾衔接
  const delta =
    direction === "compress"
      ? `translate(${end.left - start.left}px, ${end.top - start.top}px) scale(${end.width / start.width}, ${end.height / start.height})`
      : `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width}, ${start.height / end.height})`;
  const identity = "translate(0, 0) scale(1, 1)";
  const keyframes: Keyframe[] =
    direction === "compress"
      ? [
          { transform: identity, opacity: 1 },
          { transform: delta, opacity: 0.9 },
        ]
      : [
          { transform: delta, opacity: 1 },
          { transform: identity, opacity: 1, offset: 0.7 },
          { transform: identity, opacity: 0 },
        ];
  const anim = ghost.animate(keyframes, {
    duration: direction === "compress" ? 340 : 300,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
    fill: "forwards",
  });
  anim.finished
    .then(() => ghost.remove())
    .catch(() => ghost.remove()); // 页签切走等场景的 abort 也要清掉浮层
}
