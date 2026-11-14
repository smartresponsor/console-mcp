import assert from "node:assert/strict";
import {
  RELEASE_TRANSACTION_FACADE_TOOL_NAMES,
  releaseTransactionFacadeToolNames,
} from "../dist/engine/release-transaction-facade-tools.js";

assert.equal(RELEASE_TRANSACTION_FACADE_TOOL_NAMES.length, 5);
assert.equal(new Set(RELEASE_TRANSACTION_FACADE_TOOL_NAMES).size, 5);
const canonical = new Set([...RELEASE_TRANSACTION_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const admitted = new Set([...RELEASE_TRANSACTION_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const projection = releaseTransactionFacadeToolNames(canonical, admitted);
assert.deepEqual([...projection], [...RELEASE_TRANSACTION_FACADE_TOOL_NAMES]);
assert(!projection.has("read_.system.console.describe"));
for (const name of RELEASE_TRANSACTION_FACADE_TOOL_NAMES) {
  assert.throws(() => releaseTransactionFacadeToolNames(new Set([...canonical].filter(x => x !== name)), admitted), /cannot publish/);
  assert.throws(() => releaseTransactionFacadeToolNames(canonical, new Set([...admitted].filter(x => x !== name))), /cannot publish/);
}
console.log("RELEASE_TRANSACTION_FACADE_PROJECTION_PASS");
