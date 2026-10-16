/**
 * 分支名纯函数自检 —— validateBranchName / sanitizeBranchName（core/git.ts）。
 *
 * 这两个函数的正则链编码了 git ref 的细规则（前导 "-"、".."、尾斜杠、.lock），
 * 回归只会表现为莫名的 UX 拒绝。core 是零依赖纯函数，不需要 daemon，
 * 表驱动断言即可（与 check-models / check-daemon-bridge 同为自包含脚本）。
 *
 * 用法：cd prototype && pnpm check:git-names
 */

import { sanitizeBranchName, validateBranchName } from "../src/core/git.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
}

// validate：拒绝的形态
check("empty rejected", validateBranchName("   ").ok === false);
check("leading dash rejected", validateBranchName("-x").ok === false);
check("double dot rejected", validateBranchName("a..b").ok === false);
check("trailing slash rejected", validateBranchName("feat/").ok === false);
check("trailing dot rejected", validateBranchName("v1.").ok === false);
check(".lock suffix rejected", validateBranchName("a.lock").ok === false);
check("illegal chars rejected", validateBranchName("a b").ok === false);
check("illegal chars rejected (tilde)", validateBranchName("a~b").ok === false);
check("illegal chars rejected (caret)", validateBranchName("a^b").ok === false);
check("illegal chars rejected (colon)", validateBranchName("a:b").ok === false);
check("duplicate rejected against existing", validateBranchName("main", ["main", "dev"]).ok === false);

// validate：接受的形态
check("plain name ok", validateBranchName("main").ok === true);
check("slash name ok", validateBranchName("feat/x").ok === true);
check("unicode ok", validateBranchName("特性/冒烟").ok === true);
check("same name allowed when excluded from existing", validateBranchName("main", ["dev"]).ok === true);

// validate：建议名（sanitize-and-inform）
check("spaces sanitized to dash", validateBranchName("a b").sanitized === "a-b");
check("leading dashes stripped", validateBranchName("-x").sanitized === "x");

// sanitize：独立调用
check("sanitize replaces whitespace and specials", sanitizeBranchName("a b~c^d") === "a-b-c-d");
check("sanitize strips leading dash", sanitizeBranchName("--feat") === "feat");
check("sanitize collapses double dots", sanitizeBranchName("a..b") === "a-b");
check("sanitize trims trailing slash", sanitizeBranchName("feat/").endsWith("/") === false);

if (failures > 0) {
  console.error(`check-git-names: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-git-names: all checks passed");
