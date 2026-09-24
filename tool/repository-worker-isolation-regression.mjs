import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { runWithMcpRequestContext, getMcpRequestContext } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Diagnostics", "RequestContext.js")));
const { getAsyncCommandRunStatus, getAsyncCommandRunOutput } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "AsyncCommandRun.js")));
const { startRepositoryWorkerCommand, getRepositoryWorkerSnapshot } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "RepositoryWorkerHost.js")));
const { resolveRepositoryScope } = await import(pathToFileURL(path.join(root, "dist", "service", "repository-registry.js")));
const startWorkerCommand = (scope, input) => startRepositoryWorkerCommand(scope, input, { enforceRuntimeCapacity: false, enforceHeavySemaphore: false });

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-repo-worker-"));

try {
  const locating = path.join(tempRoot, "Locating");
  const cataloging = path.join(tempRoot, "Cataloging");
  await Promise.all([
    mkdir(path.join(locating, ".git"), { recursive: true }),
    mkdir(path.join(cataloging, ".git"), { recursive: true }),
  ]);

  const policy = {
    workspaceRoot: tempRoot,
    allowedRoots: [tempRoot],
    transcriptDir: path.join(tempRoot, ".console-mcp", "transcript"),
  };
  const locatingScope = await resolveRepositoryScope(policy, { componentName: "Locating" });
  const catalogingScope = await resolveRepositoryScope(policy, { componentName: "Cataloging" });

  await assert.rejects(
    () => startWorkerCommand(locatingScope, {
      workspacePath: catalogingScope.workspacePath,
      command: process.execPath,
      args: ["-e", "console.log('wrong repo')"],
      timeoutMs: 5000,
      kind: "worker-cross-scope-rejection",
    }),
    /workspace mismatch/,
    "worker dispatch must reject cross-repository workspace drift",
  );

  const dispatchStarted = Date.now();
  const [locatingRun, catalogingRun, observations] = await runWithMcpRequestContext("worker-regression-correlation", async () => {
    const [left, right] = await Promise.all([
      startWorkerCommand(locatingScope, slowCommand(locatingScope.workspacePath, "locating", 1400)),
      startWorkerCommand(catalogingScope, slowCommand(catalogingScope.workspacePath, "cataloging", 1400)),
    ]);
    return [left, right, getMcpRequestContext()?.repositoryExecutions ?? []];
  });
  const concurrentDispatchMs = Date.now() - dispatchStarted;

  assert.equal(locatingRun.status, "running");
  assert.equal(catalogingRun.status, "running");
  assert.notEqual(locatingRun.run_id, catalogingRun.run_id);
  assert.equal(locatingRun.repository_worker.scope_id, locatingScope.scopeId);
  assert.equal(catalogingRun.repository_worker.scope_id, catalogingScope.scopeId);
  assert.notEqual(locatingRun.repository_worker.worker_pid, catalogingRun.repository_worker.worker_pid, "repositories should use independent worker process hosts");
  assert.equal(observations.length, 2, "worker dispatch must propagate correlation observations");
  assert.deepEqual(new Set(observations.map((item) => path.resolve(item.cwd).toLowerCase())), new Set([path.resolve(locating).toLowerCase(), path.resolve(cataloging).toLowerCase()]));

  const snapshotStarted = Date.now();
  const activeSnapshot = getRepositoryWorkerSnapshot();
  const gatewaySnapshotLatencyMs = Date.now() - snapshotStarted;
  assert.ok(gatewaySnapshotLatencyMs < 500, `gateway-local worker snapshot was slow under load: ${gatewaySnapshotLatencyMs}ms`);
  assert.equal(activeSnapshot.filter((item) => item.scope_id === locatingScope.scopeId || item.scope_id === catalogingScope.scopeId).length, 2);

  const locatingWorkerPid = Number(locatingRun.repository_worker.worker_pid);
  process.kill(locatingWorkerPid);
  await waitForWorkerExit(locatingScope.scopeId, locatingWorkerPid);

  const rightStatusStarted = Date.now();
  const rightStatusAfterLeftCrash = await getAsyncCommandRunStatus(catalogingScope.workspacePath, catalogingRun.run_id);
  const statusLatencyAfterCrashMs = Date.now() - rightStatusStarted;
  assert.ok(statusLatencyAfterCrashMs < 1000, `status was slow after unrelated worker crash: ${statusLatencyAfterCrashMs}ms`);
  assert.equal(rightStatusAfterLeftCrash.status, "running");

  const recreated = await startWorkerCommand(locatingScope, slowCommand(locatingScope.workspacePath, "locating-recreated", 150));
  assert.equal(recreated.status, "running");
  assert.notEqual(recreated.repository_worker.worker_pid, locatingWorkerPid, "failed repository worker should be recreated on demand");
  assert.equal(recreated.repository_worker.worker_created, true);

  const reused = await startWorkerCommand(locatingScope, slowCommand(locatingScope.workspacePath, "locating-reused", 150));
  assert.equal(reused.repository_worker.worker_pid, recreated.repository_worker.worker_pid, "same repository should reuse a live worker");
  assert.equal(reused.repository_worker.worker_reused, true);

  const [rightDone, recreatedDone, reusedDone] = await Promise.all([
    waitForTerminal(catalogingScope.workspacePath, catalogingRun.run_id),
    waitForTerminal(locatingScope.workspacePath, recreated.run_id),
    waitForTerminal(locatingScope.workspacePath, reused.run_id),
  ]);
  assert.equal(rightDone.status, "succeeded", "unrelated repository run must survive another worker crash");
  assert.equal(recreatedDone.status, "succeeded");
  assert.equal(reusedDone.status, "succeeded");

  const rightOutput = await getAsyncCommandRunOutput({ workspacePath: catalogingScope.workspacePath, runId: catalogingRun.run_id });
  assert.match(rightOutput.stdout, /cataloging:/);
  assert.match(rightOutput.stdout, new RegExp(escapeRegex(path.resolve(catalogingScope.workspacePath))));

  const leftCrashStatus = await waitForTerminal(locatingScope.workspacePath, locatingRun.run_id);
  assert.equal(leftCrashStatus.status, "failed", "durable state should survive worker loss with deterministic recovery status");
  assert.equal(leftCrashStatus.stop_reason, "process_not_running");

  const eventLoopStarted = Date.now();
  let timerDelayMs = null;
  await new Promise((resolve) => setTimeout(() => {
    timerDelayMs = Date.now() - eventLoopStarted;
    resolve();
  }, 25));
  assert.ok(timerDelayMs < 250, `gateway event loop responsiveness regressed: ${timerDelayMs}ms`);

  console.log(JSON.stringify({
    ok: true,
    concurrent_dispatch_ms: concurrentDispatchMs,
    gateway_snapshot_latency_ms: gatewaySnapshotLatencyMs,
    status_latency_after_worker_crash_ms: statusLatencyAfterCrashMs,
    event_loop_timer_delay_ms: timerDelayMs,
    locating_worker_pid: locatingWorkerPid,
    cataloging_worker_pid: catalogingRun.repository_worker.worker_pid,
    recreated_worker_pid: recreated.repository_worker.worker_pid,
    worker_reuse_dispatch_ms: reused.repository_worker.dispatch_ms,
    right_status_after_left_crash: rightStatusAfterLeftCrash.status,
    left_crash_recovered_status: leftCrashStatus.status,
    left_crash_stop_reason: leftCrashStatus.stop_reason,
  }, null, 2));
} finally {
  for (const worker of getRepositoryWorkerSnapshot()) {
    if (typeof worker.pid === "number") {
      try { process.kill(worker.pid); } catch {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

function slowCommand(workspacePath, label, delayMs) {
  return {
    workspacePath,
    command: process.execPath,
    args: ["-e", `setTimeout(() => { console.log(${JSON.stringify(label)} + ':' + process.cwd()); }, ${delayMs})`],
    timeoutMs: 5000,
    kind: `worker-regression:${label}`,
  };
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

async function waitForWorkerExit(scopeId, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snapshot = getRepositoryWorkerSnapshot();
    if (!snapshot.some((item) => item.scope_id === scopeId && item.pid === pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`worker did not exit: ${pid}`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
