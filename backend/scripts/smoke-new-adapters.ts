import { RuntimeHost } from "../src/runtime/host.ts";
import { CursorAdapter } from "../src/runtime/adapters/cursor.ts";
import { GrokAdapter } from "../src/runtime/adapters/grok.ts";
import { OpenclawAdapter } from "../src/runtime/adapters/openclaw.ts";
import { Store } from "../src/store/db.ts";
import { TraceSink } from "../src/runtime/trace.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { FileMemoryInjector } from "../src/memory/injection.ts";
import os from "node:os";
import path from "node:path";

async function main() {
  console.log("=== Testing Grok, Cursor, OpenClaw Adapters ===");
  const tmpHome = path.join(os.tmpdir(), `aw-smoke-${Date.now()}`);
  const store = new Store(tmpHome);
  const gate = new PermissionGate(store);
  const trace = new TraceSink(tmpHome);
  const injector = new FileMemoryInjector();

  const host = new RuntimeHost(() => {}, trace, tmpHome, store, gate, injector);
  host.register(new CursorAdapter());
  host.register(new GrokAdapter());
  host.register(new OpenclawAdapter());

  const adapters = await host.listAdapters();
  console.log("Registered adapters count:", adapters.length);
  for (const a of adapters) {
    const rawAdapter = host.getAdapter(a.id);
    console.log(`- ${a.id} (${a.displayName}): tuiCommand=${rawAdapter?.tuiCommand}, glyph=${a.glyph}, models=${a.models.length}`);
  }

  // Check aliases
  console.log("\n--- Checking Aliases ---");
  const cursorByAlias = host.getAdapter("cursor-agent");
  console.log("host.getAdapter('cursor-agent'):", cursorByAlias?.displayName ?? "NOT FOUND");
  if (!cursorByAlias) throw new Error("cursor-agent alias failed");

  const grokByAlias = host.getAdapter("grok-build");
  console.log("host.getAdapter('grok-build'):", grokByAlias?.displayName ?? "NOT FOUND");
  if (!grokByAlias) throw new Error("grok-build alias failed");

  // Check Probes
  console.log("\n--- Probing Adapters ---");
  const cursorProbe = await host.probe("cursor");
  console.log("Cursor probe:", JSON.stringify(cursorProbe));

  const grokProbe = await host.probe("grok");
  console.log("Grok probe:", JSON.stringify(grokProbe));

  const openclawProbe = await host.probe("openclaw");
  console.log("OpenClaw probe:", JSON.stringify(openclawProbe));

  console.log("\n=== Smoke Test Passed! ===");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
