import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateRuntimeCapacity, runtimeCapacityAllowsHeavyWork, runtimeCapacityAllowsNewWork } from "../dist/tool/runtime-capacity.js";
import { acquireEngineRuntimeSlot, releaseEngineRuntimeSlot } from "../dist/engine/engine-cycle-browser.js";

function decision(input) {
  return evaluateRuntimeCapacity({
    watchdogFresh: true,
    watchdogOwnershipConsistent: true,
    resourceTelemetryFresh: true,
    resourcePressure: "NORMAL",
    stability: "NORMAL",
    currentFailureCount: 0,
    enginePressure: "IDLE",
    ...input,
  });
}

assert.equal(decision({}).decision, "ADMIT");
assert.equal(decision({ enginePressure: "HIGH" }).decision, "ADMIT_LIGHT_ONLY");
assert.equal(decision({ resourcePressure: "WATCH" }).decision, "ADMIT_LIGHT_ONLY");
assert.equal(decision({ stability: "RECOVERING" }).decision, "ADMIT_LIGHT_ONLY");
assert.equal(decision({ stability: "DEGRADED" }).decision, "ADMIT_LIGHT_ONLY");
assert.equal(decision({ resourcePressure: "WARN" }).decision, "WAIT");
assert.equal(decision({ stability: "UNSTABLE" }).decision, "WAIT");
assert.equal(decision({ currentFailureCount: 1 }).decision, "WAIT");
assert.equal(decision({ resourcePressure: "CRITICAL" }).decision, "DRAIN");
assert.equal(decision({ stability: "CRITICAL" }).decision, "DRAIN");
assert.equal(decision({ watchdogFresh: false }).decision, "DRAIN");
assert.equal(decision({ watchdogOwnershipConsistent: false }).decision, "DRAIN");
assert.equal(decision({ resourceTelemetryFresh: false }).decision, "WAIT");
assert.equal(runtimeCapacityAllowsNewWork(decision({})), true);
assert.equal(runtimeCapacityAllowsNewWork(decision({ enginePressure: "HIGH" })), true);
assert.equal(runtimeCapacityAllowsHeavyWork(decision({})), true);
assert.equal(runtimeCapacityAllowsHeavyWork(decision({ stability: "RECOVERING" })), false);
assert.equal(runtimeCapacityAllowsHeavyWork(decision({ enginePressure: "HIGH" })), false);
assert.equal(runtimeCapacityAllowsNewWork(decision({ stability: "UNSTABLE" })), false);
assert.equal(runtimeCapacityAllowsNewWork(decision({ watchdogFresh: false })), false);

const combined = decision({
  watchdogFresh: false,
  resourcePressure: "WARN",
  stability: "DEGRADED",
  enginePressure: "HIGH",
});
assert.equal(combined.decision, "DRAIN");
assert.ok(combined.reasons.includes("WATCHDOG_STALE"));
assert.ok(combined.reasons.includes("RESOURCE_PRESSURE_WARN"));
assert.ok(combined.reasons.includes("STABILITY_DEGRADED"));
assert.ok(combined.reasons.includes("ENGINE_BACKLOG_HIGH"));

const workerHostSource = fs.readFileSync(new URL("../src/Infrastructure/Process/RepositoryWorkerHost.ts", import.meta.url), "utf8");
assert.match(workerHostSource, /runtimeCapacityAllowsHeavyWork\(capacity\)/);
assert.match(workerHostSource, /REPOSITORY_WORKER_WAITING_RUNTIME_CAPACITY/);
assert.match(workerHostSource, /starts_process: false/);

