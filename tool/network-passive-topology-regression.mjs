import assert from "node:assert/strict";
import {
  parseLinuxRoutes, parseLinuxArp, inspectHostRoutes, inspectHostNeighbors,
} from "../dist/tool/network-passive-topology.js";

const routes = parseLinuxRoutes([
  "Iface\tDestination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT",
  "eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "wlo1\t0002A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0",
  "bad iface 00000000 00000000 0001 0 0 0 00000000 0 0 0",
  "",
].join("\n"));
assert.equal(routes.routes.length, 2);
assert.equal(routes.discarded, 1);
assert.equal(routes.routes[0].gateway, "192.168.2.1");
assert.equal(routes.routes[0].destination, "0.0.0.0");
assert.equal(routes.routes[1].mask, "255.255.255.0");

const arp = parseLinuxArp([
  "IP address       HW type     Flags       HW address            Mask     Device",
  "192.168.2.1 0x1 0x2 aa:bb:cc:dd:ee:ff * eth0",
  "192.168.2.5 0x1 0x0 00:00:00:00:00:00 * eth0",
  "999.999.999.999 0x1 0x2 aa:bb:cc:dd:ee:ff * eth0",
  "",
].join("\n"));
assert.equal(arp.neighbors.length, 2);
assert.equal(arp.discarded, 1);
assert.equal(arp.neighbors[0].mac, "aa:bb:cc:dd:ee:ff");
assert.equal(arp.neighbors[1].mac, null);
assert.equal(arp.neighbors[1].state, "incomplete");
const many = [
  "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT",
  ...Array.from({ length: 140 }, () => "eth0 00000000 0102A8C0 0003 0 0 100 00000000 0 0 0"),
].join("\n");
assert.equal(parseLinuxRoutes(many).routes.length, 128);
assert.equal(parseLinuxRoutes(many).truncated, true);

const liveRoutes = await inspectHostRoutes();
const liveArp = await inspectHostNeighbors();
for (const snapshot of [liveRoutes, liveArp]) {
  assert.equal(typeof snapshot.ok, "boolean");
  assert.ok(typeof snapshot.source === "string");
  assert.equal(typeof snapshot.truncated, "boolean");
  assert.ok(snapshot.discarded >= 0);
}
assert.ok(liveRoutes.routes.length <= 128 && liveArp.neighbors.length <= 128);
if (process.platform !== "linux" && process.platform !== "win32") {
  assert.equal(liveRoutes.reason, "ROUTE_SNAPSHOT_UNSUPPORTED_ON_PLATFORM");
  assert.equal(liveArp.reason, "ARP_SNAPSHOT_UNSUPPORTED_ON_PLATFORM");
}
if (process.platform === "win32") {
  assert.ok(liveRoutes.ok ? liveRoutes.source === "Get-NetRoute" : typeof liveRoutes.reason === "string");
  assert.ok(liveArp.ok ? liveArp.source === "Get-NetNeighbor" : typeof liveArp.reason === "string");
}
console.log("NETWORK_PASSIVE_TOPOLOGY_PASS", JSON.stringify({
  platform: process.platform, routes: liveRoutes.routes.length,
  arpNeighbors: liveArp.neighbors.length, sources: [liveRoutes.source, liveArp.source],
}));
