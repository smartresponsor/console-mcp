import assert from "node:assert/strict";
import { parseWindowsSnapshot, inspectWindowsNetworkSnapshot } from "../dist/tool/network-windows-topology.js";

const routeRows = {
  ok: true, kind: "routes", truncated: false, rows: [
    { DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.1.1", InterfaceAlias: "Wi-Fi", RouteMetric: 15 },
    { DestinationPrefix: "999.1.2.3/24", NextHop: "10.0.0.1", InterfaceAlias: "Bad", RouteMetric: 0 },
  ],
};
const routes = parseWindowsSnapshot(routeRows, "routes");
assert.equal(routes.ok, true);
assert.equal(routes.routes.length, 1);
assert.equal(routes.discarded, 1);
assert.equal(routes.routes[0].gateway, "192.168.1.1");

const neighbors = parseWindowsSnapshot({
  ok: true, kind: "neighbors", truncated: false, rows: [
    { IPAddress: "192.168.1.1", LinkLayerAddress: "AA-BB-CC-DD-EE-FF", InterfaceAlias: "Ethernet", State: "Reachable" },
    { IPAddress: "192.168.1.2", LinkLayerAddress: "00-00-00-00-00-00", InterfaceAlias: "Ethernet", State: "Unreachable" },
  ],
}, "neighbors");
assert.equal(neighbors.ok, true);
assert.equal(neighbors.neighbors.length, 2);
assert.equal(neighbors.neighbors[0].mac, "aa:bb:cc:dd:ee:ff");
assert.equal(neighbors.neighbors[1].mac, null);

assert.equal(parseWindowsSnapshot({ ...routeRows, rows: Array.from({length: 129}, () => routeRows.rows[0]) }, "routes").ok, false);
assert.equal(parseWindowsSnapshot({ ...routeRows, kind: "neighbors" }, "routes").ok, false);
const live = await inspectWindowsNetworkSnapshot("routes");
assert.equal(typeof live.ok, "boolean");
if (process.platform === "win32") {
  assert.equal(live.platform, "win32");
  if (live.ok) assert.equal(live.source, "Get-NetRoute");
} else {
  assert.equal(live.reason, "WINDOWS_ONLY");
}
console.log("NETWORK_WINDOWS_NATIVE_TOPOLOGY_PASS", JSON.stringify({platform: process.platform, live: live.ok, reason: live.reason ?? null}));
