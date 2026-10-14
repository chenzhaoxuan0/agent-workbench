/**
 * PTY worker 入口 —— node-pty 只在本线程加载与调用，主线程零接触。
 *
 * 为什么必须隔离（2026-10-15 minidump 实锤）：node-pty 的 conpty 原生插件
 * （conpty.node）存在同步阻塞路径（等待 ConPTY 句柄/临界区），在主线程上
 * 一旦卡住，整个 daemon 的事件循环冻结 —— /healthz 无响应、所有 RPC 超时，
 * 用户看到的就是「什么命令都拉不出来」。栈回溯证据：主线程栈顶清一色
 * conpty.node + ntdll NtWaitForSingleObject。
 *
 * 本文件跑在 worker_threads 里：插件再怎么卡，卡住的也只是这个 worker，
 * daemon 主线程照常服务（VS Code ptyHost 的同款思路）。
 *
 * 协议（postMessage JSON，见 ptyHost.ts 的 PtyHost）：
 *   主 → worker: {t:"create",id,file,args,cwd,cols,rows,env} | write | resize | kill
 *   worker → 主: {t:"created",id,pid} | {t:"data",id,data} | {t:"exit",id,exitCode} | {t:"error",id,message}
 */

import { parentPort } from "node:worker_threads";
import pty from "node-pty";

const ptys = new Map<string, pty.IPty>();

function reply(msg: unknown): void {
  parentPort?.postMessage(msg);
}

parentPort?.on("message", (m: {
  t?: string;
  id?: string;
  file?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  data?: string;
}) => {
  const { t, id } = m;
  if (t === undefined || id === undefined || id === "") return;

  if (t === "create") {
    try {
      const p = pty.spawn(m.file ?? "", m.args ?? [], {
        name: "xterm-256color",
        cols: m.cols ?? 80,
        rows: m.rows ?? 24,
        cwd: m.cwd,
        env: m.env,
        useConpty: process.platform === "win32",
        useConptyDll: process.platform === "win32",
        conptyInheritCursor: process.platform === "win32",
      });
      ptys.set(id, p);
      p.onData((data) => reply({ t: "data", id, data }));
      p.onExit(({ exitCode }) => {
        ptys.delete(id);
        reply({ t: "exit", id, exitCode });
      });
      reply({ t: "created", id, pid: p.pid });
    } catch (err: unknown) {
      reply({ t: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const p = ptys.get(id);
  if (p === undefined) {
    if (t === "write" || t === "resize") reply({ t: "error", id, message: `no such pty: ${id}` });
    return;
  }
  try {
    if (t === "write") p.write(m.data ?? "");
    else if (t === "resize") p.resize(m.cols ?? 80, m.rows ?? 24);
    else if (t === "kill") p.kill();
  } catch (err: unknown) {
    // write/resize 打死进程句柄上是常见竞态（终端刚好退出）——不回 error 帧，
    // onExit 随后会到；这里只记日志（worker 里没有全局 log 通道，stderr 走 daemon 控制台）
    console.warn(`[ptyWorker] ${t} failed for ${id}:`, err instanceof Error ? err.message : String(err));
  }
});
