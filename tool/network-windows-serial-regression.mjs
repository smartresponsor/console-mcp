import assert from "node:assert/strict";
import { parseWindowsSerialInventory, inspectWindowsSerialPorts } from "../dist/tool/network-windows-serial.js";
import { inspectLocalSerialPorts } from "../dist/tool/network-host-inventory.js";

const input = {
  ok: true, source: "Win32_PnPEntity+Win32_SerialPort", truncated: false,
  ports: [
    { device: "COM3", friendlyName: "USB Serial Port (COM3)", manufacturer: "FTDI",
      transport: "usb", vid: "0403", pid: "6001", status: "OK" },
    { device: "COM1", friendlyName: "Communications Port (COM1)", manufacturer: "Microsoft",
      transport: "bluetooth", vid: null, pid: null, status: "OK" },
  ],
};
const parsed = parseWindowsSerialInventory(input);
assert.equal(parsed.ok, true);
assert.equal(parsed.ports.length, 2);
assert.equal(parsed.ports[0].vid, "0403");
assert.equal(parsed.ports[0].device, "COM3");
assert.equal(parsed.ports[0].driver, null);
assert.equal(parsed.ports[0].sysfsPath, null);
assert.equal(parsed.ports[1].transport, "bluetooth");
for (const damaged of [
  { ...input, ports: [...input.ports, input.ports[0]] },
  { ...input, ports: [{ ...input.ports[0], device: "COM0" }] },
  { ...input, ports: [{ ...input.ports[0], device: "COM3; whoami" }] },
  { ...input, ports: [{ ...input.ports[0], vid: "ZZZZ" }] },
  { ...input, ports: [{ ...input.ports[0], friendlyName: "bad\nline" }] },
  { ...input, ports: Array.from({ length: 65 }, () => input.ports[0]) },
]) assert.equal(parseWindowsSerialInventory(damaged).ok, false);
const current = await inspectWindowsSerialPorts();
assert.equal(typeof current.ok, "boolean");
assert.ok(current.ports.length <= 64);
if (process.platform === "win32") {
  assert.equal(current.platform, "win32");
  assert.ok(current.ok || typeof current.reason === "string");
  const canonical = await inspectLocalSerialPorts();
  assert.equal(canonical.platform, "win32");
  assert.ok(canonical.ok || typeof canonical.reason === "string");
  assert.ok(canonical.ports.length <= 64);
} else {
  assert.equal(current.ok, false);
  assert.equal(current.reason, "WINDOWS_ONLY");
}
console.log("NETWORK_WINDOWS_SERIAL_INVENTORY_PASS", JSON.stringify({
  platform: process.platform, liveOk: current.ok,
  ports: current.ports.length, reason: current.reason ?? null,
}));
