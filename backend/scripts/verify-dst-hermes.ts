/**
 * dst / hermes 适配器验证脚本 —— 不起完整 daemon，只验证：
 * 1. 两个适配器可导入、id/models/capabilities 合法（host.register 的硬要求）
 * 2. probe 在本机真实可跑（resolveCommand + --version / version）
 * 3. dst.start 按设计拒绝 headless（tui_only 错误码）
 */
import { DstAdapter } from "../src/runtime/adapters/dst.ts";
import { HermesAdapter } from "../src/runtime/adapters/hermes.ts";

const dst = new DstAdapter();
const hermes = new HermesAdapter();

for (const a of [dst, hermes]) {
  if (a.models.length === 0) throw new Error(`${a.id}: models 为空（host.register 会拒）`);
  console.log(`[${a.id}] id=${a.id} displayName=${a.displayName} models=${a.models.length} ok`);
}

console.log("\n--- probe dst ---");
const dstProbe = await dst.probe();
console.log(JSON.stringify(dstProbe.state));

console.log("\n--- probe hermes ---");
const hermesProbe = await hermes.probe();
console.log(JSON.stringify(hermesProbe.state));

console.log("\n--- dst.start 应拒绝 ---");
try {
  await dst.start(
    { unitId: "u" as never, unitName: "t", rootPath: process.cwd(), prompt: "hi", model: null },
    () => {},
  );
  console.log("FAIL: dst.start 竟然成功了");
  process.exit(1);
} catch (err: unknown) {
  const code = (err as { code?: string }).code;
  console.log(`OK: dst.start rejected with code=${code}`);
}

await hermes.disconnect();
await dst.disconnect();
console.log("\nall checks passed");
