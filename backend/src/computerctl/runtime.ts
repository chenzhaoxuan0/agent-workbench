/**
 * 电脑控制的桌面运行时抽象（docs/14 §3.4）。
 *
 * DesktopRuntime 接口把全部桌面副作用收敛在一个口子上：生产实现是
 * @nut-tree-fork/nut-js（官方 nut.js 已下架 npm，社区续命版，MIT），冒烟 /
 * 回归测试注入 fake（不碰真实键鼠）。 nut 模块**懒加载**——daemon 常规启动
 * 不载原生模块，加载失败只影响工具面，不掀翻进程。
 *
 * 本机实测的事实约束（2026-10，win32 150% 缩放）：
 * - screen.width() 是**逻辑**像素，grab() 返回**物理**像素（2560 vs 3840）；
 *   鼠标坐标走逻辑空间 → 工具面统一「返回图的像素」口径（图可能已 box 降采样
 *   到 ≤1920 宽省视觉 token），执行前按 逻辑宽/返回图宽 换算（win-computer-use-mcp 的 DPI 解法）；
 * - grab 的 data 是 BGRA 4 字节/像素，包不含 imageToJpg/Png 编码器
 *   → 用 node:zlib 自写最小 PNG 编码（零新依赖）；
 * - Window 句柄无公开访问器，防御性读 windowHandle 私有字段，读不到
 *   就只剩按标题激活的降级路径。
 */
import { deflate } from "node:zlib";
import { promisify } from "node:util";

const deflateAsync = promisify(deflate);

