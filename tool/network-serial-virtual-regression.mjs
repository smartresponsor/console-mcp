import assert from "node:assert/strict";
import { captureVirtualSerial, validateSerialCaptureRequest } from "../dist/tool/network-serial-virtual.js";

const req = {
  targetId: "virtual_switch_a", profile: "passive-9600-8n1",
  operation: "capture", authorization: "explicit-read-session",
};
assert.ok(validateSerialCaptureRequest(req));
for (const input of [
  {}, null, { ...req, targetId: "../../dev/ttyUSB0" },
  { ...req, profile: "active-9600-8n1" },
  { ...req, operation: "write" }, { ...req, authorization: "implicit" },
  { ...req, command: "show version" }, { ...req, dtr: true },
]) assert.equal(validateSerialCaptureRequest(input), null);

const buffer = (s) => new TextEncoder().encode(s);
const factory = (frames, state) => async () => ({
  frames: (async function* () { for (const f of frames) yield f; })(),
  async close() { state.closed++; },
});
let state = { closed: 0 };
let result = await captureVirtualSerial(req,
  factory([buffer("version=virtual\n"), buffer("token: abc123\nready\n")], state));
assert.equal(result.ok, true);
assert.equal(result.truncated, false);
assert.match(result.output, /version=virtual/);
assert.doesNotMatch(result.output, /abc123/);
assert.equal(state.closed, 1);

state = { closed: 0 };
result = await captureVirtualSerial(req, factory([new Uint8Array(4097)], state));
assert.equal(result.status, "SERIAL_FRAME_INVALID");
assert.equal(state.closed, 1);

state = { closed: 0 };
result = await captureVirtualSerial(req,
  factory([new Uint8Array(4096), new Uint8Array(4096), buffer("overflow")], state));
assert.equal(result.status, "SERIAL_CAPTURE_TRUNCATED");
assert.equal(result.output.length, 8192);
assert.equal(state.closed, 1);

let invoked = 0;
result = await captureVirtualSerial({ ...req, dtr: true }, async () => { invoked++; throw new Error("must not open"); });
assert.equal(result.ok, false);
assert.equal(invoked, 0);

const ctrl = new AbortController();
ctrl.abort();
result = await captureVirtualSerial(req, async () => { invoked++; throw new Error("must not open"); }, ctrl.signal);
assert.equal(result.status, "SERIAL_CAPTURE_CANCELLED");
assert.equal(invoked, 0);

state = { closed: 0 };
result = await captureVirtualSerial(req, factory([buffer("valid")], state), undefined, 0);
assert.equal(result.status, "SERIAL_TIMEOUT_INVALID");
assert.equal(state.closed, 0);


state = { closed: 0 };
const delayedFactory = async () => ({
  frames: (async function* () { await new Promise(resolve => setTimeout(resolve, 100)); yield buffer("late"); })(),
  async close() { state.closed++; },
});
result = await captureVirtualSerial(req, delayedFactory, undefined, 10);
assert.equal(result.ok, false);
assert.equal(result.status, "SERIAL_CAPTURE_FAILED_OR_TIMEOUT");
assert.equal(state.closed, 1);

state = { closed: 0 };
const aborter = new AbortController();
const pending = captureVirtualSerial(req, delayedFactory, aborter.signal, 1000);
setTimeout(() => aborter.abort(), 10);
result = await pending;
assert.equal(result.status, "SERIAL_CAPTURE_CANCELLED");
assert.equal(state.closed, 1);

state = { closed: 0 };
let lateResolve;
const lateFactory = () => new Promise(resolve => { lateResolve = resolve; });
result = await captureVirtualSerial(req, lateFactory, undefined, 10);
assert.equal(result.ok, false);
lateResolve({ frames: (async function* () { yield buffer("late"); })(),
  async close() { state.closed++; } });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(state.closed, 1, "late-resolving factory must be closed");

console.log("NETWORK_SERIAL_VIRTUAL_CONTRACT_PASS");
