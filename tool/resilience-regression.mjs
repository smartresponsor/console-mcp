import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const {
  getAsyncCommandRunOutput,
  getAsyncCommandRunStatus,
  startAsyncCommandRun,
} = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "AsyncCommandRun.js")));
const { buildRepositoryExecutionFingerprint } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "RepositoryExecutionFingerprint.js")));
const { searchText } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "FileSystem", "SafeFileSystem.js")));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-resilience-"));

try {
  const repo = path.join(tempRoot, "Repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-b", "master"], { cwd: repo });
  await writeFile(path.join(repo, "composer.json"), JSON.stringify({ scripts: { "quality:static": "phpstan analyse --no-progress" } }, null, 2));
  await writeFile(path.join(repo, "tracked.php"), "<?php echo 'tracked';\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "core.hooksPath=NUL", "commit", "-m", "seed"], { cwd: repo });

  const operationInputs = {
    operation: "regression.php-quality-style",
    command: process.execPath,
    args: ["-e", "setTimeout(() => { console.log('phpstan style slow pass'); }, 800)"],
    timeoutMs: 5000,
  };
  const fingerprint = await buildRepositoryExecutionFingerprint(repo, operationInputs);
  const [first, duplicate] = await Promise.all([
    startAsyncCommandRun({
      workspacePath: repo,
      command: operationInputs.command,
      args: operationInputs.args,
      timeoutMs: operationInputs.timeoutMs,
      kind: "regression-php-quality-style",
      dedupe: { operationKey: JSON.stringify(operationInputs), repositoryFingerprint: fingerprint, reuseSuccessful: true },
    }),
    startAsyncCommandRun({
      workspacePath: repo,
      command: operationInputs.command,
      args: operationInputs.args,
      timeoutMs: operationInputs.timeoutMs,
      kind: "regression-php-quality-style",
      dedupe: { operationKey: JSON.stringify(operationInputs), repositoryFingerprint: fingerprint, reuseSuccessful: true },
    }),
  ]);
  assert.equal(first.run_id, duplicate.run_id, "equivalent concurrent operation should reuse one run id");
  const concurrentDecisions = [first, duplicate];
  assert.equal(concurrentDecisions.filter((item) => item.dedupe?.started_new === true).length, 1, "exactly one concurrent caller should start the run");
  assert.equal(concurrentDecisions.filter((item) => item.dedupe?.reused_running === true).length, 1, "exactly one concurrent caller should reuse the running job");
  assert.equal(concurrentDecisions.filter((item) => item.job_reused === true).length, 1, "exactly one concurrent caller should be marked as reused");

  const responsiveness = [];
  while (true) {
    const startedAt = Date.now();
    const status = await getAsyncCommandRunStatus(repo, first.run_id);
    const output = await getAsyncCommandRunOutput({ workspacePath: repo, runId: first.run_id, limitBytes: 4096 });
    responsiveness.push(Date.now() - startedAt);
    assert.ok(String(output.stdout).length <= 4096);
    if (status.status !== "running" && status.status !== "stopping") {
      assert.equal(status.status, "succeeded");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(Math.max(...responsiveness) < 1000, `status/output was not responsive: ${Math.max(...responsiveness)}ms`);

  const recent = await startAsyncCommandRun({
    workspacePath: repo,
    command: operationInputs.command,
    args: operationInputs.args,
    timeoutMs: operationInputs.timeoutMs,
    kind: "regression-php-quality-style",
    dedupe: { operationKey: JSON.stringify(operationInputs), repositoryFingerprint: fingerprint, reuseSuccessful: true },
  });
  assert.equal(recent.run_id, first.run_id, "successful recent result should be reused for unchanged repository state");
  assert.equal(recent.dedupe.reused_recent_result, true);

  await writeFile(path.join(repo, "tracked.php"), "<?php echo 'changed';\n");
  const changedFingerprint = await buildRepositoryExecutionFingerprint(repo, operationInputs);
  assert.notEqual(changedFingerprint, fingerprint, "repository fingerprint should change after worktree changes");
  const changedRun = await startAsyncCommandRun({
    workspacePath: repo,
    command: operationInputs.command,
    args: operationInputs.args,
    timeoutMs: operationInputs.timeoutMs,
    kind: "regression-php-quality-style",
    dedupe: { operationKey: JSON.stringify(operationInputs), repositoryFingerprint: changedFingerprint, reuseSuccessful: true },
  });
  assert.notEqual(changedRun.run_id, first.run_id, "changed repository state must not reuse previous green result");
  await waitForTerminal(repo, changedRun.run_id);

  const failingInputs = { operation: "regression.stale-lease", command: process.execPath, args: ["-e", "process.exit(2)"], timeoutMs: 5000 };
  const failingFingerprint = await buildRepositoryExecutionFingerprint(repo, failingInputs);
  const failed = await startAsyncCommandRun({
    workspacePath: repo,
    command: failingInputs.command,
    args: failingInputs.args,
    timeoutMs: failingInputs.timeoutMs,
    kind: "regression-stale-lease",
    dedupe: { operationKey: JSON.stringify(failingInputs), repositoryFingerprint: failingFingerprint, reuseSuccessful: true },
  });
  await waitForTerminal(repo, failed.run_id);
  const recovered = await startAsyncCommandRun({
    workspacePath: repo,
    command: failingInputs.command,
    args: failingInputs.args,
    timeoutMs: failingInputs.timeoutMs,
    kind: "regression-stale-lease",
    dedupe: { operationKey: JSON.stringify(failingInputs), repositoryFingerprint: failingFingerprint, reuseSuccessful: true },
  });
  assert.notEqual(recovered.run_id, failed.run_id);
  assert.equal(recovered.lease_recovered, true);
  await waitForTerminal(repo, recovered.run_id);

  const verbose = await startAsyncCommandRun({
    workspacePath: repo,
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(300000))"],
    timeoutMs: 5000,
    kind: "regression-verbose",
  });
  await waitForTerminal(repo, verbose.run_id);
  const verboseOutput = await getAsyncCommandRunOutput({ workspacePath: repo, runId: verbose.run_id, limitBytes: 4096 });
  assert.ok(String(verboseOutput.stdout).length <= 4096);
  assert.equal(verboseOutput.next_stdout_offset, 4096);

  const policy = {
    allowedRoots: [tempRoot],
    deniedPath: { denyBasenames: [], denyExtensions: [], denyPathFragments: [], allowlist: [] },
    maxFileBytes: 1024 * 1024,
    maxSearchResults: 50,
  };
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, ".venv"), { recursive: true });
  await mkdir(path.join(repo, "vendor"), { recursive: true });
  await writeFile(path.join(repo, "src", "needle.txt"), "unique-resilience-needle\n");
  await writeFile(path.join(repo, ".venv", "hidden.txt"), "unique-resilience-needle\n");
  await writeFile(path.join(repo, "vendor", "hidden.txt"), "unique-resilience-needle\n");
  await writeFile(path.join(repo, "src", "binary.pyc"), Buffer.from([0, 1, 2, 3, ...Buffer.from("unique-resilience-needle")]));
  const search = await searchText(policy, repo, "unique-resilience-needle", 20, 5000);
  assert.deepEqual(search.matches.map((match) => path.relative(repo, match.file).replaceAll("\\", "/")), ["src/needle.txt"]);
  assert.ok(search.skippedFiles >= 1);

  const deadlineRoot = path.join(repo, "deadline-fixture");
  await mkdir(deadlineRoot, { recursive: true });
  await Promise.all(Array.from({ length: 500 }, (_, index) =>
    writeFile(path.join(deadlineRoot, `fixture-${String(index).padStart(4, "0")}.txt`), `deadline-fixture-${index}\n`)
  ));
  const deadline = await searchText(policy, repo, "needle-that-will-not-complete", 20, 1);
  assert.equal(deadline.status, "TIME_BUDGET_EXCEEDED");

  console.log(JSON.stringify({
    ok: true,
    duplicate_run_id: first.run_id,
    reused_running: duplicate.dedupe.reused_running,
    reused_recent_result: recent.dedupe.reused_recent_result,
    invalidated_by_repository_change: changedRun.run_id !== first.run_id,
    stale_lease_recovered: recovered.lease_recovered,
    max_status_output_ms: Math.max(...responsiveness),
    output_chunk_bytes: verboseOutput.next_stdout_offset,
    search_status: search.status,
    deadline_status: deadline.status,
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function waitForTerminal(workspacePath, runId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await getAsyncCommandRunStatus(workspacePath, runId);
    if (state.status !== "running" && state.status !== "stopping") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run did not finish: ${runId}`);
}
