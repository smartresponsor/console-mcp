import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { startAsyncCommandRun, getAsyncCommandRunStatus } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "AsyncCommandRun.js")));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-heavy-capacity-"));
const capacity = { class: "heavy", rootPath: tempRoot, limit: 2 };

function command(label, delayMs) {
  return {
    workspacePath: tempRoot,
    command: process.execPath,
    args: ["-e", `setTimeout(() => console.log(${JSON.stringify(label)}), ${delayMs})`],
    timeoutMs: 5000,
    kind: `heavy-capacity:${label}`,
    capacity,
  };
}

async function waitForTerminal(runId) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const state = await getAsyncCommandRunStatus(tempRoot, runId);
    if (state.status !== "running" && state.status !== "stopping") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run did not finish: ${runId}`);
}

try {
  const first = await startAsyncCommandRun(command("first", 700));
  const second = await startAsyncCommandRun(command("second", 700));
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal(first.capacity_class, "heavy");
  assert.equal(second.capacity_class, "heavy");
  assert.notEqual(first.capacity_slot, second.capacity_slot);
  assert.equal(first.capacity_limit, 2);

  const third = await startAsyncCommandRun(command("third", 100));
  assert.equal(third.ok, false);
  assert.equal(third.status, "ASYNC_COMMAND_WAITING_HEAVY_CAPACITY");
  assert.equal(third.starts_process, false);
  assert.equal(third.capacity.limit, 2);
  assert.equal(third.capacity.occupied, 2);

  await waitForTerminal(first.run_id);
  const fourth = await startAsyncCommandRun(command("fourth", 100));
  assert.equal(fourth.status, "running");
  assert.equal(fourth.capacity_class, "heavy");
  await Promise.all([waitForTerminal(second.run_id), waitForTerminal(fourth.run_id)]);

  const finalProbe = await startAsyncCommandRun(command("final", 50));
  assert.equal(finalProbe.status, "running");
  await waitForTerminal(finalProbe.run_id);
  console.log(JSON.stringify({ ok: true, status: "HEAVY_CAPACITY_REGRESSION_GREEN", limit: 2, third_blocked: true, slot_reused: true }));
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
