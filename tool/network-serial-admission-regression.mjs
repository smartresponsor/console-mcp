import assert from "node:assert/strict";
import { planSerialCapture } from "../dist/tool/network-serial-admission.js";

const linux = Object.freeze({
  id: "lab_serial_a", platform: "linux", device: "/dev/ttyUSB0",
  profile: "status-only", baudRate: 9600, dtr: false, rts: false,
});
const win = Object.freeze({
  id: "lab_serial_w", platform: "win32", device: "COM7",
  profile: "status-only", baudRate: 115200, dtr: false, rts: false,
});
const req = Object.freeze({ targetId: "lab_serial_a", observation: "capture" });
const approval = Object.freeze({ targetId: "lab_serial_a", observation: "capture", approved: true });
const targetPolicy = Object.freeze([linux, win]);

const valid = planSerialCapture(req, targetPolicy, approval, "linux");
assert.equal(valid.ok, true);
assert.deepEqual(valid, {
  ok: true, status: "SERIAL_PLAN_ONLY", targetId: "lab_serial_a",
  platform: "linux", profile: "status-only", baudRate: 9600,
  requiresOsDeviceVerification: true, mayOpenDevice: false,
});
const windows = planSerialCapture({ targetId: "lab_serial_w", observation: "capture" }, targetPolicy,
  { targetId: "lab_serial_w", observation: "capture", approved: true }, "win32");
assert.equal(windows.ok, true);
assert.equal(windows.mayOpenDevice, false);

for (const malformed of [
  null, {}, { ...req, device: "/dev/ttyUSB0" }, { ...req, command: "show version" },
  { ...req, dtr: true }, { ...req, targetId: "../ttyUSB0" },
  { ...req, observation: "configure" }, { ...req, targetId: "LAB_SERIAL_A" },
]) assert.equal(planSerialCapture(malformed, targetPolicy, approval, "linux").ok, false);

for (const wrong of [
  null, false, { ...approval, approved: false }, { ...approval, targetId: "lab_serial_w" },
  { ...approval, observation: "configure" }, { ...approval, token: "untrusted" },
]) assert.equal(planSerialCapture(req, targetPolicy, wrong, "linux").status, "SERIAL_AUTHORIZATION_REQUIRED");

for (const unsafeDevice of [
  "/dev/pts/1", "/dev/ttyUSB0/../ttyACM0", "/dev/serial/by-id/usb-device",
  "/dev/ttyUSB00", "/dev/ttyUSB10000", "/dev/ttyUSB0;id", "COM1",
]) assert.equal(planSerialCapture(req, [{ ...linux, device: unsafeDevice }], approval, "linux").status,
  "SERIAL_POLICY_INVALID");

for (const unsafeCom of ["COM0", "COM01", "COM1:foo", "\\\\.\\COM7", "/dev/ttyUSB0"]) {
  assert.equal(planSerialCapture({ targetId: win.id, observation: "capture" },
    [{ ...win, device: unsafeCom }], { ...approval, targetId: win.id }, "win32").status, "SERIAL_POLICY_INVALID");
}
for (const invalidPolicy of [
  [], [linux, linux], [linux, { ...linux, id: "second" }],
  [{ ...linux, baudRate: 230400 }], [{ ...linux, dtr: true }],
  [{ ...linux, rts: true }], [{ ...linux, profile: "configure" }],
  [{ ...linux, device: "/dev/ttyACM0", privileged: true }],
  Array.from({ length: 33 }, (_, i) => ({ ...linux, id: `serial_${i}`, device: `/dev/ttyUSB${i}` })),
]) assert.equal(planSerialCapture(req, invalidPolicy, approval, "linux").ok, false);

assert.equal(planSerialCapture(req, targetPolicy, approval, "win32").status, "SERIAL_TARGET_PLATFORM_MISMATCH");
assert.equal(planSerialCapture(req, targetPolicy, approval, "darwin").status, "SERIAL_PLATFORM_UNSUPPORTED");
assert.equal(planSerialCapture({ targetId: "absent", observation: "capture" }, targetPolicy,
  { targetId: "absent", observation: "capture", approved: true }, "linux").status,
  "SERIAL_TARGET_NOT_PROVISIONED");

// A self-declared approval or device path in the MCP request never authorizes a session.
assert.equal(planSerialCapture({ ...req, approved: true }, targetPolicy, null, "linux").ok, false);
assert.ok(!Object.hasOwn(valid, "device"), "device path must not be returned in a public plan");
console.log("NETWORK_SERIAL_ADMISSION_PLAN_PASS");