const engineCycleSource = fs.readFileSync(new URL("../src/engine/engine-cycle-browser.ts", import.meta.url), "utf8");
const capacityIndex = engineCycleSource.indexOf("const capacity = readRuntimeCapacity(executorOptions.baseDir)");
const leaseIndex = engineCycleSource.indexOf("const lease = await acquireEngineCycleLease(paths, roundOptions.taskId)");
assert.ok(capacityIndex >= 0, "engine run_n boundary must evaluate runtime capacity");
assert.ok(leaseIndex > capacityIndex, "runtime capacity must be checked before acquiring a cycle lease or entering browser execution");
assert.match(engineCycleSource, /status: "waiting_runtime"[\s\S]{0,500}stage: "runtime_capacity"/);
assert.match(engineCycleSource, /ENGINE_CYCLE_WAITING_RUNTIME_CAPACITY/);
assert.match(engineCycleSource, /do not open a new ChatGPT target/);
assert.ok(engineCycleSource.indexOf("const runtimeSlot = await acquireEngineRuntimeSlot(paths, roundOptions.taskId)") > capacityIndex, "global runtime slot must be acquired after policy admission");
assert.ok(leaseIndex > engineCycleSource.indexOf("const runtimeSlot = await acquireEngineRuntimeSlot(paths, roundOptions.taskId)"), "global runtime slot must be acquired before the per-task cycle lease");
assert.match(engineCycleSource, /ENGINE_CYCLE_WAITING_RUNTIME_SLOT/);
assert.match(engineCycleSource, /CHATGPT_EXECUTION_SLOTS_EXHAUSTED/);
const roundCapacityIndex = engineCycleSource.indexOf("const nextRoundCapacity = readRuntimeCapacity(executorOptions.baseDir)");
const roundResetIndex = engineCycleSource.indexOf("const reset = await resetEngineCycleRoundState(paths, taskId)");
assert.ok(roundCapacityIndex >= 0, "long engine runs must re-check runtime capacity between rounds");
assert.ok(roundResetIndex > roundCapacityIndex, "between-round capacity must be checked before resetting state for another interaction");
assert.match(engineCycleSource, /stopReason === "runtime_capacity" \? "waiting_runtime"/);
assert.match(engineCycleSource, /resume the same task from its checkpoint after runtime capacity recovers/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-runtime-slot-"));
const leasePaths = {
  root: temporaryRoot,
  workspaceRoot: temporaryRoot,
  runDir: path.join(temporaryRoot, "run"),
  taskDir: path.join(temporaryRoot, "run", "task"),
  lockDir: path.join(temporaryRoot, "run", "lock"),
  workerDir: path.join(temporaryRoot, "run", "worker"),
  sessionDir: path.join(temporaryRoot, "run", "session"),
  logDir: path.join(temporaryRoot, "log"),
  eventLog: path.join(temporaryRoot, "log", "event.jsonl"),
  workerLog: path.join(temporaryRoot, "log", "worker.jsonl"),
  errorLog: path.join(temporaryRoot, "log", "error.jsonl"),
};
const leases = [];
try {
  for (let index = 0; index < 6; index += 1) {
    const lease = await acquireEngineRuntimeSlot(leasePaths, `task-${index}`, 6);
    assert.equal(lease.ok, true, `slot ${index} should be acquired`);
    leases.push(lease);
  }
  const exhausted = await acquireEngineRuntimeSlot(leasePaths, "task-overflow", 6);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.status, "ENGINE_RUNTIME_CAPACITY_EXHAUSTED");
  assert.equal(exhausted.occupied, 6);
  await releaseEngineRuntimeSlot(leases.pop());
  const reacquired = await acquireEngineRuntimeSlot(leasePaths, "task-reacquired", 6);
  assert.equal(reacquired.ok, true, "released global slot must be reusable");
  await releaseEngineRuntimeSlot(reacquired);
} finally {
  for (const lease of leases) await releaseEngineRuntimeSlot(lease);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const capacityCliSource = fs.readFileSync(new URL("../src/cli/runtime-capacity-cli.ts", import.meta.url), "utf8");
const cmcpCliSource = fs.readFileSync(new URL("../bin/cmcp.ps1", import.meta.url), "utf8");
assert.match(capacityCliSource, /runtimeCapacityAllowsHeavyWork/);
assert.match(capacityCliSource, /--require-heavy/);
assert.match(capacityCliSource, /requirement_allowed/);
assert.match(cmcpCliSource, /cmcp capacity \[--require-new-work\|--require-heavy\]/);
assert.match(cmcpCliSource, /runtime-capacity-cli\.js/);

console.log(JSON.stringify({ ok: true, status: "RUNTIME_CAPACITY_REGRESSION_GREEN" }));
