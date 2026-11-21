import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAsyncCommandRun, stopAsyncCommandRun, getAsyncCommandRunStatus } from "../dist/Infrastructure/Process/AsyncCommandRun.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cmcp-isolated-async-outer-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForState(runId, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await getAsyncCommandRunStatus(root, runId);
    if (state.status === expected) return state;
    await pause(75);
  }
  throw new Error("Async run never reached " + expected);
}
try {
  const script = [
    "process.on('SIGTERM',()=>{setTimeout(()=>process.exit(143),150)});",
    "setInterval(()=>{},1000);",
  ].join("");
  const run = await startAsyncCommandRun({
    workspacePath: root, command: process.execPath,
    args: ["-e", script], timeoutMs: 15000,
    kind: "isolated-test:outer-regression",
  });
  assert.equal(run.status, "running");
  await pause(400);
  const stopped = await stopAsyncCommandRun(root, run.run_id, true);
  assert.equal(stopped.status, "stopped");
  assert.equal((await waitForState(run.run_id, "stopped")).stop_reason, "requested");
  const t = Date.now();
  const timed = await startAsyncCommandRun({
    workspacePath: root, command: process.execPath,
    args: ["-e", script], timeoutMs: 1200,
    kind: "isolated-test:outer-regression-timeout",
  });
  const terminal = await waitForState(timed.run_id, "timed_out", 8000);
  assert.equal(terminal.child_timeout, true);
  assert.ok(Date.now() - t < 8000);
  console.log("PASS isolated async outer lifecycle stop and timeout (" + process.platform + ")");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
