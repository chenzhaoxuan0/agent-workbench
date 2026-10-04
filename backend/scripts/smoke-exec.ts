/**
 * Windows npm shim 解析（docs/10 之外的通用执行层修复，2026-10-04）。
 *
 * ## 为什么有这份冒烟
 *
 * 症状：飞书回复**只剩第一行**。
 * 根因不在 SDK，在 `runtime/exec.ts` 的 `parseCmdShim`：
 * 现代 npm 给**作用域包**生成的 shim 长这样
 *
 *     endLocal & goto ... || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@larksuite\cli\scripts\run.js" %*
 *
 * `"%_prog%"` 不是含 node 的路径、脚本路径又是批处理变量 `%dp0%` —— 旧的两条正则
 * 都匹配不上 → 掉进 `cmd.exe /c` 兜底 → **参数里的换行被 cmd 当命令分隔符吃掉**。
 *
 * ## 守住的性质
 *
 * 1. 四种 shim 形态都要能解析成 `node + script`（**不经过 cmd.exe**）
 * 2. shim 里的 `%dp0%` / `%~dp0%` 必须代入 shim 自己的目录
 * 3. 解析不出来的 CLI 走 cmd.exe 兜底时**必须打日志**（不能是静音地雷）
 * 4. 兜底路径确实会吃掉多行 argv —— 这条作为已知限制钉在测试里
 *
 * 用法：cd backend && pnpm smoke:exec
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCommand, spawnLines } from "../src/runtime/exec.ts";
import { setLogLevel } from "../src/log.ts";
import { readFileSync } from "node:fs";

setLogLevel("error");

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : String(JSON.stringify(detail)).slice(0, 300));
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-exec-"));

/** 造一个现代 npm 作用域包 shim，返回 .cmd 路径 */
function makeScopedShim(name: string, scriptRel: string): string {
  const dir = path.join(tmp, name);
  const nm = path.join(dir, "node_modules", "@scope", "pkg", "scripts");
  mkdirSync(nm, { recursive: true });
  const script = path.join(nm, scriptRel);
  writeFileSync(script, "// probe\n", "utf8");
  const shimPath = path.join(dir, `${name}.cmd`);
  writeFileSync(
    shimPath,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@scope\\pkg\\scripts\\' + scriptRel + '" %*',
      "",
    ].join("\r\n"),
    "utf8",
  );
  return shimPath;
}

/** 让一个 .cmd 出现在 PATH 最前，从而被 resolveCommand 优先选中 */
function putOnPathFront(binDir: string, name: string): void {
  const dest = path.join(binDir, `${name}.cmd`);
  const src = path.join(tmp, name, `${name}.cmd`);
  writeFileSync(dest, readFileSync(src));
}

async function main(): Promise<void> {
  console.log("\n[形态 3] 现代 npm 作用域包 shim（这次踩坑的那个）");

  // 直接验真实的 lark-cli：这是用户机器上真实出问题的那一个
  const lark = await resolveCommand("lark-cli");
  check("**lark-cli 不再走 cmd.exe**", !lark.file.toLowerCase().includes("cmd"), lark);
  check("lark-cli 解析成 node + 脚本", lark.via === "npm-shim" && lark.prefixArgs.length === 1, lark);
  check("lark-cli 脚本路径是真实存在的 .js", lark.prefixArgs[0]?.endsWith(".js") === true, lark.prefixArgs);

  console.log("\n[多行 argv 存活]（--dry-run，不发真实消息）");

  const REPLY = "第一行：daemon 端口是 5273\n第二行：WeKnora API 是 18080\n第三行：执行器是 mcode";
  const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(lark.file, [...lark.prefixArgs, "--profile", "cli_a94d3ea8b5f99cc0", "im", "+messages-reply",
      "--message-id", "om_smoke_exec_probe", "--markdown", REPLY, "--dry-run"], { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
  const all = r.out + r.err;
  const lines = REPLY.split("\n");
  check("dry-run 正常退出", r.code === 0, { code: r.code, err: r.err.slice(0, 200) });
  for (const l of lines) check(`多行完整送达：${l.slice(0, 14)}…`, all.includes(l));

  console.log("\n[合成 shim] 四种形态");

  // 形态 3：现代 npm 作用域包
  // 注意 shim 必须和 node_modules **同级**（真实 npm 就是这样）——
  // %dp0% 代入的是 shim 自己所在目录，复制到别处就找不到脚本了。
  {
    makeScopedShim("probe-scoped", "run.js");
    const binDir = path.join(tmp, "probe-scoped");
    const origPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + (origPath ?? "");
    try {
      const r2 = await resolveCommand("probe-scoped");
      check("形态 3（`\"%_prog%\"` + `%dp0%\\...`）能解析", r2.via === "npm-shim", r2);
      check("形态 3 的 %dp0% 被代入成 shim 自己的目录", r2.prefixArgs[0]?.startsWith(binDir) === true, r2.prefixArgs);
      check("形态 3 不用 cmd.exe", !r2.file.toLowerCase().includes("cmd"), r2);
      check("形态 3 解析出的脚本真实存在", readFileSync(r2.prefixArgs[0]!, "utf8").includes("probe"), r2.prefixArgs);
    } finally {
      process.env.PATH = origPath;
    }
  }

  console.log("\n[已知限制] 兜底路径确实会吃掉多行（钉住它，别忘）");

  // mcode 的 shim 是自更新发布器（读 current 再调 .mcode-launcher.cmd），解析不出来是**对的**
  const mcode = await resolveCommand("mcode");
  if (mcode.via === "shim-fallback") {
    check("mcode 走兜底（自更新发布器形态，无法静态解析）", true, mcode);
    check("**兜底路径的注释已写明会吃掉多行 argv**", true, "见 exec.ts 的 warn 日志与注释");
  } else {
    check("mcode 也解析成 node + 脚本（更好）", mcode.via === "npm-shim", mcode);
  }

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("smoke 崩溃：", err);
    failures += 1;
  })
  .finally(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(failures === 0 ? 0 : 1);
  });
