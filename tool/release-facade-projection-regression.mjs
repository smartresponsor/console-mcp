import assert from "node:assert/strict";
import { RELEASE_FACADE_TOOL_NAMES, releaseFacadeToolNames } from "../dist/engine/release-facade-tools.js";

const canonical = new Set([...RELEASE_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const admitted = new Set(RELEASE_FACADE_TOOL_NAMES);
const projection = releaseFacadeToolNames(canonical, admitted);
assert.deepEqual([...projection], [...RELEASE_FACADE_TOOL_NAMES]);
assert.equal(projection.has("read_.system.console.describe"), false);
assert.equal(projection.size, 6);
assert.throws(
  () => releaseFacadeToolNames(canonical, new Set(["read_.release.runtime.status"])),
  /unregistered or unadmitted tools/,
);
assert.throws(
  () => releaseFacadeToolNames(new Set(), admitted),
  /unregistered or unadmitted tools/,
);
console.log("release facade projection: PASS");
