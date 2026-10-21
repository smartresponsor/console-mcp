// Contract regression for the unregistered local diagnostics prototype.
// Run only against a feature-branch build: npm run build && node tool/infrastructure-diagnostics-regression.mjs
import assert from "node:assert/strict";
import { ipv4RoutesInput, tcpListenersInput, processesInput } from "../dist/tool/infrastructure-diagnostics.js";

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
