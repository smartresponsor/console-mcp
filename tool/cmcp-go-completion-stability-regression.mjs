#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { loadConsolePolicy } from "../dist/Policy/ConsolePolicy.js";
import { captureGitWorktreeFingerprint, createEnginePaths } from "../dist/engine/engine-core.js";
import { acquireEngineCycleLease, isEngineCycleRunVerifiedComplete, releaseEngineCycleLease, resolveEnginePreReplyStopReason, verifyEngineCompletionCandidate } from "../dist/engine/engine-cycle-browser.js";

const root = path.resolve(".");
const fixture = path.join(root, "var", "test-fixtures", "cmcp-go-completion-stability");
const policy = await loadConsolePolicy(root);

function git(...args) {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function writePackage(testExitCode) {
  await writeFile(path.join(fixture, "package.json"), `${JSON.stringify({
    name: "cmcp-go-completion-stability-fixture",
    private: true,
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      test: `node -e \"process.exit(${testExitCode})\"`,
      build: "node -e \"process.exit(0)\"",
    },
  }, null, 2)}\n`, "utf8");
}

try {
  await rm(fixture, { recursive: true, force: true });
  await mkdir(fixture, { recursive: true });
  await writePackage(0);
  await writeFile(path.join(fixture, "tracked.txt"), "alpha\n", "utf8");
  git("init");
  git("config", "core.hooksPath", ".git/no-hooks");
  git("add", "package.json", "tracked.txt");
  git("-c", "user.name=Console MCP Regression", "-c", "user.email=dev@smartresponsor.com", "commit", "-m", "baseline");

  const leasePaths = createEnginePaths(root);
  const leaseTaskId = "regression-cycle-lease";
  const firstLease = await acquireEngineCycleLease(leasePaths, leaseTaskId);
  assert.equal(firstLease.ok, true);
  const competingLease = await acquireEngineCycleLease(leasePaths, leaseTaskId);
  assert.equal(competingLease.ok, false);
  assert.equal(competingLease.status, "ENGINE_CYCLE_LEASE_ACTIVE");
  await releaseEngineCycleLease(firstLease);
  const reacquiredLease = await acquireEngineCycleLease(leasePaths, leaseTaskId);
  assert.equal(reacquiredLease.ok, true);
  await releaseEngineCycleLease(reacquiredLease);

  assert.equal(isEngineCycleRunVerifiedComplete("max_rounds"), false);
  assert.equal(isEngineCycleRunVerifiedComplete("decision_recheck_required:unknown"), false);
  assert.equal(isEngineCycleRunVerifiedComplete("human_decision_required"), false);
  assert.equal(isEngineCycleRunVerifiedComplete("decision_done_verified:done"), true);
  assert.equal(resolveEnginePreReplyStopReason({ currentFingerprint: "same", previousFingerprint: "same", previousRepeatCount: 2, autoIterationCount: 3, maxAutoIterations: 5 }), "stalled_no_semantic_progress");
  assert.equal(resolveEnginePreReplyStopReason({ currentFingerprint: "new", previousFingerprint: "old", previousRepeatCount: 2, autoIterationCount: 5, maxAutoIterations: 5 }), "max_rounds");
  assert.equal(resolveEnginePreReplyStopReason({ currentFingerprint: "new", previousFingerprint: "old", previousRepeatCount: 2, autoIterationCount: 3, maxAutoIterations: 5 }), null);
  assert.equal(resolveEnginePreReplyStopReason({ currentFingerprint: "new", previousFingerprint: "old", previousRepeatCount: 0, autoIterationCount: 3, maxAutoIterations: 3 }), "max_rounds", "resumed run_n calls must not regain M<n> budget when their local round index restarts at zero");

  const baseline = await captureGitWorktreeFingerprint(fixture);
  assert.match(baseline.fingerprint, /^[a-f0-9]{64}$/);
  const initialHead = git("rev-parse", "HEAD");
  const green = await verifyEngineCompletionCandidate(policy, root, {
    workspace_path: fixture,
    mutation_policy: "read_only",
    initial_worktree_fingerprint: baseline.fingerprint,
    initial_head: initialHead,
  });
  assert.equal(green.ok, true);
  assert.equal(green.status, "ENGINE_COMPLETION_FACTS_AND_GATES_VERIFIED");
  assert.deepEqual(green.gate_names, ["console_typecheck", "npm_test", "npm_build"]);

  await writeFile(path.join(fixture, "tracked.txt"), "beta\n", "utf8");
  const drift = await verifyEngineCompletionCandidate(policy, root, {
    workspace_path: fixture,
    mutation_policy: "read_only",
    initial_worktree_fingerprint: baseline.fingerprint,
    initial_head: initialHead,
  });
  assert.equal(drift.ok, false);
  assert.equal(drift.status, "ENGINE_COMPLETION_WORKTREE_DRIFT");

  const writeAllowedDrift = await verifyEngineCompletionCandidate(policy, root, {
    workspace_path: fixture,
    mutation_policy: "write_allowed",
    git_commit_policy: "forbidden",
    initial_worktree_fingerprint: baseline.fingerprint,
    initial_head: initialHead,
  });
  assert.equal(writeAllowedDrift.ok, true);
  assert.equal(writeAllowedDrift.workspace_state_matches_baseline, false);
  assert.equal(writeAllowedDrift.workspace_changes_allowed, true);

  await writeFile(path.join(fixture, "tracked.txt"), "gamma\n", "utf8");
  git("add", "tracked.txt");
  git("-c", "user.name=Console MCP Regression", "-c", "user.email=dev@smartresponsor.com", "commit", "-m", "forbidden-head-change");
  const forbiddenCommit = await verifyEngineCompletionCandidate(policy, root, {
    workspace_path: fixture,
    mutation_policy: "write_allowed",
    git_commit_policy: "forbidden",
    initial_worktree_fingerprint: baseline.fingerprint,
    initial_head: initialHead,
  });
  assert.equal(forbiddenCommit.ok, false);
  assert.equal(forbiddenCommit.status, "ENGINE_COMPLETION_FORBIDDEN_GIT_COMMIT");
  assert.equal(forbiddenCommit.initial_head, initialHead);
  assert.notEqual(forbiddenCommit.current_head, initialHead);

  await writeFile(path.join(fixture, "tracked.txt"), "alpha\n", "utf8");
  await writeFile(path.join(fixture, "untracked.txt"), "one\n", "utf8");
  const untrackedOne = await captureGitWorktreeFingerprint(fixture);
  await writeFile(path.join(fixture, "untracked.txt"), "two\n", "utf8");
  const untrackedTwo = await captureGitWorktreeFingerprint(fixture);
  assert.notEqual(untrackedOne.fingerprint, untrackedTwo.fingerprint, "untracked content changes must alter the worktree fingerprint even when porcelain paths are unchanged");
  await rm(path.join(fixture, "untracked.txt"), { force: true });

  await writePackage(7);
  git("add", "package.json");
  git("-c", "user.name=Console MCP Regression", "-c", "user.email=dev@smartresponsor.com", "commit", "-m", "failing-test-gate");
  const failingBaseline = await captureGitWorktreeFingerprint(fixture);
  const failingHead = git("rev-parse", "HEAD");
  const red = await verifyEngineCompletionCandidate(policy, root, {
    workspace_path: fixture,
    initial_worktree_fingerprint: failingBaseline.fingerprint,
    initial_head: failingHead,
  });
  assert.equal(red.ok, false);
  assert.equal(red.status, "ENGINE_COMPLETION_DETERMINISTIC_GATE_FAILED");
  assert.ok(red.failed_gate_names.includes("npm_test"));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "CMCP_GO_COMPLETION_STABILITY_REGRESSION_GREEN",
    scenarios: {
      exclusive_cycle_lease: true,
      fail_closed_final_success: true,
      clean_baseline_and_gates: true,
      tracked_drift_rejected: true,
      forbidden_commit_rejected: true,
      untracked_content_drift_detected: true,
      deterministic_gate_failure_rejected: true,
    },
  })}\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
