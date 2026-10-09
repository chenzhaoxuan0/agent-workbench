/**
 * 终端 TUI 直启冒烟：验证 dst / hermes 在 ConPTY 里的 executorId 直启链路。
 *
 * terminals.ts 的规则：executorId（非 shell/pwsh/mockperm）就是 pwsh 里
 * `& '<命令>'` 的命令名。这里分别用 executorId="dst" / "hermes" 起终端，
 * 收集几秒输出，确认 TUI 真起来了（出现 TUI 特征：hermes 的 banner 框线 /
 * dst 的 dsh-tui 界面），然后 kill。
 *
 * 用法：cd backend && npx tsx scripts/smoke-tui-dst-hermes.ts
 */
import { TerminalManager } from "../src/terminal/terminals.ts";

function collect(
  label: string,
  executorId: string,
  expectPatterns: readonly string[],
  waitMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const mgr = new TerminalManager((frame) => {
      if (frame.kind === "data" && frame.data !== undefined) chunks.push(frame.data);
    });
    console.log(`\n.. ${label}: spawning executorId="${executorId}" (wait ${waitMs / 1000}s)`);
    mgr.create({ executorId, cwd: process.cwd(), cols: 100, rows: 30 });
    setTimeout(() => {
      const out = chunks.join("");
      const flat = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*\x1b\\/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
      for (const p of expectPatterns) {
        console.log(`   pattern "${p}": ${flat.includes(p) ? "HIT" : "miss"}`);
      }
      console.log(`   bytes=${out.length}`);
      mgr.shutdown();
      // ConPTY 关闭是异步的，留一拍让 exit 事件落地，别让它串进下一个 collect
      setTimeout(() => resolve(expectPatterns.some((p) => flat.includes(p))), 1500);
    }, waitMs);
  });
}

// dst 的 TUI 工具链（node launcher → dsh --profile dsh-tui）冷启动要 12-20s，
// 等待窗口给足；特征串取自实测渲染输出（模型行 / Tips 条）
const dstOk = await collect("DeepSeek Harness TUI", "dst", ["deepseek", "Tips"], 30000);
const hermesOk = await collect("Hermes Agent", "hermes", ["Hermes", "│", "─"], 15000);
console.log(`\n${dstOk && hermesOk ? "all green" : "FAILURES"}`);
process.exit(dstOk && hermesOk ? 0 : 1);
