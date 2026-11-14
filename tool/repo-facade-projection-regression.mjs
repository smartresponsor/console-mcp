import assert from "node:assert/strict";
import { REPO_FACADE_TOOL_NAMES, repoFacadeToolNames } from "../dist/engine/repo-facade-tools.js";

const canonical = new Set([...REPO_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const admitted = new Set(REPO_FACADE_TOOL_NAMES);
const projection = repoFacadeToolNames(canonical, admitted);
assert.deepEqual([...projection], [...REPO_FACADE_TOOL_NAMES]);
assert.equal(projection.has("read_.system.console.describe"), false);
assert.equal(projection.size, 8);
assert.throws(() => repoFacadeToolNames(new Set(), admitted), /unregistered or unadmitted/);
assert.throws(() => repoFacadeToolNames(canonical, new Set()), /unregistered or unadmitted/);
console.log("repo facade projection: PASS");
