/**
 * git 状态自动刷新的 daemon 侧文件监听（docs/16）。
 *
 * 触发思路对齐 ZCode 的 useGitAutoRefresh（watcher 事件 → 刷新 git 状态），
 * 落点不同：ZCode 在前端起 fileWatcherService，我们的架构里 daemon 才是常驻
 * 进程，监听放 daemon、经 WS 广播 `git.changed`，所有连着的客户端共享一份。
 *
 * 监听意图不新增 RPC：`git.status` 心跳到达过的仓库自动挂监听（徽章路径本来就
 * 每 15–60s 打一次 status），从未被问询的仓库不监听、不耗句柄。收编的路径：
 * - 工作树根递归（win32/darwin 原生支持；linux 不支持递归则跳过——保守降级，
 *   对齐 ZCode 的 linux 策略：只看 git 元数据）
 * - gitdir 与 commonDir 递归（链接工作树的 gitdir 在主仓 .git/worktrees/ 下，
 *   不在工作树根之下，必须单独挂；同时兜住「终端里提交、工作树文件没动」这类
 *   只有 .git 变化的事件）
 *
 * 节流是**前沿 + 尾沿合并**（区别于 ZCode 的纯 60s 尾沿防抖）：首批事件立即
 * 广播一条（用户刚保存文件，徽章该马上翻），持续写入期间每 interval 至多一条，
 * 最长迟到 ≤ interval。纯尾沿在 agent 持续写文件的场景里会把刷新无限推后。
 *
 * 生命周期：daemon 退出统一 stop()；每分钟的存在性清扫回收「目录已被删」的
 * 仓库（临时工作树是常态），监听句柄坏了（目录被改名等）由下一次 status
 * 心跳重建。所有句柄 persistent:false + 定时器 unref —— 监听不阻止进程退出。
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";
import { gitDirs } from "./repo.ts";

/** 两次广播的最小间隔。env 覆盖仅供 smoke（等 60s 太久） */
const THROTTLE_MS = (() => {
  const raw = Number.parseInt(process.env["AGENT_WORKBENCH_GIT_WATCH_INTERVAL_MS"] ?? "", 10);
  return Number.isFinite(raw) && raw >= 50 ? raw : 60_000;
})();

const SWEEP_MS = 60_000;

interface WatchedRoot {
  readonly root: string;
  /** 挂着的句柄（可能多个：工作树根 + gitdir + commonDir） */
  handles: Set<FSWatcher>;
  /** 实际在监听的路径，坏了重建用 */
  readonly paths: string[];
  /** 节流：上次广播时间 + 尾沿合并定时器 */
  lastFire: number;
  timer: NodeJS.Timeout | null;
  /** 最近一次 git.status 心跳（清扫只回收再没人问的坏根） */
  lastAccess: number;
}

