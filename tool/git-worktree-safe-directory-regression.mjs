import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(new URL("../src/tool/git-worktree.ts", import.meta.url), "utf8");
assert.match(source, /function gitArgs\(canonicalWorktree: string, args: string\[\]\)/);
assert.match(source, /"safe\.directory=\$\{canonicalWorktree\}"/);
assert.doesNotMatch(source, /--global|--system|git config/);
const calls = [...source.matchAll(/runSupervisedCommand\([^\n]+, "git", ([^\n]+)\)/g)];
assert.equal(calls.length, 11, "all 11 worktree Git subprocesses remain visible");
for (const call of calls) assert.match(call[1], /gitArgs\(/, "Git invocation missing scoped safe.directory");
const root = mkdtempSync(path.join(tmpdir(), "stage11-git-safe-"));
try {
  execFileSync("git", ["init", "-q", root]);
  const output = execFileSync("git", ["-c", `safe.directory=${root}`, "rev-parse", "--show-toplevel"], {cwd: root, encoding:"utf8"}).trim();
  assert.equal(output, root);
  const config = execFileSync("git", ["config", "--local", "--get", "safe.directory"], {cwd: root, encoding:"utf8"}).trim();
  assert.fail("safe.directory unexpectedly persisted: " + config);
} catch (error) {
  if (error?.status !== 1 || !String(error?.stderr ?? "").includes("")) throw error;
} finally {
  rmSync(root, {recursive:true, force:true});
}
console.log("worktree process-local safe.directory regression: PASS");
