import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runIsolatedTest } from "../dist/tool/isolated-repo-test-worker.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "cmcp-isolated-contract-"));
function git(...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
try {
  await assert.rejects(runIsolatedTest(dir, "; rm -rf /"), /Exact 40-character lowercase Git SHA/);
  git("init", "-b", "main");
  git("-c", "user.name=Isolated Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Empty isolated test commit");
  const sha = git("rev-parse", "HEAD");
  await assert.rejects(runIsolatedTest(dir, sha), /ISOLATED_TEST_SHA_NOT_APPROVED/);
  await assert.rejects(runIsolatedTest(dir, sha, sha), /not contained in a fetched origin branch/);
  git("update-ref", "refs/remotes/origin/test-acceptance", sha);
  // No package-lock in this synthetic repository: the fixed test must FAIL,
  // remove its temporary worktree and never touch the primary checkout.
  await assert.rejects(runIsolatedTest(dir, sha, sha), /Isolated acceptance failed at: npm ci/);
  assert.equal(git("rev-parse", "HEAD"), sha);
  assert.equal(git("status", "--porcelain"), "");
  const worktrees = git("worktree", "list", "--porcelain");
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
  console.log("PASS isolated-repo-test-contract-regression (input guards + failure cleanup)");
} finally {
  await rm(dir, { recursive: true, force: true });
}
