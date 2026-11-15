import assert from "node:assert/strict";
import { inspectHostNetworkInterfaces, inspectLocalSerialPorts } from "../dist/tool/network-host-inventory.js";

const interfaces = await inspectHostNetworkInterfaces();
assert.equal(interfaces.ok, true);
assert.ok(interfaces.interfaces.length <= 64);
assert.equal(new Set(interfaces.interfaces.map((entry) => entry.name)).size, interfaces.interfaces.length);
assert.ok(["os.networkInterfaces", "os.networkInterfaces+sysfs"].includes(interfaces.source));
for (const entry of interfaces.interfaces) {
  assert.match(entry.name, /^[A-Za-z0-9_.:-]{1,64}$/);
  assert.ok(["ethernet", "wireless", "virtual", "unknown"].includes(entry.kind));
  assert.ok(entry.carrier === true || entry.carrier === false || entry.carrier === null);
  assert.ok(entry.speedMbps === null || (Number.isSafeInteger(entry.speedMbps) && entry.speedMbps > 0));
  assert.ok(entry.addresses.length <= 16);
  for (const address of entry.addresses) {
    assert.equal(typeof address.address, "string");
    assert.equal(typeof address.mac, "string");
  }
}
const serial = await inspectLocalSerialPorts();
assert.ok(serial.ports.length <= 64);
if (process.platform === "linux") {
  assert.equal(serial.ok, true);
  for (const entry of serial.ports) {
    assert.match(entry.device, /^\/dev\/tty(?:USB|ACM)\d{1,4}$/);
    assert.ok(entry.sysfsPath === null || entry.sysfsPath.startsWith("/sys/devices/"));
  }
} else {
  assert.equal(serial.ok, false);
  assert.equal(serial.reason, "SERIAL_ENUMERATION_UNSUPPORTED_ON_PLATFORM");
}
console.log("NETWORK_HOST_INVENTORY_PASS", JSON.stringify({
  platform: interfaces.platform, interfaces: interfaces.interfaces.length, serialPorts: serial.ports.length,
}));
