import assert from "node:assert/strict";
import { OfflineSerialLeaseCoordinator } from "../dist/tool/network-serial-session-lease.js";

const leases = new OfflineSerialLeaseCoordinator();
let entered = 0;
let finish;
const held = leases.run("serial_a", async (signal) => {
  entered++;
  assert.equal(signal.aborted, false);
  await new Promise(resolve => { finish = resolve; });
  return "done";
}, { timeoutMs: 20 });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(entered, 1);
assert.equal(leases.isLeased("serial_a"), true);
const busy = await leases.run("serial_a", async () => { throw new Error("must not enter"); },
  { timeoutMs: 1000 });
assert.equal(busy.status, "SERIAL_LEASE_BUSY");
const timedOut = await held;
assert.equal(timedOut.status, "SERIAL_LEASE_TIMEOUT");
// No early release: the timed-out task might still own a real handle.
assert.equal(leases.isLeased("serial_a"), true);
assert.equal((await leases.run("serial_a", async () => "wrong", { timeoutMs: 100 })).status,
  "SERIAL_LEASE_BUSY");
finish();
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(leases.isLeased("serial_a"), false);
const ok = await leases.run("serial_a", async () => 42, { timeoutMs: 100 });
assert.deepEqual(ok, { ok: true, status: "SERIAL_LEASE_COMPLETED", value: 42 });

const ctrl = new AbortController();
const pending = leases.run("serial_b", async (signal) => {
  await new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", resolve, { once: true });
  });
  return "cleaned";
}, { timeoutMs: 1000, signal: ctrl.signal });
await new Promise(resolve => setTimeout(resolve, 5));
ctrl.abort();
const cancelled = await pending;
// Completion and cancellation may race, but the lease must eventually release.
assert.ok(["SERIAL_LEASE_CANCELLED", "SERIAL_LEASE_COMPLETED"].includes(cancelled.status));
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(leases.isLeased("serial_b"), false);

const aborted = new AbortController();
aborted.abort();
assert.equal((await leases.run("serial_c", async () => "no", {
  timeoutMs: 100, signal: aborted.signal,
})).status, "SERIAL_LEASE_CANCELLED");
assert.equal(leases.isLeased("serial_c"), false);

for (const targetId of ["", "../COM7", "COM7", "invalid/path", "a".repeat(49)]) {
  assert.equal((await leases.run(targetId, async () => 1, { timeoutMs: 100 })).status,
    "SERIAL_LEASE_REQUEST_INVALID");
}
for (const timeoutMs of [0, -1, 5001, Number.NaN, 1.2]) {
  assert.equal((await leases.run("serial_valid", async () => 1, { timeoutMs })).status,
    "SERIAL_LEASE_REQUEST_INVALID");
}
assert.equal((await leases.run("serial_error", async () => { throw new Error("credential=secret"); },
  { timeoutMs: 100 })).status, "SERIAL_LEASE_TASK_FAILED");
assert.equal(leases.isLeased("serial_error"), false);
assert.equal((await leases.run("serial_other", async () => "independent", { timeoutMs: 100 })).ok, true);
console.log("NETWORK_SERIAL_SESSION_LEASE_PASS");
