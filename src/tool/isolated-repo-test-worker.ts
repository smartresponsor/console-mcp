import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

const sha = process.argv[2] ?? "";
const repo = process.cwd();
const shaPattern = /^[a-f0-9]{40}$/;
const tests = [
  ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], 180_000],
  ["npm", ["run", "build"], 120_000],
  ["node", ["tool/mcp-efficiency-baseline-regression.mjs"], 45_000],
  ["node", ["tool/response-body-measurement-regression.mjs"], 45_000],
  ["node", ["tool/mcp-http-response-trace-integration.mjs"], 90_000],
] as const;

export async function runIsolatedTest(repoPath: string, commit: string): Promise<Record<string, unknown>> {
  if (!shaPattern.test(commit)) throw new Error("Exact 40-character lowercase Git SHA required");
  const type = await runSupervisedCommand(repoPath, "git", ["cat-file", "-t", commit], 15000);
  if (!type.ok || type.stdout.trim() !== "commit") throw new Error("SHA is not a local commit");
  const branches = await runSupervisedCommand(repoPath, "git", ["branch", "-r", "--contains", commit], 20000);
  if (!branches.ok || !branches.stdout.split(/\r?\n/).some(line => /^\s*origin\/(?!HEAD\b)[^\s]+$/.test(line))) {
    throw new Error("SHA is not contained in a fetched origin branch");
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "cmcp-isolated-test-"));
  const stages: Array<Record<string, unknown>> = [];
  let attached = false;
  let clean = false;
  try {
    const add = await runSupervisedCommand(repoPath, "git", ["worktree", "add", "--detach", temp, commit], 30000);
    if (!add.ok) throw new Error("Unable to add isolated worktree: " + add.stderr.slice(0, 1000));
    attached = true;
    const head = await runSupervisedCommand(temp, "git", ["rev-parse", "HEAD"], 15000);
    if (!head.ok || head.stdout.trim() !== commit) throw new Error("Isolated worktree SHA mismatch");
    const stat = await runSupervisedCommand(temp, "git", ["status", "--porcelain"], 15000);
    if (!stat.ok || stat.stdout.trim()) throw new Error("Isolated worktree is not clean before tests");
    for (const [command, args, timeout] of tests) {
      const startedAt = new Date().toISOString();
      const result = await runSupervisedCommand(temp, command, [...args], timeout, 2 * 1024 * 1024);
      const record = {
        stage: command + " " + args.join(" "), startedAt,
        ok: result.ok, exitCode: result.exitCode,
        stdout: result.stdout.slice(-12000), stderr: result.stderr.slice(-4000),
      };
      stages.push(record);
      console.log(JSON.stringify(record));
      if (!result.ok) throw new Error("Isolated acceptance failed at: " + record.stage);
    }
    clean = true;
    return { ok: true, status: "ISOLATED_TEST_PASS", sha: commit, stages: stages.length };
  } finally {
    if (attached) {
      const drop = await runSupervisedCommand(repoPath, "git", ["worktree", "remove", "--force", temp], 30000);
      if (!drop.ok) {
        console.error("ISOLATED_WORKTREE_CLEANUP_FAILED " + drop.stderr.slice(0, 1500));
        clean = false;
      }
    }
    await rm(temp, { recursive: true, force: true }).catch(error => {
      console.error("ISOLATED_TEMP_CLEANUP_FAILED " + String(error));
      clean = false;
    });
    if (!clean) console.error("ISOLATED_TEST_INCOMPLETE_OR_FAILED");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  runIsolatedTest(repo, sha).then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error("ISOLATED_TEST_FAIL " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
