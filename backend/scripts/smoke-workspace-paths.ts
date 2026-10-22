/**
 * workspace.paths.list 逻辑冒烟 —— 直接调 listWorkspacePaths，不起 daemon。
 * 覆盖：根目录列举 / 子目录下钻 / 名字过滤 / 安全闸（.. 与绝对路径）/ 排序。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorkspacePaths } from "../src/workspacePaths.ts";

const root = path.join(tmpdir(), `ws-paths-smoke-${Date.now()}`);
mkdirSync(path.join(root, "src", "deep"), { recursive: true });
mkdirSync(path.join(root, ".git"));
mkdirSync(path.join(root, "node_modules"));
writeFileSync(path.join(root, "README.md"), "hi");
writeFileSync(path.join(root, "readme.txt"), "hi2");
writeFileSync(path.join(root, ".env"), "secret");
writeFileSync(path.join(root, "src", "index.ts"), "x");
writeFileSync(path.join(root, "src", "deep", "util.py"), "y");
writeFileSync(path.join(root, "node_modules", "junk.js"), "z");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failed++;
    console.log(`FAIL - ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// 1. 根目录：目录在前，.git / node_modules 排除，.env 隐藏（query 不以 . 开头）
const rootList = await listWorkspacePaths(root, "");
check(
  "根目录：目录优先且排除 .git/node_modules/隐藏文件",
  rootList.items.map((i) => i.path).join(",") === "src/,README.md,readme.txt",
  rootList,
);
check("根目录：文件带 size", rootList.items.find((i) => i.name === "README.md")?.size === 2);
check("根目录：未截断", rootList.truncated === false);

// 2. 过滤：readme → 前缀命中 README.md 排在 readme.txt 前（大小写不敏感 substring）
const filtered = await listWorkspacePaths(root, "readme");
check("过滤 readme 命中两个文件", filtered.items.length === 2, filtered);

// 3. 下钻：src/ 列出该层（deep/ 目录在前），query 为空
const drill = await listWorkspacePaths(root, "src/");
check(
  "下钻 src/ 列出 deep/ 与 index.ts",
  drill.items.map((i) => i.path).join(",") === "src/deep/,src/index.ts",
  drill,
);

// 4. 下钻 + 过滤：src/deep + util
const drillQuery = await listWorkspacePaths(root, "src/deep/ut");
check("src/deep/ 过滤 util.py", drillQuery.items.map((i) => i.path).join(",") === "src/deep/util.py", drillQuery);

// 5. 安全闸：.. / 绝对路径 / 盘符 → 空清单
check("拒绝 ..", (await listWorkspacePaths(root, "../")).items.length === 0);
check("拒绝绝对路径", (await listWorkspacePaths(root, "/etc")).items.length === 0);
check("拒绝盘符", (await listWorkspacePaths(root, "C:/Windows")).items.length === 0);

// 6. dotfile：query 以 . 开头才显示
const dot = await listWorkspacePaths(root, ".");
check("query=. 显示 .env", dot.items.some((i) => i.name === ".env"), dot);

// 7. limit 截断
const limited = await listWorkspacePaths(root, "", 1);
check("limit=1 截断标记", limited.items.length === 1 && limited.truncated === true, limited);

// 8. 不存在的目录 → 空清单不报错
const missing = await listWorkspacePaths(root, "nope/");
check("不存在目录返回空清单", missing.items.length === 0 && missing.truncated === false);

rmSync(root, { recursive: true, force: true });

// ---- 端到端：自起 daemon → WS 调 workspace.paths.list（对齐 smoke-health 的起法） ----

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpcE2E(): Promise<void> {
  const e2eRoot = path.join(tmpdir(), `ws-paths-e2e-${Date.now()}`);
  mkdirSync(path.join(e2eRoot, "sub"), { recursive: true });
  writeFileSync(path.join(e2eRoot, "a.ts"), "x");
  writeFileSync(path.join(e2eRoot, "sub", "b.ts"), "y");

  const port = await freePort();
  const daemon: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", path.join(backendRoot, "src", "index.ts")],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        AGENT_WORKBENCH_PORT: String(port),
        AGENT_WORKBENCH_HOST: "127.0.0.1",
        AGENT_WORKBENCH_INSECURE: "1",
        // 冒烟家隔离：daemon 状态住临时目录，绝不碰真实 ~/.agent-workbench
        AGENT_WORKBENCH_HOME: mkdtempSync(path.join(tmpdir(), "aw-wsp-home-")),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const daemonLogs: string[] = [];
  daemon.stdout?.on("data", (c: Buffer) => daemonLogs.push(c.toString()));
  daemon.stderr?.on("data", (c: Buffer) => daemonLogs.push(c.toString()));

  try {
    // 等 /healthz
    let healthy = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !healthy) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        healthy = res.ok;
      } catch {
        await sleep(200);
      }
    }
    check("e2e: daemon 起来", healthy);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    });

    // 帧形态见 docs/07：id 必须是 string（数字 id 会吃 bad_frame）
    const call = (
      id: string,
      params: unknown,
    ): Promise<{ id: string | null; ok: boolean; result?: unknown; error?: unknown }> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("rpc timeout")), 10000);
        const onMessage = (ev: MessageEvent): void => {
          const frame = JSON.parse(String(ev.data)) as {
            id?: string | null;
            ok?: boolean;
            result?: unknown;
            error?: unknown;
          };
          if (frame.id !== id) return;
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          resolve({ id: frame.id ?? null, ok: frame.ok === true, result: frame.result, error: frame.error });
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({ v: 1, id, method: "workspace.paths.list", params }));
      });

    const hit = await call("ws-paths-1", { rootPath: e2eRoot, token: "b" });
    // 一次只列一层："b" 只命中根下的 sub/（sub/b.ts 要下钻才可见）
    const hitPaths = (hit.result as { items: Array<{ path: string }> }).items.map((i) => i.path);
    check(
      "e2e: token=b 命中 sub/（单层语义）",
      hit.ok === true && JSON.stringify(hitPaths) === JSON.stringify(["sub/"]),
      hit,
    );

    const drill = await call("ws-paths-4", { rootPath: e2eRoot, token: "sub/b" });
    const drillPaths = (drill.result as { items: Array<{ path: string }> }).items.map((i) => i.path);
    check(
      "e2e: token=sub/b 下钻命中 sub/b.ts",
      drill.ok === true && JSON.stringify(drillPaths) === JSON.stringify(["sub/b.ts"]),
      drill,
    );

    const badParams = await call("ws-paths-2", { token: "x" });
    check("e2e: 缺 rootPath 报 bad_params", badParams.ok === false, badParams);

    const traversal = await call("ws-paths-3", { rootPath: e2eRoot, token: "../" });
    check(
      "e2e: ../ 返回空清单（不报错）",
      traversal.ok === true && (traversal.result as { items: unknown[] }).items.length === 0,
      traversal,
    );

    ws.close();
  } catch (err: unknown) {
    failed++;
    console.log(`FAIL - e2e 异常: ${err instanceof Error ? err.message : String(err)}`);
    console.log(daemonLogs.slice(-20).join("\n"));
  } finally {
    daemon.kill("SIGTERM");
    await sleep(300);
    daemon.kill("SIGKILL");
    rmSync(e2eRoot, { recursive: true, force: true });
  }
}

await rpcE2E();

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