export interface WindowInfo {
  readonly handle: number;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenshotResult {
  /** PNG base64（MCP image 块直接可用） */
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
}

export interface DesktopRuntime {
  readonly screenshot: () => Promise<ScreenshotResult>;
  readonly screenSize: () => Promise<{ width: number; height: number }>;
  readonly click: (x: number, y: number, button: "left" | "double" | "right") => Promise<void>;
  readonly drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  /** amount：滚轮格数，正=向下 */
  readonly scroll: (x: number, y: number, amount: number) => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  /** 组合键，"+" 连接，键名小写（如 "ctrl+shift+t"） */
  readonly key: (combo: string) => Promise<void>;
  readonly windows: () => Promise<readonly WindowInfo[]>;
  readonly activateWindow: (handle: number) => Promise<void>;
}

// ---- nut 实现 -------------------------------------------------------------------

/** ASCII 可打印（含换行/制表）才走键盘直打；其余走剪贴板绕 IME */
const ASCII_TYPEABLE = /^[\x09\x0a\x0d\x20-\x7e]*$/;

/** 窗口枚举的护栏：最多列 100 个有标题窗口，总时长 5s 截止（本机实测全量 762 个窗口） */
const WINDOW_LIST_LIMIT = 100;
const WINDOW_LIST_BUDGET_MS = 5000;

/** 系统噪声窗口标题（实测 GDI+ Window / 输入法宿主等占了「有标题」的大头） */
const WINDOW_NOISE: readonly RegExp[] = [
  /^GDI\+ Window/,
  /^Default IME/,
  /^MSCTFime UI/,
  /^Windows Input Experience/,
  /^Program Manager$/,
  /^Start$/,
  /^Taskbar$/i,
];

/** 返回给模型的图最大宽度：4K 原图 PNG ~1.3MB、视觉 token 爆炸；整数倍 box 缩到 ≤1920 */
const MODEL_VIEW_MAX_WIDTH = 1920;

export async function createNutRuntime(): Promise<DesktopRuntime> {
  const nut = await import("@nut-tree-fork/nut-js");
  const { keyboard, Key, mouse, Point, Button, screen, clipboard, getWindows } = nut;

  /**
   * 坐标口径：工具面的全部坐标相对「返回给模型的图」（可能已降采样）；
   * 鼠标走逻辑像素 → 换算比 = 逻辑宽 / 返回图宽，每次抓屏时刷新。
   */
  let logicalPerView = 1;
  let view: { width: number; height: number; data: Buffer } | null = null;
  let viewAt = 0;

  /** 抓一次全屏（物理 BGRA）→ box 降采样 → 校准坐标比与新鲜时间戳 */
  async function grabFresh(): Promise<{ width: number; height: number; data: Buffer }> {
    const img = (await screen.grab()) as unknown as { width: number; height: number; data: Buffer };
    const logicalW = await screen.width();
    const factor = Math.max(1, Math.ceil(img.width / MODEL_VIEW_MAX_WIDTH));
    const out = factor > 1 ? boxDownscaleBgra(img, factor) : { width: img.width, height: img.height, data: img.data };
    view = out;
    viewAt = Date.now();
    logicalPerView = out.width > 0 ? logicalW / out.width : 1;
    return out;
  }

  /** 模型图坐标 → 逻辑鼠标坐标（四舍五入） */
  const toLogical = (v: number): number => Math.round(v * logicalPerView);

  /** 键鼠操作前的口径保鲜：5s 内抓过屏算新鲜，超了重抓校准（分辨率/缩放变更自愈） */
  async function ensureView(): Promise<void> {
    if (view === null || Date.now() - viewAt > 5000) await grabFresh();
  }

  return {
    async screenshot() {
      const img = await grabFresh();
      const png = await encodePngBgra(img.data, img.width, img.height);
      return { pngBase64: png.toString("base64"), width: img.width, height: img.height };
    },
    async screenSize() {
      const img = await grabFresh();
      return { width: img.width, height: img.height };
    },
    async click(x, y, button) {
      await ensureView();
      await mouse.setPosition(new Point(toLogical(x), toLogical(y)));
      if (button === "double") await mouse.doubleClick(Button.LEFT);
      else if (button === "right") await mouse.click(Button.RIGHT);
      else await mouse.click(Button.LEFT);
    },
    async drag(x1, y1, x2, y2) {
      await ensureView();
      const p1 = new Point(toLogical(x1), toLogical(y1));
      const p2 = new Point(toLogical(x2), toLogical(y2));
      // nut 的 drag(path) 会按住左键沿路径移动后松开；给一个中点让路径平滑
      const mid = new Point(Math.round((p1.x + p2.x) / 2), Math.round((p1.y + p2.y) / 2));
      await mouse.setPosition(p1);
      await mouse.drag([p1, mid, p2]);
    },
    async scroll(x, y, amount) {
      await ensureView();
      await mouse.setPosition(new Point(toLogical(x), toLogical(y)));
      const steps = Math.min(Math.abs(Math.round(amount)), 30);
      for (let i = 0; i < steps; i++) {
        if (amount >= 0) await mouse.scrollDown(1);
        else await mouse.scrollUp(1);
      }
    },
    async typeText(text) {
      if (ASCII_TYPEABLE.test(text)) {
        await keyboard.type(text);
        return;
      }
      // 非 ASCII（中文等）：剪贴板 + 粘贴。剪贴板被占用是真实风险，如实上抛。
      await clipboard.setContent(text);
      await keyboard.pressKey(Key.LeftControl, Key.V);
      await keyboard.releaseKey(Key.LeftControl, Key.V);
    },
    async key(combo) {
      const keys = parseCombo(combo, Key);
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys);
    },
    async windows() {
      const out: WindowInfo[] = [];
      const deadline = Date.now() + WINDOW_LIST_BUDGET_MS;
      for (const w of await getWindows()) {
        if (out.length >= WINDOW_LIST_LIMIT || Date.now() > deadline) break;
        const title = await w.getTitle();
        if (title === "" || WINDOW_NOISE.some((re) => re.test(title))) continue;
        const handle = (w as unknown as { windowHandle?: number }).windowHandle;
        const r = await w.getRegion();
        out.push({
          handle: typeof handle === "number" ? handle : -1,
          title,
          x: r.left, y: r.top, width: r.width, height: r.height,
        });
      }
      return out;
    },
    async activateWindow(handle) {
      if (handle < 0) throw new Error("该窗口无句柄（handle=-1），请用 title 激活");
      const ws = await getWindows();
      for (const w of ws) {
        if ((w as unknown as { windowHandle?: number }).windowHandle === handle) {
          await w.focus();
          return;
        }
      }
      throw new Error(`找不到窗口句柄 ${handle}（用 computer_window_list 重查）`);
    },
  };
}

/** 整数倍 box 降采样（f×f 块取平均；边缘块按实际像素数均摊），BGRA 直算不换序 */
function boxDownscaleBgra(img: { width: number; height: number; data: Buffer }, f: number): { width: number; height: number; data: Buffer } {
  const outW = Math.ceil(img.width / f);
  const outH = Math.ceil(img.height / f);
  const out = Buffer.alloc(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let b = 0, g = 0, r = 0, a = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = oy * f + dy;
        if (sy >= img.height) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = ox * f + dx;
          if (sx >= img.width) break;
          const s = (sy * img.width + sx) * 4;
          b += img.data[s]!;
          g += img.data[s + 1]!;
          r += img.data[s + 2]!;
          a += img.data[s + 3]!;
          n++;
        }
      }
      const d = (oy * outW + ox) * 4;
      out[d] = Math.round(b / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(r / n);
      out[d + 3] = Math.round(a / n);
    }
  }
  return { width: outW, height: outH, data: out };
}

