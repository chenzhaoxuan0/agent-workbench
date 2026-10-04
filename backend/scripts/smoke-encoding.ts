/**
 * 源码卫生 —— 看不见的那类损坏。
 *
 * 起因：`channels/feishu.ts` 里混进过一个 **NUL 字节**，位置在一行字符串兜底值上：
 *
 *     this.#msgId = this.#sentMessageId(r.stdout) ?? "\0keep";
 *
 * 它的危害不是「编译报错」——TS 照编译、测试照跑、程序照跑。真正的后果是：
 *
 *   1. **ripgrep / Grep 工具把整个文件当二进制跳过**。于是这个文件在我所有的检索里
 *      都是隐形的 —— 我搜 `ackEmoji` 得到「只有 2 个文件」，而实际有 4 处。
 *      搜索工具对一个文件静默失灵，比它直接报错危险得多。
 *   2. 那条兜底值本身是逻辑 bug：`#msgId` 存 null 表示「首条还没发」，存 id 表示
 *      「可以编辑」。拿不到 id 时却塞了个非空垃圾串，于是后续每次刷新都拿它去
 *      `+messages-edit`，每次必失败 —— 而用户只看到占位符不动，没有任何报错。
 *
 * 所以这里查的不是「某个具体 bug」，是**整类 bug 的入口**：只要源码里能混进控制字符
 * 或解码失败的替换符，上面两条就随时会重演。
 *
 * 检查项：
 *   - 文本源码里不许有 NUL（U+0000）—— 会触发 ripgrep 的二进制判定
 *   - 不许有 U+FFFD 替换符 —— 意味着某次写入把 UTF-8 写坏了
 *   - 文件必须是合法 UTF-8（严格解码，不许靠容错解码蒙混）
 *   - 顺带确认 ripgrep 现在真的能搜到这个仓库（对 NUL 的实弹验证）
 *
 * 用法：cd backend && pnpm exec tsx scripts/smoke-encoding.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** 只扫我们自己写的文本源码：依赖、构建产物、锁文件都不算。 */
const SCAN_ROOTS = ["backend/src", "backend/scripts", "prototype/src", "docs"];
const SCAN_EXT = new Set([".ts", ".tsx", ".md", ".json", ".css", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(path.extname(full))) yield full;
  }
}

const NUL = 0x00;
const REPLACEMENT = "\uFFFD";
// 严格解码：解码不了就抛，而不是悄悄塞 U+FFFD
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

console.log("\n[1] 扫源码：NUL / U+FFFD / 非法 UTF-8");
const nulHits: string[] = [];
const fffdHits: string[] = [];
const badUtf8: string[] = [];
let scanned = 0;

for (const root of SCAN_ROOTS) {
  for (const file of walk(path.join(repoRoot, root))) {
    scanned += 1;
    const rel = path.relative(repoRoot, file);
    const bytes = readFileSync(file);

    if (bytes.includes(NUL)) nulHits.push(rel);

    // 严格解码一次：解不出来 = 文件不是合法 UTF-8；解出来了，串里的 U+FFFD
    // 就是源码里真的躺着一个替换符（而不是解码兜底产物）。
    let decoded: string | null = null;
    try {
      decoded = strictUtf8.decode(bytes);
    } catch {
      badUtf8.push(rel);
    }
    if (decoded !== null && decoded.includes(REPLACEMENT)) fffdHits.push(rel);
  }
}

check(`扫到了文件（${scanned} 个，别是 0 啊那就白扫了）`, scanned > 0, { scanned });
check("没有 NUL 字节（否则 ripgrep 会把整个文件当二进制跳过）", nulHits.length === 0, nulHits);
check("没有 U+FFFD 替换符（写入时把 UTF-8 写坏了）", fffdHits.length === 0, fffdHits);
check("全部是合法 UTF-8", badUtf8.length === 0, badUtf8);

console.log("\n[2] 实弹验证：ripgrep 现在搜得到本仓库的关键符号");
/**
 * 这一项是给「NUL 危害」的直接证据用的：只要还有文件带 NUL，ripgrep 就会漏。
 * 用一个**肯定存在**的符号当探针，比断言「搜到了 ackEmoji」稳（它跟着需求增删会变）。
 */
const probe = path.join(repoRoot, "backend", "src", "channels", "feishu.ts");
let rgHits = -1;
try {
  const out = execFileSync("rg", ["-c", "log\\.warn", probe], { encoding: "utf8" });
  rgHits = Number.parseInt(out.trim(), 10);
} catch (err: unknown) {
  // rg 认为文件是二进制时会对纯匹配也返回 0，这里显式区分
  rgHits = -2;
}
check("ripgrep 能在这个文件里搜到东西（返回 0 或负数 = 它又把它当二进制了）", rgHits > 0, { rgHits });

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
if (failures > 0) process.exitCode = 1;
