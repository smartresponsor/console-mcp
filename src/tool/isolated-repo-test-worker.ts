import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { approvedIsolatedTestSha } from "./isolated-test-approval.js";
import { runIsolatedTestStage, cancelActiveIsolatedTestStage, awaitIsolatedStageCancellation, assertIsolatedTestNotCancelled, IsolatedTestTreeTerminationError } from "./isolated-test-stage.js";

const sha = process.argv[2] ?? "";
const repo = process.cwd();
const shaPattern = /^[a-f0-9]{40}$/;
const tests = [
  ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", ".cmcp-test-npm-cache"], 180_000],
  ["npm", ["run", "build"], 120_000],
  ["node", ["tool/mcp-efficiency-baseline-regression.mjs"], 45_000],
  ["node", ["tool/response-body-measurement-regression.mjs"], 45_000],
  ["node", ["tool/mcp-http-response-trace-integration.mjs"], 90_000],
] as const;

/** The optional approval value is a module-only test seam; the MCP tool and CLI never expose it. */
export async function runIsolatedTest(repoPath: string, commit: string, approvedSha: string = approvedIsolatedTestSha): Promise<Record<string, unknown>> {
  if (!shaPattern.test(commit)) throw new Error("Exact 40-character lowercase Git SHA required");
  if (commit !== approvedSha) throw new Error("ISOLATED_TEST_SHA_NOT_APPROVED");
  const type = await runSupervisedCommand(repoPath, "git", ["cat-file", "-t", commit], 15000);
  if (!type.ok || type.stdout.trim() !== "commit") throw new Error("SHA is not a local commit");
  const branches = await runSupervisedCommand(repoPath, "git", ["branch", "-r", "--contains", commit], 20000);
  if (!branches.ok || !branches.stdout.split(/\r?\n/).some(line => /^\s*origin\/(?!HEAD\b)[^\s]+$/.test(line))) {
    throw new Error("SHA is not contained in a fetched origin branch");
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "cmcp-isolated-test-"));
  // This prefix and exact temp path are created by this invocation alone.
  const stages: Array<Record<string, unknown>> = [];
  let attached = false;
  let testError: unknown = null;
  let descendantTerminationUnconfirmed = false;
  const cleanupErrors: string[] = [];
  try {
    const add = await runSupervisedCommand(repoPath, "git", ["worktree", "add", "--detach", temp, commit], 30000);
    if (!add.ok) throw new Error("Unable to add isolated worktree: " + add.stderr.slice(0, 1000));
    attached = true;
    const head = await runSupervisedCommand(temp, "git", ["rev-parse", "HEAD"], 15000);
    if (!head.ok || head.stdout.trim() !== commit) throw new Error("Isolated worktree SHA mismatch");
    const stat = await runSupervisedCommand(temp, "git", ["status", "--porcelain"], 15000);
    if (!stat.ok || stat.stdout.trim()) throw new Error("Isolated worktree is not clean before tests");
    for (const [command, args, timeout] of tests) {
      assertIsolatedTestNotCancelled();
      const startedAt = new Date().toISOString();
      const result = await runIsolatedTestStage(temp, command, [...args], timeout);
      const record = {
        stage: command + " " + args.join(" "), startedAt,
        ok: result.ok, exitCode: result.exitCode,
        stdout: result.stdout.slice(-12000), stderr: result.stderr.slice(-4000),
      };
      stages.push(record);
      console.log(JSON.stringify(record));
      if (!result.ok) throw new Error("Isolated acceptance failed at: " + record.stage);
    }
  } catch (error) {
    testError = error;
    descendantTerminationUnconfirmed = error instanceof IsolatedTestTreeTerminationError;
  } finally {
    try { await awaitIsolatedStageCancellation(); }
    catch (error) {
      descendantTerminationUnconfirmed = true;
      console.error("ISOLATED_STAGE_TERMINATION_UNCONFIRMED " + String(error));
    }
    // A partially failed worktree-add can still register a Git worktree.
    // Git remove is confined to the freshly allocated temp path.
    if (descendantTerminationUnconfirmed) {
      cleanupErrors.push("process termination unconfirmed: preserve worktree for operator recovery");
      console.error("ISOLATED_PROCESS_TERMINATION_RECOVERY_REQUIRED " + temp);
    } else if (attached || existsSync(path.join(temp, ".git"))) {
      const drop = await runSupervisedCommand(repoPath, "git", ["worktree", "remove", "--force", temp], 30000);
      if (!drop.ok) {
        console.error("ISOLATED_WORKTREE_CLEANUP_FAILED " + drop.stderr.slice(0, 1500));
        cleanupErrors.push("worktree remove failed");
      }
    }
    // Do not erase a failed Git worktree removal: keep its .git owner marker for
    // explicit forensic reconciliation rather than creating hidden stale metadata.
    if (cleanupErrors.length === 0) {
      await rm(temp, { recursive: true, force: true }).catch(error => {
        console.error("ISOLATED_TEMP_CLEANUP_FAILED " + String(error));
        cleanupErrors.push("temporary directory removal failed");
      });
    } else {
      console.error("ISOLATED_CLEANUP_RECOVERY_REQUIRED " + temp);
    }
  }
  if (!testError && cleanupErrors.length === 0) {
    try { assertIsolatedTestNotCancelled(); } catch (error) { testError = error; }
  }
  if (testError || cleanupErrors.length) {
    throw new Error([testError instanceof Error ? testError.message : String(testError ?? ""), ...cleanupErrors].filter(Boolean).join("; "));
  }
  return { ok: true, status: "ISOLATED_TEST_PASS", sha: commit, stages: stages.length, cleanup: "complete" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  process.once("SIGTERM", () => {
    process.exitCode = 143;
    void cancelActiveIsolatedTestStage().catch(error => {
      console.error("ISOLATED_TERMINATION_RECOVERY_REQUIRED " + String(error));
      process.exitCode = 1;
    });
  });
  runIsolatedTest(repo, sha).then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error("ISOLATED_TEST_FAIL " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
