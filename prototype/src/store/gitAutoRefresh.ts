import { useGit } from "./useGit.ts";
import { useGitChanges } from "./useGitChanges.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type { RuntimeEvent } from "../core/events.ts";

/**
 * git 状态自动刷新的安装器（docs/16）—— ZCode useGitAutoRefresh 的对位物。
 *
 * daemon 侧文件监听（backend/src/git/watch.ts）发现仓库有变化时广播
 * `git.changed`；这里订阅并驱动三个消费面：
 * - 徽章缓存 force 刷新（Composer 分支芯片 / 落库触发器 / 侧栏标记即时翻转）
 * - 改动 store：正开着该仓库的改动区（源代码管理页 / 提交对话框）就重拉
 * - 面板 store：源代码管理页正指着该仓库就全量刷新（分支 / 工作树也跟着收敛）
 *
 * 为什么放 store 层而不是组件里：多个组件各自订阅会重复刷新（一个事件触发
 * N 次 git.status）；放这里 App 挂载时 install 一次，路径分发只做一遍。
 * daemon 的节流（默认 60s 一条）已保证事件不会打爆，这里不再二次防抖。
 */

let installed = false;

/** 路径比对归一：daemon 广播的是 path.resolve 后的形态（Windows 反斜杠），而
 *  各 store / 组件手里的 rootPath 是单元原串（可能正斜杠 / 带尾随斜杠 / 大小写
 *  漂移）—— 严格 === 会让自动刷新对这类单元静默失效，先归一再比 */
function normRoot(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function installGitAutoRefresh(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const client = DaemonClient.get(defaultDaemonEndpoint());
  const onGitChanged = (e: RuntimeEvent): void => {
    if (e.type !== "git.changed") return;
    const evtNorm = normRoot(e.rootPath);
    const git = useGit.getState();
    // 徽章写入用**读侧现成的键**（归一匹配到的那条），而不是事件里的形态 ——
    // badgeByRoot 的读者都拿单元原串当键，写事件形态等于白写
    const badgeRoot = Object.keys(git.badgeByRoot).find((k) => normRoot(k) === evtNorm) ?? e.rootPath;
    // 仓库没了（目录被删）时 force 刷新会静默失败——refreshBranchBadge 的
    // 失败分支本来就把 TTL 空位留给重试，这里不用特判
    void git.refreshBranchBadge(badgeRoot, { force: true });
    if (git.rootPath !== null && normRoot(git.rootPath) === evtNorm) void git.refresh();
    const changes = useGitChanges.getState();
    if (changes.rootPath !== null && normRoot(changes.rootPath) === evtNorm) void changes.reload();
  };
  const unsub = client.onEvent(onGitChanged);
  return () => {
    unsub();
    installed = false;
  };
}