export class GitWatcher {
  readonly #roots = new Map<string, WatchedRoot>();
  /** 同 root 并发 ensure 的去重（面板/触发器/侧栏同时打 status 是常态） */
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #sink: (rootPath: string) => void;
  #sweep: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(sink: (rootPath: string) => void) {
    this.#sink = sink;
    this.#sweep = setInterval(() => void this.#sweepOnce(), SWEEP_MS);
    this.#sweep.unref?.();
  }

  /**
   * 注册 / 续期一个仓库。git.status 成功且 isRepo 后调用；失败只记日志
   * （监听是增益路径，手动刷新 / TTL 轮询仍是兜底，不能因它把 status 打红）。
   */
  ensure(rootPath: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const root = path.resolve(rootPath);
    const existing = this.#roots.get(root);
    if (existing !== undefined) {
      existing.lastAccess = Date.now();
      if (existing.handles.size === 0 && existing.paths.length > 0) {
        // 句柄全丢（目录被改名等）：重建也去重，避免并发心跳起两套
        return this.#dedup(root, () => this.#rebuild(existing));
      }
      return Promise.resolve();
    }
    return this.#dedup(root, () => this.#start(root));
  }

  #dedup(root: string, run: () => Promise<void>): Promise<void> {
    const pending = this.#inflight.get(root);
    if (pending !== undefined) return pending;
    const p = run().finally(() => {
      this.#inflight.delete(root);
    });
    this.#inflight.set(root, p);
    return p;
  }

  async #start(root: string): Promise<void> {
    if (this.#stopped) return;
    const dirs = await gitDirs(root);
    if (dirs === null) return; // 不是仓库 / git 不可用：status 心跳不会再来了
    // 工作树根 + 两个 git 目录去重。commonDir 在普通仓库等于 gitDir，
    // 在链接工作树等于主仓 .git（会顺带收到主仓活动的误报——代价是多一次
    // status 刷新，可接受；换来的是主仓提交也能让工作树侧收敛）。
    const targets = new Set<string>([root, dirs.gitDir, dirs.commonDir]);
    const w: WatchedRoot = { root, handles: new Set(), paths: [...targets], lastFire: 0, timer: null, lastAccess: Date.now() };
    this.#roots.set(root, w);
    for (const p of targets) this.#attach(w, p);
    log.info("git watch started", { root, paths: w.paths, throttleMs: THROTTLE_MS });
  }

  #attach(w: WatchedRoot, target: string): void {
    // 工作树根只试递归（linux 降级后非递归只看顶层，没意义）；git 目录
    // 递归失败退非递归——.git 顶层的 HEAD / index / packed-refs 已兜住
    // 提交与分支切换的大多数事件。
    const isRootItself = path.resolve(target) === w.root;
    let handle: FSWatcher;
    try {
      handle = watch(target, { persistent: false, recursive: true }, () => this.#fire(w));
      w.handles.add(handle);
      return;
    } catch (err) {
      if (isRootItself || !this.#isRecursiveUnsupported(err)) {
        log.warn("git watch 目标挂不上（跳过，手动刷新兜底）", { target, error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    try {
      handle = watch(target, { persistent: false }, () => this.#fire(w));
      w.handles.add(handle);
    } catch (err) {
      log.warn("git watch 目标挂不上（跳过，手动刷新兜底）", { target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  #isRecursiveUnsupported(err: unknown): boolean {
    const e = err as { code?: string; message?: string };
    return e?.code === "ERR_FEATURE_UNAVAILABLE" || /recursive/i.test(e?.message ?? "");
  }

  /** 前沿 + 尾沿合并的节流（见文件头注释） */
  #fire(w: WatchedRoot): void {
    const now = Date.now();
    if (now - w.lastFire >= THROTTLE_MS) {
      w.lastFire = now;
      this.#sink(w.root);
      return;
    }
    if (w.timer === null) {
      w.timer = setTimeout(() => {
        w.timer = null;
        w.lastFire = Date.now();
        this.#sink(w.root);
      }, THROTTLE_MS - (now - w.lastFire));
      w.timer.unref?.();
    }
  }

  /** 句柄全没了（目录被改名 / watcher error）→ 下次心跳重建 */
  async #rebuild(w: WatchedRoot): Promise<void> {
    if (!existsSync(w.root)) return;
    const dirs = await gitDirs(w.root);
    const targets = new Set<string>([w.root, ...(dirs === null ? [] : [dirs.gitDir, dirs.commonDir])]);
    for (const p of targets) if (!w.paths.includes(p)) w.paths.push(p);
    for (const p of w.paths) this.#attach(w, p);
  }

  async #sweepOnce(): Promise<void> {
    for (const [root, w] of this.#roots) {
      if (existsSync(root)) continue;
      this.#drop(root, w, "目录已不存在");
    }
  }

  #drop(root: string, w: WatchedRoot, why: string): void {
    for (const h of w.handles) h.close();
    w.handles.clear();
    if (w.timer !== null) clearTimeout(w.timer);
    this.#roots.delete(root);
    log.info("git watch stopped", { root, why });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#sweep !== null) clearInterval(this.#sweep);
    for (const [root, w] of this.#roots) this.#drop(root, w, "daemon 退出");
    this.#inflight.clear();
  }
}
