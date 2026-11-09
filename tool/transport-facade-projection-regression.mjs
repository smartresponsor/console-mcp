import assert from "node:assert/strict";
import { TRANSPORT_FACADE_TOOL_NAMES, transportFacadeToolNames } from "../dist/engine/transport-facade-tools.js";

const transport = TRANSPORT_FACADE_TOOL_NAMES[0];
const canonical = new Set([transport, "read_.system.console.describe", "write.release.transaction.activate"]);
const admitted = new Set([transport, "read_.system.console.describe"]);
const projection = transportFacadeToolNames(canonical, admitted);
assert.deepEqual([...projection], [transport]);
assert.equal(projection.has("read_.system.console.describe"), false);
assert.equal(projection.has("write.release.transaction.activate"), false);
assert.throws(
  () => transportFacadeToolNames(canonical, new Set()),
  /unregistered or unadmitted tools/,
);
assert.throws(
  () => transportFacadeToolNames(new Set(), admitted),
  /unregistered or unadmitted tools/,
);
assert.equal(TRANSPORT_FACADE_TOOL_NAMES.length, 1);
console.log("transport facade projection: PASS");