/** 键名映射 —— nut Key 枚举的常用子集；认不出的键名在这里就报错 */
function parseCombo(combo: string, Key: typeof import("@nut-tree-fork/nut-js").Key): import("@nut-tree-fork/nut-js").Key[] {
  const KEY_MAP: Record<string, import("@nut-tree-fork/nut-js").Key> = {
    ctrl: Key.LeftControl, control: Key.LeftControl,
    alt: Key.LeftAlt, shift: Key.LeftShift,
    win: Key.LeftWin, meta: Key.LeftMeta, cmd: Key.LeftCmd,
    enter: Key.Enter, return: Key.Return, tab: Key.Tab, esc: Key.Escape, escape: Key.Escape,
    space: Key.Space, backspace: Key.Backspace, delete: Key.Delete, del: Key.Delete,
    insert: Key.Insert, home: Key.Home, end: Key.End,
    pageup: Key.PageUp, pagedown: Key.PageDown,
    up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
    grave: Key.Grave,
  };
  const parts = combo.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("空组合键");
  const keys: import("@nut-tree-fork/nut-js").Key[] = [];
  for (const p of parts) {
    const mapped = KEY_MAP[p]
      ?? (/^[a-z]$/.test(p) || /^f\d{1,2}$/.test(p)
        ? (Key as unknown as Record<string, import("@nut-tree-fork/nut-js").Key>)[p.toUpperCase()]
        : undefined);
    if (mapped === undefined) throw new Error(`认不出的键名：${p}`);
    keys.push(mapped);
  }
  return keys;
}

// ---- 最小 PNG 编码（BGRA → RGB，filter 0，node:zlib deflate） ----------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const tableHit = CRC_TABLE[(c ^ buf[i]!) & 0xff];
    if (tableHit === undefined) throw new Error("crc table underflow"); // 不可达：索引恒 0..255
    c = tableHit ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 异步编码（deflate 让出事件循环）：1920x1080 的 raw 是 ~6MB，同步压缩一次
 * 卡 daemon 200-400ms，终端流和 WS 都会抖。
 */
async function encodePngBgra(bgra: Buffer, width: number, height: number): Promise<Buffer> {
  // 每行：filter 字节 0 + RGB 三通道（win grab 实测 BGRA 通道序）
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * 3;
      raw[dst] = bgra[src + 2]!; // R
      raw[dst + 1] = bgra[src + 1]!; // G
      raw[dst + 2] = bgra[src]!; // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const compressed = await deflateAsync(raw, { level: 3 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- fake 实现（冒烟 / 回归） ------------------------------------------------------

/** 不碰真实桌面：记录调用、返回 1×1 占位截图 */
export function createFakeRuntime(log: ((line: string) => void) | null = null): DesktopRuntime {
  const calls: string[] = [];
  const rec = (line: string): void => {
    calls.push(line);
    log?.(line);
  };
  return {
    async screenshot() {
      rec("screenshot");
      // 1x1 灰 PNG（合法文件，MCP 客户端可解码）
      const px = Buffer.from([0x80, 0x80, 0x80, 0xff]);
      const png = await encodePngBgra(px, 1, 1);
      return { pngBase64: png.toString("base64"), width: 1, height: 1 };
    },
    async screenSize() {
      rec("screenSize");
      return { width: 1920, height: 1080 };
    },
    async click(x, y, button) {
      rec(`click ${x},${y} ${button}`);
    },
    async drag(x1, y1, x2, y2) {
      rec(`drag ${x1},${y1}->${x2},${y2}`);
    },
    async scroll(x, y, amount) {
      rec(`scroll ${x},${y} ${amount}`);
    },
    async typeText(text) {
      rec(`type ${JSON.stringify(text)}`);
    },
    async key(combo) {
      rec(`key ${combo}`);
    },
    async windows() {
      rec("windows");
      return [
        { handle: 1, title: "Fake 记事本", x: 0, y: 0, width: 800, height: 600 },
        { handle: 2, title: "Fake 浏览器", x: 100, y: 100, width: 1024, height: 768 },
      ];
    },
    async activateWindow(handle) {
      rec(`activate ${handle}`);
    },
  };
}
