// Contract regression for the unregistered local diagnostics prototype.
// Run only against a feature-branch build: npm run build && node tool/infrastructure-diagnostics-regression.mjs
import assert from "node:assert/strict";
import { ipv4RoutesInput, tcpListenersInput, processesInput, parseTcpListeners, parseProcesses, parseIpv4Routes } from "../dist/tool/infrastructure-diagnostics.js";

assert.deepEqual(ipv4RoutesInput.parse({ targetId: "local" }), { targetId: "local" });
assert.throws(() => ipv4RoutesInput.parse({ targetId: "10.1.2.3" }));
assert.throws(() => ipv4RoutesInput.parse({ targetId: "local", command: "id" }));
assert.equal(tcpListenersInput.parse({ targetId: "local" }).limit, 50);
assert.throws(() => tcpListenersInput.parse({ targetId: "local", port: 0 }));
assert.throws(() => tcpListenersInput.parse({ targetId: "local", port: 65536 }));
assert.throws(() => tcpListenersInput.parse({ targetId: "local", limit: 100000 }));
assert.equal(processesInput.parse({ targetId: "local", limit: 5 }).limit, 5);
assert.throws(() => processesInput.parse({ targetId: "other", limit: 5 }));
console.log("infrastructure diagnostics contract schema: PASS");

assert.deepEqual(parseTcpListeners("LISTEN 0 128 127.0.0.1:443 0.0.0.0:*\n"), [
  { address: "127.0.0.1", port: 443, state: "LISTEN", recvQueue: 0, sendQueue: 128 }
]);
assert.equal(parseTcpListeners("LISTEN 0 128 [::]:443 [::]:*\n", 80).length, 0);
assert.equal(parseTcpListeners("ESTAB 0 0 127.0.0.1:443 127.0.0.1:52345\n").length, 0);
assert.deepEqual(parseProcesses(" 123 1 S 3.5 2048 php-fpm\n"), [
  { pid: 123, ppid: 1, state: "S", cpuPercent: 3.5, rssBytes: 2097152, name: "php-fpm" }
]);

assert.deepEqual(parseIpv4Routes([{ dst: "default", gateway: "10.0.0.1", dev: "eth0", metric: 100 }, null, "garbage"]), [
  { destination: "default", gateway: "10.0.0.1", interface: "eth0", metric: 100, protocol: null }
]);
assert.deepEqual(parseIpv4Routes({ invalid: true }), []);

// Socket/parser edge cases: IPv6 wildcard, invalid queue, invalid port.
assert.deepEqual(parseTcpListeners("LISTEN 0 4096 [::]:8080 [::]:*\n"), [
  { address: "[::]", port: 8080, state: "LISTEN", recvQueue: 0, sendQueue: 4096 }
]);
assert.equal(parseTcpListeners("LISTEN invalid 128 0.0.0.0:80 0.0.0.0:*\n").length, 0);
assert.equal(parseTcpListeners("LISTEN 0 128 0.0.0.0:65536 0.0.0.0:*\n").length, 0);
console.log("infrastructure diagnostics parser fixtures: PASS");
