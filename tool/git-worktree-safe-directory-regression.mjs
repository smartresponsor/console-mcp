import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(new URL("../src/tool/git-worktree.ts", import.meta.url), "utf8");
assert.match(source, /function gitArgs\(policy: ConsolePolicy, canonicalWorktree: string, args: string\[\]\)/);
assert.match(source, /scopedLinkedWorktreeTrust\(canonicalWorktree, policy\)/);
assert.doesNotMatch(source, /return \["-c", `safe\.directory=/, "unconditional ownership override must be forbidden");
assert.doesNotMatch(source, /--global|--system|git config/);
const calls = [...source.matchAll(/runSupervisedCommand\([^\n]+, "git", ([^\n]+)\)/g)];
assert.equal(calls.length, 11, "all 11 worktree Git subprocesses remain visible");
for (const call of calls) assert.match(call[1], /gitArgs\(policy, /, "Git invocation missing verified scoped trust");
const root = mkdtempSync(path.join(tmpdir(), "stage11-git-safe-"));
try {
  execFileSync("git", ["init", "-q", root]);
  const output = execFileSync("git", ["-c", `safe.directory=${root}`, "rev-parse", "--show-toplevel"], {cwd: root, encoding:"utf8"}).trim();
  assert.equal(output, root);
  const local = spawnSync("git", ["config", "--local", "--get", "safe.directory"], {cwd: root, encoding:"utf8"});
  assert.equal(local.status, 1, "safe.directory must not persist in repository config");
  const global = spawnSync("git", ["config", "--global", "--get-all", "safe.directory"], {cwd: root, encoding:"utf8"});
  assert.ok(global.status === 0 || global.status === 1, "global Git config must remain readable");
} finally {
  rmSync(root, {recursive:true, force:true});
}
console.log("worktree process-local safe.directory regression: PASS");
