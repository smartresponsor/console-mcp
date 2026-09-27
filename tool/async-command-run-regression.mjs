import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const {
  getAsyncCommandRunOutput,
  getAsyncCommandRunStatus,
  startAsyncCommandRun,
} = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "AsyncCommandRun.js")));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-async-run-"));

try {
  const left = path.join(tempRoot, "Left");
  const right = path.join(tempRoot, "Right");
  await Promise.all([mkdir(left), mkdir(right)]);

  const startedAt = Date.now();
  const [leftRun, rightRun] = await Promise.all([
    startAsyncCommandRun({
      workspacePath: left,
      command: process.execPath,
      args: ["-e", "setTimeout(() => { console.log('left-done'); }, 700)"],
      timeoutMs: 5000,
      kind: "regression",
    }),
    startAsyncCommandRun({
      workspacePath: right,
      command: process.execPath,
      args: ["-e", "setTimeout(() => { console.log('right-done'); }, 700)"],
      timeoutMs: 5000,
      kind: "regression",
    }),
  ]);
  const dispatchMs = Date.now() - startedAt;

  assert.ok(dispatchMs < 1000, `async dispatch took ${dispatchMs}ms`);
  assert.equal(leftRun.status, "running");
  assert.equal(rightRun.status, "running");
  assert.notEqual(leftRun.run_id, rightRun.run_id);

  const waitForTerminal = async (workspacePath, runId) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await getAsyncCommandRunStatus(workspacePath, runId);
      if (state.status !== "running" && state.status !== "stopping") return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run did not finish: ${runId}`);
  };

  const [leftDone, rightDone] = await Promise.all([
    waitForTerminal(left, leftRun.run_id),
    waitForTerminal(right, rightRun.run_id),
  ]);
  assert.equal(leftDone.status, "succeeded");
  assert.equal(rightDone.status, "succeeded");

  const [leftOutput, rightOutput] = await Promise.all([
    getAsyncCommandRunOutput({ workspacePath: left, runId: leftRun.run_id }),
    getAsyncCommandRunOutput({ workspacePath: right, runId: rightRun.run_id }),
  ]);
  assert.match(leftOutput.stdout, /left-done/);
  assert.match(rightOutput.stdout, /right-done/);

  console.log(JSON.stringify({
    ok: true,
    dispatch_ms: dispatchMs,
    concurrent_runs: 2,
    left_status: leftDone.status,
    right_status: rightDone.status,
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

