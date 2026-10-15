import { ClaudeAdapter } from "../src/runtime/adapters/claude.ts";
import { GrokAdapter } from "../src/runtime/adapters/grok.ts";
import { OpencodeAdapter } from "../src/runtime/adapters/opencode.ts";
import { PiAdapter } from "../src/runtime/adapters/pi.ts";
import { CursorAdapter } from "../src/runtime/adapters/cursor.ts";
import { AgyAdapter } from "../src/runtime/adapters/agy.ts";
import { CodexAdapter } from "../src/runtime/adapters/codex.ts";
import { DshAdapter } from "../src/runtime/adapters/dsh.ts";
import { HermesAdapter } from "../src/runtime/adapters/hermes.ts";
import { KimiAdapter } from "../src/runtime/adapters/kimi.ts";
import { McodeAdapter } from "../src/runtime/adapters/mcode.ts";
import { OpenclawAdapter } from "../src/runtime/adapters/openclaw.ts";
import { ZcodeAdapter } from "../src/runtime/adapters/zcode.ts";
import type { ExecutorAdapter } from "../src/runtime/adapters/types.ts";

const rootPath = process.cwd();

const adapters: ExecutorAdapter[] = [
  new ClaudeAdapter(),
  new GrokAdapter(),
  new OpencodeAdapter(),
  new PiAdapter(),
  new CursorAdapter(),
  new AgyAdapter(),
  new CodexAdapter(),
  new DshAdapter(),
  new HermesAdapter(),
  new KimiAdapter(),
  new McodeAdapter(),
  new OpenclawAdapter(),
  new ZcodeAdapter(),
];

console.log(`\n================ ALL EXECUTORS SLASH COMMAND PROBE ================`);
console.log(`Testing rootPath: ${rootPath}\n`);

for (const adapter of adapters) {
  if (!adapter.listCommands) {
    console.log(`[${adapter.id.padEnd(9)}] does NOT implement listCommands`);
    continue;
  }

  try {
    const list = await adapter.listCommands(rootPath);
    const commands = list.filter((c) => (c.kind ?? "command") === "command");
    const skills = list.filter((c) => c.kind === "skill");
    const agents = list.filter((c) => c.kind === "agent");

    console.log(
      `[${adapter.id.padEnd(9)}] Total: ${String(list.length).padStart(3)} | ` +
      `Commands: ${String(commands.length).padStart(3)} | ` +
      `Skills: ${String(skills.length).padStart(3)} | ` +
      `Agents: ${String(agents.length).padStart(2)}`
    );

    // Sample top entries for sanity
    const skillSample = skills.slice(0, 3).map((s) => s.name).join(", ");
    const agentSample = agents.slice(0, 3).map((a) => a.name).join(", ");
    if (skillSample) console.log(`             └─ Skill samples: ${skillSample}`);
    if (agentSample) console.log(`             └─ Agent samples: ${agentSample}`);
  } catch (err: unknown) {
    console.error(`[${adapter.id.padEnd(9)}] ERROR:`, err);
  }
}
console.log(`===================================================================\n`);
